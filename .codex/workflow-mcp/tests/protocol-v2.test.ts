import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { WorkflowStore } from "../store.js";
import { fixture } from "./test-fixtures.js";

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

async function connect(root: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--no-warnings", SERVER],
    cwd: root,
    env: { ...process.env, WORKFLOW_MCP_DB_PATH: join(root, "state.sqlite") },
    stderr: "pipe",
  });
  const client = new Client({ name: "protocol-v2", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const body = JSON.parse((result.content[0] as { text: string }).text);
    if (name === "workflow_create" || name.startsWith("workflow_create_linked"))
      Object.defineProperty(body, "workflow", { value: body, enumerable: false });
    return { result, body };
  };
  const version = async (id: string) =>
    (await call("workflow_parent_get", { workflow_id: id })).body.version;
  return { client, transport, call, version };
}

function create(git: (...args: string[]) => string, options: any = {}) {
  const paths = options.approved_paths ?? ["note.txt"];
  return {
    workflow_type: options.workflow_type ?? "change",
    objective: options.objective ?? "protocol v2",
    approved_plan: null,
    approved_paths: paths,
    acceptance_criteria: ["criterion"],
    validation_requirements: options.validation_requirements ?? [
      { description: "validation", argv: ["bun", "run", "check"] },
    ],
    review_target: options.review_target ?? target(git("rev-parse", "HEAD"), paths),
    max_repair_cycles: options.max_repair_cycles,
  };
}

function implement(
  id: string,
  version: number,
  status = "DONE",
  resolution: Record<string, string> = {},
) {
  return {
    workflow_id: id,
    expected_version: version,
    status,
    summary: "implementation",
    agent_touched_paths: [],
    acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "accepted" }],
    validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "validated" }],
    known_failures: [],
    finding_resolution_map: resolution,
  };
}

function finding(id: string) {
  return {
    finding_id: id,
    severity: "P1",
    blocking: true,
    file_and_line: "note.txt:1",
    failure_scenario: "scenario",
    impact: "impact",
    violated_requirement: "requirement",
    remediation: "fix",
    missing_or_inadequate_test: "test",
  };
}

test("fresh STDIO repair and re-review uses exact role getters and worker IDs only", async () => {
  const { root, git } = fixture();
  const { client, transport, call, version } = await connect(root);
  try {
    const created = (await call("workflow_create", create(git, { max_repair_cycles: 1 }))).body;
    const id = created.workflow.workflow_id;
    assert.equal(
      (await call("workflow_submit_implementation", implement(id, await version(id)))).body.phase,
      "REVIEWING",
    );
    await call("workflow_begin_review", { workflow_id: id, expected_version: await version(id) });
    const changes = (
      await call("workflow_submit_review", {
        workflow_id: id,
        expected_version: await version(id),
        review_status: "CHANGES_REQUESTED",
        blocking_findings: [finding("BLOCKER-1")],
        optional_findings: [],
        prior_finding_classifications: {},
      })
    ).body;
    assert.equal(changes.phase, "REPAIR_REQUIRED");
    const repairing = (
      await call("workflow_authorize_repair", {
        workflow_id: id,
        capability: created.capability,
        expected_version: await version(id),
        finding_ids: ["BLOCKER-1"],
      })
    ).body;
    assert.equal(repairing.phase, "REPAIRING");
    assert.equal(
      (
        await call(
          "workflow_submit_implementation",
          implement(id, await version(id), "DONE", { "BLOCKER-1": "resolved" }),
        )
      ).body.phase,
      "REVIEWING",
    );
    writeFileSync(join(root, "note.txt"), "repaired\n");
    await call("workflow_begin_review", { workflow_id: id, expected_version: await version(id) });
    const approved = (
      await call("workflow_submit_review", {
        workflow_id: id,
        expected_version: await version(id),
        review_status: "APPROVED",
        blocking_findings: [],
        optional_findings: [],
        prior_finding_classifications: { "BLOCKER-1": "resolved" },
      })
    ).body;
    assert.equal(approved.phase, "STOPPED_APPROVED");
    const reviewer = (await call("workflow_reviewer_get", { workflow_id: id })).body;
    assert.deepEqual(reviewer.permitted_next_actions, []);
  } finally {
    await client.close();
    await transport.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh linked follow-up routes exact child IDs and preserves parent audit authorization", async () => {
  const { root, git } = fixture();
  const { client, transport, call, version } = await connect(root);
  try {
    const source = (await call("workflow_create", create(git, { objective: "source" }))).body;
    const id = source.workflow.workflow_id;
    await call("workflow_submit_implementation", implement(id, await version(id)));
    writeFileSync(join(root, "note.txt"), "source\n");
    await call("workflow_begin_review", { workflow_id: id, expected_version: await version(id) });
    await call("workflow_submit_review", {
      workflow_id: id,
      expected_version: await version(id),
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [{ ...finding("OPTIONAL-1"), severity: "P3", blocking: false }],
      prior_finding_classifications: {},
    });
    const linked = (
      await call("workflow_create_linked_followup", {
        workflow_id: id,
        capability: source.capability,
        expected_version: await version(id),
        objective: "child",
        approved_plan: null,
        approved_paths: ["note.txt"],
        acceptance_criteria: ["child criterion"],
        validation_requirements: [
          { description: "child validation", argv: ["bun", "run", "check"] },
        ],
        finding_ids: ["OPTIONAL-1"],
        user_authorization: "authorized child",
      })
    ).body;
    assert.notEqual(linked.workflow.workflow_id, id);
    assert.equal("capability" in linked, false);
    assert.equal("capabilities" in linked, false);
    assert.equal(
      (await call("workflow_implementer_get", { workflow_id: linked.workflow.workflow_id })).body
        .workflow_id,
      linked.workflow.workflow_id,
    );
    const audit = (
      await call("workflow_get_audit", { workflow_id: id, capability: source.capability })
    ).body;
    assert.equal(audit.at(-1).event_type, "LINKED_FOLLOWUP_CREATED");
    assert.equal(JSON.stringify(audit).includes("OPTIONAL-1"), false);
  } finally {
    await client.close();
    await transport.close();
    rmSync(root, { recursive: true, force: true });
  }
});

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
            /* parser above records malformed lines */
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
      arguments: create(git),
    });
    const body = JSON.parse(created.result.content[0].text);
    assert.equal("capability" in body, false);
    assert.equal("capabilities" in body, false);
    assert.deepEqual(invalid, []);
    assert.equal(output.endsWith("\n"), true);
  } finally {
    child.kill("SIGTERM");
    await once(child, "close");
    rmSync(root, { recursive: true, force: true });
  }
});

test("direct store can reopen the exact schema after protocol activity", () => {
  const { root, git } = fixture();
  try {
    const path = join(root, "state.sqlite");
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const created = store.create(create(git));
    assert.equal(store.parentGet(created.workflow.workflow_id).version, 0);
    store.close();
    const reopened: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    assert.equal(
      reopened.parentGet(created.workflow.workflow_id).workflow_id,
      created.workflow.workflow_id,
    );
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("STDIO commit-range review remains receipt-free and cannot authorize a commit", async () => {
  const { root, git } = fixture();
  const { client, transport, call, version } = await connect(root);
  try {
    writeFileSync(join(root, "range.txt"), "range\n");
    git("add", "range.txt");
    git("commit", "-qm", "range review");
    const base = git("rev-parse", "HEAD~1");
    const head = git("rev-parse", "HEAD");
    const created = (
      await call(
        "workflow_create",
        create(git, {
          workflow_type: "review_only",
          approved_paths: ["range.txt"],
          validation_requirements: [],
          review_target: {
            review_mode: "commit_range",
            base_revision: base,
            head_revision: head,
            approved_paths: ["range.txt"],
            include_staged: false,
            include_unstaged: false,
            include_untracked: false,
          },
        }),
      )
    ).body;
    const id = created.workflow.workflow_id;
    assert.equal(created.workflow.phase, "REVIEWING");
    assert.equal("initial_receipt" in created.workflow, false);
    const approved = (
      await call("workflow_submit_review", {
        workflow_id: id,
        expected_version: await version(id),
        review_status: "APPROVED",
        blocking_findings: [],
        optional_findings: [],
        prior_finding_classifications: {},
      })
    ).body;
    assert.equal(approved.phase, "STOPPED_APPROVED");
    assert.deepEqual(
      (await call("workflow_reviewer_get", { workflow_id: id })).body.permitted_next_actions,
      [],
    );
    const denied = await client.callTool({
      name: "workflow_authorize_commit",
      arguments: {
        workflow_id: id,
        capability: created.capability,
        expected_version: await version(id),
        user_authorization: "range commit must be denied",
      },
    });
    assert.equal(denied.isError, true);
    assert.equal(
      JSON.parse((denied.content[0] as { text: string }).text).category,
      "ERROR_COMMIT_NOT_ALLOWED",
    );
  } finally {
    await client.close();
    await transport.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("STDIO unchanged-head commit failure is retryable through parent authorization", async () => {
  const { root, git } = fixture();
  const { client, transport, call, version } = await connect(root);
  try {
    const created = (await call("workflow_create", create(git))).body;
    const id = created.workflow.workflow_id;
    await call("workflow_submit_implementation", implement(id, await version(id)));
    writeFileSync(join(root, "note.txt"), "retryable\n");
    await call("workflow_begin_review", { workflow_id: id, expected_version: await version(id) });
    await call("workflow_submit_review", {
      workflow_id: id,
      expected_version: await version(id),
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [],
      prior_finding_classifications: {},
    });
    await call("workflow_authorize_commit", {
      workflow_id: id,
      capability: created.capability,
      expected_version: await version(id),
      user_authorization: "retryable protocol commit",
    });
    git("add", "note.txt");
    const prepared = (
      await call("workflow_prepare_commit", {
        workflow_id: id,
        expected_version: await version(id),
      })
    ).body;
    const stopped = (
      await call("workflow_submit_commit_result", {
        workflow_id: id,
        expected_version: await version(id),
        attempt_id: prepared.commit_preparation.attempt_id,
        outcome: "not_committed",
        failure_summary: "external commit command failed",
      })
    ).body;
    assert.equal(stopped.phase, "STOPPED_NOT_COMMITTED");
    assert.deepEqual(stopped.commit_result, {
      outcome: "not_committed",
      commit_hash: null,
      failure_summary: "external commit command failed",
    });
    const retried = (
      await call("workflow_retry_commit", {
        workflow_id: id,
        capability: created.capability,
        expected_version: await version(id),
        retry_context: "external command fixed",
      })
    ).body;
    assert.equal(retried.phase, "COMMIT_AUTHORIZED");
    assert.equal(retried.commit_preparation, null);
    assert.equal(retried.commit_result, null);
    assert.deepEqual(
      (await call("workflow_committer_get", { workflow_id: id })).body.permitted_next_actions,
      ["workflow_prepare_commit"],
    );
  } finally {
    await client.close();
    await transport.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("STDIO commit verification covers head, tree, and not-committed mismatch matrices", async () => {
  const { root, git } = fixture();
  const { client, transport, call } = await connect(root);
  const version = async (id: string) =>
    (await call("workflow_parent_get", { workflow_id: id })).body.version;
  const failed = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    return JSON.parse((result.content[0] as { text: string }).text);
  };
  const prepare = async (objective: string) => {
    const created = (await call("workflow_create", create(git, { objective }))).body;
    const id = created.workflow.workflow_id;
    await call("workflow_submit_implementation", implement(id, await version(id)));
    writeFileSync(join(root, "note.txt"), `${objective}\n`);
    await call("workflow_begin_review", { workflow_id: id, expected_version: await version(id) });
    await call("workflow_submit_review", {
      workflow_id: id,
      expected_version: await version(id),
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [],
      prior_finding_classifications: {},
    });
    await call("workflow_authorize_commit", {
      workflow_id: id,
      capability: created.capability,
      expected_version: await version(id),
      user_authorization: "matrix test",
    });
    git("add", "note.txt");
    const prepared = (
      await call("workflow_prepare_commit", {
        workflow_id: id,
        expected_version: await version(id),
      })
    ).body;
    return { created, id, prepared };
  };
  try {
    const head = await prepare("HEAD_CHANGED");
    const headMismatch = (
      await call("workflow_submit_commit_result", {
        workflow_id: head.id,
        expected_version: await version(head.id),
        attempt_id: head.prepared.commit_preparation.attempt_id,
        outcome: "committed",
        failure_summary: null,
      })
    ).body;
    assert.equal(headMismatch.phase, "STOPPED_COMMIT_MISMATCH", JSON.stringify(headMismatch));
    assert.equal(headMismatch.commit_result.mismatch_category, "HEAD_CHANGED");

    const tree = await prepare("TREE_MISMATCH");
    writeFileSync(join(root, "note.txt"), "tree changed after prepare\n");
    git("add", "note.txt");
    git("commit", "-qm", "tree mismatch");
    const treeMismatch = (
      await call("workflow_submit_commit_result", {
        workflow_id: tree.id,
        expected_version: await version(tree.id),
        attempt_id: tree.prepared.commit_preparation.attempt_id,
        outcome: "committed",
        failure_summary: null,
      })
    ).body;
    assert.equal(treeMismatch.phase, "STOPPED_COMMIT_MISMATCH");
    assert.equal(treeMismatch.commit_result.mismatch_category, "TREE_MISMATCH");

    const notCommitted = await prepare("CHANGED_HEAD_NOT_COMMITTED");
    git("commit", "--allow-empty", "-qm", "head changed before failure report");
    const changedHead = (
      await call("workflow_submit_commit_result", {
        workflow_id: notCommitted.id,
        expected_version: await version(notCommitted.id),
        attempt_id: notCommitted.prepared.commit_preparation.attempt_id,
        outcome: "not_committed",
        failure_summary: "commit command did not report success",
      })
    ).body;
    assert.equal(changedHead.phase, "STOPPED_COMMIT_MISMATCH");
    assert.equal(changedHead.commit_result.mismatch_category, "HEAD_CHANGED");
    assert.deepEqual(
      (await call("workflow_parent_get", { workflow_id: notCommitted.id })).body
        .permitted_next_actions,
      [],
    );
    const terminal = await failed("workflow_retry_commit", {
      workflow_id: notCommitted.id,
      capability: notCommitted.created.capability,
      expected_version: await version(notCommitted.id),
      retry_context: "terminal mismatch cannot retry",
    });
    assert.equal(terminal.category, "ERROR_INVALID_TRANSITION");
  } finally {
    await client.close();
    await transport.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("STDIO rejects legacy role fields, stale versions, invalid phases, and malformed commit claims", async () => {
  const { root, git } = fixture();
  const { client, transport, call } = await connect(root);
  const failed = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, true);
    return JSON.parse((result.content[0] as { text: string }).text);
  };
  try {
    const created = (await call("workflow_create", create(git))).body;
    const id = created.workflow.workflow_id;
    const currentVersion = async () =>
      (await call("workflow_parent_get", { workflow_id: id })).body.version;
    const legacy = await failed("workflow_submit_implementation", {
      ...implement(id, await currentVersion()),
      capability: created.capability,
      implementation_receipt: null,
    });
    assert.equal(legacy.category, "ERROR_INVALID_SHAPE");
    const stale = await failed(
      "workflow_submit_implementation",
      implement(id, (await currentVersion()) + 1),
    );
    assert.equal(stale.category, "ERROR_VERSION_CONFLICT");
    const phase = await failed("workflow_prepare_commit", {
      workflow_id: id,
      expected_version: await currentVersion(),
    });
    assert.equal(phase.category, "ERROR_INVALID_TRANSITION");
    await call("workflow_submit_implementation", implement(id, await currentVersion()));
    writeFileSync(join(root, "note.txt"), "malformed claim\n");
    await call("workflow_begin_review", {
      workflow_id: id,
      expected_version: await currentVersion(),
    });
    await call("workflow_submit_review", {
      workflow_id: id,
      expected_version: await currentVersion(),
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [],
      prior_finding_classifications: {},
    });
    await call("workflow_authorize_commit", {
      workflow_id: id,
      capability: created.capability,
      expected_version: await currentVersion(),
      user_authorization: "malformed claim test",
    });
    git("add", "note.txt");
    const prepared = (
      await call("workflow_prepare_commit", {
        workflow_id: id,
        expected_version: await currentVersion(),
      })
    ).body;
    const role = await failed("workflow_prepare_commit", {
      workflow_id: id,
      expected_version: await currentVersion(),
      capability: "legacy-bearer",
    });
    assert.equal(role.category, "ERROR_INVALID_SHAPE");
    const malformed = await failed("workflow_submit_commit_result", {
      workflow_id: id,
      expected_version: await currentVersion(),
      attempt_id: prepared.commit_preparation.attempt_id,
      outcome: "mismatch",
      failure_summary: null,
    });
    assert.equal(malformed.category, "ERROR_INVALID_SHAPE");
  } finally {
    await client.close();
    await transport.close();
    rmSync(root, { recursive: true, force: true });
  }
});
