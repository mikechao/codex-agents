import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { currentHead } from "../../git.js";
import { materializeRuntimeArtifact } from "../../runtime-artifact.js";
import { RuntimeSupervisor } from "../../runtime-supervisor.js";
import { createRuntimeAttestation, WorkflowStore } from "../../store.js";
import {
  annotateFixtureFailure,
  type FixtureDiagnosticContext,
  fixture,
  fixtureDiagnostic,
} from "../test-fixtures.js";

function runtimeChildContext(
  child: ReturnType<typeof spawn> | undefined,
  role: string,
): FixtureDiagnosticContext["child"] {
  if (!child) return undefined;
  return {
    pid: child.pid,
    role,
    live: child.exitCode === null && child.signalCode === null,
    killed: child.killed,
    exitCode: child.exitCode,
    signalCode: child.signalCode,
  };
}

function runtimeDiagnostic(
  root: string,
  stage: string,
  operation: string,
  child: ReturnType<typeof spawn> | undefined,
  role: string,
  cleanupStarted: boolean,
): string {
  return fixtureDiagnostic(root, {
    stage,
    operation,
    cleanupStarted,
    child: runtimeChildContext(child, role),
  });
}

function removeRuntimeFixture(
  root: string,
  stage: string,
  child: ReturnType<typeof spawn> | undefined,
  role: string,
): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    throw annotateFixtureFailure(error, root, {
      stage,
      operation: "repository removal",
      cleanupStarted: true,
      child: runtimeChildContext(child, role),
    });
  }
}

async function waitForProcessExit(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`process ${pid} remained alive after initialization failure cleanup`);
}

function fixtureHead(root: string, stage: string): string {
  try {
    return currentHead(root);
  } catch (error) {
    throw annotateFixtureFailure(error, root, {
      stage,
      operation: "HEAD-dependent currentHead operation",
      cleanupStarted: false,
    });
  }
}

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
      validation_requirements: [
        { description: "validation", kind: "command", argv: ["bun", "run", "check"] },
      ],
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
           const operatorDecision = request.params?.name === "workflow_operator_decision_get" ? {
             content: [{ type: "text", text: JSON.stringify({
               primary: runtimeLabel === "current" ? {
                 kind: "terminal",
                 outcome: "committed",
                 reason: "the workflow commit is verified and complete",
               } : null,
             }) }],
           } : {};
         process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
           runtime_id: process.env.WORKFLOW_MCP_RUNTIME_ID,
           runtime_revision: process.env.WORKFLOW_MCP_RUNTIME_REVISION,
           expected_version: request.params?.arguments?.expected_version,
           method: request.method,
           tool: request.params?.name,
           ...parentView,
           ...operatorDecision,
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
    const start = (bunExecutable?: string, role = "runtime-routing-child") => {
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
      const closePromise = once(child, "close");
      const reader = createInterface({ input: child.stdout! });
      const pending = new Map<
        string | number,
        {
          resolve: (value: any) => void;
          reject: (error: unknown) => void;
          timeout: ReturnType<typeof setTimeout>;
        }
      >();
      reader.on("line", (line) => {
        try {
          const response = JSON.parse(line);
          const entry = response.id === undefined ? undefined : pending.get(response.id);
          if (entry) {
            clearTimeout(entry.timeout);
            pending.delete(response.id);
            entry.resolve(response);
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
          const timeout = setTimeout(() => {
            if (pending.delete(id)) reject(new Error(`request ${id} timed out`));
          }, 10_000);
          pending.set(id, { resolve, reject, timeout });
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
            (error) => {
              if (!error) return;
              const entry = pending.get(id);
              if (!entry) return;
              clearTimeout(entry.timeout);
              pending.delete(id);
              reject(error);
            },
          );
        });
      const stop = async () => {
        try {
          for (const entry of pending.values()) {
            clearTimeout(entry.timeout);
            entry.reject(new Error("runtime routing child stopped"));
          }
          pending.clear();
          reader.close();
          child.stdin!.end();
          await closePromise;
        } catch (error) {
          throw annotateFixtureFailure(error, target.root, {
            stage: "runtime routing teardown",
            operation: "runtime child shutdown",
            cleanupStarted: true,
            child: runtimeChildContext(child, role),
          });
        }
      };
      return { child, request, stop, role };
    };
    let active: ReturnType<typeof start> | undefined;
    let restarted: ReturnType<typeof start> | undefined;
    let secondStore: any;
    try {
      writeProvider();
      git("add", ".");
      git("commit", "-qm", "runtime A");
      const revisionA = fixtureHead(target.root, "runtime routing revision A");
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
      const revisionB = fixtureHead(target.root, "runtime routing revision B");
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
    } finally {
      secondStore?.close();
      await active?.stop().catch(() => {});
      await restarted?.stop().catch(() => {});
      removeRuntimeFixture(
        target.root,
        "runtime routing fixture teardown",
        restarted?.child ?? active?.child,
        restarted?.role ?? active?.role ?? "runtime-routing-child",
      );
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(dirname(databasePath), { recursive: true, force: true });
    }
  });

  test("terminates a historical child after initialization failure", async () => {
    const target = fixture();
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-init-failure-cache-"));
    const databaseRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-init-failure-db-"));
    const databasePath = join(databaseRoot, "state.sqlite");
    const pidPath = join(target.root, "initialization-child.pid");
    const runtimeModule = pathToFileURL(
      join(process.cwd(), ".codex/workflow-mcp/runtime-supervisor.ts"),
    ).href;
    const failingServer = `
      import { appendFileSync } from "node:fs";
      import { createInterface } from "node:readline";
      const pidPath = process.env.WORKFLOW_MCP_INIT_FAILURE_PID_FILE;
      if (pidPath) appendFileSync(pidPath, String(process.pid) + "\\n");
      createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        if (request.method === "initialize") {
          process.stdout.write(JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32001, message: "initialization failed" },
          }) + "\\n");
        }
      });
    `;
    const healthyServer = `
      import { createInterface } from "node:readline";
      createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        process.stdout.write(JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          result: {
            runtime_id: process.env.WORKFLOW_MCP_RUNTIME_ID,
            runtime_revision: process.env.WORKFLOW_MCP_RUNTIME_REVISION,
          },
        }) + "\\n");
      });
    `;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", target.root, ...args], { encoding: "utf8" }).trim();
    const writeRuntimeFiles = (server: string) => {
      const workflowRoot = join(target.root, ".codex", "workflow-mcp");
      mkdirSync(workflowRoot, { recursive: true });
      mkdirSync(join(target.root, ".codex", "agents"), { recursive: true });
      writeFileSync(join(workflowRoot, "server.ts"), server);
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
        '{"name":"runtime-init-failure-fixture","type":"module","dependencies":{}}\n',
      );
      writeFileSync(join(target.root, "bun.lock"), "{}\n");
    };
    const start = () => {
      const script = `import { RuntimeSupervisor } from ${JSON.stringify(runtimeModule)}; new RuntimeSupervisor(${JSON.stringify(
        {
          repositoryRoot: target.root,
          providerRoot: target.root,
          databasePath,
          cacheRoot,
          installDependencies: false,
        },
      )}).run();`;
      const child = spawn(process.execPath, ["--no-warnings", "-e", script], {
        env: { ...process.env, WORKFLOW_MCP_INIT_FAILURE_PID_FILE: pidPath },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const closePromise = once(child, "close");
      const reader = createInterface({ input: child.stdout! });
      const pending = new Map<
        string | number,
        {
          resolve: (value: any) => void;
          reject: (error: unknown) => void;
          timeout: ReturnType<typeof setTimeout>;
        }
      >();
      reader.on("line", (line) => {
        try {
          const response = JSON.parse(line);
          const entry = response.id === undefined ? undefined : pending.get(response.id);
          if (entry) {
            clearTimeout(entry.timeout);
            pending.delete(response.id);
            entry.resolve(response);
          }
        } catch {
          // Only JSON-RPC responses are relevant to this process-lifecycle assertion.
        }
      });
      const request = (message: Record<string, unknown>) =>
        new Promise<any>((resolve, reject) => {
          const id = message.id as string | number;
          const timeout = setTimeout(() => {
            if (pending.delete(id)) reject(new Error(`request ${id} timed out`));
          }, 10_000);
          pending.set(id, { resolve, reject, timeout });
          child.stdin!.write(`${JSON.stringify(message)}\n`, (error) => {
            if (!error) return;
            const entry = pending.get(id);
            if (!entry) return;
            clearTimeout(entry.timeout);
            pending.delete(id);
            reject(error);
          });
        });
      const stop = async () => {
        for (const entry of pending.values()) {
          clearTimeout(entry.timeout);
          entry.reject(new Error("runtime initialization-failure child stopped"));
        }
        pending.clear();
        reader.close();
        child.stdin!.end();
        await closePromise;
      };
      return { child, request, stop };
    };
    let owner: WorkflowStore | undefined;
    let active: ReturnType<typeof start> | undefined;
    let historicalPid: number | undefined;
    try {
      writeRuntimeFiles(failingServer);
      git("add", ".");
      git("commit", "-qm", "runtime A");
      const revisionA = fixtureHead(target.root, "runtime initialization failure revision A");
      const artifactA = materializeRuntimeArtifact(target.root, revisionA, {
        cacheRoot,
        installDependencies: false,
      });
      writeFileSync(join(target.root, ".codex", "workflow-mcp", "server.ts"), healthyServer);
      git("add", ".codex/workflow-mcp/server.ts");
      git("commit", "-qm", "runtime B");
      const revisionB = fixtureHead(target.root, "runtime initialization failure revision B");
      const ownerKey = readFileSync(artifactA.attestationKeyPath);
      const ownerNonce = "1".repeat(64);
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
      const workflow = create(owner, target.root, revisionB, "historical initialization failure");
      owner.close();
      owner = undefined;

      active = start();
      const initialized = await active.request({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
      });
      assert.ok(initialized.result);
      active.child.stdin!.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      const failed = await active.request({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "workflow_parent_get", arguments: { workflow_id: workflow.workflow_id } },
      });
      assert.equal(failed.error?.data?.category, "ERROR_RUNTIME_RECOVERY");
      historicalPid = Number(readFileSync(pidPath, "utf8").trim());
      assert.ok(Number.isInteger(historicalPid) && historicalPid > 0);
      await waitForProcessExit(historicalPid);
    } finally {
      if (historicalPid === undefined) {
        try {
          const candidate = Number(readFileSync(pidPath, "utf8").trim());
          if (Number.isInteger(candidate) && candidate > 0) historicalPid = candidate;
        } catch {
          // The historical child may not have started before an earlier assertion failed.
        }
      }
      if (historicalPid !== undefined) {
        try {
          process.kill(historicalPid, "SIGKILL");
        } catch {
          // The regression assertion already confirmed the child exited.
        }
      }
      await active?.stop().catch(() => {});
      owner?.close();
      removeRuntimeFixture(
        target.root,
        "runtime initialization failure fixture teardown",
        active?.child,
        "runtime-initialization-failure-child",
      );
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(databaseRoot, { recursive: true, force: true });
    }
  }, 60_000);

  test("shutdown rejects pending initialization before terminating its child", async () => {
    const target = fixture();
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-shutdown-cache-"));
    const databaseRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-shutdown-db-"));
    const databasePath = join(databaseRoot, "state.sqlite");
    const server = `
      import { createInterface } from "node:readline";
      createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        if (request.id === undefined || request.method !== "initialize") return;
        // Hold initialization open until the supervisor performs shutdown cleanup.
      });
    `;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", target.root, ...args], { encoding: "utf8" }).trim();
    const workflowRoot = join(target.root, ".codex", "workflow-mcp");
    let supervisor: RuntimeSupervisor | undefined;
    let child: any;
    try {
      mkdirSync(workflowRoot, { recursive: true });
      mkdirSync(join(target.root, ".codex", "agents"), { recursive: true });
      writeFileSync(join(workflowRoot, "server.ts"), server);
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
        '{"name":"runtime-shutdown-fixture","type":"module","dependencies":{}}\n',
      );
      writeFileSync(join(target.root, "bun.lock"), "{}\n");
      git("add", ".");
      git("commit", "-qm", "runtime shutdown");

      supervisor = new RuntimeSupervisor({
        repositoryRoot: target.root,
        providerRoot: target.root,
        databasePath,
        cacheRoot,
        installDependencies: false,
      });
      const internal = supervisor as any;
      child = internal.launch(supervisor.defaultRuntime);
      const key = `${supervisor.defaultRuntime.runtime_id}\u0000${supervisor.defaultRuntime.revision}`;
      internal.children.set(key, child);
      internal.initialized = true;
      internal.initializationLines = [
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      ];
      const childClosed = once(child.process, "close");
      const initializing = internal.initializeOwner(child);
      supervisor.close();
      supervisor = undefined;
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<never>((_, reject) => {
          deadlineTimer = setTimeout(
            () => reject(new Error("runtime shutdown exceeded the prompt cleanup deadline")),
            2_000,
          );
        });
        const [initializationOutcome, processOutcome] = await Promise.race([
          Promise.all([
            initializing.then(
              () => "resolved",
              () => "rejected",
            ),
            childClosed.then(() => "closed"),
          ]),
          deadline,
        ]);
        assert.equal(initializationOutcome, "rejected");
        assert.equal(processOutcome, "closed");
      } finally {
        if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      }
    } finally {
      child?.initReject?.(new Error("runtime shutdown fixture cleanup"));
      supervisor?.close();
      try {
        child?.process.kill("SIGKILL");
      } catch {
        // The child was already terminated by supervisor shutdown.
      }
      removeRuntimeFixture(
        target.root,
        "runtime shutdown fixture teardown",
        child?.process,
        "runtime-shutdown-child",
      );
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(databaseRoot, { recursive: true, force: true });
    }
  }, 60_000);

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
        try {
          const value = handler(request.params?.arguments ?? {});
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {
            content: [{ type: "text", text: JSON.stringify(value) }],
            tools: tools.map((name) => ({ name })),
            runtime_id: process.env.WORKFLOW_MCP_RUNTIME_ID,
            runtime_revision: process.env.WORKFLOW_MCP_RUNTIME_REVISION,
            tool: request.params?.name,
          } }) + "\\n");
        } catch (error) {
          const category = error?.category ?? "ERROR_RUNTIME_RECOVERY";
          const detail = error?.detail ?? category;
          process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: {
            code: -1,
            message: category,
            data: { category, detail },
          } }) + "\\n");
        }
      });
      process.stdin.on("close", () => store.close());
    `;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", target.root, ...args], { encoding: "utf8" }).trim();
    const start = (role = "runtime-adoption-child") => {
      const script = `import { RuntimeSupervisor } from ${JSON.stringify(runtimeModule)}; new RuntimeSupervisor(${JSON.stringify(
        {
          repositoryRoot: target.root,
          providerRoot: target.root,
          databasePath,
          cacheRoot,
          installDependencies: false,
        },
      )}).run();`;
      const nodePath = [join(process.cwd(), "node_modules"), process.env.NODE_PATH]
        .filter((value): value is string => Boolean(value))
        .join(delimiter);
      const child = spawn(process.execPath, ["--no-warnings", "-e", script], {
        env: { ...process.env, NODE_PATH: nodePath },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const closePromise = once(child, "close");
      let stderr = "";
      child.stderr!.on("data", (chunk) => {
        stderr = `${stderr}${chunk.toString()}`.slice(0, 4_000);
      });
      const reader = createInterface({ input: child.stdout! });
      const pending = new Map<
        string | number,
        {
          resolve: (value: any) => void;
          reject: (error: unknown) => void;
          timeout: ReturnType<typeof setTimeout>;
        }
      >();
      reader.on("line", (line) => {
        try {
          const response = JSON.parse(line);
          const entry = response.id === undefined ? undefined : pending.get(response.id);
          if (entry) {
            clearTimeout(entry.timeout);
            pending.delete(response.id);
            entry.resolve(response);
          }
        } catch {
          // The fake runtime emits only JSON responses for request assertions.
        }
      });
      const request = (id: number, tool: string, args: any) =>
        new Promise<any>((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (pending.delete(id)) reject(new Error(`request ${id} timed out`));
          }, 10_000);
          pending.set(id, { resolve, reject, timeout });
          child.stdin!.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id,
              method: "tools/call",
              params: { name: tool, arguments: args },
            })}\n`,
            (error) => {
              if (!error) return;
              const entry = pending.get(id);
              if (!entry) return;
              clearTimeout(entry.timeout);
              pending.delete(id);
              reject(error);
            },
          );
        });
      const initialize = () =>
        new Promise<any>((resolve, reject) => {
          const timeout = setTimeout(() => {
            if (pending.delete(1)) reject(new Error("initialize timed out"));
          }, 10_000);
          pending.set(1, { resolve, reject, timeout });
          child.stdin!.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n', (error) => {
            if (!error) return;
            const entry = pending.get(1);
            if (!entry) return;
            clearTimeout(entry.timeout);
            pending.delete(1);
            reject(error);
          });
        });
      const stop = async () => {
        try {
          for (const entry of pending.values()) {
            clearTimeout(entry.timeout);
            entry.reject(new Error("runtime adoption child stopped"));
          }
          pending.clear();
          reader.close();
          child.stdin!.end();
          await closePromise;
        } catch (error) {
          throw annotateFixtureFailure(error, target.root, {
            stage: "runtime adoption teardown",
            operation: "runtime child shutdown",
            cleanupStarted: true,
            child: runtimeChildContext(child, role),
          });
        }
      };
      return {
        child,
        initialize,
        request,
        stop,
        role,
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
      writeFileSync(
        join(target.root, "package.json"),
        '{"name":"runtime-adoption-fixture","type":"module","dependencies":{}}\n',
      );
      writeFileSync(join(target.root, "bun.lock"), "{}\n");
      git("add", ".");
      git("commit", "-qm", "runtime A");
      const revisionA = fixtureHead(target.root, "runtime adoption revision A");
      const artifactA = materializeRuntimeArtifact(target.root, revisionA, {
        cacheRoot,
        installDependencies: false,
      });

      writeFileSync(join(target.root, "runtime-b.txt"), "B\n");
      git("add", "runtime-b.txt");
      git("commit", "-qm", "runtime B");
      const revisionB = fixtureHead(target.root, "runtime adoption revision B");
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
        validation_requirements: [
          { description: "validation", kind: "command", argv: ["bun", "run", "check"] },
        ],
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
      assert.ok(
        initialized.result,
        `${JSON.stringify(initialized)}\n${active.stderr}\n${runtimeDiagnostic(
          target.root,
          "runtime adoption request",
          "initialize owning runtime",
          active.child,
          active.role,
          false,
        )}`,
      );
      assert.equal(initialized.result.runtime_revision, revisionB);
      assert.equal(initialized.result.runtime_id, artifactA.runtime_id);
      assert.notEqual(initialized.result.runtime_revision, revisionA);
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
      assert.ok(adopted.result);
      const forwardedResume = await active.request(5, "workflow_resume_review", {
        workflow_id: id,
        expected_version: 5,
        resume_context: "resume after adoption",
      });
      assert.ok(
        forwardedResume.result,
        `${JSON.stringify(forwardedResume)}\n${active.stderr}\n${runtimeDiagnostic(
          target.root,
          "runtime adoption request",
          "resume historical review",
          active.child,
          active.role,
          false,
        )}`,
      );
      assert.equal(forwardedResume.result.runtime_revision, revisionA);
      assert.equal(forwardedResume.result.tool, "workflow_resume_review");
      const resumedView = JSON.parse(forwardedResume.result.content[0].text);
      assert.equal(resumedView.workflow_id, id);
      assert.equal(resumedView.version, 6);
      assert.equal(resumedView.phase, "REVIEWING");
    } finally {
      await active?.stop().catch(() => {});
      owner?.close();
      removeRuntimeFixture(
        target.root,
        "runtime adoption fixture teardown",
        active?.child,
        active?.role ?? "runtime-adoption-child",
      );
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(databaseRoot, { recursive: true, force: true });
    }
  }, 60_000);

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
      const closePromise = once(child, "close");
      const reader = createInterface({ input: child.stdout! });
      let stderr = "";
      child.stderr!.on("data", (chunk) => {
        stderr = `${stderr}${chunk.toString()}`.slice(0, 4_000);
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
      await closePromise;
    } finally {
      try {
        child?.kill("SIGKILL");
      } catch {
        // process already exited
      }
      removeRuntimeFixture(target.root, "bootstrap fixture teardown", child, "bootstrap child");
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(dirname(databasePath), { recursive: true, force: true });
    }
  });
});
