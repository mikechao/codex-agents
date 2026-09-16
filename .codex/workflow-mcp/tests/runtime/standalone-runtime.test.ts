import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { buildStandaloneWorkflowMcp } from "../../build.js";
import { workflowCreateInput } from "../protocol-fixtures.js";
import { disposeFixture, fixture } from "../test-fixtures.js";

const projectRoot = resolve(import.meta.dir, "../../../..");

interface CompilerRecord {
  args: string[];
  cwd: string;
  artifact: string;
}

function writeFakeBun(root: string, mode: "success" | "smoke-failure" | "compile-failure") {
  const compiler = join(root, "fake-bun");
  const script = String.raw`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const mode = ${JSON.stringify(mode)};
const logPath = process.env.FAKE_BUN_LOG || path.join(path.dirname(path.dirname(process.argv[1])), "compiler.log");
const artifact = path.join(process.cwd(), "synthetic-" + process.pid + "-" + Date.now() + "-" + Math.random().toString(16).slice(2) + ".bun-build");
fs.writeFileSync(artifact, "synthetic build artifact\n");
fs.appendFileSync(logPath, JSON.stringify({ args, cwd: process.cwd(), artifact }) + "\n");
const barrier = process.env.FAKE_BUN_BARRIER;
if (barrier) {
  fs.writeFileSync(path.join(barrier, "entered-" + process.pid), process.cwd());
  const wait = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 10000;
  while (fs.readdirSync(barrier).filter((name) => name.startsWith("entered-")).length < 2) {
    if (Date.now() > deadline) {
      process.stderr.write("fake compiler barrier timed out\n");
      process.exit(17);
    }
    Atomics.wait(wait, 0, 0, 20);
  }
}
if (mode === "compile-failure") {
  process.stderr.write("fake compiler failed\n");
  process.exit(23);
}
const outputIndex = args.indexOf("--outfile");
const outputPath = args[outputIndex + 1];
const observationPath = process.env.FAKE_RUNTIME_OBSERVATION;
const runtime = mode === "smoke-failure"
  ? '#!/usr/bin/env node\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst observationPath = process.env.FAKE_RUNTIME_OBSERVATION || path.join(path.dirname(process.argv[1]), "runtime.log");\nprocess.stdin.on("data", () => { fs.writeFileSync(process.env.WORKFLOW_MCP_DB_PATH, "scratch"); fs.appendFileSync(observationPath, JSON.stringify({ cwd: process.cwd(), database: process.env.WORKFLOW_MCP_DB_PATH }) + "\\n"); process.stdout.write("not-protocol\\nnot-protocol\\n", () => process.exit(0)); });\n'
  : '#!/usr/bin/env node\nconst fs = require("node:fs");\nconst path = require("node:path");\nconst observationPath = process.env.FAKE_RUNTIME_OBSERVATION || path.join(path.dirname(process.argv[1]), "runtime.log");\nlet buffer = "";\nprocess.stdin.on("data", (chunk) => { buffer += chunk; for (;;) { const index = buffer.indexOf("\\n"); if (index < 0) return; const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); let message; try { message = JSON.parse(line); } catch { continue; } const result = { jsonrpc: "2.0", id: message.id, result: {} }; if (message.id === 1 || message.id === 2) { if (message.id === 1) fs.appendFileSync(observationPath, JSON.stringify({ cwd: process.cwd(), database: process.env.WORKFLOW_MCP_DB_PATH }) + "\\n"); process.stdout.write(JSON.stringify(result) + "\\n", () => { if (message.id === 2) process.exit(0); }); } } });\n';
fs.writeFileSync(outputPath, runtime);
fs.chmodSync(outputPath, 0o755);
`;
  writeFileSync(compiler, script);
  chmodSync(compiler, 0o755);
  return compiler;
}

function compilerRecords(logPath: string): CompilerRecord[] {
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CompilerRecord);
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function sourceSnapshot(root: string, git: (...args: string[]) => string) {
  return { note: readFileSync(join(root, "note.txt"), "utf8"), status: git("status", "--short") };
}

function withEnvironment<T>(values: Record<string, string>, callback: () => T): T {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return callback();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function runBuildInChild(
  sourceRoot: string,
  outputPath: string,
  bunExecutable: string,
  env: Record<string, string>,
): Promise<{ status: number | null; stderr: string }> {
  const script = `import { buildStandaloneWorkflowMcp } from ${JSON.stringify(join(projectRoot, ".codex/workflow-mcp/build.ts"))};\ntry { buildStandaloneWorkflowMcp(${JSON.stringify({ sourceRoot, outputPath, bunExecutable })}); } catch (error) { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; }`;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["-e", script], {
      cwd: projectRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stderr }));
  });
}

test("standalone build keeps compiler scratch external and preserves a dirty source repository", () => {
  const { root, git } = fixture();
  const testRoot = mkdtempSync(join(tmpdir(), "workflow-mcp-standalone-fake-success-"));
  const compilerRoot = mkdtempSync(join(testRoot, "compiler-"));
  const compiler = writeFakeBun(compilerRoot, "success");
  const logPath = join(testRoot, "compiler.log");
  const observationPath = join(testRoot, "runtime.log");
  const outputPath = join(testRoot, "requested-output");
  writeFileSync(join(root, "note.txt"), "dirty\n");
  const before = sourceSnapshot(root, git);
  try {
    assert.equal(
      withEnvironment(
        {
          FAKE_BUN_LOG: logPath,
          FAKE_RUNTIME_OBSERVATION: observationPath,
          FAKE_BUN_MODE: "success",
        },
        () =>
          buildStandaloneWorkflowMcp({
            sourceRoot: root,
            outputPath,
            bunExecutable: compiler,
          }),
      ),
      resolve(outputPath),
    );
    const records = compilerRecords(logPath);
    assert.equal(records.length, 1);
    assert.deepEqual(records[0].args, [
      "build",
      "--compile",
      resolve(root, ".codex/workflow-mcp/server.ts"),
      "--outfile",
      resolve(outputPath),
    ]);
    assert.notEqual(records[0].cwd, root);
    assert.equal(records[0].cwd.startsWith(`${root}/`), false);
    assert.equal(pathExists(records[0].cwd), false);
    assert.equal(pathExists(records[0].artifact), false);
    assert.equal(
      readdirSync(root).some((name) => name.endsWith(".bun-build")),
      false,
    );
    assert.deepEqual(sourceSnapshot(root, git), before);
    const observation = JSON.parse(readFileSync(observationPath, "utf8").trim()) as {
      cwd: string;
      database: string;
    };
    assert.equal(observation.cwd, root);
    assert.notEqual(observation.database, "");
    assert.equal(observation.database.startsWith(`${root}/`), false);
    assert.equal(pathExists(observation.database), false);
    assert.equal(pathExists(outputPath), true);
  } finally {
    rmSync(outputPath, { force: true });
    rmSync(observationPath, { force: true });
    rmSync(logPath, { force: true });
    rmSync(compilerRoot, { recursive: true, force: true });
    rmSync(testRoot, { recursive: true, force: true });
    disposeFixture(root);
  }
});

test("standalone build cleans compiler scratch after compiler failure", () => {
  const { root, git } = fixture();
  const testRoot = mkdtempSync(join(tmpdir(), "workflow-mcp-standalone-fake-failure-"));
  const compilerRoot = mkdtempSync(join(testRoot, "compiler-"));
  const compiler = writeFakeBun(compilerRoot, "compile-failure");
  const logPath = join(testRoot, "compiler.log");
  const outputPath = join(testRoot, "requested-output");
  writeFileSync(join(root, "note.txt"), "dirty failure\n");
  const before = sourceSnapshot(root, git);
  try {
    assert.throws(
      () =>
        withEnvironment({ FAKE_BUN_LOG: logPath, FAKE_BUN_MODE: "compile-failure" }, () =>
          buildStandaloneWorkflowMcp({
            sourceRoot: root,
            outputPath,
            bunExecutable: compiler,
          }),
        ),
      /Unable to compile standalone Workflow MCP: fake compiler failed/,
    );
    const record = compilerRecords(logPath)[0];
    assert.notEqual(record.cwd, root);
    assert.equal(pathExists(record.cwd), false);
    assert.equal(pathExists(record.artifact), false);
    assert.equal(pathExists(outputPath), false);
    assert.deepEqual(sourceSnapshot(root, git), before);
  } finally {
    rmSync(outputPath, { force: true });
    rmSync(logPath, { force: true });
    rmSync(compilerRoot, { recursive: true, force: true });
    rmSync(testRoot, { recursive: true, force: true });
    disposeFixture(root);
  }
});

test("standalone build cleans all internal scratch after protocol smoke failure", () => {
  const { root, git } = fixture();
  const testRoot = mkdtempSync(join(tmpdir(), "workflow-mcp-standalone-fake-smoke-"));
  const compilerRoot = mkdtempSync(join(testRoot, "compiler-"));
  const compiler = writeFakeBun(compilerRoot, "smoke-failure");
  const logPath = join(testRoot, "compiler.log");
  const observationPath = join(testRoot, "runtime.log");
  const outputPath = join(testRoot, "requested-output");
  writeFileSync(join(root, "note.txt"), "dirty smoke\n");
  const before = sourceSnapshot(root, git);
  try {
    assert.throws(
      () =>
        withEnvironment(
          {
            FAKE_BUN_LOG: logPath,
            FAKE_RUNTIME_OBSERVATION: observationPath,
            FAKE_BUN_MODE: "smoke-failure",
          },
          () =>
            buildStandaloneWorkflowMcp({
              sourceRoot: root,
              outputPath,
              bunExecutable: compiler,
            }),
        ),
      /Standalone Workflow MCP emitted malformed or non-protocol stdout/,
    );
    const record = compilerRecords(logPath)[0];
    const observation = JSON.parse(readFileSync(observationPath, "utf8").trim()) as {
      cwd: string;
      database: string;
    };
    assert.equal(observation.cwd, root);
    assert.equal(observation.database.startsWith(`${root}/`), false);
    assert.equal(pathExists(observation.database), false);
    assert.equal(pathExists(record.cwd), false);
    assert.equal(pathExists(record.artifact), false);
    assert.equal(pathExists(outputPath), true);
    assert.deepEqual(sourceSnapshot(root, git), before);
  } finally {
    rmSync(outputPath, { force: true });
    rmSync(observationPath, { force: true });
    rmSync(logPath, { force: true });
    rmSync(compilerRoot, { recursive: true, force: true });
    rmSync(testRoot, { recursive: true, force: true });
    disposeFixture(root);
  }
});

test("independent standalone builds overlap with distinct compiler scratch", async () => {
  const { root, git } = fixture();
  const testRoot = mkdtempSync(join(tmpdir(), "workflow-mcp-standalone-fake-overlap-"));
  const compilerRoot = mkdtempSync(join(testRoot, "compiler-"));
  const compiler = writeFakeBun(compilerRoot, "success");
  const barrier = mkdtempSync(join(testRoot, "barrier-"));
  const logPath = join(testRoot, "compiler.log");
  const outputOne = join(testRoot, "output-one");
  const outputTwo = join(testRoot, "output-two");
  const before = sourceSnapshot(root, git);
  try {
    const results = await Promise.all([
      runBuildInChild(root, outputOne, compiler, {
        FAKE_BUN_LOG: logPath,
        FAKE_BUN_BARRIER: barrier,
        FAKE_BUN_MODE: "success",
      }),
      runBuildInChild(root, outputTwo, compiler, {
        FAKE_BUN_LOG: logPath,
        FAKE_BUN_BARRIER: barrier,
        FAKE_BUN_MODE: "success",
      }),
    ]);
    assert.deepEqual(
      results.map((result) => result.status),
      [0, 0],
    );
    assert.deepEqual(
      results.map((result) => result.stderr),
      ["", ""],
    );
    const records = compilerRecords(logPath);
    assert.equal(records.length, 2);
    assert.notEqual(records[0].cwd, records[1].cwd);
    assert.notEqual(records[0].artifact, records[1].artifact);
    for (const record of records) {
      assert.equal(record.cwd.startsWith(`${root}/`), false);
      assert.equal(pathExists(record.cwd), false);
      assert.equal(pathExists(record.artifact), false);
      assert.deepEqual(record.args.slice(0, 3), [
        "build",
        "--compile",
        resolve(root, ".codex/workflow-mcp/server.ts"),
      ]);
    }
    assert.equal(pathExists(outputOne), true);
    assert.equal(pathExists(outputTwo), true);
    assert.deepEqual(sourceSnapshot(root, git), before);
  } finally {
    rmSync(outputOne, { force: true });
    rmSync(outputTwo, { force: true });
    rmSync(logPath, { force: true });
    rmSync(barrier, { recursive: true, force: true });
    rmSync(compilerRoot, { recursive: true, force: true });
    rmSync(testRoot, { recursive: true, force: true });
    disposeFixture(root);
  }
});

async function connect(binary: string, root: string, databasePath: string) {
  const transport = new StdioClientTransport({
    command: binary,
    cwd: root,
    env: { ...process.env, WORKFLOW_MCP_DB_PATH: databasePath },
    stderr: "pipe",
  });
  const client = new Client(
    { name: "standalone-runtime-test", version: "1" },
    { capabilities: {} },
  );
  await client.connect(transport);
  return { client, transport };
}

test("compiled Workflow MCP runtime persists state across restart", async () => {
  const { root, git } = fixture();
  const buildRoot = mkdtempSync(join(tmpdir(), "workflow-mcp-standalone-test-"));
  const databaseRoot = mkdtempSync(join(tmpdir(), "workflow-mcp-standalone-database-"));
  const binary = join(
    buildRoot,
    process.platform === "win32" ? "workflow-mcp.exe" : "workflow-mcp",
  );
  const databasePath = join(databaseRoot, "standalone-state.sqlite");
  let first: Awaited<ReturnType<typeof connect>> | undefined;
  let second: Awaited<ReturnType<typeof connect>> | undefined;
  try {
    buildStandaloneWorkflowMcp({ sourceRoot: projectRoot, outputPath: binary });
    assert.equal(lstatSync(binary).isFile(), true);
    if (process.platform !== "win32") {
      chmodSync(binary, 0o755);
      assert.notEqual(statSync(binary).mode & 0o111, 0);
    }
    first = await connect(binary, root, databasePath);
    const created = await first.client.callTool({
      name: "workflow_create",
      arguments: workflowCreateInput(git),
    });
    const createdBody = JSON.parse((created.content[0] as { text: string }).text) as {
      workflow_id: string;
    };
    await first.client.close();
    await first.transport.close();
    first = undefined;

    second = await connect(binary, root, databasePath);
    const parent = await second.client.callTool({
      name: "workflow_parent_get",
      arguments: { workflow_id: createdBody.workflow_id },
    });
    const parentBody = JSON.parse((parent.content[0] as { text: string }).text) as {
      workflow_id: string;
    };
    assert.equal(parentBody.workflow_id, createdBody.workflow_id);
  } finally {
    if (first) {
      await first.client.close().catch(() => undefined);
      await first.transport.close().catch(() => undefined);
    }
    if (second) {
      await second.client.close().catch(() => undefined);
      await second.transport.close().catch(() => undefined);
    }
    rmSync(buildRoot, { recursive: true, force: true });
    rmSync(databaseRoot, { recursive: true, force: true });
    disposeFixture(root);
  }
});
