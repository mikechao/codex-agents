import { test } from "bun:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { diagnosticsDirectory } from "../diagnostics.js";
import { WorkflowStore } from "../store.js";
import { fixture, receipt } from "./test-fixtures.js";

const SERVER = join(process.cwd(), ".codex", "workflow-mcp", "server.ts");

function target(base: string, paths = ["note.txt"]) {
  return {
    review_mode: "working_tree",
    base_revision: base,
    head_revision: null,
    approved_paths: paths,
    include_staged: true,
    include_unstaged: true,
    include_untracked: true,
  };
}

async function start(root: string, diagnostics = false) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--no-warnings", SERVER],
    cwd: root,
    env: {
      ...process.env,
      WORKFLOW_MCP_DB_PATH: join(root, "state.sqlite"),
      ...(diagnostics ? { WORKFLOW_MCP_DIAGNOSTICS: "1" } : {}),
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "workflow-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  const call = async (name: string, arguments_: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: arguments_ });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    if (result.isError) throw new Error(`${name}: ${body.category}`);
    return body;
  };
  return { client, transport, call };
}

function createArgs(git: (...args: string[]) => string, options: any = {}) {
  const paths = options.approved_paths ?? ["note.txt"];
  return {
    workflow_type: options.workflow_type ?? "change",
    objective: options.objective ?? "stdio protocol",
    approved_plan: options.approved_plan ?? null,
    approved_paths: paths,
    acceptance_criteria: ["criterion"],
    validation_requirements: [{ description: "validation", argv: ["bun", "run", "check"] }],
    review_target: options.review_target ?? target(git("rev-parse", "HEAD"), paths),
  };
}

function implementation(
  id: string,
  version: number,
  status = "DONE",
  resolution: Record<string, string> = {},
) {
  return {
    workflow_id: id,
    expected_version: version,
    status,
    summary: "implementation evidence",
    agent_touched_paths: [],
    acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "accepted" }],
    validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "validated" }],
    known_failures: [],
    finding_resolution_map: resolution,
  };
}

test("STDIO exposes exact role tools and drives a capability-free worker lifecycle", async () => {
  const { root, git } = fixture();
  const { client, transport, call } = await start(root);
  try {
    const version = async (id: string) =>
      (await call("workflow_parent_get", { workflow_id: id })).version;
    const listed = await client.listTools();
    assert.equal(
      listed.tools.some((tool) => tool.name === "workflow_get"),
      false,
    );
    for (const name of [
      "workflow_parent_get",
      "workflow_implementer_get",
      "workflow_reviewer_get",
      "workflow_committer_get",
    ]) {
      assert.ok(listed.tools.some((tool) => tool.name === name));
    }
    const created = await call("workflow_create", createArgs(git));
    const id = created.workflow.workflow_id;
    assert.equal(typeof created.capability, "string");
    assert.equal("capabilities" in created, false);
    assert.equal(
      (await call("workflow_implementer_get", { workflow_id: id })).phase,
      "IMPLEMENTING",
    );
    const incomplete = await call(
      "workflow_submit_implementation",
      implementation(id, await version(id), "INCOMPLETE"),
    );
    assert.equal(incomplete.phase, "IMPLEMENTING");
    assert.equal(incomplete.stop_context, null);
    assert.deepEqual(incomplete.permitted_next_actions, ["workflow_submit_implementation"]);
    assert.deepEqual(
      (await call("workflow_reviewer_get", { workflow_id: id })).permitted_next_actions,
      [],
    );
    assert.equal(
      (await call("workflow_submit_implementation", implementation(id, await version(id)))).phase,
      "REVIEWING",
    );
    writeFileSync(join(root, "note.txt"), "after\n");
    assert.equal(
      (
        await call("workflow_begin_review", {
          workflow_id: id,
          expected_version: await version(id),
        })
      ).phase,
      "REVIEWING",
    );
    assert.equal(
      (
        await call("workflow_submit_review", {
          workflow_id: id,
          expected_version: await version(id),
          review_status: "APPROVED",
          blocking_findings: [],
          optional_findings: [],
          prior_finding_classifications: {},
        })
      ).phase,
      "STOPPED_APPROVED",
    );
    assert.equal(
      (
        await call("workflow_authorize_commit", {
          workflow_id: id,
          capability: created.capability,
          expected_version: await version(id),
          user_authorization: "protocol commit",
        })
      ).phase,
      "COMMIT_AUTHORIZED",
    );
    git("add", "note.txt");
    const prepared = await call("workflow_prepare_commit", {
      workflow_id: id,
      expected_version: await version(id),
    });
    git("commit", "-qm", "stdio protocol");
    assert.equal(
      (
        await call("workflow_submit_commit_result", {
          workflow_id: id,
          expected_version: await version(id),
          attempt_id: prepared.commit_preparation.attempt_id,
          outcome: "committed",
          failure_summary: null,
        })
      ).phase,
      "COMMITTED",
    );
    const audit = await call("workflow_get_audit", {
      workflow_id: id,
      capability: created.capability,
    });
    assert.deepEqual(
      audit.map((event: any) => event.event_type),
      [
        "WORKFLOW_CREATED",
        "IMPLEMENTATION_INCOMPLETE",
        "IMPLEMENTATION_SUBMITTED",
        "REVIEW_STARTED",
        "REVIEW_SUBMITTED",
        "COMMIT_AUTHORIZED",
        "COMMIT_PREPARED",
        "COMMIT_RESULT_SUBMITTED",
      ],
    );
  } finally {
    await client.close();
    await transport.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("STDIO planning operations preserve exact revisions and bind only the approved current revision", async () => {
  const targetFixture = fixture();
  const { root } = targetFixture;
  const { transport, client, call } = await start(root);
  try {
    const draft = await call("plan_create", {
      full_plan: "full plan text",
      execution_brief: "bounded execution brief",
      objective: "stdio planning",
      approved_paths: ["note.txt"],
      acceptance_criteria: ["plan survives"],
      validation_requirements: [{ description: "manual check", argv: null }],
    });
    assert.equal(draft.metadata.status, "draft");
    assert.deepEqual(draft.validation_requirements, [
      { validation_id: "VAL-001", description: "manual check", argv: null },
    ]);
    const revised = await call("plan_revise", {
      plan_id: draft.plan_id,
      base_revision: 1,
      full_plan: "replacement full plan",
      execution_brief: "replacement brief",
      objective: "stdio planning revised",
      approved_paths: ["note.txt"],
      acceptance_criteria: ["replacement survives"],
      validation_requirements: ["manual replacement"],
    });
    assert.equal(revised.revision, 2);
    assert.equal(
      (await call("plan_get", { plan_id: draft.plan_id, revision: 1 })).full_plan,
      "full plan text",
    );
    const approved = await call("plan_approve", {
      plan_id: draft.plan_id,
      revision: 2,
      user_authorization: "approve current exact revision",
    });
    assert.equal(approved.metadata.status, "approved");
    const created = await call("workflow_create_from_plan", {
      plan_id: draft.plan_id,
      revision: 2,
      work_items: [],
    });
    assert.equal(created.workflow.approved_plan, "replacement full plan");
    assert.equal(created.workflow.execution_brief, "replacement brief");
    assert.equal(created.workflow.objective, "stdio planning revised");
    assert.equal(created.workflow.plan_provenance.revision, 2);
  } finally {
    await client.close();
    await transport.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("STDIO role routing is exact and parent authorization remains protected", async () => {
  const { root, git } = fixture();
  const { client, transport, call } = await start(root);
  try {
    const first = await call("workflow_create", createArgs(git, { objective: "first workflow" }));
    const second = await call("workflow_create", createArgs(git, { objective: "second workflow" }));
    assert.equal(
      (await call("workflow_reviewer_get", { workflow_id: first.workflow.workflow_id })).objective,
      "first workflow",
    );
    assert.equal(
      (await call("workflow_committer_get", { workflow_id: second.workflow.workflow_id }))
        .objective,
      "second workflow",
    );
    const denied = await client.callTool({
      name: "workflow_authorize_commit",
      arguments: {
        workflow_id: first.workflow.workflow_id,
        capability: "wrong",
        expected_version: 0,
        user_authorization: "denied",
      },
    });
    assert.equal(denied.isError, true);
    assert.equal(
      JSON.parse((denied.content[0] as { text: string }).text).category,
      "ERROR_CAPABILITY_DENIED",
    );
    const malformed = await client.callTool({
      name: "workflow_submit_implementation",
      arguments: { ...implementation(first.workflow.workflow_id, 0), capability: first.capability },
    });
    assert.equal(malformed.isError, true);
    assert.equal(
      JSON.parse((malformed.content[0] as { text: string }).text).category,
      "ERROR_INVALID_SHAPE",
    );
  } finally {
    await client.close();
    await transport.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("startup corruption fails closed with an actionable stderr diagnostic", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "corrupt.sqlite");
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath });
    store.create(createArgs(git));
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
    rmSync(root, { recursive: true, force: true });
  }
});

test("receipt capture stays server-owned for worker submissions", async () => {
  const { root, git } = fixture();
  const { client, transport, call } = await start(root);
  try {
    const created = await call("workflow_create", createArgs(git));
    const result = await call(
      "workflow_submit_implementation",
      implementation(created.workflow.workflow_id, 0),
    );
    assert.equal(result.phase, "REVIEWING");
    assert.equal("initial_receipt" in result, false);
    assert.equal("implementation_receipt" in result, false);
    assert.equal(
      (await call("workflow_reviewer_get", { workflow_id: created.workflow.workflow_id })).phase,
      "REVIEWING",
    );
  } finally {
    await client.close();
    await transport.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("test fixture receipts remain available only for direct receipt assertions", () => {
  const { root } = fixture();
  try {
    const current = receipt(root);
    assert.equal(current.approved_paths[0], "note.txt");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("opt-in child diagnostics correlate tool receipt and result without touching stdout", async () => {
  const { root, git } = fixture();
  const { client, transport, call } = await start(root, true);
  try {
    const created = await call("workflow_create", createArgs(git));
    await call("workflow_parent_get", { workflow_id: created.workflow.workflow_id });
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
    await client.close();
    await transport.close();
    rmSync(diagnosticsDirectory(root), { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
