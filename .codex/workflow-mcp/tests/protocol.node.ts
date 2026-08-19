import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { TOML } from "bun";
import { tools } from "../server.js";
import { WorkflowStore } from "../store.js";
import { fixture, receipt as makeReceipt } from "./test-fixtures.js";

function makeLegacyCompatibleCall(client: Client) {
  const versionOffsets = new Map<string, number>();
  return async (name: string, arguments_: any) => {
    const args = { ...arguments_ };
    const workflowId = args.workflow_id;
    if (typeof args.expected_version === "number" && workflowId) {
      args.expected_version += versionOffsets.get(workflowId) ?? 0;
    }
    if (name === "workflow_submit_implementation") delete args.implementation_receipt;
    if (name === "workflow_submit_review") {
      const legacyReceipt = Object.hasOwn(args, "review_receipt");
      const isWorkingTree = args.review_target?.review_mode === "working_tree";
      delete args.review_receipt;
      delete args.review_target;
      if (legacyReceipt && isWorkingTree) {
        await client.callTool({
          name: "workflow_begin_review",
          arguments: {
            workflow_id: workflowId,
            capability: args.capability,
            expected_version: args.expected_version,
          },
        });
        versionOffsets.set(workflowId, (versionOffsets.get(workflowId) ?? 0) + 1);
        args.expected_version += 1;
      }
    }
    return JSON.parse(
      ((await client.callTool({ name, arguments: args })).content[0] as { text: string }).text,
    );
  };
}

test("STDIO protocol exposes tools and keeps stdout protocol-clean", async () => {
  const { root, git } = fixture();
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--no-warnings", join(process.cwd(), ".codex", "workflow-mcp", "server.ts")],
      cwd: root,
      env: { ...process.env, WORKFLOW_MCP_DB_PATH: join(root, "state.sqlite") },
      stderr: "pipe",
    });
    const client = new Client({ name: "workflow-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const listed = await client.listTools();
    const createTool = listed.tools.find((tool) => tool.name === "workflow_create");
    assert.ok(createTool);
    assert.equal(createTool.annotations?.readOnlyHint, false);
    assert.ok(listed.tools.some((tool) => tool.name === "workflow_get"));
    const createdResult = await client.callTool({
      name: "workflow_create",
      arguments: {
        workflow_type: "change",
        objective: "protocol",
        approved_paths: ["note.txt"],
        acceptance_criteria: ["protocol criterion"],
        validation_requirements: ["protocol validation"],
        review_target: {
          review_mode: "working_tree",
          base_revision: git("rev-parse", "HEAD"),
          head_revision: null,
          approved_paths: ["note.txt"],
          include_staged: true,
          include_unstaged: true,
          include_untracked: true,
        },
      },
    });
    const created = JSON.parse((createdResult.content[0] as { text: string }).text);
    assert.equal(created.workflow.phase, "IMPLEMENTING");
    assert.equal(created.workflow.capabilities, undefined);
    assert.equal(Object.keys(created.capabilities).length, 4);
    assert.deepEqual(created.workflow.permitted_next_actions, []);
    const denied = await client.callTool({
      name: "workflow_get",
      arguments: { workflow_id: created.workflow.workflow_id, role: "parent", capability: "bad" },
    });
    assert.equal(denied.isError, true);
    assert.equal(
      JSON.parse((denied.content[0] as { text: string }).text).category,
      "ERROR_CAPABILITY_DENIED",
    );
    const versionOffsets = new Map<string, number>();
    const call = async (name: string, arguments_: any) => {
      const args = { ...arguments_ };
      const workflowId = args.workflow_id;
      if (typeof args.expected_version === "number" && workflowId) {
        args.expected_version += versionOffsets.get(workflowId) ?? 0;
      }
      if (name === "workflow_submit_implementation") delete args.implementation_receipt;
      if (name === "workflow_submit_review") {
        const legacyReceipt = Object.hasOwn(args, "review_receipt");
        const isWorkingTree = args.review_target?.review_mode === "working_tree";
        delete args.review_receipt;
        delete args.review_target;
        if (legacyReceipt && isWorkingTree) {
          await client.callTool({
            name: "workflow_begin_review",
            arguments: {
              workflow_id: workflowId,
              capability: args.capability,
              expected_version: args.expected_version,
            },
          });
          versionOffsets.set(workflowId, (versionOffsets.get(workflowId) ?? 0) + 1);
          args.expected_version += 1;
        }
      }
      return JSON.parse(
        ((await client.callTool({ name, arguments: args })).content[0] as { text: string }).text,
      );
    };
    const base = created.workflow;
    const initialReceipt = makeReceipt(root);
    const implemented = await call("workflow_submit_implementation", {
      workflow_id: base.workflow_id,
      capability: created.capabilities.implementer,
      expected_version: 0,
      status: "DONE",
      summary: "implemented",
      agent_touched_paths: [],
      acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "accepted" }],
      validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "validated" }],
      implementation_receipt: initialReceipt,
      known_failures: [],
      finding_resolution_map: {},
    });
    assert.equal(implemented.phase, "REVIEWING");
    writeFileSync(join(root, "note.txt"), "after\n");
    const target = {
      review_mode: "working_tree",
      base_revision: base.base_head,
      head_revision: null,
      approved_paths: ["note.txt"],
      include_staged: true,
      include_unstaged: true,
      include_untracked: true,
    };
    const finding = {
      finding_id: "PROTO-1",
      severity: "P1",
      blocking: true,
      file_and_line: "note.txt:1",
      failure_scenario: "fails",
      impact: "bad",
      violated_requirement: "safe",
      remediation: "fix",
      missing_or_inadequate_test: "test",
    };
    const changes = await call("workflow_submit_review", {
      workflow_id: base.workflow_id,
      capability: created.capabilities.reviewer,
      expected_version: 1,
      review_status: "CHANGES_REQUESTED",
      blocking_findings: [finding],
      optional_findings: [],
      review_receipt: null,
      review_target: target,
      prior_finding_classifications: {},
    });
    assert.equal(changes.phase, "REPAIR_REQUIRED");
    const repairing = await call("workflow_authorize_repair", {
      workflow_id: base.workflow_id,
      capability: created.capabilities.parent,
      expected_version: 2,
      finding_ids: ["PROTO-1"],
    });
    assert.equal(repairing.phase, "REPAIRING");
    const receipt = makeReceipt(root);
    const repaired = await call("workflow_submit_implementation", {
      workflow_id: base.workflow_id,
      capability: created.capabilities.implementer,
      expected_version: 3,
      status: "DONE",
      summary: "repaired",
      agent_touched_paths: ["note.txt"],
      acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "repaired" }],
      validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "validated" }],
      implementation_receipt: receipt,
      known_failures: [],
      finding_resolution_map: { "PROTO-1": "resolved" },
    });
    assert.equal(repaired.phase, "REVIEWING");
    const approved = await call("workflow_submit_review", {
      workflow_id: base.workflow_id,
      capability: created.capabilities.reviewer,
      expected_version: 4,
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [],
      review_receipt: receipt,
      review_target: target,
      prior_finding_classifications: { "PROTO-1": "resolved" },
    });
    assert.equal(approved.phase, "STOPPED_APPROVED");
    const authorized = await call("workflow_authorize_commit", {
      workflow_id: base.workflow_id,
      capability: created.capabilities.parent,
      expected_version: 5,
      user_authorization: "protocol test commit",
    });
    assert.equal(authorized.phase, "COMMIT_AUTHORIZED");
    git("add", "note.txt");
    const preparedCommit = await call("workflow_prepare_commit", {
      workflow_id: base.workflow_id,
      capability: created.capabilities.committer,
      expected_version: 6,
    });
    git("commit", "-qm", "protocol change");
    const committed = await call("workflow_submit_commit_result", {
      workflow_id: base.workflow_id,
      capability: created.capabilities.committer,
      expected_version: 7,
      attempt_id: preparedCommit.commit_preparation.attempt_id,
      outcome: "committed",
      commit_hash: git("rev-parse", "HEAD"),
      failure_summary: null,
    });
    assert.equal(committed.phase, "COMMITTED");
    await client.close();
    await transport.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup corruption fails closed with an actionable stderr diagnostic", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "corrupt-state.sqlite");
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath });
    const created = store.create({
      workflow_type: "change",
      objective: "corrupt startup",
      approved_paths: ["note.txt"],
      acceptance_criteria: ["criterion"],
      validation_requirements: ["validation"],
      review_target: {
        review_mode: "working_tree",
        base_revision: git("rev-parse", "HEAD"),
        head_revision: null,
        approved_paths: ["note.txt"],
        include_staged: true,
        include_unstaged: true,
        include_untracked: true,
      },
    });
    store.db
      .prepare("UPDATE workflows SET state_json = ? WHERE workflow_id = ?")
      .run('{"schema_version":2}', created.workflow.workflow_id);
    store.close();
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          ["--no-warnings", join(process.cwd(), ".codex/workflow-mcp/server.ts")],
          {
            cwd: root,
            env: { ...process.env, WORKFLOW_MCP_DB_PATH: databasePath },
            input: "",
            encoding: "utf8",
            stdio: ["pipe", "pipe", "pipe"],
          },
        ),
      (error: unknown) => {
        const result = error as { stdout?: string; stderr?: string };
        assert.equal(result.stdout ?? "", "");
        assert.match(result.stderr ?? "", /ERROR_STATE_CORRUPT/);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("role view projection over STDIO returns only role data without capabilities", async () => {
  const { root, git } = fixture();
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--no-warnings", join(process.cwd(), ".codex", "workflow-mcp", "server.ts")],
      cwd: root,
      env: { ...process.env, WORKFLOW_MCP_DB_PATH: join(root, "state.sqlite") },
      stderr: "pipe",
    });
    const client = new Client({ name: "workflow-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const createdResult = await client.callTool({
      name: "workflow_create",
      arguments: {
        workflow_type: "change",
        objective: "role view protocol",
        approved_paths: ["note.txt"],
        acceptance_criteria: ["criterion"],
        validation_requirements: ["validation"],
        review_target: {
          review_mode: "working_tree",
          base_revision: git("rev-parse", "HEAD"),
          head_revision: null,
          approved_paths: ["note.txt"],
          include_staged: true,
          include_unstaged: true,
          include_untracked: true,
        },
      },
    });
    const created = JSON.parse((createdResult.content[0] as { text: string }).text);
    const get = async (role: string, capability: string) =>
      JSON.parse(
        (
          (
            await client.callTool({
              name: "workflow_get",
              arguments: { workflow_id: created.workflow.workflow_id, role, capability },
            })
          ).content[0] as { text: string }
        ).text,
      );

    const implementer = await get("implementer", created.capabilities.implementer);
    assert.equal(implementer.phase, "IMPLEMENTING");
    assert.deepEqual(implementer.permitted_next_actions, ["workflow_submit_implementation"]);
    assert.equal("initial_receipt" in implementer, false);
    assert.equal("acceptance_criteria" in implementer, true);
    assert.equal("review_receipt" in implementer, false);
    assert.equal("optional_findings" in implementer, false);
    assert.equal("commit_authorization" in implementer, false);

    const reviewer = await get("reviewer", created.capabilities.reviewer);
    assert.equal("initial_receipt" in reviewer, false);
    assert.equal("review_receipt" in reviewer, false);
    assert.equal("commit_authorization" in reviewer, false);

    const committer = await get("committer", created.capabilities.committer);
    assert.equal("initial_receipt" in committer, false);
    assert.equal("commit_authorization" in committer, true);

    const parent = await get("parent", created.capabilities.parent);
    assert.equal("initial_receipt" in parent, false);
    assert.equal("commit_authorization" in parent, true);
    for (const view of [implementer, reviewer, committer, parent]) {
      const serialized = JSON.stringify(view);
      assert.equal(serialized.includes("legacy_evidence"), false);
      for (const token of Object.values(created.capabilities)) {
        assert.equal(
          serialized.includes(token as string),
          false,
          `view contains capability ${token}`,
        );
      }
    }
    const denied = await client.callTool({
      name: "workflow_get",
      arguments: {
        workflow_id: created.workflow.workflow_id,
        role: "parent",
        capability: created.capabilities.implementer,
      },
    });
    assert.equal(denied.isError, true);
    assert.equal(
      JSON.parse((denied.content[0] as { text: string }).text).category,
      "ERROR_CAPABILITY_DENIED",
    );
    await client.close();
    await transport.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGINT and SIGTERM shutdown close the store and leave a reopenable database", async () => {
  const { root } = fixture();
  const script = join(process.cwd(), ".codex", "workflow-mcp", "server.ts");
  try {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const db = join(root, `${signal}.sqlite`);
      const child = spawn(process.execPath, ["--no-warnings", script], {
        cwd: root,
        env: { ...process.env, WORKFLOW_MCP_DB_PATH: db },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      const deadline = Date.now() + 3000;
      while (!existsSync(db) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(existsSync(db), true);
      child.kill(signal as NodeJS.Signals);
      const [code] = await once(child, "close");
      assert.equal(code, 0);
      assert.equal(stdout, "");
      const reopened = new WorkflowStore({ repositoryRoot: root, databasePath: db });
      reopened.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact create tool schema matches the normative contract", () => {
  const createTool = tools.find((tool) => tool.name === "workflow_create");
  assert.ok(createTool);
  const inputSchema = createTool.inputSchema as any;
  assert.equal(inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(inputSchema.properties).sort(), [
    "acceptance_criteria",
    "approved_paths",
    "max_repair_cycles",
    "objective",
    "review_target",
    "validation_requirements",
    "workflow_type",
  ]);
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
  const validationItem = inputSchema.properties.validation_requirements.items;
  const structuredValidation = validationItem.oneOf.find((entry: any) => entry.type === "object");
  assert.deepEqual(structuredValidation.required, ["description", "argv"]);
  assert.equal(structuredValidation.properties.argv.oneOf[0].type, "null");
  assert.equal(inputSchema.properties.max_repair_cycles.minimum, 0);
  assert.equal(inputSchema.properties.max_repair_cycles.maximum, 2);
  const target = inputSchema.properties.review_target;
  assert.deepEqual(target.oneOf.map((entry: any) => entry.properties.review_mode.enum[0]).sort(), [
    "commit_range",
    "working_tree",
  ]);
  const working = target.oneOf.find(
    (entry: any) => entry.properties.review_mode.enum[0] === "working_tree",
  );
  assert.equal(working.properties.head_revision.type, "null");
  assert.equal(working.properties.include_staged.const, true);
  assert.equal(working.properties.include_unstaged.const, true);
  assert.equal(working.properties.include_untracked.const, true);
  const range = target.oneOf.find(
    (entry: any) => entry.properties.review_mode.enum[0] === "commit_range",
  );
  assert.equal(range.properties.head_revision.pattern, "^[0-9a-f]{40}$");
  assert.equal(range.properties.include_staged.const, false);
  assert.equal(range.properties.include_unstaged.const, false);
  assert.equal(range.properties.include_untracked.const, false);
});

test("exact implementation tool schema matches the normative contract", () => {
  const submitTool = tools.find((tool) => tool.name === "workflow_submit_implementation");
  assert.ok(submitTool);
  const inputSchema = submitTool.inputSchema as any;
  assert.equal(inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(inputSchema.properties).sort(), [
    "acceptance_results",
    "agent_touched_paths",
    "capability",
    "expected_version",
    "finding_resolution_map",
    "known_failures",
    "status",
    "summary",
    "validation_results",
    "workflow_id",
  ]);
  assert.deepEqual(inputSchema.required, [
    "workflow_id",
    "capability",
    "expected_version",
    "status",
    "summary",
    "agent_touched_paths",
    "acceptance_results",
    "validation_results",
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

test("review submission schema accepts semantic data only", () => {
  const submitTool = tools.find((tool) => tool.name === "workflow_submit_review");
  assert.ok(submitTool);
  const inputSchema = submitTool.inputSchema as any;
  assert.equal(inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(inputSchema.properties).sort(), [
    "blocking_findings",
    "capability",
    "expected_version",
    "optional_findings",
    "prior_finding_classifications",
    "review_status",
    "workflow_id",
  ]);
  assert.deepEqual(inputSchema.required, [
    "workflow_id",
    "capability",
    "expected_version",
    "review_status",
    "blocking_findings",
    "optional_findings",
    "prior_finding_classifications",
  ]);
  assert.equal("review_target" in inputSchema.properties, false);
});

test("exact recovery tool schemas match the normative contract", () => {
  const resumeTool = tools.find((tool) => tool.name === "workflow_resume_implementation");
  assert.ok(resumeTool);
  const resumeSchema = resumeTool.inputSchema as any;
  assert.equal(resumeSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(resumeSchema.properties).sort(), [
    "capability",
    "expected_version",
    "resume_context",
    "workflow_id",
  ]);
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
  const acceptSchema = acceptTool.inputSchema as any;
  assert.equal(acceptSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(acceptSchema.properties).sort(), [
    "capability",
    "expected_version",
    "user_authorization",
    "workflow_id",
  ]);
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
  const resumeReviewSchema = resumeReviewTool.inputSchema as any;
  assert.equal(resumeReviewSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(resumeReviewSchema.properties).sort(), [
    "capability",
    "expected_version",
    "resume_context",
    "workflow_id",
  ]);
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
  const finalizeSchema = finalizeTool.inputSchema as any;
  assert.equal(finalizeSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(finalizeSchema.properties).sort(), [
    "capability",
    "expected_version",
    "workflow_id",
  ]);
  assert.deepEqual(finalizeSchema.required, ["workflow_id", "capability", "expected_version"]);
  assert.equal(
    tools.some((tool) => tool.name === "workflow_finalize_blocked"),
    false,
  );
});

test("exact linked follow-up tool schema matches the normative contract", () => {
  assert.equal(
    tools.some((tool) => tool.name.includes("optional_followup")),
    false,
  );
  const linkedTool = tools.find((tool) => tool.name === "workflow_create_linked_followup");
  assert.ok(linkedTool);
  const inputSchema = linkedTool.inputSchema as any;
  assert.equal(inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(inputSchema.properties).sort(), [
    "acceptance_criteria",
    "approved_paths",
    "capability",
    "expected_version",
    "finding_ids",
    "objective",
    "user_authorization",
    "validation_requirements",
    "workflow_id",
  ]);
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

test("exact prepare commit tool schema matches the normative contract", () => {
  const prepareTool = tools.find((tool) => tool.name === "workflow_prepare_commit");
  assert.ok(prepareTool);
  const inputSchema = prepareTool.inputSchema as any;
  assert.equal(inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(inputSchema.properties).sort(), [
    "capability",
    "expected_version",
    "workflow_id",
  ]);
  assert.deepEqual(inputSchema.required, ["workflow_id", "capability", "expected_version"]);
  assert.equal(inputSchema.properties.expected_version.minimum, 0);
  assert.equal(prepareTool.annotations?.destructiveHint, false);
});

test("implementation stops resume and concerns over STDIO", async () => {
  const { root, git } = fixture();
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--no-warnings", join(process.cwd(), ".codex", "workflow-mcp", "server.ts")],
      cwd: root,
      env: { ...process.env, WORKFLOW_MCP_DB_PATH: join(root, "state.sqlite") },
      stderr: "pipe",
    });
    const client = new Client({ name: "workflow-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const createdResult = await client.callTool({
      name: "workflow_create",
      arguments: {
        workflow_type: "change",
        objective: "recover",
        approved_paths: ["note.txt"],
        acceptance_criteria: ["criterion"],
        validation_requirements: ["validation"],
        review_target: {
          review_mode: "working_tree",
          base_revision: git("rev-parse", "HEAD"),
          head_revision: null,
          approved_paths: ["note.txt"],
          include_staged: true,
          include_unstaged: true,
          include_untracked: true,
        },
      },
    });
    const created = JSON.parse((createdResult.content[0] as { text: string }).text);
    const call = makeLegacyCompatibleCall(client);
    const base = created.workflow;
    const initialReceipt = makeReceipt(root);

    const stopped = await call("workflow_submit_implementation", {
      workflow_id: base.workflow_id,
      capability: created.capabilities.implementer,
      expected_version: 0,
      status: "NEEDS_CONTEXT",
      summary: "missing context",
      agent_touched_paths: [],
      acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "accepted" }],
      validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "validated" }],
      implementation_receipt: initialReceipt,
      known_failures: [],
      finding_resolution_map: {},
    });
    assert.equal(stopped.phase, "STOPPED_NEEDS_CONTEXT");
    assert.deepEqual(stopped.stop_context, {
      status: "NEEDS_CONTEXT",
      summary: "missing context",
      stopped_from: "IMPLEMENTING",
    });
    assert.deepEqual(stopped.permitted_next_actions, []);

    const resumeDenied = await client.callTool({
      name: "workflow_resume_implementation",
      arguments: {
        workflow_id: base.workflow_id,
        capability: created.capabilities.implementer,
        expected_version: 1,
        resume_context: "x",
      },
    });
    assert.equal(resumeDenied.isError, true);
    assert.equal(
      JSON.parse((resumeDenied.content[0] as { text: string }).text).category,
      "ERROR_CAPABILITY_DENIED",
    );

    const resumed = await call("workflow_resume_implementation", {
      workflow_id: base.workflow_id,
      capability: created.capabilities.parent,
      expected_version: 1,
      resume_context: "context now available",
    });
    assert.equal(resumed.phase, "IMPLEMENTING");
    assert.equal(resumed.recovery_context.kind, "implementation");

    const concerns = await call("workflow_submit_implementation", {
      workflow_id: base.workflow_id,
      capability: created.capabilities.implementer,
      expected_version: 2,
      status: "DONE_WITH_CONCERNS",
      summary: "done with flaky",
      agent_touched_paths: [],
      acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "accepted" }],
      validation_results: [{ validation_id: "VAL-001", status: "failed", evidence: "flaky" }],
      implementation_receipt: initialReceipt,
      known_failures: ["flaky test"],
      finding_resolution_map: {},
    });
    assert.equal(concerns.phase, "STOPPED_CONCERNS");

    const accepted = await call("workflow_accept_concerns", {
      workflow_id: base.workflow_id,
      capability: created.capabilities.parent,
      expected_version: 3,
      user_authorization: "user accepts flaky",
    });
    assert.equal(accepted.phase, "REVIEWING");
    assert.equal(accepted.concern_acceptance.user_authorization, "user accepts flaky");
    assert.equal(accepted.commit_authorization, null);

    const reviewed = await call("workflow_submit_review", {
      workflow_id: base.workflow_id,
      capability: created.capabilities.reviewer,
      expected_version: 4,
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [],
      review_receipt: initialReceipt,
      review_target: {
        review_mode: "working_tree",
        base_revision: base.base_head,
        head_revision: null,
        approved_paths: ["note.txt"],
        include_staged: true,
        include_unstaged: true,
        include_untracked: true,
      },
      prior_finding_classifications: {},
    });
    assert.equal(reviewed.phase, "STOPPED_APPROVED");
    await client.close();
    await transport.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review-only workflows over STDIO cover working-tree approval and range commit denial", async () => {
  const { root, git } = fixture();
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--no-warnings", join(process.cwd(), ".codex", "workflow-mcp", "server.ts")],
      cwd: root,
      env: { ...process.env, WORKFLOW_MCP_DB_PATH: join(root, "state.sqlite") },
      stderr: "pipe",
    });
    const client = new Client({ name: "workflow-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const call = makeLegacyCompatibleCall(client);
    const receipt = (paths: string[]): any => makeReceipt(root, paths);

    const wtResult = await call("workflow_create", {
      workflow_type: "review_only",
      objective: "working-tree review only",
      approved_paths: ["note.txt"],
      acceptance_criteria: ["review criterion"],
      validation_requirements: [],
      review_target: {
        review_mode: "working_tree",
        base_revision: git("rev-parse", "HEAD"),
        head_revision: null,
        approved_paths: ["note.txt"],
        include_staged: true,
        include_unstaged: true,
        include_untracked: true,
      },
    });
    assert.equal(wtResult.workflow.phase, "REVIEWING");
    assert.equal(wtResult.workflow.workflow_type, "review_only");
    assert.deepEqual(wtResult.workflow.permitted_next_actions, []);
    const wt = wtResult.workflow;
    const wtTarget = wt.review_target;
    assert.deepEqual(
      (
        await call("workflow_get", {
          workflow_id: wt.workflow_id,
          role: "reviewer",
          capability: wtResult.capabilities.reviewer,
        })
      ).permitted_next_actions,
      ["workflow_begin_review"],
    );
    const wtApproved = await call("workflow_submit_review", {
      workflow_id: wt.workflow_id,
      capability: wtResult.capabilities.reviewer,
      expected_version: 0,
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [],
      review_receipt: receipt(["note.txt"]),
      review_target: wtTarget,
      prior_finding_classifications: {},
    });
    assert.equal(wtApproved.phase, "STOPPED_APPROVED");
    const wtAuthorized = await call("workflow_authorize_commit", {
      workflow_id: wt.workflow_id,
      capability: wtResult.capabilities.parent,
      expected_version: 1,
      user_authorization: "authorize working-tree review-only",
    });
    assert.equal(wtAuthorized.phase, "COMMIT_AUTHORIZED");

    writeFileSync(join(root, "added.txt"), "added\n");
    git("add", "added.txt");
    git("commit", "-qm", "range head");
    const base = git("rev-parse", "HEAD~1");
    const head = git("rev-parse", "HEAD");
    const rangeResult = await call("workflow_create", {
      workflow_type: "review_only",
      objective: "range review only",
      approved_paths: ["added.txt", "note.txt"],
      acceptance_criteria: ["review criterion"],
      validation_requirements: [],
      review_target: {
        review_mode: "commit_range",
        base_revision: base,
        head_revision: head,
        approved_paths: ["added.txt", "note.txt"],
        include_staged: false,
        include_unstaged: false,
        include_untracked: false,
      },
    });
    assert.equal(rangeResult.workflow.phase, "REVIEWING");
    assert.equal("initial_receipt" in rangeResult.workflow, false);
    const range = rangeResult.workflow;
    const rangeApproved = await call("workflow_submit_review", {
      workflow_id: range.workflow_id,
      capability: rangeResult.capabilities.reviewer,
      expected_version: 0,
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [],
      review_receipt: null,
      review_target: range.review_target,
      prior_finding_classifications: {},
    });
    assert.equal(rangeApproved.phase, "STOPPED_APPROVED");
    assert.equal("review_receipt" in rangeApproved, false);
    assert.deepEqual(
      (
        await call("workflow_get", {
          workflow_id: range.workflow_id,
          role: "parent",
          capability: rangeResult.capabilities.parent,
        })
      ).permitted_next_actions,
      ["workflow_create_linked_followup"],
    );
    const denied = await client.callTool({
      name: "workflow_authorize_commit",
      arguments: {
        workflow_id: range.workflow_id,
        capability: rangeResult.capabilities.parent,
        expected_version: 1,
        user_authorization: "authorize range review-only",
      },
    });
    assert.equal(denied.isError, true);
    assert.equal(
      JSON.parse((denied.content[0] as { text: string }).text).category,
      "ERROR_COMMIT_NOT_ALLOWED",
    );
    await client.close();
    await transport.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("review resume and repair exhaustion over STDIO", async () => {
  const { root, git } = fixture();
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--no-warnings", join(process.cwd(), ".codex", "workflow-mcp", "server.ts")],
      cwd: root,
      env: { ...process.env, WORKFLOW_MCP_DB_PATH: join(root, "state.sqlite") },
      stderr: "pipe",
    });
    const client = new Client({ name: "workflow-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const call = makeLegacyCompatibleCall(client);
    const receipt = (): any => makeReceipt(root);

    const wtResult = await call("workflow_create", {
      workflow_type: "review_only",
      objective: "recover review",
      approved_paths: ["note.txt"],
      acceptance_criteria: ["criterion"],
      validation_requirements: [],
      review_target: {
        review_mode: "working_tree",
        base_revision: git("rev-parse", "HEAD"),
        head_revision: null,
        approved_paths: ["note.txt"],
        include_staged: true,
        include_unstaged: true,
        include_untracked: true,
      },
    });
    const wt = wtResult.workflow;
    const wtTarget = wt.review_target;
    const inconclusive = await call("workflow_submit_review", {
      workflow_id: wt.workflow_id,
      capability: wtResult.capabilities.reviewer,
      expected_version: 0,
      review_status: "INCONCLUSIVE",
      blocking_findings: [],
      optional_findings: [],
      review_receipt: null,
      review_target: wtTarget,
      prior_finding_classifications: {},
    });
    assert.equal(inconclusive.phase, "STOPPED_INCONCLUSIVE");
    assert.deepEqual(inconclusive.stop_context, {
      status: "INCONCLUSIVE",
      summary: "review context unavailable",
      stopped_from: "REVIEWING",
    });
    const resumed = await call("workflow_resume_review", {
      workflow_id: wt.workflow_id,
      capability: wtResult.capabilities.parent,
      expected_version: 1,
      resume_context: "context available",
    });
    assert.equal(resumed.phase, "REVIEWING");
    assert.equal(resumed.stop_context, null);
    assert.equal(resumed.recovery_context.kind, "review");
    assert.equal(resumed.recovery_context.context, "context available");
    const approved = await call("workflow_submit_review", {
      workflow_id: wt.workflow_id,
      capability: wtResult.capabilities.reviewer,
      expected_version: 2,
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [],
      review_receipt: receipt(),
      review_target: wtTarget,
      prior_finding_classifications: {},
    });
    assert.equal(approved.phase, "STOPPED_APPROVED");

    const chgResult = await call("workflow_create", {
      workflow_type: "change",
      objective: "exhaust",
      approved_paths: ["note.txt"],
      acceptance_criteria: ["criterion"],
      validation_requirements: ["validation"],
      max_repair_cycles: 0,
      review_target: {
        review_mode: "working_tree",
        base_revision: git("rev-parse", "HEAD"),
        head_revision: null,
        approved_paths: ["note.txt"],
        include_staged: true,
        include_unstaged: true,
        include_untracked: true,
      },
    });
    const chg = chgResult.workflow;
    await call("workflow_submit_implementation", {
      workflow_id: chg.workflow_id,
      capability: chgResult.capabilities.implementer,
      expected_version: 0,
      status: "DONE",
      summary: "done",
      agent_touched_paths: [],
      acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "accepted" }],
      validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "validated" }],
      implementation_receipt: receipt(),
      known_failures: [],
      finding_resolution_map: {},
    });
    const finding = {
      finding_id: "PROTO-EXH",
      severity: "P1",
      blocking: true,
      file_and_line: "note.txt:1",
      failure_scenario: "fails",
      impact: "bad",
      violated_requirement: "safe",
      remediation: "fix",
      missing_or_inadequate_test: "test",
    };
    await call("workflow_submit_review", {
      workflow_id: chg.workflow_id,
      capability: chgResult.capabilities.reviewer,
      expected_version: 1,
      review_status: "CHANGES_REQUESTED",
      blocking_findings: [finding],
      optional_findings: [],
      review_receipt: null,
      review_target: chg.review_target,
      prior_finding_classifications: {},
    });
    const exhausted = await call("workflow_finalize_repair_exhausted", {
      workflow_id: chg.workflow_id,
      capability: chgResult.capabilities.parent,
      expected_version: 2,
    });
    assert.equal(exhausted.phase, "STOPPED_REPAIR_EXHAUSTED");
    assert.deepEqual(
      (
        await call("workflow_get", {
          workflow_id: chg.workflow_id,
          role: "parent",
          capability: chgResult.capabilities.parent,
        })
      ).permitted_next_actions,
      ["workflow_create_linked_followup"],
    );
    const resumeDenied = await client.callTool({
      name: "workflow_resume_review",
      arguments: {
        workflow_id: chg.workflow_id,
        capability: chgResult.capabilities.parent,
        expected_version: 4,
        resume_context: "x",
      },
    });
    assert.equal(resumeDenied.isError, true);
    assert.equal(
      JSON.parse((resumeDenied.content[0] as { text: string }).text).category,
      "ERROR_INVALID_TRANSITION",
    );
    await client.close();
    await transport.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linked follow-up over STDIO creates a self-contained child without source capability", async () => {
  const { root, git } = fixture();
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--no-warnings", join(process.cwd(), ".codex", "workflow-mcp", "server.ts")],
      cwd: root,
      env: { ...process.env, WORKFLOW_MCP_DB_PATH: join(root, "state.sqlite") },
      stderr: "pipe",
    });
    const client = new Client({ name: "workflow-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const call = makeLegacyCompatibleCall(client);
    const receipt = (paths: string[]): any => makeReceipt(root, paths);

    const createdResult = await call("workflow_create", {
      workflow_type: "change",
      objective: "linked protocol",
      approved_paths: ["note.txt"],
      acceptance_criteria: ["criterion"],
      validation_requirements: ["validation"],
      review_target: {
        review_mode: "working_tree",
        base_revision: git("rev-parse", "HEAD"),
        head_revision: null,
        approved_paths: ["note.txt"],
        include_staged: true,
        include_unstaged: true,
        include_untracked: true,
      },
    });
    const created = createdResult.workflow;
    await call("workflow_submit_implementation", {
      workflow_id: created.workflow_id,
      capability: createdResult.capabilities.implementer,
      expected_version: 0,
      status: "DONE",
      summary: "done",
      agent_touched_paths: [],
      acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "accepted" }],
      validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "validated" }],
      implementation_receipt: receipt(["note.txt"]),
      known_failures: [],
      finding_resolution_map: {},
    });
    writeFileSync(join(root, "note.txt"), "after\n");
    const target = {
      review_mode: "working_tree",
      base_revision: created.base_head,
      head_revision: null,
      approved_paths: ["note.txt"],
      include_staged: true,
      include_unstaged: true,
      include_untracked: true,
    };
    const optional = {
      finding_id: "PROTO-LINK",
      severity: "P3",
      blocking: false,
      file_and_line: "note.txt:1",
      failure_scenario: "might fail",
      impact: "small",
      violated_requirement: "quality",
      remediation: "consider",
      missing_or_inadequate_test: "optional",
    };
    const approved = await call("workflow_submit_review", {
      workflow_id: created.workflow_id,
      capability: createdResult.capabilities.reviewer,
      expected_version: 1,
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [optional],
      review_receipt: receipt(["note.txt"]),
      review_target: target,
      prior_finding_classifications: {},
    });
    assert.equal(approved.phase, "STOPPED_APPROVED");
    assert.deepEqual(
      (
        await call("workflow_get", {
          workflow_id: created.workflow_id,
          role: "parent",
          capability: createdResult.capabilities.parent,
        })
      ).permitted_next_actions,
      ["workflow_authorize_commit", "workflow_create_linked_followup"],
    );

    const linkedResult = await call("workflow_create_linked_followup", {
      workflow_id: created.workflow_id,
      capability: createdResult.capabilities.parent,
      expected_version: 2,
      objective: "linked child",
      approved_paths: ["note.txt"],
      acceptance_criteria: ["child criterion"],
      validation_requirements: ["child validation"],
      finding_ids: ["PROTO-LINK"],
      user_authorization: "user authorized linked follow-up",
    });
    const child = linkedResult.workflow;
    assert.equal(child.phase, "IMPLEMENTING");
    assert.equal(child.source_workflow_id, created.workflow_id);
    assert.equal(child.parent_workflow_id, created.workflow_id);
    const childImplementer = await call("workflow_get", {
      workflow_id: child.workflow_id,
      role: "implementer",
      capability: linkedResult.capabilities.implementer,
    });
    assert.deepEqual(childImplementer.linked_findings, [optional]);
    assert.deepEqual(childImplementer.remediation_context, {
      policy: "explicitly_authorized",
      authorized_finding_ids: ["PROTO-LINK"],
      repair_cycle: 0,
      user_authorization: "user authorized linked follow-up",
    });
    assert.deepEqual(childImplementer.acceptance_criteria, [
      { criterion_id: "AC-001", description: "child criterion" },
    ]);
    assert.deepEqual(childImplementer.validation_requirements, [
      { validation_id: "VAL-001", description: "child validation", argv: null },
    ]);
    assert.deepEqual(childImplementer.permitted_next_actions, ["workflow_submit_implementation"]);
    const parentView = await call("workflow_get", {
      workflow_id: created.workflow_id,
      role: "parent",
      capability: createdResult.capabilities.parent,
    });
    assert.equal(parentView.version, 4);
    const audit = await call("workflow_get_audit", {
      workflow_id: created.workflow_id,
      role: "parent",
      capability: createdResult.capabilities.parent,
    });
    assert.equal(audit[audit.length - 1].event_type, "LINKED_FOLLOWUP_CREATED");
    assert.equal(audit[audit.length - 1].summary.linked_workflow_id, child.workflow_id);
    assert.equal(JSON.stringify(audit).includes("PROTO-LINK"), false);
    await client.close();
    await transport.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit preparation over STDIO verifies the staged index and binds the authorized receipt", async () => {
  const { root, git } = fixture();
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--no-warnings", join(process.cwd(), ".codex", "workflow-mcp", "server.ts")],
      cwd: root,
      env: { ...process.env, WORKFLOW_MCP_DB_PATH: join(root, "state.sqlite") },
      stderr: "pipe",
    });
    const client = new Client({ name: "workflow-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const call = makeLegacyCompatibleCall(client);
    const receipt = (): any => makeReceipt(root);

    const createdResult = await call("workflow_create", {
      workflow_type: "change",
      objective: "prepare protocol",
      approved_paths: ["note.txt"],
      acceptance_criteria: ["criterion"],
      validation_requirements: ["validation"],
      review_target: {
        review_mode: "working_tree",
        base_revision: git("rev-parse", "HEAD"),
        head_revision: null,
        approved_paths: ["note.txt"],
        include_staged: true,
        include_unstaged: true,
        include_untracked: true,
      },
    });
    const created = createdResult.workflow;
    await call("workflow_submit_implementation", {
      workflow_id: created.workflow_id,
      capability: createdResult.capabilities.implementer,
      expected_version: 0,
      status: "DONE",
      summary: "done",
      agent_touched_paths: [],
      acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "accepted" }],
      validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "validated" }],
      implementation_receipt: receipt(),
      known_failures: [],
      finding_resolution_map: {},
    });
    writeFileSync(join(root, "note.txt"), "after\n");
    const target = {
      review_mode: "working_tree",
      base_revision: created.base_head,
      head_revision: null,
      approved_paths: ["note.txt"],
      include_staged: true,
      include_unstaged: true,
      include_untracked: true,
    };
    const approved = await call("workflow_submit_review", {
      workflow_id: created.workflow_id,
      capability: createdResult.capabilities.reviewer,
      expected_version: 1,
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [],
      review_receipt: receipt(),
      review_target: target,
      prior_finding_classifications: {},
    });
    assert.equal(approved.phase, "STOPPED_APPROVED");
    const authorized = await call("workflow_authorize_commit", {
      workflow_id: created.workflow_id,
      capability: createdResult.capabilities.parent,
      expected_version: 2,
      user_authorization: "prepare protocol authorized",
    });
    assert.equal(authorized.phase, "COMMIT_AUTHORIZED");
    const head = git("rev-parse", "HEAD");
    git("add", "note.txt");
    const tree = git("write-tree");
    const prepared = await call("workflow_prepare_commit", {
      workflow_id: created.workflow_id,
      capability: createdResult.capabilities.committer,
      expected_version: 3,
    });
    assert.equal(prepared.phase, "COMMIT_PREPARED");
    assert.equal(prepared.commit_preparation.prepared_head, head);
    assert.equal(prepared.commit_preparation.prepared_tree, tree);
    assert.deepEqual(prepared.commit_preparation.expected_paths, ["note.txt"]);
    assert.match(prepared.commit_preparation.attempt_id, /^[0-9a-f-]{36}$/u);
    assert.match(prepared.commit_preparation.prepared_at, /^[0-9]{4}-/u);
    assert.equal("review_receipt_digest" in prepared.commit_preparation, false);
    assert.deepEqual(
      (
        await call("workflow_get", {
          workflow_id: created.workflow_id,
          role: "committer",
          capability: createdResult.capabilities.committer,
        })
      ).permitted_next_actions,
      ["workflow_submit_commit_result"],
    );
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.equal(git("write-tree"), tree);
    const denied = await client.callTool({
      name: "workflow_prepare_commit",
      arguments: {
        workflow_id: created.workflow_id,
        capability: createdResult.capabilities.reviewer,
        expected_version: 4,
      },
    });
    assert.equal(denied.isError, true);
    assert.equal(
      JSON.parse((denied.content[0] as { text: string }).text).category,
      "ERROR_CAPABILITY_DENIED",
    );
    await client.close();
    await transport.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact commit result and retry tool schemas match the normative contract", () => {
  const resultTool = tools.find((tool) => tool.name === "workflow_submit_commit_result");
  assert.ok(resultTool);
  const inputSchema = resultTool.inputSchema as any;
  assert.equal(inputSchema.additionalProperties, false);
  assert.deepEqual(Object.keys(inputSchema.properties).sort(), [
    "attempt_id",
    "capability",
    "commit_hash",
    "expected_version",
    "failure_summary",
    "outcome",
    "workflow_id",
  ]);
  assert.deepEqual(inputSchema.required, [
    "workflow_id",
    "capability",
    "expected_version",
    "attempt_id",
    "outcome",
    "commit_hash",
    "failure_summary",
  ]);
  assert.equal(inputSchema.properties.attempt_id.pattern, "^[0-9a-f-]{36}$");
  assert.deepEqual(inputSchema.properties.outcome.enum, ["committed", "not_committed"]);
  assert.equal(inputSchema.properties.expected_version.minimum, 0);
  assert.equal(inputSchema.properties.failure_summary.oneOf[0].maxLength, 2000);
  assert.equal(resultTool.annotations?.destructiveHint, true);

  const retryTool = tools.find((tool) => tool.name === "workflow_retry_commit");
  assert.ok(retryTool);
  const retrySchema = retryTool.inputSchema as any;
  assert.equal(retrySchema.additionalProperties, false);
  assert.deepEqual(Object.keys(retrySchema.properties).sort(), [
    "capability",
    "expected_version",
    "retry_context",
    "workflow_id",
  ]);
  assert.deepEqual(retrySchema.required, [
    "workflow_id",
    "capability",
    "expected_version",
    "retry_context",
  ]);
  assert.equal(retrySchema.properties.retry_context.minLength, 1);
  assert.equal(retrySchema.properties.retry_context.maxLength, 2000);
  assert.equal(retryTool.annotations?.destructiveHint, true);
});

test("commit result success over STDIO records a verified external commit", async () => {
  const { root, git } = fixture();
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--no-warnings", join(process.cwd(), ".codex", "workflow-mcp", "server.ts")],
      cwd: root,
      env: { ...process.env, WORKFLOW_MCP_DB_PATH: join(root, "state.sqlite") },
      stderr: "pipe",
    });
    const client = new Client({ name: "workflow-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const call = makeLegacyCompatibleCall(client);
    const receipt = (): any => makeReceipt(root);

    const createdResult = await call("workflow_create", {
      workflow_type: "change",
      objective: "commit result protocol",
      approved_paths: ["note.txt"],
      acceptance_criteria: ["criterion"],
      validation_requirements: ["validation"],
      review_target: {
        review_mode: "working_tree",
        base_revision: git("rev-parse", "HEAD"),
        head_revision: null,
        approved_paths: ["note.txt"],
        include_staged: true,
        include_unstaged: true,
        include_untracked: true,
      },
    });
    const created = createdResult.workflow;
    const caps = createdResult.capabilities;
    await call("workflow_submit_implementation", {
      workflow_id: created.workflow_id,
      capability: caps.implementer,
      expected_version: 0,
      status: "DONE",
      summary: "done",
      agent_touched_paths: [],
      acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "accepted" }],
      validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "validated" }],
      implementation_receipt: receipt(),
      known_failures: [],
      finding_resolution_map: {},
    });
    writeFileSync(join(root, "note.txt"), "after\n");
    const target = {
      review_mode: "working_tree",
      base_revision: created.base_head,
      head_revision: null,
      approved_paths: ["note.txt"],
      include_staged: true,
      include_unstaged: true,
      include_untracked: true,
    };
    const approved = await call("workflow_submit_review", {
      workflow_id: created.workflow_id,
      capability: caps.reviewer,
      expected_version: 1,
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [],
      review_receipt: receipt(),
      review_target: target,
      prior_finding_classifications: {},
    });
    assert.equal(approved.phase, "STOPPED_APPROVED");
    await call("workflow_authorize_commit", {
      workflow_id: created.workflow_id,
      capability: caps.parent,
      expected_version: 2,
      user_authorization: "commit result authorized",
    });
    git("add", "note.txt");
    const prepared = await call("workflow_prepare_commit", {
      workflow_id: created.workflow_id,
      capability: caps.committer,
      expected_version: 3,
    });
    assert.equal(prepared.phase, "COMMIT_PREPARED");
    git("commit", "-qm", "external commit");
    const hash = git("rev-parse", "HEAD");
    const committed = await call("workflow_submit_commit_result", {
      workflow_id: created.workflow_id,
      capability: caps.committer,
      expected_version: 4,
      attempt_id: prepared.commit_preparation.attempt_id,
      outcome: "committed",
      commit_hash: hash,
      failure_summary: null,
    });
    assert.equal(committed.phase, "COMMITTED");
    assert.deepEqual(committed.commit_result, {
      outcome: "committed",
      commit_hash: hash,
      failure_summary: null,
    });
    assert.deepEqual(
      (
        await call("workflow_get", {
          workflow_id: created.workflow_id,
          role: "committer",
          capability: caps.committer,
        })
      ).permitted_next_actions,
      [],
    );
    const audit = await call("workflow_get_audit", {
      workflow_id: created.workflow_id,
      role: "parent",
      capability: caps.parent,
    });
    const resultEvent = audit[audit.length - 1];
    assert.equal(resultEvent.event_type, "COMMIT_RESULT_SUBMITTED");
    assert.equal(resultEvent.summary.phase_before, "COMMIT_PREPARED");
    assert.equal(resultEvent.summary.phase_after, "COMMITTED");
    assert.equal(resultEvent.summary.outcome, "committed");
    assert.equal(JSON.stringify(audit).includes(hash), false);
    const deniedRetry = await client.callTool({
      name: "workflow_retry_commit",
      arguments: {
        workflow_id: created.workflow_id,
        capability: caps.parent,
        expected_version: 6,
        retry_context: "x",
      },
    });
    assert.equal(deniedRetry.isError, true);
    assert.equal(
      JSON.parse((deniedRetry.content[0] as { text: string }).text).category,
      "ERROR_INVALID_TRANSITION",
    );
    await client.close();
    await transport.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("not committed failure and retry over STDIO", async () => {
  const { root, git } = fixture();
  try {
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    writeFileSync(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(root, ".git", "hooks", "pre-commit"), 0o755);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--no-warnings", join(process.cwd(), ".codex", "workflow-mcp", "server.ts")],
      cwd: root,
      env: { ...process.env, WORKFLOW_MCP_DB_PATH: join(root, "state.sqlite") },
      stderr: "pipe",
    });
    const client = new Client({ name: "workflow-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const call = makeLegacyCompatibleCall(client);
    const receipt = (): any => makeReceipt(root);

    const createdResult = await call("workflow_create", {
      workflow_type: "change",
      objective: "retry protocol",
      approved_paths: ["note.txt"],
      acceptance_criteria: ["criterion"],
      validation_requirements: ["validation"],
      review_target: {
        review_mode: "working_tree",
        base_revision: git("rev-parse", "HEAD"),
        head_revision: null,
        approved_paths: ["note.txt"],
        include_staged: true,
        include_unstaged: true,
        include_untracked: true,
      },
    });
    const created = createdResult.workflow;
    const caps = createdResult.capabilities;
    await call("workflow_submit_implementation", {
      workflow_id: created.workflow_id,
      capability: caps.implementer,
      expected_version: 0,
      status: "DONE",
      summary: "done",
      agent_touched_paths: [],
      acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "accepted" }],
      validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "validated" }],
      implementation_receipt: receipt(),
      known_failures: [],
      finding_resolution_map: {},
    });
    writeFileSync(join(root, "note.txt"), "after\n");
    const target = {
      review_mode: "working_tree",
      base_revision: created.base_head,
      head_revision: null,
      approved_paths: ["note.txt"],
      include_staged: true,
      include_unstaged: true,
      include_untracked: true,
    };
    await call("workflow_submit_review", {
      workflow_id: created.workflow_id,
      capability: caps.reviewer,
      expected_version: 1,
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [],
      review_receipt: receipt(),
      review_target: target,
      prior_finding_classifications: {},
    });
    await call("workflow_authorize_commit", {
      workflow_id: created.workflow_id,
      capability: caps.parent,
      expected_version: 2,
      user_authorization: "retry authorized",
    });
    git("add", "note.txt");
    const prepared = await call("workflow_prepare_commit", {
      workflow_id: created.workflow_id,
      capability: caps.committer,
      expected_version: 3,
    });
    assert.equal(prepared.phase, "COMMIT_PREPARED");
    const headBefore = git("rev-parse", "HEAD");
    let failed = false;
    try {
      git("commit", "-qm", "blocked");
    } catch {
      failed = true;
    }
    assert.equal(failed, true);
    assert.equal(git("rev-parse", "HEAD"), headBefore);
    const stopped = await call("workflow_submit_commit_result", {
      workflow_id: created.workflow_id,
      capability: caps.committer,
      expected_version: 4,
      attempt_id: prepared.commit_preparation.attempt_id,
      outcome: "not_committed",
      commit_hash: null,
      failure_summary: "pre-commit hook blocked",
    });
    assert.equal(stopped.phase, "STOPPED_NOT_COMMITTED");
    assert.deepEqual(stopped.commit_result, {
      outcome: "not_committed",
      commit_hash: null,
      failure_summary: "pre-commit hook blocked",
    });
    assert.deepEqual(
      (
        await call("workflow_get", {
          workflow_id: created.workflow_id,
          role: "parent",
          capability: caps.parent,
        })
      ).permitted_next_actions,
      ["workflow_retry_commit"],
    );
    const retried = await call("workflow_retry_commit", {
      workflow_id: created.workflow_id,
      capability: caps.parent,
      expected_version: 5,
      retry_context: "hook fixed",
    });
    assert.equal(retried.phase, "COMMIT_AUTHORIZED");
    assert.equal(retried.commit_preparation, null);
    assert.equal(retried.commit_result, null);
    assert.equal(retried.recovery_context.kind, "commit");
    assert.equal(retried.recovery_context.context, "hook fixed");
    assert.equal(retried.commit_authorization.user_authorization, "retry authorized");
    assert.deepEqual(
      (
        await call("workflow_get", {
          workflow_id: created.workflow_id,
          role: "committer",
          capability: caps.committer,
        })
      ).permitted_next_actions,
      ["workflow_prepare_commit"],
    );
    const audit = await call("workflow_get_audit", {
      workflow_id: created.workflow_id,
      role: "parent",
      capability: caps.parent,
    });
    const retryEvent = audit[audit.length - 1];
    assert.equal(retryEvent.event_type, "COMMIT_RETRY_AUTHORIZED");
    assert.equal(retryEvent.summary.phase_before, "STOPPED_NOT_COMMITTED");
    assert.equal(retryEvent.summary.phase_after, "COMMIT_AUTHORIZED");
    assert.equal(retryEvent.summary.outcome, "retry");
    assert.equal(JSON.stringify(audit).includes("pre-commit hook blocked"), false);
    await client.close();
    await transport.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("commit mismatch over STDIO stops terminally and leaves no retry", async () => {
  const { root, git } = fixture();
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--no-warnings", join(process.cwd(), ".codex", "workflow-mcp", "server.ts")],
      cwd: root,
      env: { ...process.env, WORKFLOW_MCP_DB_PATH: join(root, "state.sqlite") },
      stderr: "pipe",
    });
    const client = new Client({ name: "workflow-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const call = makeLegacyCompatibleCall(client);
    const receipt = (): any => makeReceipt(root);

    const createdResult = await call("workflow_create", {
      workflow_type: "change",
      objective: "mismatch protocol",
      approved_paths: ["note.txt"],
      acceptance_criteria: ["criterion"],
      validation_requirements: ["validation"],
      review_target: {
        review_mode: "working_tree",
        base_revision: git("rev-parse", "HEAD"),
        head_revision: null,
        approved_paths: ["note.txt"],
        include_staged: true,
        include_unstaged: true,
        include_untracked: true,
      },
    });
    const created = createdResult.workflow;
    const caps = createdResult.capabilities;
    await call("workflow_submit_implementation", {
      workflow_id: created.workflow_id,
      capability: caps.implementer,
      expected_version: 0,
      status: "DONE",
      summary: "done",
      agent_touched_paths: [],
      acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "accepted" }],
      validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "validated" }],
      implementation_receipt: receipt(),
      known_failures: [],
      finding_resolution_map: {},
    });
    writeFileSync(join(root, "note.txt"), "after\n");
    const target = {
      review_mode: "working_tree",
      base_revision: created.base_head,
      head_revision: null,
      approved_paths: ["note.txt"],
      include_staged: true,
      include_unstaged: true,
      include_untracked: true,
    };
    const approved = await call("workflow_submit_review", {
      workflow_id: created.workflow_id,
      capability: caps.reviewer,
      expected_version: 1,
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [],
      review_receipt: receipt(),
      review_target: target,
      prior_finding_classifications: {},
    });
    assert.equal(approved.phase, "STOPPED_APPROVED");
    await call("workflow_authorize_commit", {
      workflow_id: created.workflow_id,
      capability: caps.parent,
      expected_version: 2,
      user_authorization: "mismatch authorized",
    });
    git("add", "note.txt");
    const prepared = await call("workflow_prepare_commit", {
      workflow_id: created.workflow_id,
      capability: caps.committer,
      expected_version: 3,
    });
    assert.equal(prepared.phase, "COMMIT_PREPARED");
    git("commit", "-qm", "moved head");
    const mismatched = await call("workflow_submit_commit_result", {
      workflow_id: created.workflow_id,
      capability: caps.committer,
      expected_version: 4,
      attempt_id: prepared.commit_preparation.attempt_id,
      outcome: "committed",
      commit_hash: created.base_head,
      failure_summary: null,
    });
    assert.equal(mismatched.phase, "STOPPED_COMMIT_MISMATCH");
    assert.deepEqual(mismatched.commit_result, {
      outcome: "mismatch",
      mismatch_category: "HEAD_CHANGED",
    });
    assert.deepEqual(
      (
        await call("workflow_get", {
          workflow_id: created.workflow_id,
          role: "parent",
          capability: caps.parent,
        })
      ).permitted_next_actions,
      [],
    );
    const denied = await client.callTool({
      name: "workflow_retry_commit",
      arguments: {
        workflow_id: created.workflow_id,
        capability: caps.parent,
        expected_version: 6,
        retry_context: "x",
      },
    });
    assert.equal(denied.isError, true);
    assert.equal(
      JSON.parse((denied.content[0] as { text: string }).text).category,
      "ERROR_INVALID_TRANSITION",
    );
    const audit = await call("workflow_get_audit", {
      workflow_id: created.workflow_id,
      role: "parent",
      capability: caps.parent,
    });
    const resultEvent = audit[audit.length - 1];
    assert.equal(resultEvent.event_type, "COMMIT_RESULT_SUBMITTED");
    assert.equal(resultEvent.summary.phase_after, "STOPPED_COMMIT_MISMATCH");
    assert.equal(resultEvent.summary.outcome, "mismatch");
    assert.equal(JSON.stringify(audit).includes("HEAD_CHANGED"), false);
    await client.close();
    await transport.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("v2 workflows deny legacy commit recording over STDIO", async () => {
  const { root, git } = fixture();
  try {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["--no-warnings", join(process.cwd(), ".codex", "workflow-mcp", "server.ts")],
      cwd: root,
      env: { ...process.env, WORKFLOW_MCP_DB_PATH: join(root, "state.sqlite") },
      stderr: "pipe",
    });
    const client = new Client({ name: "workflow-test", version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);
    const call = makeLegacyCompatibleCall(client);
    const receipt = (): any => makeReceipt(root);

    const createdResult = await call("workflow_create", {
      workflow_type: "change",
      objective: "record deny protocol",
      approved_paths: ["note.txt"],
      acceptance_criteria: ["criterion"],
      validation_requirements: ["validation"],
      review_target: {
        review_mode: "working_tree",
        base_revision: git("rev-parse", "HEAD"),
        head_revision: null,
        approved_paths: ["note.txt"],
        include_staged: true,
        include_unstaged: true,
        include_untracked: true,
      },
    });
    const created = createdResult.workflow;
    const caps = createdResult.capabilities;
    await call("workflow_submit_implementation", {
      workflow_id: created.workflow_id,
      capability: caps.implementer,
      expected_version: 0,
      status: "DONE",
      summary: "done",
      agent_touched_paths: [],
      acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "accepted" }],
      validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "validated" }],
      implementation_receipt: receipt(),
      known_failures: [],
      finding_resolution_map: {},
    });
    writeFileSync(join(root, "note.txt"), "after\n");
    const target = {
      review_mode: "working_tree",
      base_revision: created.base_head,
      head_revision: null,
      approved_paths: ["note.txt"],
      include_staged: true,
      include_unstaged: true,
      include_untracked: true,
    };
    await call("workflow_submit_review", {
      workflow_id: created.workflow_id,
      capability: caps.reviewer,
      expected_version: 1,
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [],
      review_receipt: receipt(),
      review_target: target,
      prior_finding_classifications: {},
    });
    await call("workflow_authorize_commit", {
      workflow_id: created.workflow_id,
      capability: caps.parent,
      expected_version: 2,
      user_authorization: "record deny authorized",
    });
    const denied = await client.callTool({
      name: "workflow_record_commit",
      arguments: {
        workflow_id: created.workflow_id,
        capability: caps.committer,
        expected_version: 4,
        commit_hash: git("rev-parse", "HEAD"),
      },
    });
    assert.equal(denied.isError, true);
    assert.equal(
      JSON.parse((denied.content[0] as { text: string }).text).category,
      "ERROR_LEGACY_WORKFLOW",
    );
    await client.close();
    await transport.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

interface AgentContract {
  name: string;
  description: string;
  model: string;
  developer_instructions: string;
}

interface WorkflowStateConfig {
  mcp_servers?: {
    workflow_state?: {
      command?: string;
      args?: string[];
      startup_timeout_sec?: number;
      tool_timeout_sec?: number;
      required?: boolean;
    };
  };
}

test("agent contracts parse as TOML and reference the authoritative v2 view and exact tools", () => {
  const contracts = {
    implementer: {
      file: ".codex/agents/implementer.toml",
      tools: ["workflow_get", "workflow_submit_implementation"],
    },
    reviewer: {
      file: ".codex/agents/code_reviewer.toml",
      tools: ["workflow_get", "workflow_submit_review"],
    },
    committer: {
      file: ".codex/agents/committer.toml",
      tools: ["workflow_get", "workflow_prepare_commit", "workflow_submit_commit_result"],
    },
  };
  for (const [name, contract] of Object.entries(contracts)) {
    const text = readFileSync(join(process.cwd(), contract.file), "utf8");
    const parsed = TOML.parse(text) as AgentContract;
    assert.equal(parsed.name, name === "reviewer" ? "code_reviewer" : name);
    assert.ok(parsed.description.length > 0);
    assert.ok(parsed.model.length > 0);
    const instructions = parsed.developer_instructions;
    assert.ok(instructions.length > 0);
    for (const tool of contract.tools) {
      assert.ok(instructions.includes(tool), `${name} instructions must reference ${tool}`);
    }
    for (const token of ["workflow_id", "capability", "expected_version", "workflow_get"]) {
      assert.ok(instructions.includes(token), `${name} instructions must mention ${token}`);
    }
    for (const obsolete of [
      /\bchanged_paths\b/,
      /\bacceptance_evidence\b/,
      /\bvalidation_evidence\b/,
      /\bready_for_commit\b/,
      /\bremediation_policy\b/,
      /\bauthorized_finding_ids\b/,
      /\brepair_cycle\b/,
      /\buser_authorization\b/,
      /\boptional_finding_ids\b/,
    ]) {
      assert.equal(
        obsolete.test(instructions),
        false,
        `${name} instructions must not carry prompt-authoritative field ${obsolete}`,
      );
    }
  }
});

test("project config.toml registers an immutable committed workflow_state bootstrap", () => {
  const text = readFileSync(join(process.cwd(), ".codex", "config.toml"), "utf8");
  const parsed = TOML.parse(text) as WorkflowStateConfig;
  const server = parsed.mcp_servers?.workflow_state;
  assert.ok(server, "config.toml must register mcp_servers.workflow_state");
  assert.equal(server.command, "sh");
  assert.deepEqual(server.args, [
    "-c",
    'export WORKFLOW_MCP_TRUSTED_PROVIDER_ROOT="$PWD"; bootstrap=$(mktemp) && trap \'rm -f "$bootstrap"\' EXIT && git show HEAD:.codex/workflow-mcp/bootstrap.ts >"$bootstrap" && bun --no-warnings "$bootstrap"; status=$?; exit "$status"',
  ]);
  assert.equal(existsSync(join(process.cwd(), ".codex/workflow-mcp/bootstrap.ts")), true);
  assert.equal(typeof server.startup_timeout_sec, "number");
  assert.ok((server.startup_timeout_sec ?? 0) >= 1);
  assert.equal(typeof server.tool_timeout_sec, "number");
  assert.ok((server.tool_timeout_sec ?? 0) >= 1);
  assert.throws(() => TOML.parse('command = "unterminated'), /unterminated/i);
});

test("obsolete names are absent and workflow_record_commit appears only in migrated-v1 compatibility text", () => {
  const ownedTexts = [
    ".codex/agents/WORKFLOW.md",
    ".codex/agents/implementer.toml",
    ".codex/agents/code_reviewer.toml",
    ".codex/agents/committer.toml",
    ".codex/agents/EVALS.md",
    ".codex/workflow-mcp/README.md",
    ".codex/workflow-mcp/server.ts",
  ];
  for (const file of ownedTexts) {
    const text = readFileSync(join(process.cwd(), file), "utf8");
    for (const obsolete of [
      "STOPPED_" + "BLOCKED",
      "workflow_create_" + "optional_followup",
      "optional-ID-" + "only",
    ]) {
      assert.equal(text.includes(obsolete), false, `${file} must not contain ${obsolete}`);
    }
  }
  for (const file of [".codex/agents/WORKFLOW.md", ".codex/workflow-mcp/README.md"]) {
    const text = readFileSync(join(process.cwd(), file), "utf8");
    let from = 0;
    let occurrences = 0;
    while (true) {
      const idx = text.indexOf("workflow_record_commit", from);
      if (idx < 0) break;
      occurrences++;
      const windowText = text.slice(Math.max(0, idx - 200), idx + 200);
      assert.ok(
        /migrat/i.test(windowText),
        `${file} must mention workflow_record_commit only inside a labeled migrated-v1 compatibility paragraph`,
      );
      from = idx + 1;
    }
    assert.ok(
      occurrences > 0,
      `${file} must document the migrated-v1 workflow_record_commit compatibility`,
    );
  }
  const recordTool = tools.find((tool) => tool.name === "workflow_record_commit");
  assert.ok(recordTool);
  assert.match(recordTool.description as string, /migrat/i);
});

test("normal documentation covers review-only dispatch, recovery, and the prepare/submit commit flow", () => {
  const workflowMd = readFileSync(join(process.cwd(), ".codex", "agents", "WORKFLOW.md"), "utf8");
  const readme = readFileSync(join(process.cwd(), ".codex", "workflow-mcp", "README.md"), "utf8");
  for (const [name, text] of [
    ["WORKFLOW.md", workflowMd],
    ["README.md", readme],
  ]) {
    assert.ok(
      text.includes("workflow_prepare_commit"),
      `${name} must document workflow_prepare_commit`,
    );
    assert.ok(
      text.includes("workflow_submit_commit_result"),
      `${name} must document workflow_submit_commit_result`,
    );
    assert.ok(/review.only|review_only/i.test(text), `${name} must document review-only workflows`);
    assert.ok(
      text.includes("workflow_create_linked_followup"),
      `${name} must document linked follow-ups`,
    );
    assert.ok(
      text.includes("skipping the implementer"),
      `${name} must document that review-only dispatch skips the implementer`,
    );
  }
  for (const tool of [
    "workflow_resume_implementation",
    "workflow_accept_concerns",
    "workflow_resume_review",
    "workflow_finalize_repair_exhausted",
    "workflow_retry_commit",
  ]) {
    assert.ok(workflowMd.includes(tool), `WORKFLOW.md must document ${tool}`);
  }
});
