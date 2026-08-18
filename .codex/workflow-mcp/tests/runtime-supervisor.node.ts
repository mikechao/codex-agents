import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { WorkflowError } from "../errors.js";
import { currentHead } from "../git.js";
import { materializeRuntimeArtifact } from "../runtime-artifact.js";
import { RuntimeSupervisor, resolveOwningRuntime } from "../runtime-supervisor.js";
import { WorkflowStore } from "../store.js";
import { objectDigest } from "../validation.js";
import { fixture } from "./test-fixtures.js";

describe("Workflow MCP runtime supervision", () => {
  test("persists immutable runtime affinity and keeps it across reopen", () => {
    const { root } = fixture();
    const databaseRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-state-"));
    const databasePath = join(databaseRoot, "state.sqlite");
    const revision = currentHead(root);
    const runtimeId = "a".repeat(64);
    try {
      const first = new WorkflowStore({
        repositoryRoot: root,
        databasePath,
        runtimeId,
        runtimeRevision: revision,
      });
      const created = first.create({
        workflow_type: "change",
        objective: "runtime affinity",
        approved_paths: ["note.txt"],
        acceptance_criteria: ["criterion"],
        validation_requirements: ["validation"],
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
      expect(first.runtimeAffinity(created.workflow.workflow_id)).toEqual({
        runtime_id: runtimeId,
        runtime_revision: revision,
      });
      first.close();

      const reopened = new WorkflowStore({ repositoryRoot: root, databasePath });
      expect(reopened.runtimeAffinity(created.workflow.workflow_id)).toEqual({
        runtime_id: runtimeId,
        runtime_revision: revision,
      });
      reopened.close();
    } finally {
      rmSync(databaseRoot, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fails closed with runtime recovery for incomplete persisted affinity", () => {
    const { root } = fixture();
    const databasePath = join(root, "incomplete-runtime.sqlite");
    try {
      const store: any = new WorkflowStore({ repositoryRoot: root, databasePath });
      const created = store.create({
        workflow_type: "change",
        objective: "incomplete runtime",
        approved_paths: ["note.txt"],
        acceptance_criteria: ["criterion"],
        validation_requirements: ["validation"],
        review_target: {
          review_mode: "working_tree",
          base_revision: currentHead(root),
          head_revision: null,
          approved_paths: ["note.txt"],
          include_staged: true,
          include_unstaged: true,
          include_untracked: true,
        },
      });
      const row = store.db
        .prepare("SELECT state_json FROM workflows WHERE workflow_id = ?")
        .get(created.workflow.workflow_id) as { state_json: string };
      const state = JSON.parse(row.state_json);
      state.runtime_id = "a".repeat(64);
      state.runtime_revision = null;
      store.db
        .prepare("UPDATE workflows SET state_json = ?, state_digest = ? WHERE workflow_id = ?")
        .run(JSON.stringify(state), objectDigest(state), created.workflow.workflow_id);
      store.close();
      assert.throws(
        () => new WorkflowStore({ repositoryRoot: root, databasePath }),
        (error: unknown) =>
          error instanceof WorkflowError && error.category === "ERROR_RUNTIME_RECOVERY",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects direct server access without the owning runtime identity", async () => {
    const target = fixture();
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-direct-cache-"));
    const databaseRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-direct-db-"));
    const databasePath = join(databaseRoot, "state.sqlite");
    const runtimeServer = join(process.cwd(), ".codex/workflow-mcp/server.ts");
    const runtimeSupervisor = pathToFileURL(
      join(process.cwd(), ".codex/workflow-mcp/runtime-supervisor.ts"),
    ).href;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", target.root, ...args], { encoding: "utf8" }).trim();
    const connect = async (
      command: string,
      args: string[],
      env: Record<string, string | undefined>,
    ) => {
      const transport = new StdioClientTransport({
        command,
        args,
        cwd: target.root,
        env: Object.fromEntries(
          Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
        ),
        stderr: "pipe",
      });
      const client = new Client({ name: "runtime-ownership-test", version: "1.0.0" }, {});
      await client.connect(transport);
      return client;
    };
    const readTool = async (client: Client, name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: args });
      const body = JSON.parse((result.content[0] as { text: string }).text) as Record<string, any>;
      return { result, body };
    };
    const implementationArgs = (workflowId: string, capability: string) => ({
      workflow_id: workflowId,
      capability,
      expected_version: 0,
      status: "DONE",
      summary: "must be rejected",
      agent_touched_paths: [],
      acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "x" }],
      validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "x" }],
      known_failures: [],
      finding_resolution_map: {},
    });
    const writeProvider = () => {
      mkdirSync(join(target.root, ".codex", "workflow-mcp"), { recursive: true });
      mkdirSync(join(target.root, ".codex", "agents"), { recursive: true });
      writeFileSync(
        join(target.root, ".codex/workflow-mcp/server.ts"),
        `import { main } from ${JSON.stringify(pathToFileURL(runtimeServer).href)}; main(); export { main };\n`,
      );
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
        '{"name":"runtime-direct-fixture","type":"module","dependencies":{}}\n',
      );
      writeFileSync(join(target.root, "bun.lock"), "{}\n");
      git("add", ".");
      git("commit", "-qm", "runtime owner fixture");
    };
    let supervisor: Client | undefined;
    let missing: Client | undefined;
    let mismatched: Client | undefined;
    const supervisorScript = `import { RuntimeSupervisor } from ${JSON.stringify(runtimeSupervisor)}; new RuntimeSupervisor(${JSON.stringify({ repositoryRoot: target.root, providerRoot: target.root, databasePath, cacheRoot, installDependencies: false })}).run();`;
    try {
      writeProvider();
      const revision = currentHead(target.root);
      const artifact = materializeRuntimeArtifact(target.root, revision, {
        cacheRoot,
        installDependencies: false,
      });
      const supervisorEnv = {
        ...process.env,
        WORKFLOW_MCP_DB_PATH: databasePath,
        WORKFLOW_MCP_RUNTIME_CACHE_ROOT: cacheRoot,
        WORKFLOW_MCP_INSTALL_DEPENDENCIES: "0",
      };
      supervisor = await connect(
        process.execPath,
        ["--no-warnings", "-e", supervisorScript],
        supervisorEnv,
      );
      const createdCall = await readTool(supervisor, "workflow_create", {
        workflow_type: "change",
        objective: "supervised runtime ownership",
        approved_paths: ["note.txt"],
        acceptance_criteria: ["criterion"],
        validation_requirements: ["validation"],
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
      assert.equal(createdCall.result.isError, undefined);
      const workflowId = createdCall.body.workflow.workflow_id as string;
      const capabilities = createdCall.body.capabilities as Record<string, string>;
      assert.equal(artifact.runtime_id.length, 64);

      const directBaseEnv: Record<string, string | undefined> = {
        ...process.env,
        WORKFLOW_MCP_DB_PATH: databasePath,
      };
      delete directBaseEnv.WORKFLOW_MCP_RUNTIME_ID;
      delete directBaseEnv.WORKFLOW_MCP_RUNTIME_REVISION;
      missing = await connect(process.execPath, ["--no-warnings", runtimeServer], directBaseEnv);
      for (const [name, args] of [
        [
          "workflow_get",
          { workflow_id: workflowId, role: "parent", capability: capabilities.parent },
        ],
        [
          "workflow_submit_implementation",
          implementationArgs(workflowId, capabilities.implementer),
        ],
      ] as Array<[string, Record<string, unknown>]>) {
        const rejected = await readTool(missing, name, args);
        assert.equal(rejected.result.isError, true);
        assert.equal(rejected.body.category, "ERROR_RUNTIME_ISOLATION");
      }
      await missing.close();
      missing = undefined;

      mismatched = await connect(process.execPath, ["--no-warnings", runtimeServer], {
        ...directBaseEnv,
        WORKFLOW_MCP_RUNTIME_ID: "b".repeat(64),
        WORKFLOW_MCP_RUNTIME_REVISION: revision,
      });
      for (const [name, args] of [
        [
          "workflow_get",
          { workflow_id: workflowId, role: "parent", capability: capabilities.parent },
        ],
        [
          "workflow_submit_implementation",
          implementationArgs(workflowId, capabilities.implementer),
        ],
      ] as Array<[string, Record<string, unknown>]>) {
        const rejected = await readTool(mismatched, name, args);
        assert.equal(rejected.result.isError, true);
        assert.equal(rejected.body.category, "ERROR_RUNTIME_ISOLATION");
      }
      await mismatched.close();
      mismatched = undefined;
      await supervisor.close();
      supervisor = undefined;

      supervisor = await connect(
        process.execPath,
        ["--no-warnings", "-e", supervisorScript],
        supervisorEnv,
      );
      const recovered = await readTool(supervisor, "workflow_get", {
        workflow_id: workflowId,
        role: "parent",
        capability: capabilities.parent,
      });
      assert.equal(recovered.result.isError, undefined);
      assert.equal(recovered.body.workflow_id, workflowId);
    } finally {
      await missing?.close().catch(() => {});
      await mismatched?.close().catch(() => {});
      await supervisor?.close().catch(() => {});
      rmSync(target.root, { recursive: true, force: true });
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(databaseRoot, { recursive: true, force: true });
    }
  });

  test("routes an A workflow back to A after promotion to B and restart", async () => {
    const target = fixture();
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-cache-"));
    const databasePath = join(mkdtempSync(join(tmpdir(), "workflow-runtime-db-")), "state.sqlite");
    const runtimeModule = pathToFileURL(
      join(process.cwd(), ".codex/workflow-mcp/runtime-supervisor.ts"),
    ).href;
    const server = `
      import { createInterface } from "node:readline";
      createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { runtime_id: process.env.WORKFLOW_MCP_RUNTIME_ID, runtime_revision: process.env.WORKFLOW_MCP_RUNTIME_REVISION, expected_version: request.params?.arguments?.expected_version, method: request.method } }) + "\\n");
      });
    `;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", target.root, ...args], { encoding: "utf8" }).trim();
    const writeProvider = () => {
      mkdirSync(join(target.root, ".codex", "workflow-mcp"), { recursive: true });
      mkdirSync(join(target.root, ".codex", "agents"), { recursive: true });
      writeFileSync(join(target.root, ".codex/workflow-mcp/server.ts"), server);
      cpSync(
        join(process.cwd(), ".codex/agents/change-receipt.ts"),
        join(target.root, ".codex/agents/change-receipt.ts"),
      );
      cpSync(
        join(process.cwd(), ".codex/agents/change-receipt.ts"),
        join(target.root, ".codex/agents/receipt.ts"),
      );
      writeFileSync(
        join(target.root, "package.json"),
        '{"name":"runtime-fixture","type":"module","dependencies":{}}\n',
      );
      writeFileSync(join(target.root, "bun.lock"), "{}\n");
    };
    const start = (bunExecutable?: string) => {
      const script = `import { RuntimeSupervisor } from ${JSON.stringify(runtimeModule)};
        new RuntimeSupervisor(${JSON.stringify({
          repositoryRoot: target.root,
          providerRoot: target.root,
          databasePath,
          cacheRoot,
          installDependencies: false,
          ...(bunExecutable ? { bunExecutable } : {}),
        })}).run();`;
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
          // A malformed child line is not a response for this protocol test.
        }
      });
      const request = (
        id: number,
        method: string,
        workflowId?: string,
        arguments_: Record<string, unknown> = {},
      ) =>
        new Promise<any>((resolve, reject) => {
          pending.set(id, resolve);
          child.stdin!.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id,
              method,
              ...(workflowId
                ? { params: { arguments: { workflow_id: workflowId, ...arguments_ } } }
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
        await new Promise<void>((resolve) => child.once("close", () => resolve()));
      };
      return { child, request, stop };
    };

    try {
      writeProvider();
      git("add", ".");
      git("commit", "-qm", "runtime A");
      const revisionA = currentHead(target.root);
      const artifactA = materializeRuntimeArtifact(target.root, revisionA, {
        cacheRoot,
        installDependencies: false,
      });
      const firstStore = new WorkflowStore({
        repositoryRoot: target.root,
        databasePath,
        runtimeId: artifactA.runtime_id,
        runtimeRevision: revisionA,
      });
      const workflowA = firstStore.create({
        workflow_type: "change",
        objective: "runtime A",
        approved_paths: ["note.txt"],
        acceptance_criteria: ["criterion"],
        validation_requirements: ["validation"],
        review_target: {
          review_mode: "working_tree",
          base_revision: currentHead(target.root),
          head_revision: null,
          approved_paths: ["note.txt"],
          include_staged: true,
          include_unstaged: true,
          include_untracked: true,
        },
      });
      firstStore.close();
      const legacyStore = new WorkflowStore({ repositoryRoot: target.root, databasePath });
      const legacyWorkflow = legacyStore.create({
        workflow_type: "change",
        objective: "pre-affinity workflow",
        approved_paths: ["note.txt"],
        acceptance_criteria: ["criterion"],
        validation_requirements: ["validation"],
        review_target: {
          review_mode: "working_tree",
          base_revision: currentHead(target.root),
          head_revision: null,
          approved_paths: ["note.txt"],
          include_staged: true,
          include_unstaged: true,
          include_untracked: true,
        },
      });
      const firstUseWorkflow = legacyStore.create({
        workflow_type: "change",
        objective: "first-use mutation workflow",
        approved_paths: ["note.txt"],
        acceptance_criteria: ["criterion"],
        validation_requirements: ["validation"],
        review_target: {
          review_mode: "working_tree",
          base_revision: currentHead(target.root),
          head_revision: null,
          approved_paths: ["note.txt"],
          include_staged: true,
          include_unstaged: true,
          include_untracked: true,
        },
      });
      legacyStore.close();
      const active = start();
      assert.equal((await active.request(10, "initialize")).result.runtime_revision, revisionA);
      active.child.stdin!.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      assert.equal(
        (await active.request(11, "workflow_get", workflowA.workflow.workflow_id!)).result
          .runtime_revision,
        revisionA,
      );
      assert.equal(
        (
          await active.request(
            13,
            "workflow_submit_implementation",
            firstUseWorkflow.workflow.workflow_id!,
            {
              capability: firstUseWorkflow.capabilities.implementer,
              expected_version: 0,
            },
          )
        ).result.expected_version,
        1,
      );
      writeFileSync(join(target.root, "unrelated-runtime-change.txt"), "B\n");
      git("add", ".");
      git("commit", "-qm", "runtime B");
      assert.equal(
        (await active.request(12, "workflow_get", workflowA.workflow.workflow_id!)).result
          .runtime_revision,
        revisionA,
      );
      await active.stop();
      const revisionB = currentHead(target.root);
      const artifactB = materializeRuntimeArtifact(target.root, revisionB, {
        cacheRoot,
        installDependencies: false,
      });
      const secondStore = new WorkflowStore({
        repositoryRoot: target.root,
        databasePath,
        runtimeId: artifactB.runtime_id,
        runtimeRevision: revisionB,
      });
      const workflowB = secondStore.create({
        workflow_type: "change",
        objective: "runtime B",
        approved_paths: ["note.txt"],
        acceptance_criteria: ["criterion"],
        validation_requirements: ["validation"],
        review_target: {
          review_mode: "working_tree",
          base_revision: currentHead(target.root),
          head_revision: null,
          approved_paths: ["note.txt"],
          include_staged: true,
          include_unstaged: true,
          include_untracked: true,
        },
      });
      secondStore.close();

      const supervisor = start();
      assert.equal((await supervisor.request(1, "initialize")).result.runtime_revision, revisionB);
      supervisor.child.stdin!.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      assert.equal(
        (await supervisor.request(2, "workflow_get", workflowB.workflow.workflow_id!)).result
          .runtime_revision,
        revisionB,
      );
      assert.equal(
        (await supervisor.request(4, "workflow_get", legacyWorkflow.workflow.workflow_id!)).result
          .runtime_revision,
        revisionB,
      );
      assert.equal(
        (await supervisor.request(3, "workflow_get", workflowA.workflow.workflow_id!)).result
          .runtime_revision,
        revisionA,
      );
      assert.equal(
        (await supervisor.request(5, "workflow_get", firstUseWorkflow.workflow.workflow_id!)).result
          .runtime_revision,
        revisionA,
      );
      await supervisor.stop();
      const adopted = new WorkflowStore({ repositoryRoot: target.root, databasePath });
      assert.deepEqual(adopted.runtimeAffinity(legacyWorkflow.workflow.workflow_id!), {
        runtime_id: artifactB.runtime_id,
        runtime_revision: revisionB,
      });
      adopted.close();

      const failed = start("/definitely/missing/workflow-bun");
      const failure = await failed.request(4, "initialize");
      assert.equal(failure.error.data.category, "ERROR_RUNTIME_RECOVERY");
      await failed.stop();
    } finally {
      rmSync(target.root, { recursive: true, force: true });
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(dirname(databasePath), { recursive: true, force: true });
    }
  });

  test("bootstrap executes committed supervisor source despite dirty launcher and supervisor files", async () => {
    const target = fixture();
    const provider = target.root;
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-bootstrap-cache-"));
    const databasePath = join(
      mkdtempSync(join(tmpdir(), "workflow-bootstrap-db-")),
      "state.sqlite",
    );
    const workflowSource = join(process.cwd(), ".codex/workflow-mcp");
    const agentsSource = join(process.cwd(), ".codex/agents");
    const server = `
      import { createInterface } from "node:readline";
      createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, label: "committed", runtime_id: process.env.WORKFLOW_MCP_RUNTIME_ID }) + "\\n");
      });
    `;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", provider, ...args], { encoding: "utf8" }).trim();
    const bootstrap = join(provider, ".codex/workflow-mcp/bootstrap.ts");
    const supervisor = join(provider, ".codex/workflow-mcp/runtime-supervisor.ts");
    const committedServer = join(provider, ".codex/workflow-mcp/server.ts");
    try {
      cpSync(workflowSource, join(provider, ".codex/workflow-mcp"), { recursive: true });
      mkdirSync(join(provider, ".codex/agents"), { recursive: true });
      cpSync(
        join(agentsSource, "change-receipt.ts"),
        join(provider, ".codex/agents/change-receipt.ts"),
      );
      cpSync(join(agentsSource, "receipt.ts"), join(provider, ".codex/agents/receipt.ts"));
      writeFileSync(committedServer, server);
      writeFileSync(
        join(provider, "package.json"),
        '{"name":"bootstrap-fixture","type":"module","dependencies":{}}\n',
      );
      writeFileSync(join(provider, "bun.lock"), "{}\n");
      execFileSync("git", ["-C", provider, "init", "-q"]);
      git("config", "user.email", "workflow@example.invalid");
      git("config", "user.name", "Workflow Tests");
      git("add", ".");
      git("commit", "-qm", "committed bootstrap");

      writeFileSync(
        bootstrap,
        `${readFileSync(bootstrap, "utf8")}\nprocess.stderr.write("dirty bootstrap\\n");\n`,
      );
      writeFileSync(supervisor, 'process.stdout.write("dirty supervisor\\n");\n');
      writeFileSync(committedServer, `${server}\nprocess.stdout.write("dirty server\\n");\n`);

      const child = spawn(
        "sh",
        [
          "-c",
          `export WORKFLOW_MCP_TRUSTED_PROVIDER_ROOT=${JSON.stringify(provider)}; bootstrap=$(mktemp) && trap 'rm -f "$bootstrap"' EXIT && git -C ${JSON.stringify(provider)} show HEAD:.codex/workflow-mcp/bootstrap.ts >"$bootstrap" && bun --no-warnings "$bootstrap"; status=$?; exit "$status"`,
        ],
        {
          cwd: target.root,
          env: {
            ...process.env,
            WORKFLOW_MCP_DB_PATH: databasePath,
            WORKFLOW_MCP_PROVIDER_ROOT: "/definitely/not-the-provider",
            WORKFLOW_MCP_RUNTIME_CACHE_ROOT: cacheRoot,
            WORKFLOW_MCP_INSTALL_DEPENDENCIES: "0",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      const reader = createInterface({ input: child.stdout! });
      let stderr = "";
      child.stderr!.on("data", (chunk) => {
        stderr += chunk.toString();
      });
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
          // A malformed child line is not a response for this protocol test.
        }
      });
      const response = new Promise<any>((resolve, reject) => {
        pending.set(1, resolve);
        child.stdin!.write(
          '{"jsonrpc":"2.0","id":1,"method":"initialize"}\n',
          (error) => error && reject(error),
        );
        setTimeout(() => {
          if (pending.delete(1)) reject(new Error(`bootstrap request timed out: ${stderr}`));
        }, 10_000);
      });
      assert.equal((await response).label, "committed");
      assert.ok(!stderr.includes("dirty bootstrap"));
      assert.ok(!stderr.includes("dirty supervisor"));
      assert.ok(!stderr.includes("dirty server"));
      reader.close();
      child.stdin!.end();
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
    } finally {
      rmSync(target.root, { recursive: true, force: true });
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(dirname(databasePath), { recursive: true, force: true });
    }
  });

  test("fails owning-runtime resolution closed when affinity is incomplete", () => {
    expect(() =>
      resolveOwningRuntime(process.cwd(), { runtime_id: null, runtime_revision: null }),
    ).toThrow(WorkflowError);
    try {
      resolveOwningRuntime(process.cwd(), { runtime_id: null, runtime_revision: null });
    } catch (error) {
      expect((error as WorkflowError).category).toBe("ERROR_RUNTIME_RECOVERY");
    }
  });

  test("rejects a cross-repository supervisor before materializing or opening state", () => {
    const provider = fixture();
    const target = fixture();
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-mismatch-cache-"));
    const databaseRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-mismatch-db-"));
    const databasePath = join(databaseRoot, "state.sqlite");
    try {
      assert.throws(
        () =>
          new RuntimeSupervisor({
            repositoryRoot: target.root,
            providerRoot: provider.root,
            cacheRoot,
            databasePath,
            installDependencies: false,
          }),
        (error: unknown) => {
          return error instanceof WorkflowError && error.category === "ERROR_RUNTIME_ISOLATION";
        },
      );
      assert.deepEqual(readdirSync(cacheRoot), []);
      assert.deepEqual(readdirSync(databaseRoot), []);
    } finally {
      rmSync(provider.root, { recursive: true, force: true });
      rmSync(target.root, { recursive: true, force: true });
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(databaseRoot, { recursive: true, force: true });
    }
  });

  test("bootstrap rejects a provider from a different canonical repository before materialization", () => {
    const provider = fixture();
    const target = fixture();
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-bootstrap-mismatch-cache-"));
    const source = join(process.cwd(), ".codex/workflow-mcp");
    try {
      cpSync(source, join(provider.root, ".codex/workflow-mcp"), { recursive: true });
      provider.git("add", ".");
      provider.git("commit", "-qm", "provider");
      const command = `bootstrap=$(mktemp) && trap 'rm -f "$bootstrap"' EXIT && git -C ${JSON.stringify(provider.root)} show HEAD:.codex/workflow-mcp/bootstrap.ts >"$bootstrap" && bun --no-warnings "$bootstrap"`;
      let stderr = "";
      assert.throws(
        () =>
          execFileSync("sh", ["-c", command], {
            cwd: target.root,
            env: {
              ...process.env,
              WORKFLOW_MCP_TRUSTED_PROVIDER_ROOT: provider.root,
              WORKFLOW_MCP_RUNTIME_CACHE_ROOT: cacheRoot,
            },
            stdio: ["ignore", "pipe", "pipe"],
          }),
        (error: unknown) => {
          const cause = error as { stderr?: Buffer };
          stderr = cause.stderr?.toString() ?? "";
          return true;
        },
      );
      assert.match(stderr, /roots do not match/);
      assert.deepEqual(readdirSync(cacheRoot), []);
    } finally {
      rmSync(provider.root, { recursive: true, force: true });
      rmSync(target.root, { recursive: true, force: true });
      rmSync(cacheRoot, { recursive: true, force: true });
    }
  });
});
