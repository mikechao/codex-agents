import { test } from "bun:test";
import assert from "node:assert/strict";
import { chmodSync, lstatSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { buildStandaloneWorkflowMcp } from "../build.js";
import { workflowCreateInput } from "./protocol-fixtures.js";
import { disposeFixture, fixture } from "./test-fixtures.js";

const projectRoot = resolve(import.meta.dir, "../../..");

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
  const binary = join(
    buildRoot,
    process.platform === "win32" ? "workflow-mcp.exe" : "workflow-mcp",
  );
  const databasePath = join(root, "standalone-state.sqlite");
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
    disposeFixture(root);
  }
});
