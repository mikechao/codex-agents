import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, cpSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { WorkflowStore } from "../store.mjs";

test("STDIO protocol exposes tools and keeps stdout protocol-clean", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-protocol-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  try {
    git("init", "-q");
    git("config", "user.email", "workflow@example.invalid");
    git("config", "user.name", "Workflow Tests");
    writeFileSync(join(root, "note.txt"), "before\n");
    git("add", ".");
    git("commit", "-qm", "fixture");
    mkdirSync(join(root, ".codex", "agents"), { recursive: true });
    cpSync(join(process.cwd(), ".codex", "agents", "change-receipt.mjs"), join(root, ".codex", "agents", "change-receipt.mjs"));
    const transport = new StdioClientTransport({ command: process.execPath, args: ["--no-warnings", join(process.cwd(), ".codex", "workflow-mcp", "server.mjs")], cwd: root, env: { ...process.env, WORKFLOW_MCP_DB_PATH: join(root, "state.sqlite") }, stderr: "pipe" });
    const client = new Client({ name: "workflow-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const listed = await client.listTools();
    const createTool = listed.tools.find((tool) => tool.name === "workflow_create");
    assert.ok(createTool);
    assert.equal(createTool.annotations.readOnlyHint, false);
    assert.ok(listed.tools.some((tool) => tool.name === "workflow_get"));
    const createdResult = await client.callTool({ name: "workflow_create", arguments: { objective: "protocol", approved_paths: ["note.txt"] } });
    const created = JSON.parse(createdResult.content[0].text);
    assert.equal(created.workflow.phase, "IMPLEMENTING");
    assert.equal(created.workflow.capabilities, undefined);
    assert.equal(Object.keys(created.capabilities).length, 4);
    const denied = await client.callTool({ name: "workflow_get", arguments: { workflow_id: created.workflow.workflow_id, role: "parent", capability: "bad" } });
    assert.equal(denied.isError, true);
    assert.equal(JSON.parse(denied.content[0].text).category, "ERROR_CAPABILITY_DENIED");
    const call = async (name, arguments_) => JSON.parse((await client.callTool({ name, arguments: arguments_ })).content[0].text);
    const base = created.workflow;
    const initialReceipt = JSON.parse(execFileSync(process.execPath, [realpathSync(join(root, ".codex", "agents", "change-receipt.mjs")), "--", "note.txt"], { cwd: root, encoding: "utf8" }));
    const implemented = await call("workflow_submit_implementation", { workflow_id: base.workflow_id, capability: created.capabilities.implementer, expected_version: 0, status: "DONE", summary: "implemented", changed_paths: [], acceptance_evidence: ["accepted"], validation_evidence: ["validated"], implementation_receipt: initialReceipt, known_failures: [], finding_resolution_map: {} });
    assert.equal(implemented.phase, "REVIEWING");
    writeFileSync(join(root, "note.txt"), "after\n");
    const target = { review_mode: "working_tree", base_revision: base.base_head, head_revision: null, approved_paths: ["note.txt"], include_staged: true, include_unstaged: true, include_untracked: true };
    const finding = { finding_id: "PROTO-1", severity: "P1", blocking: true, file_and_line: "note.txt:1", failure_scenario: "fails", impact: "bad", violated_requirement: "safe", remediation: "fix", missing_or_inadequate_test: "test" };
    const changes = await call("workflow_submit_review", { workflow_id: base.workflow_id, capability: created.capabilities.reviewer, expected_version: 1, review_status: "CHANGES_REQUESTED", blocking_findings: [finding], optional_findings: [], review_receipt: null, review_target: target, prior_finding_classifications: {} });
    assert.equal(changes.phase, "REPAIR_REQUIRED");
    const repairing = await call("workflow_authorize_repair", { workflow_id: base.workflow_id, capability: created.capabilities.parent, expected_version: 2, finding_ids: ["PROTO-1"] });
    assert.equal(repairing.phase, "REPAIRING");
    const receipt = JSON.parse(execFileSync(process.execPath, [realpathSync(join(root, ".codex", "agents", "change-receipt.mjs")), "--", "note.txt"], { cwd: root, encoding: "utf8" }));
    const repaired = await call("workflow_submit_implementation", { workflow_id: base.workflow_id, capability: created.capabilities.implementer, expected_version: 3, status: "DONE", summary: "repaired", changed_paths: ["note.txt"], acceptance_evidence: ["repaired"], validation_evidence: ["validated"], implementation_receipt: receipt, known_failures: [], finding_resolution_map: { "PROTO-1": "resolved" } });
    assert.equal(repaired.phase, "REVIEWING");
    const approved = await call("workflow_submit_review", { workflow_id: base.workflow_id, capability: created.capabilities.reviewer, expected_version: 4, review_status: "APPROVED", blocking_findings: [], optional_findings: [], review_receipt: receipt, review_target: target, prior_finding_classifications: { "PROTO-1": "resolved" } });
    assert.equal(approved.phase, "STOPPED_APPROVED");
    const authorized = await call("workflow_authorize_commit", { workflow_id: base.workflow_id, capability: created.capabilities.parent, expected_version: 5, user_authorization: "protocol test commit" });
    assert.equal(authorized.phase, "COMMIT_AUTHORIZED");
    git("add", "note.txt");
    git("commit", "-qm", "protocol change");
    const committed = await call("workflow_record_commit", { workflow_id: base.workflow_id, capability: created.capabilities.committer, expected_version: 6, commit_hash: git("rev-parse", "HEAD") });
    assert.equal(committed.phase, "COMMITTED");
    await client.close();
    await transport.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("SIGINT and SIGTERM shutdown close the store and leave a reopenable database", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-shutdown-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const script = join(process.cwd(), ".codex", "workflow-mcp", "server.mjs");
  try {
    git("init", "-q");
    git("config", "user.email", "workflow@example.invalid");
    git("config", "user.name", "Workflow Tests");
    writeFileSync(join(root, "note.txt"), "before\n");
    git("add", ".");
    git("commit", "-qm", "fixture");
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const db = join(root, `${signal}.sqlite`);
      const child = spawn(process.execPath, ["--no-warnings", script], { cwd: root, env: { ...process.env, WORKFLOW_MCP_DB_PATH: db }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      const deadline = Date.now() + 3000;
      while (!existsSync(db) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(existsSync(db), true);
      child.kill(signal);
      const [code] = await once(child, "close");
      assert.equal(code, 0);
      assert.equal(stdout, "");
      const reopened = new WorkflowStore({ repositoryRoot: root, databasePath: db });
      reopened.close();
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
