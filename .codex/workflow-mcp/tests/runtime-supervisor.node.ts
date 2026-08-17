import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { WorkflowError } from "../errors.js";
import { currentHead } from "../git.js";
import { materializeRuntimeArtifact } from "../runtime-artifact.js";
import { resolveOwningRuntime } from "../runtime-supervisor.js";
import { WorkflowStore } from "../store.js";
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

  test("routes an A workflow back to A after promotion to B and restart", async () => {
    const provider = mkdtempSync(join(tmpdir(), "workflow-runtime-provider-"));
    const target = fixture();
    const cacheRoot = mkdtempSync(join(tmpdir(), "workflow-runtime-cache-"));
    const databasePath = join(mkdtempSync(join(tmpdir(), "workflow-runtime-db-")), "state.sqlite");
    const runtimeModule = pathToFileURL(
      join(process.cwd(), ".codex/workflow-mcp/runtime-supervisor.ts"),
    ).href;
    const server = (label: string) => `
      import { createInterface } from "node:readline";
      const label = ${JSON.stringify(label)};
      createInterface({ input: process.stdin }).on("line", (line) => {
        const request = JSON.parse(line);
        if (request.id === undefined) return;
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { label, runtime_id: process.env.WORKFLOW_MCP_RUNTIME_ID, method: request.method } }) + "\\n");
      });
    `;
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", provider, ...args], { encoding: "utf8" }).trim();
    const writeProvider = (label: string) => {
      mkdirSync(join(provider, ".codex", "workflow-mcp"), { recursive: true });
      mkdirSync(join(provider, ".codex", "agents"), { recursive: true });
      writeFileSync(join(provider, ".codex/workflow-mcp/server.ts"), server(label));
      cpSync(
        join(process.cwd(), ".codex/agents/change-receipt.ts"),
        join(provider, ".codex/agents/change-receipt.ts"),
      );
      cpSync(
        join(process.cwd(), ".codex/agents/change-receipt.ts"),
        join(provider, ".codex/agents/receipt.ts"),
      );
      writeFileSync(
        join(provider, "package.json"),
        '{"name":"runtime-fixture","type":"module","dependencies":{}}\n',
      );
      writeFileSync(join(provider, "bun.lock"), "{}\n");
    };
    const start = (bunExecutable?: string) => {
      const script = `import { RuntimeSupervisor } from ${JSON.stringify(runtimeModule)};
        new RuntimeSupervisor(${JSON.stringify({
          repositoryRoot: target.root,
          providerRoot: provider,
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
      const request = (id: number, method: string, workflowId?: string) =>
        new Promise<any>((resolve, reject) => {
          pending.set(id, resolve);
          child.stdin!.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id,
              method,
              ...(workflowId ? { params: { arguments: { workflow_id: workflowId } } } : {}),
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
      execFileSync("git", ["-C", provider, "init", "-q"]);
      git("config", "user.email", "workflow@example.invalid");
      git("config", "user.name", "Workflow Tests");
      writeProvider("A");
      git("add", ".");
      git("commit", "-qm", "runtime A");
      const revisionA = currentHead(provider);
      const artifactA = materializeRuntimeArtifact(provider, revisionA, {
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
      legacyStore.close();
      const active = start();
      assert.equal((await active.request(10, "initialize")).result.label, "A");
      active.child.stdin!.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      assert.equal(
        (await active.request(11, "workflow_get", workflowA.workflow.workflow_id!)).result.label,
        "A",
      );
      writeProvider("B");
      git("add", ".");
      git("commit", "-qm", "runtime B");
      assert.equal(
        (await active.request(12, "workflow_get", workflowA.workflow.workflow_id!)).result.label,
        "A",
      );
      await active.stop();
      const revisionB = currentHead(provider);
      const artifactB = materializeRuntimeArtifact(provider, revisionB, {
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
      assert.equal((await supervisor.request(1, "initialize")).result.label, "B");
      supervisor.child.stdin!.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      assert.equal(
        (await supervisor.request(2, "workflow_get", workflowB.workflow.workflow_id!)).result.label,
        "B",
      );
      assert.equal(
        (await supervisor.request(4, "workflow_get", legacyWorkflow.workflow.workflow_id!)).result
          .label,
        "B",
      );
      assert.equal(
        (await supervisor.request(3, "workflow_get", workflowA.workflow.workflow_id!)).result.label,
        "A",
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
      rmSync(provider, { recursive: true, force: true });
      rmSync(target.root, { recursive: true, force: true });
      rmSync(cacheRoot, { recursive: true, force: true });
      rmSync(dirname(databasePath), { recursive: true, force: true });
    }
  });

  test("bootstrap executes committed supervisor source despite dirty launcher and supervisor files", async () => {
    const provider = mkdtempSync(join(tmpdir(), "workflow-bootstrap-provider-"));
    const target = fixture();
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
      rmSync(provider, { recursive: true, force: true });
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
});
