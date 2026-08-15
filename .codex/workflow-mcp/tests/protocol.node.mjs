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
import { tools } from "../server.mjs";

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
    const createdResult = await client.callTool({ name: "workflow_create", arguments: { workflow_type: "change", objective: "protocol", approved_paths: ["note.txt"], acceptance_criteria: ["protocol criterion"], validation_requirements: ["protocol validation"], review_target: { review_mode: "working_tree", base_revision: git("rev-parse", "HEAD"), head_revision: null, approved_paths: ["note.txt"], include_staged: true, include_unstaged: true, include_untracked: true } } });
    const created = JSON.parse(createdResult.content[0].text);
    assert.equal(created.workflow.phase, "IMPLEMENTING");
    assert.equal(created.workflow.capabilities, undefined);
    assert.equal(Object.keys(created.capabilities).length, 4);
    assert.deepEqual(created.workflow.permitted_next_actions, []);
    const denied = await client.callTool({ name: "workflow_get", arguments: { workflow_id: created.workflow.workflow_id, role: "parent", capability: "bad" } });
    assert.equal(denied.isError, true);
    assert.equal(JSON.parse(denied.content[0].text).category, "ERROR_CAPABILITY_DENIED");
    const call = async (name, arguments_) => JSON.parse((await client.callTool({ name, arguments: arguments_ })).content[0].text);
    const base = created.workflow;
    const initialReceipt = JSON.parse(execFileSync(process.execPath, [realpathSync(join(root, ".codex", "agents", "change-receipt.mjs")), "--", "note.txt"], { cwd: root, encoding: "utf8" }));
    const implemented = await call("workflow_submit_implementation", { workflow_id: base.workflow_id, capability: created.capabilities.implementer, expected_version: 0, status: "DONE", summary: "implemented", agent_touched_paths: [], acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "accepted" }], validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "validated" }], implementation_receipt: initialReceipt, known_failures: [], finding_resolution_map: {} });
    assert.equal(implemented.phase, "REVIEWING");
    writeFileSync(join(root, "note.txt"), "after\n");
    const target = { review_mode: "working_tree", base_revision: base.base_head, head_revision: null, approved_paths: ["note.txt"], include_staged: true, include_unstaged: true, include_untracked: true };
    const finding = { finding_id: "PROTO-1", severity: "P1", blocking: true, file_and_line: "note.txt:1", failure_scenario: "fails", impact: "bad", violated_requirement: "safe", remediation: "fix", missing_or_inadequate_test: "test" };
    const changes = await call("workflow_submit_review", { workflow_id: base.workflow_id, capability: created.capabilities.reviewer, expected_version: 1, review_status: "CHANGES_REQUESTED", blocking_findings: [finding], optional_findings: [], review_receipt: null, review_target: target, prior_finding_classifications: {} });
    assert.equal(changes.phase, "REPAIR_REQUIRED");
    const repairing = await call("workflow_authorize_repair", { workflow_id: base.workflow_id, capability: created.capabilities.parent, expected_version: 2, finding_ids: ["PROTO-1"] });
    assert.equal(repairing.phase, "REPAIRING");
    const receipt = JSON.parse(execFileSync(process.execPath, [realpathSync(join(root, ".codex", "agents", "change-receipt.mjs")), "--", "note.txt"], { cwd: root, encoding: "utf8" }));
    const repaired = await call("workflow_submit_implementation", { workflow_id: base.workflow_id, capability: created.capabilities.implementer, expected_version: 3, status: "DONE", summary: "repaired", agent_touched_paths: ["note.txt"], acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "repaired" }], validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "validated" }], implementation_receipt: receipt, known_failures: [], finding_resolution_map: { "PROTO-1": "resolved" } });
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

test("role view projection over STDIO returns only role data without capabilities", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-roleview-"));
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
    const createdResult = await client.callTool({ name: "workflow_create", arguments: { workflow_type: "change", objective: "role view protocol", approved_paths: ["note.txt"], acceptance_criteria: ["criterion"], validation_requirements: ["validation"], review_target: { review_mode: "working_tree", base_revision: git("rev-parse", "HEAD"), head_revision: null, approved_paths: ["note.txt"], include_staged: true, include_unstaged: true, include_untracked: true } } });
    const created = JSON.parse(createdResult.content[0].text);
    const get = async (role, capability) => JSON.parse((await client.callTool({ name: "workflow_get", arguments: { workflow_id: created.workflow.workflow_id, role, capability } })).content[0].text);

    const implementer = await get("implementer", created.capabilities.implementer);
    assert.equal(implementer.phase, "IMPLEMENTING");
    assert.deepEqual(implementer.permitted_next_actions, ["workflow_submit_implementation"]);
    assert.equal("initial_receipt" in implementer, true);
    assert.equal("acceptance_criteria" in implementer, true);
    assert.equal("review_receipt" in implementer, false);
    assert.equal("optional_findings" in implementer, false);
    assert.equal("commit_authorization" in implementer, false);

    const reviewer = await get("reviewer", created.capabilities.reviewer);
    assert.equal("initial_receipt" in reviewer, false);
    assert.equal("review_receipt" in reviewer, true);
    assert.equal("commit_authorization" in reviewer, false);

    const committer = await get("committer", created.capabilities.committer);
    assert.equal("initial_receipt" in committer, false);
    assert.equal("commit_authorization" in committer, true);

    const parent = await get("parent", created.capabilities.parent);
    assert.equal("initial_receipt" in parent, true);
    assert.equal("commit_authorization" in parent, true);
    for (const view of [implementer, reviewer, committer, parent]) {
      const serialized = JSON.stringify(view);
      assert.equal(serialized.includes("legacy_evidence"), false);
      for (const token of Object.values(created.capabilities)) {
        assert.equal(serialized.includes(token), false, `view contains capability ${token}`);
      }
    }
    const denied = await client.callTool({ name: "workflow_get", arguments: { workflow_id: created.workflow.workflow_id, role: "parent", capability: created.capabilities.implementer } });
    assert.equal(denied.isError, true);
    assert.equal(JSON.parse(denied.content[0].text).category, "ERROR_CAPABILITY_DENIED");
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

test("exact create tool schema matches the normative contract", () => {
  const createTool = tools.find((tool) => tool.name === "workflow_create");
  assert.ok(createTool);
  const { inputSchema } = createTool;
  assert.equal(inputSchema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(inputSchema.properties).sort(),
    [
      "acceptance_criteria",
      "approved_paths",
      "max_repair_cycles",
      "objective",
      "review_target",
      "validation_requirements",
      "workflow_type",
    ],
  );
  assert.deepEqual(inputSchema.required, [
    "workflow_type",
    "objective",
    "approved_paths",
    "acceptance_criteria",
    "validation_requirements",
    "review_target",
  ]);
  assert.deepEqual(inputSchema.properties.workflow_type.enum, ["change", "review_only"]);
  assert.equal(inputSchema.properties.objective.minLength, 1);
  assert.equal(inputSchema.properties.objective.maxLength, 4000);
  assert.equal(inputSchema.properties.approved_paths.minItems, 1);
  assert.equal(inputSchema.properties.approved_paths.maxItems, 200);
  assert.equal(inputSchema.properties.acceptance_criteria.minItems, 1);
  assert.equal(inputSchema.properties.acceptance_criteria.maxItems, 999);
  assert.equal(inputSchema.properties.validation_requirements.minItems, 0);
  assert.equal(inputSchema.properties.validation_requirements.maxItems, 999);
  assert.equal(inputSchema.properties.max_repair_cycles.minimum, 0);
  assert.equal(inputSchema.properties.max_repair_cycles.maximum, 2);
  const target = inputSchema.properties.review_target;
  assert.deepEqual(
    target.oneOf.map((entry) => entry.properties.review_mode.enum[0]).sort(),
    ["commit_range", "working_tree"],
  );
  const working = target.oneOf.find((entry) => entry.properties.review_mode.enum[0] === "working_tree");
  assert.equal(working.properties.head_revision.type, "null");
  assert.equal(working.properties.include_staged.const, true);
  assert.equal(working.properties.include_unstaged.const, true);
  assert.equal(working.properties.include_untracked.const, true);
  const range = target.oneOf.find((entry) => entry.properties.review_mode.enum[0] === "commit_range");
  assert.equal(range.properties.head_revision.pattern, "^[0-9a-f]{40}$");
  assert.equal(range.properties.include_staged.const, false);
  assert.equal(range.properties.include_unstaged.const, false);
  assert.equal(range.properties.include_untracked.const, false);
});

test("exact implementation tool schema matches the normative contract", () => {
  const submitTool = tools.find((tool) => tool.name === "workflow_submit_implementation");
  assert.ok(submitTool);
  const { inputSchema } = submitTool;
  assert.equal(inputSchema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(inputSchema.properties).sort(),
    [
      "acceptance_results",
      "agent_touched_paths",
      "capability",
      "expected_version",
      "finding_resolution_map",
      "implementation_receipt",
      "known_failures",
      "status",
      "summary",
      "validation_results",
      "workflow_id",
    ],
  );
  assert.deepEqual(inputSchema.required, [
    "workflow_id",
    "capability",
    "expected_version",
    "status",
    "summary",
    "agent_touched_paths",
    "acceptance_results",
    "validation_results",
    "implementation_receipt",
    "known_failures",
    "finding_resolution_map",
  ]);
  assert.deepEqual(inputSchema.properties.status.enum, [
    "DONE",
    "DONE_WITH_CONCERNS",
    "NEEDS_CONTEXT",
    "BLOCKED",
  ]);
  assert.deepEqual(inputSchema.properties.agent_touched_paths.maxItems, 200);
  const acceptanceItem = inputSchema.properties.acceptance_results.items;
  assert.equal(acceptanceItem.additionalProperties, false);
  assert.deepEqual(acceptanceItem.properties.status.enum, ["satisfied", "not_satisfied"]);
  assert.equal(acceptanceItem.properties.evidence.maxLength, 2000);
  const validationItem = inputSchema.properties.validation_results.items;
  assert.equal(validationItem.additionalProperties, false);
  assert.deepEqual(validationItem.properties.status.enum, ["passed", "failed", "not_run"]);
  assert.equal(validationItem.properties.evidence.maxLength, 2000);
  assert.equal("changed_paths" in inputSchema.properties, false);
  assert.equal("acceptance_evidence" in inputSchema.properties, false);
  assert.equal("validation_evidence" in inputSchema.properties, false);
});

test("exact recovery tool schemas match the normative contract", () => {
  const resumeTool = tools.find((tool) => tool.name === "workflow_resume_implementation");
  assert.ok(resumeTool);
  const resumeSchema = resumeTool.inputSchema;
  assert.equal(resumeSchema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(resumeSchema.properties).sort(),
    ["capability", "expected_version", "resume_context", "workflow_id"],
  );
  assert.deepEqual(resumeSchema.required, [
    "workflow_id",
    "capability",
    "expected_version",
    "resume_context",
  ]);
  assert.equal(resumeSchema.properties.resume_context.minLength, 1);
  assert.equal(resumeSchema.properties.resume_context.maxLength, 2000);

  const acceptTool = tools.find((tool) => tool.name === "workflow_accept_concerns");
  assert.ok(acceptTool);
  const acceptSchema = acceptTool.inputSchema;
  assert.equal(acceptSchema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(acceptSchema.properties).sort(),
    ["capability", "expected_version", "user_authorization", "workflow_id"],
  );
  assert.deepEqual(acceptSchema.required, [
    "workflow_id",
    "capability",
    "expected_version",
    "user_authorization",
  ]);
  assert.equal(acceptSchema.properties.user_authorization.minLength, 1);
  assert.equal(acceptSchema.properties.user_authorization.maxLength, 2000);
});

test("resume review and repair exhaustion tool schemas match the normative contract", () => {
  const resumeReviewTool = tools.find((tool) => tool.name === "workflow_resume_review");
  assert.ok(resumeReviewTool);
  const resumeReviewSchema = resumeReviewTool.inputSchema;
  assert.equal(resumeReviewSchema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(resumeReviewSchema.properties).sort(),
    ["capability", "expected_version", "resume_context", "workflow_id"],
  );
  assert.deepEqual(resumeReviewSchema.required, [
    "workflow_id",
    "capability",
    "expected_version",
    "resume_context",
  ]);
  assert.equal(resumeReviewSchema.properties.resume_context.minLength, 1);
  assert.equal(resumeReviewSchema.properties.resume_context.maxLength, 2000);

  const finalizeTool = tools.find((tool) => tool.name === "workflow_finalize_repair_exhausted");
  assert.ok(finalizeTool);
  const finalizeSchema = finalizeTool.inputSchema;
  assert.equal(finalizeSchema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(finalizeSchema.properties).sort(),
    ["capability", "expected_version", "workflow_id"],
  );
  assert.deepEqual(finalizeSchema.required, [
    "workflow_id",
    "capability",
    "expected_version",
  ]);
  assert.equal(tools.some((tool) => tool.name === "workflow_finalize_blocked"), false);
});

test("exact linked follow-up tool schema matches the normative contract", () => {
  assert.equal(tools.some((tool) => tool.name === "workflow_create_optional_followup"), false);
  const linkedTool = tools.find((tool) => tool.name === "workflow_create_linked_followup");
  assert.ok(linkedTool);
  const { inputSchema } = linkedTool;
  assert.equal(inputSchema.additionalProperties, false);
  assert.deepEqual(
    Object.keys(inputSchema.properties).sort(),
    [
      "acceptance_criteria",
      "approved_paths",
      "capability",
      "expected_version",
      "finding_ids",
      "objective",
      "user_authorization",
      "validation_requirements",
      "workflow_id",
    ],
  );
  assert.deepEqual(inputSchema.required, [
    "workflow_id",
    "capability",
    "expected_version",
    "objective",
    "approved_paths",
    "acceptance_criteria",
    "validation_requirements",
    "finding_ids",
    "user_authorization",
  ]);
  assert.equal(inputSchema.properties.objective.minLength, 1);
  assert.equal(inputSchema.properties.objective.maxLength, 4000);
  assert.equal(inputSchema.properties.approved_paths.minItems, 1);
  assert.equal(inputSchema.properties.approved_paths.maxItems, 200);
  assert.equal(inputSchema.properties.acceptance_criteria.minItems, 1);
  assert.equal(inputSchema.properties.acceptance_criteria.maxItems, 999);
  assert.equal(inputSchema.properties.validation_requirements.minItems, 1);
  assert.equal(inputSchema.properties.validation_requirements.maxItems, 999);
  assert.equal(inputSchema.properties.finding_ids.minItems, 1);
  assert.equal(inputSchema.properties.user_authorization.minLength, 1);
  assert.equal(inputSchema.properties.user_authorization.maxLength, 2000);
});

test("implementation stops resume and concerns over STDIO", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-recover-"));
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
    const createdResult = await client.callTool({ name: "workflow_create", arguments: { workflow_type: "change", objective: "recover", approved_paths: ["note.txt"], acceptance_criteria: ["criterion"], validation_requirements: ["validation"], review_target: { review_mode: "working_tree", base_revision: git("rev-parse", "HEAD"), head_revision: null, approved_paths: ["note.txt"], include_staged: true, include_unstaged: true, include_untracked: true } } });
    const created = JSON.parse(createdResult.content[0].text);
    const call = async (name, arguments_) => JSON.parse((await client.callTool({ name, arguments: arguments_ })).content[0].text);
    const base = created.workflow;
    const initialReceipt = JSON.parse(execFileSync(process.execPath, [realpathSync(join(root, ".codex", "agents", "change-receipt.mjs")), "--", "note.txt"], { cwd: root, encoding: "utf8" }));

    const stopped = await call("workflow_submit_implementation", { workflow_id: base.workflow_id, capability: created.capabilities.implementer, expected_version: 0, status: "NEEDS_CONTEXT", summary: "missing context", agent_touched_paths: [], acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "accepted" }], validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "validated" }], implementation_receipt: initialReceipt, known_failures: [], finding_resolution_map: {} });
    assert.equal(stopped.phase, "STOPPED_NEEDS_CONTEXT");
    assert.deepEqual(stopped.stop_context, { status: "NEEDS_CONTEXT", summary: "missing context", stopped_from: "IMPLEMENTING" });
    assert.deepEqual(stopped.permitted_next_actions, []);

    const resumeDenied = await client.callTool({ name: "workflow_resume_implementation", arguments: { workflow_id: base.workflow_id, capability: created.capabilities.implementer, expected_version: 1, resume_context: "x" } });
    assert.equal(resumeDenied.isError, true);
    assert.equal(JSON.parse(resumeDenied.content[0].text).category, "ERROR_CAPABILITY_DENIED");

    const resumed = await call("workflow_resume_implementation", { workflow_id: base.workflow_id, capability: created.capabilities.parent, expected_version: 1, resume_context: "context now available" });
    assert.equal(resumed.phase, "IMPLEMENTING");
    assert.equal(resumed.recovery_context.kind, "implementation");

    const concerns = await call("workflow_submit_implementation", { workflow_id: base.workflow_id, capability: created.capabilities.implementer, expected_version: 2, status: "DONE_WITH_CONCERNS", summary: "done with flaky", agent_touched_paths: [], acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "accepted" }], validation_results: [{ validation_id: "VAL-001", status: "failed", evidence: "flaky" }], implementation_receipt: initialReceipt, known_failures: ["flaky test"], finding_resolution_map: {} });
    assert.equal(concerns.phase, "STOPPED_CONCERNS");

    const accepted = await call("workflow_accept_concerns", { workflow_id: base.workflow_id, capability: created.capabilities.parent, expected_version: 3, user_authorization: "user accepts flaky" });
    assert.equal(accepted.phase, "REVIEWING");
    assert.equal(accepted.concern_acceptance.user_authorization, "user accepts flaky");
    assert.equal(accepted.commit_authorization, null);

    const reviewed = await call("workflow_submit_review", { workflow_id: base.workflow_id, capability: created.capabilities.reviewer, expected_version: 4, review_status: "APPROVED", blocking_findings: [], optional_findings: [], review_receipt: initialReceipt, review_target: { review_mode: "working_tree", base_revision: base.base_head, head_revision: null, approved_paths: ["note.txt"], include_staged: true, include_unstaged: true, include_untracked: true }, prior_finding_classifications: {} });
    assert.equal(reviewed.phase, "STOPPED_APPROVED");
    await client.close();
    await transport.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("review-only workflows over STDIO cover working-tree approval and range commit denial", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-reviewonly-"));
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
    const call = async (name, arguments_) => JSON.parse((await client.callTool({ name, arguments: arguments_ })).content[0].text);
    const receipt = (paths) => JSON.parse(execFileSync(process.execPath, [realpathSync(join(root, ".codex", "agents", "change-receipt.mjs")), "--", ...paths], { cwd: root, encoding: "utf8" }));

    const wtResult = await call("workflow_create", { workflow_type: "review_only", objective: "working-tree review only", approved_paths: ["note.txt"], acceptance_criteria: ["review criterion"], validation_requirements: [], review_target: { review_mode: "working_tree", base_revision: git("rev-parse", "HEAD"), head_revision: null, approved_paths: ["note.txt"], include_staged: true, include_unstaged: true, include_untracked: true } });
    assert.equal(wtResult.workflow.phase, "REVIEWING");
    assert.equal(wtResult.workflow.workflow_type, "review_only");
    assert.deepEqual(wtResult.workflow.permitted_next_actions, []);
    const wt = wtResult.workflow;
    const wtTarget = wt.review_target;
    assert.deepEqual((await call("workflow_get", { workflow_id: wt.workflow_id, role: "reviewer", capability: wtResult.capabilities.reviewer })).permitted_next_actions, ["workflow_submit_review"]);
    const wtApproved = await call("workflow_submit_review", { workflow_id: wt.workflow_id, capability: wtResult.capabilities.reviewer, expected_version: 0, review_status: "APPROVED", blocking_findings: [], optional_findings: [], review_receipt: receipt(["note.txt"]), review_target: wtTarget, prior_finding_classifications: {} });
    assert.equal(wtApproved.phase, "STOPPED_APPROVED");
    const wtAuthorized = await call("workflow_authorize_commit", { workflow_id: wt.workflow_id, capability: wtResult.capabilities.parent, expected_version: 1, user_authorization: "authorize working-tree review-only" });
    assert.equal(wtAuthorized.phase, "COMMIT_AUTHORIZED");

    writeFileSync(join(root, "added.txt"), "added\n");
    git("add", "added.txt");
    git("commit", "-qm", "range head");
    const base = git("rev-parse", "HEAD~1");
    const head = git("rev-parse", "HEAD");
    const rangeResult = await call("workflow_create", { workflow_type: "review_only", objective: "range review only", approved_paths: ["added.txt", "note.txt"], acceptance_criteria: ["review criterion"], validation_requirements: [], review_target: { review_mode: "commit_range", base_revision: base, head_revision: head, approved_paths: ["added.txt", "note.txt"], include_staged: false, include_unstaged: false, include_untracked: false } });
    assert.equal(rangeResult.workflow.phase, "REVIEWING");
    assert.equal(rangeResult.workflow.initial_receipt, null);
    const range = rangeResult.workflow;
    const rangeApproved = await call("workflow_submit_review", { workflow_id: range.workflow_id, capability: rangeResult.capabilities.reviewer, expected_version: 0, review_status: "APPROVED", blocking_findings: [], optional_findings: [], review_receipt: null, review_target: range.review_target, prior_finding_classifications: {} });
    assert.equal(rangeApproved.phase, "STOPPED_APPROVED");
    assert.equal(rangeApproved.review_receipt, null);
    assert.deepEqual((await call("workflow_get", { workflow_id: range.workflow_id, role: "parent", capability: rangeResult.capabilities.parent })).permitted_next_actions, ["workflow_create_linked_followup"]);
    const denied = await client.callTool({ name: "workflow_authorize_commit", arguments: { workflow_id: range.workflow_id, capability: rangeResult.capabilities.parent, expected_version: 1, user_authorization: "authorize range review-only" } });
    assert.equal(denied.isError, true);
    assert.equal(JSON.parse(denied.content[0].text).category, "ERROR_COMMIT_NOT_ALLOWED");
    await client.close();
    await transport.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("review resume and repair exhaustion over STDIO", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-recover-review-"));
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
    const call = async (name, arguments_) => JSON.parse((await client.callTool({ name, arguments: arguments_ })).content[0].text);
    const receipt = () => JSON.parse(execFileSync(process.execPath, [realpathSync(join(root, ".codex", "agents", "change-receipt.mjs")), "--", "note.txt"], { cwd: root, encoding: "utf8" }));

    const wtResult = await call("workflow_create", { workflow_type: "review_only", objective: "recover review", approved_paths: ["note.txt"], acceptance_criteria: ["criterion"], validation_requirements: [], review_target: { review_mode: "working_tree", base_revision: git("rev-parse", "HEAD"), head_revision: null, approved_paths: ["note.txt"], include_staged: true, include_unstaged: true, include_untracked: true } });
    const wt = wtResult.workflow;
    const wtTarget = wt.review_target;
    const inconclusive = await call("workflow_submit_review", { workflow_id: wt.workflow_id, capability: wtResult.capabilities.reviewer, expected_version: 0, review_status: "INCONCLUSIVE", blocking_findings: [], optional_findings: [], review_receipt: null, review_target: wtTarget, prior_finding_classifications: {} });
    assert.equal(inconclusive.phase, "STOPPED_INCONCLUSIVE");
    assert.deepEqual(inconclusive.stop_context, { status: "INCONCLUSIVE", summary: "review context unavailable", stopped_from: "REVIEWING" });
    const resumed = await call("workflow_resume_review", { workflow_id: wt.workflow_id, capability: wtResult.capabilities.parent, expected_version: 1, resume_context: "context available" });
    assert.equal(resumed.phase, "REVIEWING");
    assert.equal(resumed.stop_context, null);
    assert.equal(resumed.recovery_context.kind, "review");
    assert.equal(resumed.recovery_context.context, "context available");
    const approved = await call("workflow_submit_review", { workflow_id: wt.workflow_id, capability: wtResult.capabilities.reviewer, expected_version: 2, review_status: "APPROVED", blocking_findings: [], optional_findings: [], review_receipt: receipt(), review_target: wtTarget, prior_finding_classifications: {} });
    assert.equal(approved.phase, "STOPPED_APPROVED");

    const chgResult = await call("workflow_create", { workflow_type: "change", objective: "exhaust", approved_paths: ["note.txt"], acceptance_criteria: ["criterion"], validation_requirements: ["validation"], max_repair_cycles: 0, review_target: { review_mode: "working_tree", base_revision: git("rev-parse", "HEAD"), head_revision: null, approved_paths: ["note.txt"], include_staged: true, include_unstaged: true, include_untracked: true } });
    const chg = chgResult.workflow;
    await call("workflow_submit_implementation", { workflow_id: chg.workflow_id, capability: chgResult.capabilities.implementer, expected_version: 0, status: "DONE", summary: "done", agent_touched_paths: [], acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "accepted" }], validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "validated" }], implementation_receipt: receipt(), known_failures: [], finding_resolution_map: {} });
    const finding = { finding_id: "PROTO-EXH", severity: "P1", blocking: true, file_and_line: "note.txt:1", failure_scenario: "fails", impact: "bad", violated_requirement: "safe", remediation: "fix", missing_or_inadequate_test: "test" };
    await call("workflow_submit_review", { workflow_id: chg.workflow_id, capability: chgResult.capabilities.reviewer, expected_version: 1, review_status: "CHANGES_REQUESTED", blocking_findings: [finding], optional_findings: [], review_receipt: null, review_target: chg.review_target, prior_finding_classifications: {} });
    const exhausted = await call("workflow_finalize_repair_exhausted", { workflow_id: chg.workflow_id, capability: chgResult.capabilities.parent, expected_version: 2 });
    assert.equal(exhausted.phase, "STOPPED_REPAIR_EXHAUSTED");
    assert.deepEqual((await call("workflow_get", { workflow_id: chg.workflow_id, role: "parent", capability: chgResult.capabilities.parent })).permitted_next_actions, ["workflow_create_linked_followup"]);
    const resumeDenied = await client.callTool({ name: "workflow_resume_review", arguments: { workflow_id: chg.workflow_id, capability: chgResult.capabilities.parent, expected_version: 3, resume_context: "x" } });
    assert.equal(resumeDenied.isError, true);
    assert.equal(JSON.parse(resumeDenied.content[0].text).category, "ERROR_INVALID_TRANSITION");
    await client.close();
    await transport.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("linked follow-up over STDIO creates a self-contained child without source capability", async () => {
  const root = mkdtempSync(join(tmpdir(), "workflow-linked-"));
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
    const call = async (name, arguments_) => JSON.parse((await client.callTool({ name, arguments: arguments_ })).content[0].text);
    const receipt = (paths) => JSON.parse(execFileSync(process.execPath, [realpathSync(join(root, ".codex", "agents", "change-receipt.mjs")), "--", ...paths], { cwd: root, encoding: "utf8" }));

    const createdResult = await call("workflow_create", { workflow_type: "change", objective: "linked protocol", approved_paths: ["note.txt"], acceptance_criteria: ["criterion"], validation_requirements: ["validation"], review_target: { review_mode: "working_tree", base_revision: git("rev-parse", "HEAD"), head_revision: null, approved_paths: ["note.txt"], include_staged: true, include_unstaged: true, include_untracked: true } });
    const created = createdResult.workflow;
    await call("workflow_submit_implementation", { workflow_id: created.workflow_id, capability: createdResult.capabilities.implementer, expected_version: 0, status: "DONE", summary: "done", agent_touched_paths: [], acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "accepted" }], validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "validated" }], implementation_receipt: receipt(["note.txt"]), known_failures: [], finding_resolution_map: {} });
    writeFileSync(join(root, "note.txt"), "after\n");
    const target = { review_mode: "working_tree", base_revision: created.base_head, head_revision: null, approved_paths: ["note.txt"], include_staged: true, include_unstaged: true, include_untracked: true };
    const optional = { finding_id: "PROTO-LINK", severity: "P3", blocking: false, file_and_line: "note.txt:1", failure_scenario: "might fail", impact: "small", violated_requirement: "quality", remediation: "consider", missing_or_inadequate_test: "optional" };
    const approved = await call("workflow_submit_review", { workflow_id: created.workflow_id, capability: createdResult.capabilities.reviewer, expected_version: 1, review_status: "APPROVED", blocking_findings: [], optional_findings: [optional], review_receipt: receipt(["note.txt"]), review_target: target, prior_finding_classifications: {} });
    assert.equal(approved.phase, "STOPPED_APPROVED");
    assert.deepEqual((await call("workflow_get", { workflow_id: created.workflow_id, role: "parent", capability: createdResult.capabilities.parent })).permitted_next_actions, ["workflow_authorize_commit", "workflow_create_linked_followup"]);

    const linkedResult = await call("workflow_create_linked_followup", { workflow_id: created.workflow_id, capability: createdResult.capabilities.parent, expected_version: 2, objective: "linked child", approved_paths: ["note.txt"], acceptance_criteria: ["child criterion"], validation_requirements: ["child validation"], finding_ids: ["PROTO-LINK"], user_authorization: "user authorized linked follow-up" });
    const child = linkedResult.workflow;
    assert.equal(child.phase, "IMPLEMENTING");
    assert.equal(child.source_workflow_id, created.workflow_id);
    assert.equal(child.parent_workflow_id, created.workflow_id);
    const childImplementer = await call("workflow_get", { workflow_id: child.workflow_id, role: "implementer", capability: linkedResult.capabilities.implementer });
    assert.deepEqual(childImplementer.linked_findings, [optional]);
    assert.deepEqual(childImplementer.remediation_context, { policy: "explicitly_authorized", authorized_finding_ids: ["PROTO-LINK"], repair_cycle: 0, user_authorization: "user authorized linked follow-up" });
    assert.deepEqual(childImplementer.acceptance_criteria, [{ criterion_id: "AC-001", description: "child criterion" }]);
    assert.deepEqual(childImplementer.validation_requirements, [{ validation_id: "VAL-001", description: "child validation" }]);
    assert.deepEqual(childImplementer.permitted_next_actions, ["workflow_submit_implementation"]);
    const parentView = await call("workflow_get", { workflow_id: created.workflow_id, role: "parent", capability: createdResult.capabilities.parent });
    assert.equal(parentView.version, 3);
    const audit = await call("workflow_get_audit", { workflow_id: created.workflow_id, role: "parent", capability: createdResult.capabilities.parent });
    assert.equal(audit[audit.length - 1].event_type, "LINKED_FOLLOWUP_CREATED");
    assert.equal(audit[audit.length - 1].summary.linked_workflow_id, child.workflow_id);
    assert.equal(JSON.stringify(audit).includes("PROTO-LINK"), false);
    await client.close();
    await transport.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
