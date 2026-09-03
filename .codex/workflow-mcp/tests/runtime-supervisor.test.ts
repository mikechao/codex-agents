import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { WorkflowError } from "../errors.js";
import { currentHead } from "../git.js";
import { isValidRuntimeArtifact, materializeRuntimeArtifact } from "../runtime-artifact.js";
import { RuntimeSupervisor, resolveOwningRuntime } from "../runtime-supervisor.js";
import { createRuntimeAttestation, WorkflowStore } from "../store.js";
import { objectDigest } from "../validation.js";
import { fixture } from "./test-fixtures.js";

describe("Workflow MCP runtime supervision", () => {
  function attestation(runtimeId: string, revision: string) {
    const nonce = "1".repeat(64);
    const key = "2".repeat(64);
    return {
      runtimeAttestation: createRuntimeAttestation(runtimeId, revision, nonce, key),
      runtimeAttestationNonce: nonce,
      runtimeAttestationKey: key,
    };
  }

  function create(store: any, _root: string, revision: string, objective: string) {
    return store.create({
      workflow_type: "change",
      objective,
      approved_plan: null,
      approved_paths: ["note.txt"],
      acceptance_criteria: ["criterion"],
      validation_requirements: [{ description: "validation", argv: ["bun", "run", "check"] }],
      review_target: {
        review_mode: "working_tree",
        base_revision: revision,
        head_revision: null,
        approved_paths: ["note.txt"],
        include_staged: true,
        include_unstaged: true,
        include_untracked: true,
      },
    });
  }

  test("persists immutable runtime affinity and keeps it across reopen", () => {
    const { root } = fixture();
    const path = join(root, "runtime.sqlite");
    const revision = currentHead(root);
    const runtimeId = "a".repeat(64);
    try {
      const first: any = new WorkflowStore({
        repositoryRoot: root,
        databasePath: path,
        runtimeId,
        runtimeRevision: revision,
      });
      const created = create(first, root, revision, "runtime affinity");
      expect(first.runtimeAffinity(created.workflow_id)).toEqual({
        runtime_id: runtimeId,
        runtime_revision: revision,
      });
      first.close();
      const reopened: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
      expect(reopened.runtimeAffinity(created.workflow_id)).toEqual({
        runtime_id: runtimeId,
        runtime_revision: revision,
      });
      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("keeps exact affinity reads visible across two long-lived WAL connections", () => {
    const { root } = fixture();
    const databasePath = join(root, "same-wal.sqlite");
    const revision = currentHead(root);
    const runtimeId = "a".repeat(64);
    let owner: any;
    let supervisor: any;
    try {
      owner = new WorkflowStore({
        repositoryRoot: root,
        databasePath,
        runtimeId,
        runtimeRevision: revision,
        ...attestation(runtimeId, revision),
      });
      supervisor = new WorkflowStore({
        repositoryRoot: root,
        databasePath,
        runtimeId,
        runtimeRevision: revision,
      });
      const created = create(owner, root, revision, "same WAL owner");
      for (let index = 0; index < 20; index += 1) {
        create(owner, root, revision, `same WAL write ${index}`);
        expect(supervisor.runtimeAffinity(created.workflow_id)).toEqual({
          runtime_id: runtimeId,
          runtime_revision: revision,
        });
        expect(owner.parentGet(created.workflow_id).workflow_id).toBe(created.workflow_id);
      }
      expect(owner.db.prepare("PRAGMA journal_mode").get()).toMatchObject({ journal_mode: "wal" });
      const audit = owner.audit(created.workflow_id);
      expect(audit).toHaveLength(1);
      expect(audit[0].event_type).toBe("WORKFLOW_CREATED");
    } finally {
      owner?.close();
      supervisor?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed with runtime recovery for incomplete persisted affinity", () => {
    const { root } = fixture();
    const path = join(root, "incomplete.sqlite");
    try {
      const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
      const created = create(store, root, currentHead(root), "incomplete runtime");
      const row = store.db
        .prepare("SELECT state_json FROM workflows WHERE workflow_id = ?")
        .get(created.workflow_id) as { state_json: string };
      const state = JSON.parse(row.state_json);
      state.runtime_id = "a".repeat(64);
      state.runtime_revision = null;
      store.db
        .prepare("UPDATE workflows SET state_json = ?, state_digest = ? WHERE workflow_id = ?")
        .run(JSON.stringify(state), objectDigest(state), created.workflow_id);
      store.close();
      assert.throws(
        () => new WorkflowStore({ repositoryRoot: root, databasePath: path }),
        (error: unknown) =>
          error instanceof WorkflowError && error.category === "ERROR_RUNTIME_RECOVERY",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects direct role access without the owning runtime identity", () => {
    const { root } = fixture();
    const path = join(root, "owned.sqlite");
    const revision = currentHead(root);
    const ownerId = "a".repeat(64);
    const foreignId = "b".repeat(64);
    try {
      const owner: any = new WorkflowStore({
        repositoryRoot: root,
        databasePath: path,
        runtimeId: ownerId,
        runtimeRevision: revision,
        ...attestation(ownerId, revision),
      });
      const created = create(owner, root, revision, "owned workflow");
      owner.close();
      const foreign: any = new WorkflowStore({
        repositoryRoot: root,
        databasePath: path,
        runtimeId: foreignId,
        runtimeRevision: revision,
      });
      assert.throws(
        () => foreign.parentGet(created.workflow_id),
        (error: unknown) =>
          error instanceof WorkflowError && error.category === "ERROR_RUNTIME_ISOLATION",
      );
      assert.throws(
        () => foreign.implementerGet(created.workflow_id),
        (error: unknown) =>
          error instanceof WorkflowError && error.category === "ERROR_RUNTIME_ISOLATION",
      );
      foreign.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed for incomplete affinity and cross-repository providers", () => {
    assert.throws(
      () => resolveOwningRuntime(process.cwd(), { runtime_id: null, runtime_revision: null }),
      (error: unknown) =>
        error instanceof WorkflowError && error.category === "ERROR_RUNTIME_RECOVERY",
    );
    const provider = fixture();
    const target = fixture();
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-isolation-cache-"));
    const databaseRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-isolation-db-"));
    try {
      assert.throws(
        () =>
          new RuntimeSupervisor({
            repositoryRoot: target.root,
            providerRoot: provider.root,
            cacheRoot,
            databasePath: join(databaseRoot, "state.sqlite"),
            installDependencies: false,
          }),
        (error: unknown) =>
          error instanceof WorkflowError && error.category === "ERROR_RUNTIME_ISOLATION",
      );
    } finally {
      rmSync(provider.root, { recursive: true, force: true });
      rmSync(target.root, { recursive: true, force: true });
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(databaseRoot, { recursive: true, force: true });
    }
  });

  test("bootstrap rejects a missing trusted provider root before launch", () => {
    const target = fixture();
    try {
      const workflowRoot = join(target.root, ".codex", "workflow-mcp");
      mkdirSync(workflowRoot, { recursive: true });
      cpSync(
        join(process.cwd(), ".codex/workflow-mcp/bootstrap.ts"),
        join(workflowRoot, "bootstrap.ts"),
      );

      let error: unknown;
      try {
        const env = { ...process.env };
        delete env.WORKFLOW_MCP_TRUSTED_PROVIDER_ROOT;
        execFileSync(process.execPath, ["--no-warnings", join(workflowRoot, "bootstrap.ts")], {
          cwd: target.root,
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        assert.fail("expected bootstrap to require a trusted provider root");
      } catch (caught) {
        error = caught;
      }

      assert.equal((error as { status?: number }).status, 1);
      assert.equal(String((error as { stdout?: string | Buffer }).stdout ?? ""), "");
      assert.match(
        String((error as { stderr?: string | Buffer }).stderr ?? ""),
        /WORKFLOW_MCP_TRUSTED_PROVIDER_ROOT is required as the trusted provider root/u,
      );
    } finally {
      rmSync(target.root, { recursive: true, force: true });
    }
  });

  test("bootstrap rejects a provider from a different canonical repository", () => {
    const target = fixture();
    const provider = fixture();
    const workflowSource = join(process.cwd(), ".codex/workflow-mcp");
    try {
      cpSync(workflowSource, join(target.root, ".codex/workflow-mcp"), { recursive: true });
      cpSync(
        join(process.cwd(), ".codex/agents/receipt.ts"),
        join(target.root, ".codex/agents/receipt.ts"),
      );
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", target.root, ...args], { encoding: "utf8" }).trim();
      git("add", ".");
      git("commit", "-qm", "bootstrap target");
      let error: unknown;
      try {
        execFileSync(
          process.execPath,
          ["--no-warnings", join(target.root, ".codex/workflow-mcp/bootstrap.ts")],
          {
            cwd: target.root,
            env: {
              ...process.env,
              WORKFLOW_MCP_TRUSTED_PROVIDER_ROOT: provider.root,
            },
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        assert.fail("expected bootstrap to reject a foreign provider");
      } catch (caught) {
        error = caught;
      }
      assert.match(
        String((error as { stderr?: string | Buffer }).stderr ?? ""),
        /roots do not match/u,
      );
    } finally {
      rmSync(target.root, { recursive: true, force: true });
      rmSync(provider.root, { recursive: true, force: true });
    }
  });

  test("rejects missing, mismatched, and borrowed attestations and recovers tampered artifacts", () => {
    const { root } = fixture();
    const path = join(root, "attestation.sqlite");
    const runtimeId = "a".repeat(64);
    const nonce = "1".repeat(64);
    const key = "2".repeat(64);
    try {
      const workflowSource = join(process.cwd(), ".codex/workflow-mcp");
      cpSync(workflowSource, join(root, ".codex/workflow-mcp"), { recursive: true });
      mkdirSync(join(root, ".codex/agents"), { recursive: true });
      cpSync(
        join(process.cwd(), ".codex/agents/receipt.ts"),
        join(root, ".codex/agents/receipt.ts"),
      );
      writeFileSync(
        join(root, "package.json"),
        '{"name":"runtime-attestation-fixture","type":"module","dependencies":{}}\n',
      );
      writeFileSync(join(root, "bun.lock"), "{}\n");
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
      git("add", ".");
      git("commit", "-qm", "runtime attestation fixture");
      const revision = currentHead(root);
      const createdAttestation = createRuntimeAttestation(runtimeId, revision, nonce, key);
      const owner: any = new WorkflowStore({
        repositoryRoot: root,
        databasePath: path,
        runtimeId,
        runtimeRevision: revision,
        runtimeAttestation: createdAttestation,
        runtimeAttestationNonce: nonce,
        runtimeAttestationKey: key,
      });
      const created = create(owner, root, revision, "attestation matrix");
      owner.close();

      const cases = [
        {
          name: "missing",
          options: { runtimeId, runtimeRevision: revision },
        },
        {
          name: "mismatched",
          options: {
            runtimeId,
            runtimeRevision: revision,
            runtimeAttestation: "0".repeat(64),
            runtimeAttestationNonce: nonce,
            runtimeAttestationKey: key,
          },
        },
        {
          name: "borrowed key",
          options: {
            runtimeId,
            runtimeRevision: revision,
            runtimeAttestation: createRuntimeAttestation(
              runtimeId,
              revision,
              nonce,
              "3".repeat(64),
            ),
            runtimeAttestationNonce: nonce,
            runtimeAttestationKey: key,
          },
        },
      ];
      assert.throws(
        () =>
          new WorkflowStore({
            repositoryRoot: root,
            databasePath: path,
            runtimeId,
            runtimeRevision: revision,
            runtimeAttestation: "malformed",
            runtimeAttestationNonce: nonce,
            runtimeAttestationKey: key,
          }),
        (error: unknown) =>
          error instanceof WorkflowError && error.category === "ERROR_RUNTIME_ISOLATION",
      );
      for (const candidate of cases) {
        const store: any = new WorkflowStore({
          repositoryRoot: root,
          databasePath: path,
          ...candidate.options,
        });
        assert.throws(
          () => store.parentGet(created.workflow_id),
          (error: unknown) =>
            error instanceof WorkflowError && error.category === "ERROR_RUNTIME_ISOLATION",
          candidate.name,
        );
        store.close();
      }

      const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-tamper-cache-"));
      try {
        const artifact = materializeRuntimeArtifact(root, revision, {
          cacheRoot,
          installDependencies: false,
        });
        writeFileSync(
          artifact.runtimePath,
          `${readFileSync(artifact.runtimePath, "utf8")}\n// tampered\n`,
        );
        assert.equal(isValidRuntimeArtifact(artifact), false);
        const recovered = resolveOwningRuntime(
          root,
          { runtime_id: artifact.runtime_id, runtime_revision: revision },
          { cacheRoot, installDependencies: false },
        );
        assert.equal(recovered.runtime_id, artifact.runtime_id);
        assert.equal(recovered.revision, revision);
        assert.equal(isValidRuntimeArtifact(recovered), true);
      } finally {
        rmSync(cacheRoot, { recursive: true, force: true });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  test("requires launch attestation before cross-runtime review start", () => {
    const { root } = fixture();
    const path = join(root, "cross-runtime-review.sqlite");
    const revision = currentHead(root);
    const ownerId = "a".repeat(64);
    const foreignId = "b".repeat(64);
    const nonce = "1".repeat(64);
    const ownerKey = "2".repeat(64);
    try {
      const owner: any = new WorkflowStore({
        repositoryRoot: root,
        databasePath: path,
        runtimeId: ownerId,
        runtimeRevision: revision,
        ...attestation(ownerId, revision),
      });
      const created = create(owner, root, revision, "cross-runtime review attestation");
      owner.close();

      const cases = [
        { name: "missing", options: { runtimeId: foreignId, runtimeRevision: revision } },
        {
          name: "mismatched",
          options: {
            runtimeId: foreignId,
            runtimeRevision: revision,
            runtimeAttestation: "0".repeat(64),
            runtimeAttestationNonce: nonce,
            runtimeAttestationKey: ownerKey,
          },
        },
        {
          name: "borrowed",
          options: {
            runtimeId: foreignId,
            runtimeRevision: revision,
            runtimeAttestation: createRuntimeAttestation(
              foreignId,
              revision,
              nonce,
              "3".repeat(64),
            ),
            runtimeAttestationNonce: nonce,
            runtimeAttestationKey: ownerKey,
          },
        },
      ];
      for (const candidate of cases) {
        const store: any = new WorkflowStore({
          repositoryRoot: root,
          databasePath: path,
          ...candidate.options,
        });
        assert.throws(
          () =>
            store.beginReviewCrossRuntime({
              workflow_id: created.workflow_id,
              expected_version: 0,
            }),
          (error: unknown) =>
            error instanceof WorkflowError && error.category === "ERROR_RUNTIME_ISOLATION",
          candidate.name,
        );
        store.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("routes workflows to their immutable runtime after promotion and restart", async () => {
    const target = fixture();
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-routing-cache-"));
    const databaseRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-routing-db-"));
    const databasePath = join(databaseRoot, "state.sqlite");
    const runtimeModule = pathToFileURL(
      join(process.cwd(), ".codex/workflow-mcp/runtime-supervisor.ts"),
    ).href;
    const fakeServer = `
       import { createInterface } from "node:readline";
       const runtimeLabel = "current";
       createInterface({ input: process.stdin }).on("line", (line) => {
         const request = JSON.parse(line);
         if (request.id === undefined) return;
           const parentView = request.params?.name === "workflow_parent_get" ? {
            content: [{ type: "text", text: JSON.stringify({
              workflow_id: request.params?.arguments?.workflow_id,
              phase: runtimeLabel === "current" ? "COMMITTED" : "COMMIT_PREPARED",
             permitted_next_actions: [],
             runtime_label: runtimeLabel,
           }) }],
         } : {};
         process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
           runtime_id: process.env.WORKFLOW_MCP_RUNTIME_ID,
           runtime_revision: process.env.WORKFLOW_MCP_RUNTIME_REVISION,
           expected_version: request.params?.arguments?.expected_version,
           method: request.method,
           tool: request.params?.name,
           ...parentView,
         } }) + "\\n");
       });
     `;
    const historicalServer = fakeServer.replace(
      'const runtimeLabel = "current";',
      'const runtimeLabel = "historical";',
    );
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", target.root, ...args], { encoding: "utf8" }).trim();
    const writeProvider = () => {
      const workflowRoot = join(target.root, ".codex", "workflow-mcp");
      mkdirSync(workflowRoot, { recursive: true });
      mkdirSync(join(target.root, ".codex", "agents"), { recursive: true });
      writeFileSync(join(workflowRoot, "server.ts"), historicalServer);
      cpSync(
        join(process.cwd(), ".codex/agents/change-receipt.ts"),
        join(target.root, ".codex/agents/change-receipt.ts"),
      );
      cpSync(
        join(process.cwd(), ".codex/agents/receipt.ts"),
        join(target.root, ".codex/agents/receipt.ts"),
      );
      writeFileSync(
        join(target.root, "package.json"),
        '{"name":"runtime-routing-fixture","type":"module","dependencies":{}}\n',
      );
      writeFileSync(join(target.root, "bun.lock"), "{}\n");
    };
    const start = (bunExecutable?: string) => {
      const script = `import { RuntimeSupervisor } from ${JSON.stringify(runtimeModule)}; new RuntimeSupervisor(${JSON.stringify(
        {
          repositoryRoot: target.root,
          providerRoot: target.root,
          databasePath,
          cacheRoot,
          installDependencies: false,
          ...(bunExecutable ? { bunExecutable } : {}),
        },
      )}).run();`;
      const child = spawn(process.execPath, ["--no-warnings", "-e", script], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      const reader = createInterface({ input: child.stdout! });
      const pending = new Map<string | number, (value: any) => void>();
      reader.on("line", (line) => {
        try {
          const response = JSON.parse(line);
          const resolve = response.id === undefined ? undefined : pending.get(response.id);
          if (resolve) {
            pending.delete(response.id);
            resolve(response);
          }
        } catch {
          // malformed child output is not a response for this routing test
        }
      });
      const request = (
        id: number,
        method: string,
        workflowId?: string,
        args: any = {},
        tool?: string,
      ) =>
        new Promise<any>((resolve, reject) => {
          pending.set(id, resolve);
          child.stdin!.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id,
              method,
              ...(workflowId
                ? {
                    params: {
                      ...(tool ? { name: tool } : {}),
                      arguments: { workflow_id: workflowId, ...args },
                    },
                  }
                : {}),
            })}\n`,
            (error) => error && reject(error),
          );
          setTimeout(() => {
            if (pending.delete(id)) reject(new Error(`request ${id} timed out`));
          }, 10_000);
        });
      const stop = async () => {
        reader.close();
        child.stdin!.end();
        await once(child, "close");
      };
      return { child, request, stop };
    };
    let active: ReturnType<typeof start> | undefined;
    let restarted: ReturnType<typeof start> | undefined;
    let secondStore: any;
    try {
      writeProvider();
      git("add", ".");
      git("commit", "-qm", "runtime A");
      const revisionA = currentHead(target.root);
      const artifactA = materializeRuntimeArtifact(target.root, revisionA, {
        cacheRoot,
        installDependencies: false,
      });
      const firstStore: any = new WorkflowStore({
        repositoryRoot: target.root,
        databasePath,
        runtimeId: artifactA.runtime_id,
        runtimeRevision: revisionA,
        ...attestation(artifactA.runtime_id, revisionA),
      });
      const workflowA = create(firstStore, target.root, revisionA, "runtime A");
      const workflowIdA = workflowA.workflow_id;
      writeFileSync(join(target.root, "note.txt"), "prepared on historical runtime\n");
      firstStore.submitImplementation({
        workflow_id: workflowIdA,
        expected_version: 0,
        status: "DONE",
        summary: "implemented",
        agent_touched_paths: ["note.txt"],
        acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "ok" }],
        validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "ok" }],
        known_failures: [],
        finding_resolution_map: {},
      });
      firstStore.beginReview({ workflow_id: workflowIdA, expected_version: 1 });
      firstStore.submitReview({
        workflow_id: workflowIdA,
        expected_version: 2,
        review_status: "APPROVED",
        blocking_findings: [],
        optional_findings: [],
        prior_finding_classifications: {},
      });
      firstStore.authorizeCommit({
        workflow_id: workflowIdA,
        expected_version: 3,
        user_authorization: "authorize historical preparation",
      });
      git("add", "note.txt");
      const preparedA = firstStore.prepareCommit({ workflow_id: workflowIdA, expected_version: 4 });
      firstStore.close();
      active = start();
      assert.equal((await active.request(1, "initialize")).result.runtime_revision, revisionA);
      active.child.stdin!.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      const routedA = await active.request(
        2,
        "tools/call",
        workflowA.workflow_id,
        {},
        "workflow_parent_get",
      );
      assert.equal(routedA.result.runtime_revision, revisionA);
      assert.equal(routedA.result.tool, "workflow_parent_get");
      writeFileSync(join(target.root, ".codex", "workflow-mcp", "server.ts"), fakeServer);
      writeFileSync(join(target.root, "runtime-b.txt"), "B\n");
      git("add", "runtime-b.txt", ".codex/workflow-mcp/server.ts");
      git(
        "commit",
        "-qm",
        "runtime B",
        "--",
        "note.txt",
        "runtime-b.txt",
        ".codex/workflow-mcp/server.ts",
      );
      await active.stop();
      active = undefined;
      const revisionB = currentHead(target.root);
      const artifactB = materializeRuntimeArtifact(target.root, revisionB, {
        cacheRoot,
        installDependencies: false,
      });
      assert.notEqual(artifactB.runtime_id, artifactA.runtime_id);
      assert.notEqual(artifactB.revision, artifactA.revision);
      secondStore = new WorkflowStore({
        repositoryRoot: target.root,
        databasePath,
        runtimeId: artifactB.runtime_id,
        runtimeRevision: revisionB,
        ...attestation(artifactB.runtime_id, revisionB),
      });
      const workflowB = create(secondStore, target.root, revisionB, "runtime B");
      restarted = start();
      assert.equal((await restarted.request(3, "initialize")).result.runtime_revision, revisionB);
      restarted.child.stdin!.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      const routedB = await restarted.request(
        4,
        "tools/call",
        workflowB.workflow_id,
        {},
        "workflow_implementer_get",
      );
      assert.equal(routedB.result.runtime_revision, revisionB);
      assert.equal(routedB.result.tool, "workflow_implementer_get");
      const routedAAfterRestart = await restarted.request(
        5,
        "tools/call",
        workflowA.workflow_id,
        {},
        "workflow_parent_get",
      );
      assert.equal(routedAAfterRestart.result.runtime_revision, revisionA);
      assert.equal(routedAAfterRestart.result.tool, "workflow_parent_get");
      const historicalView = JSON.parse(routedAAfterRestart.result.content[0].text);
      assert.equal(historicalView.runtime_label, "historical");
      assert.deepEqual(historicalView.permitted_next_actions, ["workflow_reconcile_commit_result"]);
      secondStore.reconcileCommitResult({
        workflow_id: workflowIdA,
        expected_version: preparedA.version,
        attempt_id: preparedA.commit_preparation.attempt_id,
      });
      const routedRecovery = await restarted.request(
        6,
        "tools/call",
        workflowA.workflow_id,
        {},
        "workflow_reconcile_commit_result",
      );
      assert.equal(routedRecovery.result.runtime_revision, revisionB);
      assert.equal(routedRecovery.result.tool, "workflow_reconcile_commit_result");
      const routedTerminalParent = await restarted.request(
        7,
        "tools/call",
        workflowIdA,
        {},
        "workflow_parent_get",
      );
      assert.equal(routedTerminalParent.result.runtime_revision, revisionB);
      assert.equal(routedTerminalParent.result.tool, "workflow_parent_get");
      const terminalView = JSON.parse(routedTerminalParent.result.content[0].text);
      assert.equal(terminalView.phase, "COMMITTED");
      const routedTerminalDecision = await restarted.request(
        10,
        "tools/call",
        workflowIdA,
        {},
        "workflow_operator_decision_get",
      );
      assert.equal(routedTerminalDecision.result.runtime_revision, revisionB);
      assert.equal(routedTerminalDecision.result.tool, "workflow_operator_decision_get");
      const routedWorker = await restarted.request(
        8,
        "tools/call",
        workflowIdA,
        {},
        "workflow_implementer_get",
      );
      assert.equal(routedWorker.result.runtime_revision, revisionA);
      assert.equal(routedWorker.result.tool, "workflow_implementer_get");
      const routedAudit = await restarted.request(
        9,
        "tools/call",
        workflowIdA,
        {},
        "workflow_get_audit",
      );
      assert.equal(routedAudit.result.runtime_revision, revisionA);
      assert.equal(routedAudit.result.tool, "workflow_get_audit");
    } finally {
      secondStore?.close();
      await active?.stop().catch(() => {});
      await restarted?.stop().catch(() => {});
      rmSync(target.root, { recursive: true, force: true });
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(dirname(databasePath), { recursive: true, force: true });
    }
  });

  test("recovers dirty adoption through a real historical owner after promotion", async () => {
    const target = fixture();
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-adoption-cache-"));
    const databaseRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-adoption-db-"));
    const databasePath = join(databaseRoot, "state.sqlite");
    const runtimeModule = pathToFileURL(
      join(process.cwd(), ".codex/workflow-mcp/runtime-supervisor.ts"),
    ).href;
    const ownerServer = `
      import { createInterface } from "node:readline";
      import { openStore } from "./store.js";
      const store = openStore();
      const tools = ["workflow_parent_get", "workflow_resume_review", "workflow_begin_review", "workflow_implementer_get"];
      const handlers = {
        workflow_parent_get: (args) => store.parentGet(args.workflow_id),
        workflow_resume_review: (args) => store.resumeReview(args),
        workflow_begin_review: (args) => store.beginReview(args),
        workflow_implementer_get: (args) => store.implementerGet(args.workflow_id),
      };
      createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        if (request.method === "initialize") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
            runtime_id: process.env.WORKFLOW_MCP_RUNTIME_ID,
            runtime_revision: process.env.WORKFLOW_MCP_RUNTIME_REVISION,
          } }) + "\\n");
          return;
        }
        if (request.method === "tools/list") {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: tools.map((name) => ({ name })) } }) + "\\n");
          return;
        }
        const handler = handlers[request.params?.name];
        if (!handler) {
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -1, message: "ERROR_UNKNOWN_TOOL" } }) + "\\n");
          return;
        }
        let value;
        try {
          value = handler(request.params?.arguments ?? {});
        } catch (error) {
          const category = error?.category ?? "ERROR_RUNTIME_RECOVERY";
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -1, message: category, data: { category, detail: error?.detail ?? category } } }) + "\\n");
          return;
        }
        const content = {
          content: [{ type: "text", text: JSON.stringify(value) }],
          tools: tools.map((name) => ({ name })),
          runtime_id: process.env.WORKFLOW_MCP_RUNTIME_ID,
          runtime_revision: process.env.WORKFLOW_MCP_RUNTIME_REVISION,
          expected_version: request.params?.arguments?.expected_version,
          tool: request.params?.name,
        };
        const result = content;
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\\n");
      });
    `;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", target.root, ...args], { encoding: "utf8" }).trim();
    const start = () => {
      const script = `import { RuntimeSupervisor } from ${JSON.stringify(runtimeModule)}; new RuntimeSupervisor(${JSON.stringify(
        {
          repositoryRoot: target.root,
          providerRoot: target.root,
          databasePath,
          cacheRoot,
          installDependencies: true,
        },
      )}).run();`;
      const child = spawn(process.execPath, ["--no-warnings", "-e", script], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr!.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      const reader = createInterface({ input: child.stdout! });
      const pending = new Map<string | number, (value: any) => void>();
      reader.on("line", (line) => {
        try {
          const response = JSON.parse(line);
          const resolve = response.id === undefined ? undefined : pending.get(response.id);
          if (resolve) {
            pending.delete(response.id);
            resolve(response);
          }
        } catch {
          // The fake runtime emits only JSON responses for request assertions.
        }
      });
      const request = (id: number, tool: string, args: any) =>
        new Promise<any>((resolve, reject) => {
          pending.set(id, resolve);
          child.stdin!.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: { name: tool, arguments: args },
            })}\n`,
            (error) => error && reject(error),
          );
          setTimeout(() => {
            if (pending.delete(id)) reject(new Error(`request ${id} timed out`));
          }, 10_000);
        });
      const initialize = () =>
        new Promise<any>((resolve, reject) => {
          pending.set(1, resolve);
          child.stdin!.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n', (error) => {
            if (error) reject(error);
          });
          setTimeout(() => {
            if (pending.delete(1)) reject(new Error("initialize timed out"));
          }, 10_000);
        });
      const stop = async () => {
        reader.close();
        child.stdin!.end();
        await once(child, "close");
      };
      return {
        child,
        initialize,
        request,
        stop,
        get stderr() {
          return stderr;
        },
      };
    };
    let active: ReturnType<typeof start> | undefined;
    let owner: any;
    try {
      const workflowRoot = join(target.root, ".codex", "workflow-mcp");
      cpSync(join(process.cwd(), ".codex/workflow-mcp"), workflowRoot, { recursive: true });
      mkdirSync(join(target.root, ".codex", "agents"), { recursive: true });
      writeFileSync(join(workflowRoot, "server.ts"), ownerServer);
      cpSync(
        join(process.cwd(), ".codex/agents/change-receipt.ts"),
        join(target.root, ".codex/agents/change-receipt.ts"),
      );
      cpSync(
        join(process.cwd(), ".codex/agents/receipt.ts"),
        join(target.root, ".codex/agents/receipt.ts"),
      );
      cpSync(join(process.cwd(), "package.json"), join(target.root, "package.json"));
      cpSync(join(process.cwd(), "bun.lock"), join(target.root, "bun.lock"));
      git("add", ".");
      git("commit", "-qm", "runtime A");
      const revisionA = currentHead(target.root);
      const artifactA = materializeRuntimeArtifact(target.root, revisionA, {
        cacheRoot,
        installDependencies: true,
      });

      writeFileSync(join(target.root, "runtime-b.txt"), "B\n");
      git("add", "runtime-b.txt");
      git("commit", "-qm", "runtime B");
      const revisionB = currentHead(target.root);
      const ownerNonce = "1".repeat(64);
      const ownerKey = readFileSync(artifactA.attestationKeyPath);
      owner = new WorkflowStore({
        repositoryRoot: target.root,
        databasePath,
        runtimeId: artifactA.runtime_id,
        runtimeRevision: revisionA,
        runtimeAttestation: createRuntimeAttestation(
          artifactA.runtime_id,
          revisionA,
          ownerNonce,
          ownerKey,
        ),
        runtimeAttestationNonce: ownerNonce,
        runtimeAttestationKey: ownerKey as any,
      });
      const created = owner.create({
        workflow_type: "change",
        objective: "historical dirty adoption",
        approved_plan: null,
        approved_paths: ["note.txt"],
        acceptance_criteria: ["criterion"],
        validation_requirements: [{ description: "validation", argv: ["bun", "run", "check"] }],
        review_target: {
          review_mode: "working_tree",
          base_revision: revisionB,
          head_revision: null,
          approved_paths: ["note.txt"],
          include_staged: true,
          include_unstaged: true,
          include_untracked: true,
        },
      });
      const id = created.workflow_id;
      owner.expandScope({
        workflow_id: id,
        expected_version: 0,
        added_paths: ["dirty.txt"],
        reason: "planned path",
        user_authorization: "authorized",
      });
      owner.submitImplementation({
        workflow_id: id,
        expected_version: 1,
        status: "DONE",
        summary: "implemented",
        agent_touched_paths: [],
        acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "ok" }],
        validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "ok" }],
        known_failures: [],
        finding_resolution_map: {},
      });
      owner.beginReview({ workflow_id: id, expected_version: 2 });
      owner.submitReview({
        workflow_id: id,
        expected_version: 3,
        review_status: "INCONCLUSIVE",
        blocking_findings: [],
        optional_findings: [],
        prior_finding_classifications: {},
      });
      writeFileSync(join(target.root, "dirty.txt"), "authorized\n");
      owner.close();
      owner = undefined;

      active = start();
      const initialized = await active.initialize();
      assert.ok(initialized.result, `${JSON.stringify(initialized)}\n${active.stderr}`);
      assert.equal(initialized.result.runtime_revision, revisionB);
      active.child.stdin!.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      const routedHistorical = await active.request(2, "workflow_parent_get", {
        workflow_id: id,
      });
      assert.equal(routedHistorical.result.runtime_revision, revisionA);
      assert.equal(routedHistorical.result.tool, "workflow_parent_get");
      assert.equal(
        routedHistorical.result.tools.some(
          (tool: { name: string }) => tool.name === "workflow_adopt_dirty_scope",
        ),
        false,
      );
      const adopted = await active.request(3, "workflow_adopt_dirty_scope", {
        workflow_id: id,
        expected_version: 4,
        adopted_paths: ["dirty.txt"],
        reason: "recover dirty path",
        user_authorization: "explicit recovery",
      });
      const adoptedView = JSON.parse(adopted.result.content[0].text);
      assert.equal(adoptedView.version, 5);
      assert.equal(adoptedView.phase, "STOPPED_INCONCLUSIVE");
      const forwardedResume = await active.request(5, "workflow_resume_review", {
        workflow_id: id,
        expected_version: 5,
        resume_context: "resume after adoption",
      });
      assert.ok(forwardedResume.result, `${JSON.stringify(forwardedResume)}\n${active.stderr}`);
      assert.equal(forwardedResume.result.runtime_revision, revisionA);
      assert.equal(forwardedResume.result.tool, "workflow_resume_review");
      const resumedView = JSON.parse(forwardedResume.result.content[0].text);
      assert.equal(resumedView.version, 6);
      assert.equal(resumedView.phase, "REVIEWING");
      const beganReview = await active.request(6, "workflow_begin_review", {
        workflow_id: id,
        expected_version: 6,
      });
      const reviewView = JSON.parse(beganReview.result.content[0].text);
      assert.equal(reviewView.version, 7);
      assert.equal(reviewView.phase, "REVIEWING");

      owner = new WorkflowStore({
        repositoryRoot: target.root,
        databasePath,
        runtimeId: artifactA.runtime_id,
        runtimeRevision: revisionA,
        runtimeAttestation: createRuntimeAttestation(
          artifactA.runtime_id,
          revisionA,
          ownerNonce,
          ownerKey,
        ),
        runtimeAttestationNonce: ownerNonce,
        runtimeAttestationKey: ownerKey as any,
      });
      const recovered = owner.parentGet(id);
      assert.equal(recovered.phase, "REVIEWING");
      assert.equal(recovered.version, 7);
      assert.deepEqual(owner.runtimeAffinity(id), {
        runtime_id: artifactA.runtime_id,
        runtime_revision: revisionA,
      });
    } finally {
      await active?.stop().catch(() => {});
      owner?.close();
      rmSync(target.root, { recursive: true, force: true });
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(databaseRoot, { recursive: true, force: true });
    }
  }, 30_000);

  test("bootstrap executes committed supervisor source despite dirty checkout launchers", async () => {
    const target = fixture();
    const provider = target.root;
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-bootstrap-cache-"));
    const databasePath = join(
      mkdtempSync(join(tmpdir(), "workflow-bootstrap-db-")),
      "state.sqlite",
    );
    const workflowSource = join(process.cwd(), ".codex/workflow-mcp");
    const server = `
      import { createInterface } from "node:readline";
      createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, label: "committed" }) + "\\n");
      });
    `;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", provider, ...args], { encoding: "utf8" }).trim();
    const bootstrap = join(provider, ".codex/workflow-mcp/bootstrap.ts");
    const supervisor = join(provider, ".codex/workflow-mcp/runtime-supervisor.ts");
    const committedServer = join(provider, ".codex/workflow-mcp/server.ts");
    let child: ReturnType<typeof spawn> | undefined;
    try {
      cpSync(workflowSource, join(provider, ".codex/workflow-mcp"), { recursive: true });
      cpSync(
        join(process.cwd(), ".codex/agents/receipt.ts"),
        join(provider, ".codex/agents/receipt.ts"),
      );
      writeFileSync(committedServer, server);
      writeFileSync(
        join(provider, "package.json"),
        '{"name":"bootstrap-fixture","type":"module","dependencies":{}}\n',
      );
      writeFileSync(join(provider, "bun.lock"), "{}\n");
      git("add", ".");
      git("commit", "-qm", "committed bootstrap");

      writeFileSync(
        bootstrap,
        `${readFileSync(bootstrap, "utf8")}\nprocess.stderr.write("dirty bootstrap\\n");\n`,
      );
      writeFileSync(supervisor, 'process.stderr.write("dirty supervisor\\n");\n');
      writeFileSync(committedServer, `${server}\nprocess.stderr.write("dirty server\\n");\n`);

      const command =
        `bootstrap=$(mktemp) && trap 'rm -f "$bootstrap"' EXIT && ` +
        `git -C ${JSON.stringify(provider)} show HEAD:.codex/workflow-mcp/bootstrap.ts >"$bootstrap" && ` +
        `bun --no-warnings "$bootstrap"`;
      child = spawn("sh", ["-c", command], {
        cwd: provider,
        env: {
          ...process.env,
          WORKFLOW_MCP_TRUSTED_PROVIDER_ROOT: provider,
          WORKFLOW_MCP_DB_PATH: databasePath,
          WORKFLOW_MCP_PROVIDER_ROOT: "/definitely/not-the-provider",
          WORKFLOW_MCP_RUNTIME_CACHE_ROOT: cacheRoot,
          WORKFLOW_MCP_INSTALL_DEPENDENCIES: "0",
        },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const reader = createInterface({ input: child.stdout! });
      let stderr = "";
      child.stderr!.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      const response = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`bootstrap timed out: ${stderr}`)), 15_000);
        reader.on("line", (line) => {
          try {
            const message = JSON.parse(line);
            if (message.id === 1) {
              clearTimeout(timer);
              resolve(message);
            }
          } catch {
            // malformed stdout is checked below by the response assertion
          }
        });
        child!.stdin!.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
      });
      assert.equal((await response).label, "committed");
      assert.equal(stderr.includes("dirty bootstrap"), false);
      assert.equal(stderr.includes("dirty supervisor"), false);
      assert.equal(stderr.includes("dirty server"), false);
      reader.close();
      child.stdin!.end();
      await once(child, "close");
    } finally {
      try {
        child?.kill("SIGKILL");
      } catch {
        // process already exited
      }
      rmSync(target.root, { recursive: true, force: true });
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(dirname(databasePath), { recursive: true, force: true });
    }
  });
});
