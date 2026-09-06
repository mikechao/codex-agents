import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { diagnosticsDirectory } from "../diagnostics.js";
import { WorkflowStore } from "../store.js";
import {
  closeProtocol,
  connectProtocol,
  SERVER,
  workflowCreateInput,
} from "./protocol-fixtures.js";
import { disposeFixture, fixture } from "./test-fixtures.js";

test("raw STDIO remains JSON-RPC clean and does not expose generic getter or worker capabilities", async () => {
  const { root, git } = fixture();
  const child = spawn(process.execPath, ["--no-warnings", SERVER], {
    cwd: root,
    env: { ...process.env, WORKFLOW_MCP_DB_PATH: join(root, "state.sqlite") },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let buffer = "";
  const invalid: string[] = [];
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
    buffer += chunk.toString();
    for (;;) {
      const index = buffer.indexOf("\n");
      if (index < 0) break;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      try {
        JSON.parse(line);
      } catch {
        invalid.push(line);
      }
    }
  });
  const request = (id: number, method: string, params: any = {}) =>
    new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("raw request timed out")), 10_000);
      const onData = (chunk: Buffer) => {
        for (const line of chunk.toString().split("\n")) {
          if (!line) continue;
          try {
            const response = JSON.parse(line);
            if (response.id === id) {
              clearTimeout(timer);
              child.stdout.off("data", onData);
              resolve(response);
            }
          } catch {
            /* The stream observer above records malformed lines. */
          }
        }
      };
      child.stdout.on("data", onData);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    const initialized = await request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "raw", version: "1" },
    });
    assert.equal(initialized.result.protocolVersion, "2024-11-05");
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}\n');
    const listed = await request(2, "tools/list");
    const names = listed.result.tools.map((tool: any) => tool.name);
    assert.equal(names.includes("workflow_get"), false);
    assert.equal(names.includes("workflow_submit_implementation"), true);
    const created = await request(3, "tools/call", {
      name: "workflow_create",
      arguments: workflowCreateInput(git),
    });
    const body = JSON.parse(created.result.content[0].text);
    assert.equal("capability" in body, false);
    assert.equal("capabilities" in body, false);
    assert.deepEqual(invalid, []);
    assert.equal(output.endsWith("\n"), true);
  } finally {
    child.kill("SIGTERM");
    await once(child, "close");
    disposeFixture(root);
  }
});

test("startup corruption keeps stdout empty and reports an actionable stderr diagnostic", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "corrupt.sqlite");
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath });
    store.create(workflowCreateInput(git));
    store.db.prepare("UPDATE workflows SET state_json = ?").run('{"schema_version":2}');
    store.close();
    assert.throws(
      () =>
        execFileSync(process.execPath, ["--no-warnings", SERVER], {
          cwd: root,
          env: { ...process.env, WORKFLOW_MCP_DB_PATH: databasePath },
          input: "",
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        }),
      (error: any) => {
        assert.equal(error.stdout ?? "", "");
        assert.match(error.stderr ?? "", /ERROR_MIGRATION_REQUIRED/u);
        return true;
      },
    );
  } finally {
    disposeFixture(root);
  }
});

test("opt-in child diagnostics correlate tool receipt and result without touching stdout", async () => {
  const { root, git } = fixture();
  const session = await connectProtocol(root, true);
  try {
    const created = await session.call("workflow_create", workflowCreateInput(git));
    await session.call("workflow_parent_get", { workflow_id: created.workflow_id });
    const directory = diagnosticsDirectory(root);
    const files = readdirSync(directory).filter((entry) => /^runtime-\d+\.jsonl$/u.test(entry));
    assert.equal(files.length, 1);
    const records = readFileSync(join(directory, files[0]), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const receipts = records.filter((record) => record.event === "tool_receipt");
    const results = records.filter((record) => record.event === "tool_result");
    assert.ok(receipts.some((record) => record.tool === "workflow_parent_get"));
    const receipt = receipts.find((record) => record.tool === "workflow_parent_get");
    assert.ok(
      results.some(
        (record) => record.request_id === receipt.request_id && record.outcome === "success",
      ),
    );
  } finally {
    await closeProtocol(session);
    rmSync(diagnosticsDirectory(root), { recursive: true, force: true });
    disposeFixture(root);
  }
});
