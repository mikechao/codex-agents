import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { WorkflowStore } from "../store.js";

const SERVER = join(process.cwd(), ".codex", "workflow-mcp", "dist", "server.js");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workflow-v2-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("config", "user.email", "workflow@example.invalid");
  git("config", "user.name", "Workflow Tests");
  writeFileSync(join(root, "note.txt"), "before\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  mkdirSync(join(root, ".codex", "agents", "dist"), { recursive: true });
  cpSync(
    join(process.cwd(), ".codex", "agents", "dist", "change-receipt.js"),
    join(root, ".codex", "agents", "dist", "change-receipt.js"),
  );
  return { root, git };
}

async function start(root: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--no-warnings", SERVER],
    cwd: root,
    env: { ...process.env, WORKFLOW_MCP_DB_PATH: join(root, "state.sqlite") },
    stderr: "pipe",
  });
  const stderr = { text: "" };
  transport.stderr?.on("data", (chunk) => {
    stderr.text += chunk.toString();
  });
  const client = new Client({ name: "workflow-test", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  const call = async (name: string, arguments_: any) =>
    JSON.parse(((await client.callTool({ name, arguments: arguments_ })).content[0] as { text: string }).text);
  const receipt = (paths: string[] = ["note.txt"]): any =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          realpathSync(join(root, ".codex", "agents", "dist", "change-receipt.js")),
          "--",
          ...paths,
        ],
        { cwd: root, encoding: "utf8" },
      ),
    );
  return { client, transport, call, receipt, stderr };
}

function workingTarget(baseHead: string, paths: string[] = ["note.txt"]) {
  return {
    review_mode: "working_tree",
    base_revision: baseHead,
    head_revision: null,
    approved_paths: paths,
    include_staged: true,
    include_unstaged: true,
    include_untracked: true,
  };
}

function rangeTarget(base: string, head: string, paths: string[]) {
  return {
    review_mode: "commit_range",
    base_revision: base,
    head_revision: head,
    approved_paths: paths,
    include_staged: false,
    include_unstaged: false,
    include_untracked: false,
  };
}

function createInput(git: (...args: string[]) => string, options: any = {}) {
  const approvedPaths = options.approved_paths ?? ["note.txt"];
  return {
    workflow_type: options.workflow_type ?? "change",
    objective: options.objective ?? "protocol v2 objective",
    approved_paths: approvedPaths,
    acceptance_criteria: options.acceptance_criteria ?? ["criterion"],
    validation_requirements: options.validation_requirements ?? ["validation"],
    review_target: options.review_target ?? workingTarget(git("rev-parse", "HEAD"), approvedPaths),
    max_repair_cycles: options.max_repair_cycles,
  };
}

function implementInput(workflowId: string, caps: any, version: number, overrides: any = {}) {
  return {
    workflow_id: workflowId,
    capability: caps.implementer,
    expected_version: version,
    status: "DONE",
    summary: "implemented",
    agent_touched_paths: [],
    acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "accepted" }],
    validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "validated" }],
    implementation_receipt: null,
    known_failures: [],
    finding_resolution_map: {},
    ...overrides,
  };
}

function reviewInput(workflowId: string, caps: any, version: number, overrides: any = {}) {
  return {
    workflow_id: workflowId,
    capability: caps.reviewer,
    expected_version: version,
    review_status: "APPROVED",
    blocking_findings: [],
    optional_findings: [],
    review_receipt: null,
    review_target: null,
    prior_finding_classifications: {},
    ...overrides,
  };
}

function finding(id: string, overrides: any = {}) {
  return {
    finding_id: id,
    severity: "P1",
    blocking: true,
    file_and_line: "note.txt:1",
    failure_scenario: "scenario",
    impact: "impact",
    violated_requirement: "requirement",
    remediation: "remediation",
    missing_or_inadequate_test: "test",
    ...overrides,
  };
}

function assertSanitizedStderr(
  stderrText: string,
  { capabilities = [], objectives = [], auths = [], findingTexts = [], paths = [] }: any = {},
) {
  for (const token of [...capabilities, ...objectives, ...auths, ...findingTexts, ...paths]) {
    assert.equal(stderrText.includes(token), false, `stderr leaks ${JSON.stringify(token)}`);
  }
  const lower = stderrText.toLowerCase();
  for (const keyword of ["select ", "insert ", "update ", "pragma ", "sqlite", " at ", "error"]) {
    assert.equal(lower.includes(keyword), false, `stderr contains ${JSON.stringify(keyword)}`);
  }
  assert.equal(stderrText.includes(SERVER), false, "stderr leaks the server module path");
  for (const token of stderrText.split(/\s+/).filter(Boolean)) {
    assert.equal(
      /^[0-9a-f]{64}$/.test(token),
      false,
      "stderr contains a 64-hex capability, hash, or digest",
    );
  }
}

test("change workflow drives an external commit to COMMITTED over STDIO", async () => {
  const { root, git } = fixture();
  const { client, transport, call, receipt, stderr } = await start(root);
  try {
    const objective = "protocol v2 change through external commit";
    const created = await call("workflow_create", createInput(git, { objective }));
    const wf = created.workflow;
    const caps = created.capabilities;
    assert.equal(wf.phase, "IMPLEMENTING");
    assert.equal(wf.version, 0);

    const implemented = await call(
      "workflow_submit_implementation",
      implementInput(wf.workflow_id, caps, 0, { implementation_receipt: receipt() }),
    );
    assert.equal(implemented.phase, "REVIEWING");
    assert.equal(implemented.version, 1);

    writeFileSync(join(root, "note.txt"), "after\n");
    const target = workingTarget(wf.base_head);
    const approved = await call(
      "workflow_submit_review",
      reviewInput(wf.workflow_id, caps, 1, { review_receipt: receipt(), review_target: target }),
    );
    assert.equal(approved.phase, "STOPPED_APPROVED");
    assert.equal(approved.version, 2);

    const authorized = await call("workflow_authorize_commit", {
      workflow_id: wf.workflow_id,
      capability: caps.parent,
      expected_version: 2,
      user_authorization: "protocol v2 commit authorization",
    });
    assert.equal(authorized.phase, "COMMIT_AUTHORIZED");

    git("add", "note.txt");
    const prepared = await call("workflow_prepare_commit", {
      workflow_id: wf.workflow_id,
      capability: caps.committer,
      expected_version: 3,
    });
    assert.equal(prepared.phase, "COMMIT_PREPARED");
    assert.equal(prepared.commit_preparation.prepared_head, wf.base_head);

    git("commit", "-qm", "external v2 commit");
    const hash = git("rev-parse", "HEAD");
    const committed = await call("workflow_submit_commit_result", {
      workflow_id: wf.workflow_id,
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
    assert.deepEqual(committed.permitted_next_actions, []);

    const audit = await call("workflow_get_audit", {
      workflow_id: wf.workflow_id,
      role: "parent",
      capability: caps.parent,
    });
    assert.deepEqual(
      audit.map((event: any) => event.event_type),
      [
        "WORKFLOW_CREATED",
        "IMPLEMENTATION_SUBMITTED",
        "REVIEW_SUBMITTED",
        "COMMIT_AUTHORIZED",
        "COMMIT_PREPARED",
        "COMMIT_RESULT_SUBMITTED",
      ],
    );
    assert.equal(JSON.stringify(audit).includes(hash), false);

    assertSanitizedStderr(stderr.text, {
      capabilities: Object.values(caps),
      objectives: [objective],
      auths: ["protocol v2 commit authorization"],
      findingTexts: [],
      paths: ["note.txt"],
    });
  } finally {
    await client.close();
    await transport.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("range review to linked change and approval over STDIO", async () => {
  const { root, git } = fixture();
  const { client, transport, call, receipt, stderr } = await start(root);
  try {
    writeFileSync(join(root, "added.txt"), "added\n");
    git("add", "added.txt");
    git("commit", "-qm", "range head");
    const base = git("rev-parse", "HEAD~1");
    const head = git("rev-parse", "HEAD");

    const rangeObjective = "protocol v2 range review objective";
    const range = await call(
      "workflow_create",
      createInput(git, {
        workflow_type: "review_only",
        objective: rangeObjective,
        approved_paths: ["added.txt", "note.txt"],
        acceptance_criteria: ["range criterion"],
        validation_requirements: [],
        review_target: rangeTarget(base, head, ["added.txt", "note.txt"]),
      }),
    );
    const rangeWf = range.workflow;
    assert.equal(rangeWf.phase, "REVIEWING");
    assert.equal(rangeWf.initial_receipt, null);

    const optional = finding("RANGE-OPT-1", { severity: "P3", blocking: false });
    const approved = await call(
      "workflow_submit_review",
      reviewInput(rangeWf.workflow_id, range.capabilities, 0, {
        review_status: "APPROVED",
        optional_findings: [optional],
        review_receipt: null,
        review_target: rangeWf.review_target,
      }),
    );
    assert.equal(approved.phase, "STOPPED_APPROVED");
    assert.deepEqual(
      (
        await call("workflow_get", {
          workflow_id: rangeWf.workflow_id,
          role: "parent",
          capability: range.capabilities.parent,
        })
      ).permitted_next_actions,
      ["workflow_create_linked_followup"],
    );

    const linkedAuth = "protocol v2 linked follow-up authorization";
    const childObjective = "protocol v2 linked child objective";
    const linked = await call("workflow_create_linked_followup", {
      workflow_id: rangeWf.workflow_id,
      capability: range.capabilities.parent,
      expected_version: 1,
      objective: childObjective,
      approved_paths: ["note.txt"],
      acceptance_criteria: ["child criterion"],
      validation_requirements: ["child validation"],
      finding_ids: ["RANGE-OPT-1"],
      user_authorization: linkedAuth,
    });
    const child = linked.workflow;
    const childCaps = linked.capabilities;
    assert.equal(child.phase, "IMPLEMENTING");
    assert.equal(child.version, 0);
    assert.equal(child.workflow_type, "change");
    assert.equal(child.source_workflow_id, rangeWf.workflow_id);
    assert.equal(child.parent_workflow_id, rangeWf.workflow_id);

    const childImplementer = await call("workflow_get", {
      workflow_id: child.workflow_id,
      role: "implementer",
      capability: childCaps.implementer,
    });
    assert.deepEqual(childImplementer.linked_findings, [optional]);
    assert.deepEqual(childImplementer.remediation_context, {
      policy: "explicitly_authorized",
      authorized_finding_ids: ["RANGE-OPT-1"],
      repair_cycle: 0,
      user_authorization: linkedAuth,
    });
    assert.deepEqual(childImplementer.acceptance_criteria, [
      { criterion_id: "AC-001", description: "child criterion" },
    ]);
    assert.deepEqual(childImplementer.validation_requirements, [
      { validation_id: "VAL-001", description: "child validation" },
    ]);

    const implemented = await call(
      "workflow_submit_implementation",
      implementInput(child.workflow_id, childCaps, 0, {
        summary: "linked child implemented",
        implementation_receipt: receipt(["note.txt"]),
      }),
    );
    assert.equal(implemented.phase, "REVIEWING");

    writeFileSync(join(root, "note.txt"), "child after\n");
    const childApproved = await call(
      "workflow_submit_review",
      reviewInput(child.workflow_id, childCaps, 1, {
        review_receipt: receipt(["note.txt"]),
        review_target: workingTarget(child.base_head, ["note.txt"]),
      }),
    );
    assert.equal(childApproved.phase, "STOPPED_APPROVED");

    const childAuthorized = await call("workflow_authorize_commit", {
      workflow_id: child.workflow_id,
      capability: childCaps.parent,
      expected_version: 2,
      user_authorization: "protocol v2 child commit authorization",
    });
    assert.equal(childAuthorized.phase, "COMMIT_AUTHORIZED");

    const parentAudit = await call("workflow_get_audit", {
      workflow_id: rangeWf.workflow_id,
      role: "parent",
      capability: range.capabilities.parent,
    });
    assert.deepEqual(
      parentAudit.map((event: any) => event.event_type),
      ["WORKFLOW_CREATED", "REVIEW_SUBMITTED", "LINKED_FOLLOWUP_CREATED"],
    );
    assert.equal(parentAudit[2].summary.linked_workflow_id, child.workflow_id);
    assert.equal(JSON.stringify(parentAudit).includes("RANGE-OPT-1"), false);

    assertSanitizedStderr(stderr.text, {
      capabilities: [...Object.values(range.capabilities), ...Object.values(childCaps)],
      objectives: [rangeObjective, childObjective],
      auths: [linkedAuth, "protocol v2 child commit authorization"],
      findingTexts: ["RANGE-OPT-1"],
      paths: ["added.txt", "note.txt"],
    });
  } finally {
    await client.close();
    await transport.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("repair through stop, resume, and exhaustion over STDIO", async () => {
  const { root, git } = fixture();
  const { client, transport, call, receipt, stderr } = await start(root);
  try {
    const objective = "protocol v2 repair exhaustion objective";
    const created = await call(
      "workflow_create",
      createInput(git, { objective, max_repair_cycles: 1 }),
    );
    const wf = created.workflow;
    const caps = created.capabilities;
    const target = workingTarget(wf.base_head);
    const blocker1 = finding("REPAIR-1");
    const blocker2 = finding("REPAIR-2");

    const implemented = await call(
      "workflow_submit_implementation",
      implementInput(wf.workflow_id, caps, 0, { implementation_receipt: receipt() }),
    );
    assert.equal(implemented.phase, "REVIEWING");

    const changes = await call(
      "workflow_submit_review",
      reviewInput(wf.workflow_id, caps, 1, {
        review_status: "CHANGES_REQUESTED",
        blocking_findings: [blocker1],
        review_receipt: null,
        review_target: target,
      }),
    );
    assert.equal(changes.phase, "REPAIR_REQUIRED");
    assert.equal(changes.repair_cycle, 0);

    const repairing = await call("workflow_authorize_repair", {
      workflow_id: wf.workflow_id,
      capability: caps.parent,
      expected_version: 2,
      finding_ids: ["REPAIR-1"],
    });
    assert.equal(repairing.phase, "REPAIRING");
    assert.equal(repairing.repair_cycle, 1);

    const blocked = await call(
      "workflow_submit_implementation",
      implementInput(wf.workflow_id, caps, 3, {
        status: "BLOCKED",
        summary: "blocked mid-repair",
        implementation_receipt: receipt(),
        finding_resolution_map: { "REPAIR-1": "still_present" },
      }),
    );
    assert.equal(blocked.phase, "STOPPED_IMPLEMENTATION_BLOCKED");
    assert.deepEqual(blocked.stop_context, {
      status: "BLOCKED",
      summary: "blocked mid-repair",
      stopped_from: "REPAIRING",
    });
    assert.equal(blocked.repair_cycle, 1);

    const resumed = await call("workflow_resume_implementation", {
      workflow_id: wf.workflow_id,
      capability: caps.parent,
      expected_version: 4,
      resume_context: "blocker resolved",
    });
    assert.equal(resumed.phase, "REPAIRING");
    assert.equal(resumed.recovery_context.kind, "implementation");
    assert.equal(resumed.recovery_context.context, "blocker resolved");
    assert.equal(resumed.repair_cycle, 1);

    const repaired = await call(
      "workflow_submit_implementation",
      implementInput(wf.workflow_id, caps, 5, {
        summary: "repaired",
        agent_touched_paths: ["note.txt"],
        implementation_receipt: receipt(),
        finding_resolution_map: { "REPAIR-1": "resolved" },
      }),
    );
    assert.equal(repaired.phase, "REVIEWING");

    const changes2 = await call(
      "workflow_submit_review",
      reviewInput(wf.workflow_id, caps, 6, {
        review_status: "CHANGES_REQUESTED",
        blocking_findings: [blocker2],
        review_receipt: null,
        review_target: target,
        prior_finding_classifications: { "REPAIR-1": "resolved" },
      }),
    );
    assert.equal(changes2.phase, "REPAIR_REQUIRED");
    assert.equal(changes2.repair_cycle, 1);

    const exhausted = await call("workflow_finalize_repair_exhausted", {
      workflow_id: wf.workflow_id,
      capability: caps.parent,
      expected_version: 7,
    });
    assert.equal(exhausted.phase, "STOPPED_REPAIR_EXHAUSTED");
    assert.equal(exhausted.repair_cycle, 1);
    assert.deepEqual(
      (
        await call("workflow_get", {
          workflow_id: wf.workflow_id,
          role: "parent",
          capability: caps.parent,
        })
      ).permitted_next_actions,
      ["workflow_create_linked_followup"],
    );
    for (const role of ["implementer", "reviewer", "committer"]) {
      assert.deepEqual(
        (
          await call("workflow_get", {
            workflow_id: wf.workflow_id,
            role,
            capability: caps[role],
          })
        ).permitted_next_actions,
        [],
      );
    }

    const audit = await call("workflow_get_audit", {
      workflow_id: wf.workflow_id,
      role: "parent",
      capability: caps.parent,
    });
    assert.deepEqual(
      audit.map((event: any) => event.event_type),
      [
        "WORKFLOW_CREATED",
        "IMPLEMENTATION_SUBMITTED",
        "REVIEW_SUBMITTED",
        "REPAIR_AUTHORIZED",
        "IMPLEMENTATION_STOPPED",
        "IMPLEMENTATION_RESUMED",
        "IMPLEMENTATION_SUBMITTED",
        "REVIEW_SUBMITTED",
        "REPAIR_EXHAUSTED",
      ],
    );
    assert.equal(JSON.stringify(audit).includes("blocked mid-repair"), false);
    assert.equal(JSON.stringify(audit).includes("REPAIR-1"), false);

    assertSanitizedStderr(stderr.text, {
      capabilities: Object.values(caps),
      objectives: [objective],
      auths: [],
      findingTexts: ["REPAIR-1", "REPAIR-2"],
      paths: ["note.txt"],
    });
  } finally {
    await client.close();
    await transport.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("safe errors over STDIO for role, version, phase, malformed fields, and range commit denial", async () => {
  const { root, git } = fixture();
  const { client, transport, call, receipt, stderr } = await start(root);
  const assertError = async (name: string, arguments_: any, category: string) => {
    const result = await client.callTool({ name, arguments: arguments_ });
    assert.equal(result.isError, true);
    assert.equal(JSON.parse((result.content[0] as { text: string }).text).category, category);
  };
  try {
    const denialObjective = "protocol v2 denial objective";
    const created = await call("workflow_create", createInput(git, { objective: denialObjective }));
    const wf = created.workflow;
    const caps = created.capabilities;
    const validImplement = implementInput(wf.workflow_id, caps, 0, {
      implementation_receipt: receipt(),
    });

    await assertError(
      "workflow_submit_implementation",
      { ...validImplement, capability: caps.parent },
      "ERROR_CAPABILITY_DENIED",
    );
    await assertError(
      "workflow_submit_implementation",
      { ...validImplement, expected_version: 99 },
      "ERROR_VERSION_CONFLICT",
    );
    await assertError(
      "workflow_submit_implementation",
      { ...validImplement, changed_paths: [] },
      "ERROR_INVALID_SHAPE",
    );
    await assertError(
      "workflow_submit_review",
      reviewInput(wf.workflow_id, caps, 0, {
        review_receipt: receipt(),
        review_target: workingTarget(wf.base_head),
      }),
      "ERROR_INVALID_TRANSITION",
    );
    const badCreate = createInput(git, { objective: "protocol v2 bad create objective" });
    await assertError(
      "workflow_create",
      { ...badCreate, bogus: true },
      "ERROR_INVALID_SHAPE",
    );

    const implemented = await call("workflow_submit_implementation", validImplement);
    assert.equal(implemented.phase, "REVIEWING");
    const blocker = finding("DENY-1");
    const changes = await call(
      "workflow_submit_review",
      reviewInput(wf.workflow_id, caps, 1, {
        review_status: "CHANGES_REQUESTED",
        blocking_findings: [blocker],
        review_receipt: null,
        review_target: workingTarget(wf.base_head),
      }),
    );
    assert.equal(changes.phase, "REPAIR_REQUIRED");
    await assertError(
      "workflow_authorize_repair",
      {
        workflow_id: wf.workflow_id,
        capability: caps.implementer,
        expected_version: 2,
        finding_ids: ["DENY-1"],
      },
      "ERROR_CAPABILITY_DENIED",
    );

    writeFileSync(join(root, "added.txt"), "added\n");
    git("add", "added.txt");
    git("commit", "-qm", "range head");
    const rangeObjective = "protocol v2 range denial objective";
    const range = await call(
      "workflow_create",
      createInput(git, {
        workflow_type: "review_only",
        objective: rangeObjective,
        approved_paths: ["added.txt"],
        acceptance_criteria: ["criterion"],
        validation_requirements: [],
        review_target: rangeTarget(git("rev-parse", "HEAD~1"), git("rev-parse", "HEAD"), ["added.txt"]),
      }),
    );
    const rangeWf = range.workflow;
    await call(
      "workflow_submit_review",
      reviewInput(rangeWf.workflow_id, range.capabilities, 0, {
        review_receipt: null,
        review_target: rangeWf.review_target,
      }),
    );
    const rangeAuth = "protocol v2 range denial authorization";
    await assertError(
      "workflow_authorize_commit",
      {
        workflow_id: rangeWf.workflow_id,
        capability: range.capabilities.parent,
        expected_version: 1,
        user_authorization: rangeAuth,
      },
      "ERROR_COMMIT_NOT_ALLOWED",
    );

    assertSanitizedStderr(stderr.text, {
      capabilities: [...Object.values(caps), ...Object.values(range.capabilities)],
      objectives: [denialObjective, "protocol v2 bad create objective", rangeObjective],
      auths: [rangeAuth],
      findingTexts: ["DENY-1"],
      paths: ["note.txt", "added.txt"],
    });
  } finally {
    await client.close();
    await transport.close();
    rmSync(root, { recursive: true, force: true });
  }
});

class RawStdioClient {
  proc: any;
  stdout: string;
  stderr: string;
  frames: any[];
  invalid: string[];
  pending: Map<number, (message: any) => void>;
  buffer: string;
  nextId: number;

  constructor(root: string, dbPath: string) {
    this.proc = spawn(process.execPath, ["--no-warnings", SERVER], {
      cwd: root,
      env: { ...process.env, WORKFLOW_MCP_DB_PATH: dbPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.stdout = "";
    this.stderr = "";
    this.frames = [];
    this.invalid = [];
    this.pending = new Map();
    this.buffer = "";
    this.nextId = 1;
    this.proc.stdout.on("data", (chunk: any) => {
      this.stdout += chunk.toString();
      this.buffer += chunk.toString();
      this.#drain();
    });
    this.proc.stderr.on("data", (chunk: any) => {
      this.stderr += chunk.toString();
    });
  }

  #drain() {
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        this.invalid.push(line);
        continue;
      }
      this.frames.push(message);
      if (message && message.id !== undefined && message.id !== null) {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          pending(message);
        }
      }
    }
  }

  notify(method: string, params: any) {
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  request(method: string, params: any): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`raw request ${method} timed out`));
      }, 15000);
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
      this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }
}

test("startup, requests, SIGINT, and SIGTERM keep stdout protocol-clean and stderr sanitized", async () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const { root, git } = fixture();
    let raw: RawStdioClient | undefined;
    try {
      const db = join(root, "state.sqlite");
      raw = new RawStdioClient(root, db);
      const objective = "protocol v2 transport objective";
      const initialize = await raw.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "protocol-v2-transport", version: "1.0.0" },
      });
      assert.equal(initialize.result.protocolVersion, "2024-11-05");
      raw.notify("notifications/initialized", {});
      const list = await raw.request("tools/list", {});
      assert.ok(list.result.tools.some((tool: any) => tool.name === "workflow_create"));

      const createResponse = await raw.request("tools/call", {
        name: "workflow_create",
        arguments: createInput(git, { objective }),
      });
      assert.ok(createResponse.result.content[0].text, "create must return a tool result");
      const created = JSON.parse(createResponse.result.content[0].text);
      const capabilities = Object.values(created.capabilities);
      const getResponse = await raw.request("tools/call", {
        name: "workflow_get",
        arguments: {
          workflow_id: created.workflow.workflow_id,
          role: "parent",
          capability: created.capabilities.parent,
        },
      });
      assert.equal(JSON.parse(getResponse.result.content[0].text).phase, "IMPLEMENTING");
      const auditResponse = await raw.request("tools/call", {
        name: "workflow_get_audit",
        arguments: {
          workflow_id: created.workflow.workflow_id,
          role: "parent",
          capability: created.capabilities.parent,
        },
      });
      assert.equal(JSON.parse(auditResponse.result.content[0].text)[0].event_type, "WORKFLOW_CREATED");
      const unknownTool = await raw.request("tools/call", {
        name: "workflow_bogus",
        arguments: {},
      });
      assert.equal(unknownTool.result.isError, true);
      assert.equal(JSON.parse(unknownTool.result.content[0].text).category, "ERROR_UNKNOWN_TOOL");

      assert.deepEqual(raw.invalid, []);
      assert.equal(raw.buffer, "");
      assert.ok(raw.frames.length > 0);
      for (const frame of raw.frames) {
        assert.equal(frame.jsonrpc, "2.0");
        assert.equal(typeof frame.id, "number");
        assert.ok(frame.result !== undefined, "every server stdout frame must be a response");
      }
      assert.ok(raw.stdout.endsWith("\n"));

      raw.proc.kill(signal);
      const [code] = await once(raw.proc, "close");
      assert.equal(code, 0);
      assert.equal(raw.buffer, "");
      assert.deepEqual(raw.invalid, []);
      assert.ok(raw.stdout.endsWith("\n"));

      assertSanitizedStderr(raw.stderr, {
        capabilities,
        objectives: [objective],
        auths: [],
        findingTexts: [],
        paths: ["note.txt"],
      });

      const reopened = new WorkflowStore({ repositoryRoot: root, databasePath: db });
      reopened.close();
    } finally {
      try {
        raw?.proc.kill("SIGKILL");
      } catch {
        // process already exited
      }
      rmSync(root, { recursive: true, force: true });
    }
  }
});