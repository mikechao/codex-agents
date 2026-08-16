import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, cpSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { test } from "bun:test";
import { WorkflowError } from "../errors.js";
import { resolveStatePath, WorkflowStore } from "../store.js";
import { permittedNextActions, roleView } from "../transitions.js";
import { hashCapability, issueCapability, objectDigest } from "../validation.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workflow-state-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.email", "workflow@example.invalid");
  git("config", "user.name", "Workflow Tests");
  writeFileSync(join(root, "note.txt"), "before\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  mkdirSync(join(root, ".codex", "agents"), { recursive: true });
  cpSync(join(process.cwd(), ".codex", "agents", "change-receipt.ts"), join(root, ".codex", "agents", "change-receipt.ts"));
  return { root, git };
}

function receipt(root: string): any {
  return JSON.parse(execFileSync(process.execPath, [realpathSync(join(root, ".codex", "agents", "change-receipt.ts")), "--", "note.txt"], { cwd: root, encoding: "utf8" }));
}

function absentReceipt(root: string, paths: string[]): any {
  return JSON.parse(execFileSync(process.execPath, [realpathSync(join(root, ".codex", "agents", "change-receipt.ts")), "--allow-absent", "--", ...paths], { cwd: root, encoding: "utf8" }));
}

function implementation(store: any, created: any, root: string, version: number, summary: string, resolution: Record<string, unknown> = {}, status = "DONE", options: any = {}) {
  return store.submitImplementation({
    workflow_id: created.workflow.workflow_id,
    capability: created.capabilities.implementer,
    expected_version: version,
    status,
    summary,
    agent_touched_paths: options.touched ?? [],
    acceptance_results: created.workflow.acceptance_criteria.map(({ criterion_id }: any) => ({ criterion_id, status: options.criterionStatus ?? "satisfied", evidence: "acceptance evidence" })),
    validation_results: created.workflow.validation_requirements.map(({ validation_id }: any) => ({ validation_id, status: options.validationStatus ?? "passed", evidence: "validation evidence" })),
    implementation_receipt: options.receipt ?? receipt(root),
    known_failures: options.knownFailures ?? [],
    finding_resolution_map: resolution,
  });
}

function review(store: any, created: any, root: string, version: number, status: string, blocking: any[], optional: any[], prior: any = {}) {
  return store.submitReview({
    workflow_id: created.workflow.workflow_id,
    capability: created.capabilities.reviewer,
    expected_version: version,
    review_status: status,
    blocking_findings: blocking,
    optional_findings: optional,
    review_receipt: status === "APPROVED" ? receipt(root) : null,
    review_target: { review_mode: "working_tree", base_revision: created.workflow.base_head, head_revision: null, approved_paths: ["note.txt"], include_staged: true, include_unstaged: true, include_untracked: true },
    prior_finding_classifications: prior,
  });
}

function errorCategory(callback: () => void): string {
  try { callback(); } catch (error) { assert.ok(error instanceof WorkflowError); return error.category; }
  assert.fail("expected workflow error");
}

function createInput(root: string, git: (...args: string[]) => string, options: any = {}) {
  const approvedPaths = options.approved_paths ?? ["note.txt"];
  return {
    workflow_type: options.workflow_type ?? "change",
    objective: options.objective ?? "test workflow",
    approved_paths: approvedPaths,
    acceptance_criteria: options.acceptance_criteria ?? ["criterion A"],
    validation_requirements: options.validation_requirements ?? ["validation A"],
    review_target: options.review_target ?? {
      review_mode: "working_tree",
      base_revision: git("rev-parse", "HEAD"),
      head_revision: null,
      approved_paths: approvedPaths,
      include_staged: true,
      include_unstaged: true,
      include_untracked: true,
    },
    max_repair_cycles: options.max_repair_cycles,
  };
}

function create(store: any, root: string, git: (...args: string[]) => string, options: any = {}) {
  return store.create(createInput(root, git, options));
}

test("store database runs in Bun SQLite strict mode for named bindings", () => {
  const { root } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const byId = store.db.prepare("SELECT workflow_id FROM workflows WHERE workflow_id = :id");
    assert.throws(() => byId.get({}), /Missing parameter/);
    assert.equal(byId.get({ id: "0".repeat(36) }), null);
    const store2: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state2.sqlite") });
    assert.equal(store2.db.prepare("SELECT :value AS bound").get({ value: 7 }).bound, 7);
    store.close();
    store2.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("persists workflow, rejects stale versions and enforces role capabilities", () => {
  const { root, git } = fixture();
  const path = join(root, "state.sqlite");
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const created = create(store, root, git, { objective: "test workflow" });
    assert.equal(created.workflow.phase, "IMPLEMENTING");
    assert.equal(errorCategory(() => store.get(created.workflow.workflow_id, "reviewer", created.capabilities.parent)), "ERROR_CAPABILITY_DENIED");
    const reviewing = implementation(store, created, root, 0, "implemented");
    assert.equal(reviewing.phase, "REVIEWING");
    assert.equal(errorCategory(() => implementation(store, created, root, 0, "stale")), "ERROR_VERSION_CONFLICT");
    store.close();
    const reopened: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    assert.equal(reopened.get(created.workflow.workflow_id, "parent", created.capabilities.parent).phase, "REVIEWING");
    reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("production state path is stable and outside the repository", () => {
  const { root, git } = fixture();
  try {
    const path = resolveStatePath(root);
    assert.equal(path.startsWith(root), false);
    assert.match(path, /[\\/]\.codex[\\/]state[\\/]workflow-mcp[\\/][0-9a-f]{24}[\\/]state\.sqlite$/u);
    assert.equal(path.includes("state.sqlite"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("enforces P3 stopping and blocking repair cycle limit", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "findings", max_repair_cycles: 1 });
    assert.equal(created.workflow.version, 0);
    implementation(store, created, root, 0, "implemented");
    const finding = { finding_id: "F-1", severity: "P1", blocking: true, file_and_line: "note.txt:1", failure_scenario: "fails", impact: "bad", violated_requirement: "safe", remediation: "fix", missing_or_inadequate_test: "test" };
    const optional = { finding_id: "F-2", severity: "P3", blocking: false, file_and_line: "note.txt:1", failure_scenario: "might fail", impact: "small", violated_requirement: "quality", remediation: "consider", missing_or_inadequate_test: "optional" };
    const reviewResult = review(store, created, root, 1, "CHANGES_REQUESTED", [finding], [optional]);
    assert.equal(reviewResult.phase, "REPAIR_REQUIRED");
    const repairing = store.authorizeRepair({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.parent, expected_version: 2, finding_ids: ["F-1"] });
    assert.equal(repairing.phase, "REPAIRING");
    implementation(store, created, root, 3, "repaired", { "F-1": "still_present" });
    const finalReview = review(store, created, root, 4, "CHANGES_REQUESTED", [finding], [], { "F-1": "still_present", "F-2": "resolved" });
    assert.equal(finalReview.phase, "REPAIR_REQUIRED");
    assert.equal(errorCategory(() => store.authorizeRepair({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.parent, expected_version: 5, finding_ids: ["F-1"] })), "ERROR_REPAIR_LIMIT");
    assert.equal(store.finalizeRepairExhausted({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.parent, expected_version: 5 }).phase, "STOPPED_REPAIR_EXHAUSTED");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("approves a resolved blocker with a still-present optional finding remaining", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "optional continuity" });
    implementation(store, created, root, 0, "implemented");
    const blocker = { finding_id: "B-1", severity: "P1", blocking: true, file_and_line: "note.txt:1", failure_scenario: "fails", impact: "bad", violated_requirement: "safe", remediation: "fix", missing_or_inadequate_test: "test" };
    const optional = { finding_id: "O-1", severity: "P3", blocking: false, file_and_line: "note.txt:1", failure_scenario: "might fail", impact: "small", violated_requirement: "quality", remediation: "consider", missing_or_inadequate_test: "optional" };
    const first = review(store, created, root, 1, "CHANGES_REQUESTED", [blocker], [optional]);
    assert.equal(first.phase, "REPAIR_REQUIRED");
    store.authorizeRepair({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.parent, expected_version: 2, finding_ids: ["B-1"] });
    implementation(store, created, root, 3, "fixed blocker", { "B-1": "resolved" });
    const approved = review(store, created, root, 4, "APPROVED", [], [optional], { "B-1": "resolved", "O-1": "still_present" });
    assert.equal(approved.phase, "STOPPED_APPROVED");
    assert.deepEqual(approved.optional_findings, [optional]);
    assert.deepEqual(approved.prior_finding_classifications, { "B-1": "resolved", "O-1": "still_present" });
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("optional findings require a fresh linked workflow", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "optional" });
    implementation(store, created, root, 0, "implemented");
    writeFileSync(join(root, "note.txt"), "changed\n");
    const optional = { finding_id: "F-3", severity: "P3", blocking: false, file_and_line: "note.txt:1", failure_scenario: "might fail", impact: "small", violated_requirement: "quality", remediation: "consider", missing_or_inadequate_test: "optional" };
    const approved = review(store, created, root, 1, "APPROVED", [], [optional]);
    assert.equal(approved.phase, "STOPPED_APPROVED");
    const parentBefore = store.db.prepare("SELECT state_json FROM workflows WHERE workflow_id = ?").get(created.workflow.workflow_id).state_json;
    const linked = store.createLinkedFollowup({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.parent, expected_version: 2, objective: "authorized optional", approved_paths: ["note.txt"], acceptance_criteria: ["child criterion"], validation_requirements: ["child validation"], finding_ids: ["F-3"], user_authorization: "user approved optional follow-up" });
    assert.equal(linked.workflow.phase, "IMPLEMENTING");
    assert.equal(linked.workflow.workflow_type, "change");
    assert.equal(linked.workflow.repair_cycle, 0);
    assert.equal(linked.workflow.max_repair_cycles, created.workflow.max_repair_cycles);
    assert.equal(linked.workflow.parent_workflow_id, created.workflow.workflow_id);
    assert.equal(linked.workflow.source_workflow_id, created.workflow.workflow_id);
    assert.deepEqual(linked.workflow.review_target, { review_mode: "working_tree", base_revision: created.workflow.base_head, head_revision: null, approved_paths: ["note.txt"], include_staged: true, include_unstaged: true, include_untracked: true });
    assert.deepEqual(linked.workflow.acceptance_criteria, [{ criterion_id: "AC-001", description: "child criterion" }]);
    assert.deepEqual(linked.workflow.validation_requirements, [{ validation_id: "VAL-001", description: "child validation" }]);
    const childState = JSON.parse(store.db.prepare("SELECT state_json FROM workflows WHERE workflow_id = ?").get(linked.workflow.workflow_id).state_json);
    assert.deepEqual(childState.linked_findings, [optional]);
    assert.deepEqual(childState.remediation_context, { policy: "explicitly_authorized", authorized_finding_ids: ["F-3"], repair_cycle: 0, user_authorization: "user approved optional follow-up" });
    assert.equal("authorized_optional_ids" in childState, false);
    assert.equal("user_authorization_summary" in childState, false);
    const parentAfter = JSON.parse(store.db.prepare("SELECT state_json FROM workflows WHERE workflow_id = ?").get(created.workflow.workflow_id).state_json);
    assert.equal(store.get(created.workflow.workflow_id, "parent", created.capabilities.parent).version, 3);
    const parentBeforeState = JSON.parse(parentBefore);
    assert.equal(parentBeforeState.version, parentAfter.version - 1);
    assert.deepEqual({ ...parentAfter, version: parentBeforeState.version }, parentBeforeState);
    const childImplementer = store.get(linked.workflow.workflow_id, "implementer", linked.capabilities.implementer);
    assert.deepEqual(childImplementer.linked_findings, [optional]);
    assert.deepEqual(childImplementer.remediation_context, { policy: "explicitly_authorized", authorized_finding_ids: ["F-3"], repair_cycle: 0, user_authorization: "user approved optional follow-up" });
    assert.deepEqual(childImplementer.acceptance_criteria, [{ criterion_id: "AC-001", description: "child criterion" }]);
    assert.deepEqual(childImplementer.permitted_next_actions, ["workflow_submit_implementation"]);
    const childEvents = store.audit(linked.workflow.workflow_id, "parent", linked.capabilities.parent);
    assert.equal(childEvents[0].event_type, "WORKFLOW_CREATED");
    assert.equal(childEvents[0].summary.linked_workflow_id, created.workflow.workflow_id);
    assert.equal(JSON.stringify(childEvents).includes("F-3"), false);
    const parentEvents = store.audit(created.workflow.workflow_id, "parent", created.capabilities.parent);
    assert.equal(parentEvents[parentEvents.length - 1].event_type, "LINKED_FOLLOWUP_CREATED");
    assert.equal(parentEvents[parentEvents.length - 1].summary.linked_workflow_id, linked.workflow.workflow_id);
    assert.equal(JSON.stringify(parentEvents).includes("F-3"), false);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("approved receipt gates commit and commit evidence", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "commit" });
    implementation(store, created, root, 0, "implemented");
    writeFileSync(join(root, "note.txt"), "after\n");
    const reviewResult = review(store, created, root, 1, "APPROVED", [], []);
    assert.equal(reviewResult.phase, "STOPPED_APPROVED");
    const authorized = store.authorizeCommit({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.parent, expected_version: 2, user_authorization: "user requested commit" });
    assert.equal(authorized.phase, "COMMIT_AUTHORIZED");
    git("add", "note.txt");
    const prepared = store.prepareCommit({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.committer, expected_version: 3 });
    assert.equal(prepared.phase, "COMMIT_PREPARED");
    git("commit", "-qm", "fixture change");
    const hash = git("rev-parse", "HEAD");
    const committed = store.submitCommitResult({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.committer, expected_version: 4, attempt_id: prepared.commit_preparation.attempt_id, outcome: "committed", commit_hash: hash, failure_summary: null });
    assert.equal(committed.phase, "COMMITTED");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("implementation statuses stop explicitly and require complete repair continuity", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "status" });
    const stopped = implementation(store, created, root, 0, "needs context", {}, "NEEDS_CONTEXT");
    assert.equal(stopped.phase, "STOPPED_NEEDS_CONTEXT");
    assert.equal(stopped.implementation_status, "NEEDS_CONTEXT");
    store.close();

    const resumed = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    assert.equal(resumed.get(created.workflow.workflow_id, "parent", created.capabilities.parent).phase, "STOPPED_NEEDS_CONTEXT");
    resumed.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects unsafe scopes, malformed capabilities, and duplicate finding IDs without mutation", () => {
  const { root, git } = fixture();
  try {
    mkdirSync(join(root, "folder"));
    writeFileSync(join(root, "socket-target"), "x");
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    for (const [paths, expected] of [[["folder"], "ERROR_DIRECTORY_PATH"], [["*.txt"], "ERROR_INVALID_PATHS"], [["../note.txt"], "ERROR_INVALID_PATHS"], [["./note.txt", "note.txt"], "ERROR_INVALID_PATHS"]]) {
      assert.equal(errorCategory(() => store.create(createInput(root, git, { objective: "invalid", approved_paths: paths }))), expected);
    }
    const created = create(store, root, git, { objective: "valid" });
    const auditBefore = store.audit(created.workflow.workflow_id, "parent", created.capabilities.parent).length;
    assert.equal(errorCategory(() => store.get(created.workflow.workflow_id, "parent", "bad")), "ERROR_CAPABILITY_DENIED");
    implementation(store, created, root, 0, "implemented");
    const finding = { finding_id: "DUP", severity: "P1", blocking: true, file_and_line: "note.txt:1", failure_scenario: "fails", impact: "bad", violated_requirement: "safe", remediation: "fix", missing_or_inadequate_test: "test" };
    const duplicateReview = () => review(store, created, root, 1, "CHANGES_REQUESTED", [finding], [{ ...finding, severity: "P3", blocking: false }]);
    assert.equal(errorCategory(duplicateReview), "ERROR_INVALID_FINDING");
    assert.equal(store.get(created.workflow.workflow_id, "parent", created.capabilities.parent).version, 1);
    assert.equal(store.audit(created.workflow.workflow_id, "parent", created.capabilities.parent).length, auditBefore + 1);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("optional follow-up is atomic and audit rows remain append-only", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite"), faultAfterLinkedChildInsert: true });
    const created = create(store, root, git, { objective: "atomic" });
    implementation(store, created, root, 0, "implemented");
    writeFileSync(join(root, "note.txt"), "changed\n");
    review(store, created, root, 1, "APPROVED", [], [{ finding_id: "OPT", severity: "P3", blocking: false, file_and_line: "note.txt:1", failure_scenario: "might fail", impact: "small", violated_requirement: "quality", remediation: "consider", missing_or_inadequate_test: "optional" }]);
    const before = store.audit(created.workflow.workflow_id, "parent", created.capabilities.parent);
    assert.equal(errorCategory(() => store.createLinkedFollowup({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.parent, expected_version: 2, objective: "atomic child", approved_paths: ["note.txt"], acceptance_criteria: ["criterion"], validation_requirements: ["validation"], finding_ids: ["OPT"], user_authorization: "authorized" })), "ERROR_INJECTED_FAILURE");
    const after = store.audit(created.workflow.workflow_id, "parent", created.capabilities.parent);
    assert.deepEqual(after, before);
    assert.equal(store.get(created.workflow.workflow_id, "parent", created.capabilities.parent).version, 2);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM workflows").get().count, 1);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM audit_events").get().count, before.length);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("accepts tracked deletions and symlink receipt classifications", () => {
  const { root, git } = fixture();
  try {
    writeFileSync(join(root, "target.txt"), "target\n");
    symlinkSync("target.txt", join(root, "link.txt"));
    git("add", ".");
    git("commit", "-qm", "symlink");
    unlinkSync(join(root, "note.txt"));
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const deleted = create(store, root, git, { objective: "deletion" });
    assert.equal(deleted.workflow.phase, "IMPLEMENTING");
    const symlink = create(store, root, git, { objective: "symlink", approved_paths: ["link.txt"] });
    assert.equal(symlink.workflow.phase, "IMPLEMENTING");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects missing implementation and review continuity classifications without mutation", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "continuity" });
    implementation(store, created, root, 0, "implemented");
    const finding = { finding_id: "CONT-1", severity: "P1", blocking: true, file_and_line: "note.txt:1", failure_scenario: "fails", impact: "bad", violated_requirement: "safe", remediation: "fix", missing_or_inadequate_test: "test" };
    review(store, created, root, 1, "CHANGES_REQUESTED", [finding], []);
    store.authorizeRepair({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.parent, expected_version: 2, finding_ids: ["CONT-1"] });
    const before = store.get(created.workflow.workflow_id, "parent", created.capabilities.parent);
    assert.equal(errorCategory(() => implementation(store, created, root, 3, "repaired")), "ERROR_INVALID_FINDING");
    assert.equal(store.get(created.workflow.workflow_id, "parent", created.capabilities.parent).version, before.version);
    implementation(store, created, root, 3, "repaired", { "CONT-1": "resolved" });
    assert.equal(errorCategory(() => review(store, created, root, 4, "APPROVED", [], [], {})), "ERROR_INVALID_FINDING");
    assert.equal(store.get(created.workflow.workflow_id, "parent", created.capabilities.parent).version, 4);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects extra mutation fields without changing workflow state", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    assert.equal(
      errorCategory(() => store.create({ ...createInput(root, git, { objective: "extra" }), extra: true })),
      "ERROR_INVALID_SHAPE",
    );

    const repairing = create(store, root, git, { objective: "repair shape", max_repair_cycles: 0 });
    implementation(store, repairing, root, 0, "implemented");
    const blocker = { finding_id: "SHAPE-1", severity: "P1", blocking: true, file_and_line: "note.txt:1", failure_scenario: "fails", impact: "bad", violated_requirement: "safe", remediation: "fix", missing_or_inadequate_test: "test" };
    review(store, repairing, root, 1, "CHANGES_REQUESTED", [blocker], []);
    const repairBefore = store.get(repairing.workflow.workflow_id, "parent", repairing.capabilities.parent);
    const repairAudit = store.audit(repairing.workflow.workflow_id, "parent", repairing.capabilities.parent).length;
    assert.equal(errorCategory(() => store.authorizeRepair({ workflow_id: repairing.workflow.workflow_id, capability: repairing.capabilities.parent, expected_version: 2, finding_ids: ["SHAPE-1"], extra: true })), "ERROR_INVALID_SHAPE");
    assert.equal(errorCategory(() => store.finalizeRepairExhausted({ workflow_id: repairing.workflow.workflow_id, capability: repairing.capabilities.parent, expected_version: 2, extra: true })), "ERROR_INVALID_SHAPE");
    assert.equal(store.get(repairing.workflow.workflow_id, "parent", repairing.capabilities.parent).version, repairBefore.version);
    assert.equal(store.audit(repairing.workflow.workflow_id, "parent", repairing.capabilities.parent).length, repairAudit);

    const approved = create(store, root, git, { objective: "commit shape" });
    implementation(store, approved, root, 0, "implemented");
    writeFileSync(join(root, "note.txt"), "shape\n");
    review(store, approved, root, 1, "APPROVED", [], [{ finding_id: "OPT-SHAPE", severity: "P3", blocking: false, file_and_line: "note.txt:1", failure_scenario: "might fail", impact: "small", violated_requirement: "quality", remediation: "consider", missing_or_inadequate_test: "optional" }]);
    const approvedBefore = store.get(approved.workflow.workflow_id, "parent", approved.capabilities.parent);
    const approvedAudit = store.audit(approved.workflow.workflow_id, "parent", approved.capabilities.parent).length;
    assert.equal(errorCategory(() => store.createLinkedFollowup({ workflow_id: approved.workflow.workflow_id, capability: approved.capabilities.parent, expected_version: 2, objective: "child", approved_paths: ["note.txt"], acceptance_criteria: ["criterion"], validation_requirements: ["validation"], finding_ids: ["OPT-SHAPE"], user_authorization: "authorized", extra: true })), "ERROR_INVALID_SHAPE");
    assert.equal(errorCategory(() => store.authorizeCommit({ workflow_id: approved.workflow.workflow_id, capability: approved.capabilities.parent, expected_version: 2, user_authorization: "authorized", extra: true })), "ERROR_INVALID_SHAPE");
    assert.equal(store.get(approved.workflow.workflow_id, "parent", approved.capabilities.parent).version, approvedBefore.version);
    assert.equal(store.audit(approved.workflow.workflow_id, "parent", approved.capabilities.parent).length, approvedAudit);
    store.authorizeCommit({ workflow_id: approved.workflow.workflow_id, capability: approved.capabilities.parent, expected_version: 2, user_authorization: "authorized" });
    const commitBefore = store.get(approved.workflow.workflow_id, "committer", approved.capabilities.committer);
    const commitAudit = store.audit(approved.workflow.workflow_id, "committer", approved.capabilities.committer).length;
    assert.equal(errorCategory(() => store.recordCommit({ workflow_id: approved.workflow.workflow_id, capability: approved.capabilities.committer, expected_version: 3, commit_hash: "0".repeat(40), extra: true })), "ERROR_INVALID_SHAPE");
    assert.equal(store.get(approved.workflow.workflow_id, "committer", approved.capabilities.committer).version, commitBefore.version);
    assert.equal(store.audit(approved.workflow.workflow_id, "committer", approved.capabilities.committer).length, commitAudit);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("preserves blocking continuity and handles inconclusive receipt semantics", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "continuity" });
    implementation(store, created, root, 0, "implemented");
    const blocker = { finding_id: "DEMOTE-1", severity: "P1", blocking: true, file_and_line: "note.txt:1", failure_scenario: "fails", impact: "bad", violated_requirement: "safe", remediation: "fix", missing_or_inadequate_test: "test" };
    review(store, created, root, 1, "CHANGES_REQUESTED", [blocker], []);
    store.authorizeRepair({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.parent, expected_version: 2, finding_ids: ["DEMOTE-1"] });
    implementation(store, created, root, 3, "repaired", { "DEMOTE-1": "still_present" });
    const before = store.get(created.workflow.workflow_id, "parent", created.capabilities.parent);
    const auditBefore = store.audit(created.workflow.workflow_id, "parent", created.capabilities.parent).length;
    const demoted = { ...blocker, severity: "P3", blocking: false };
    assert.equal(errorCategory(() => review(store, created, root, 4, "APPROVED", [], [demoted], { "DEMOTE-1": "still_present" })), "ERROR_INVALID_FINDING");
    assert.equal(store.get(created.workflow.workflow_id, "parent", created.capabilities.parent).version, before.version);
    assert.equal(store.audit(created.workflow.workflow_id, "parent", created.capabilities.parent).length, auditBefore);

    const inconclusive = create(store, root, git, { objective: "inconclusive" });
    implementation(store, inconclusive, root, 0, "implemented");
    const inconclusiveBefore = store.get(inconclusive.workflow.workflow_id, "parent", inconclusive.capabilities.parent);
    const target = { review_mode: "working_tree", base_revision: inconclusive.workflow.base_head, head_revision: null, approved_paths: ["note.txt"], include_staged: true, include_unstaged: true, include_untracked: true };
    assert.equal(errorCategory(() => store.submitReview({ workflow_id: inconclusive.workflow.workflow_id, capability: inconclusive.capabilities.reviewer, expected_version: 1, review_status: "INCONCLUSIVE", blocking_findings: [], optional_findings: [], review_receipt: receipt(root), review_target: target, prior_finding_classifications: {} })), "ERROR_INVALID_REVIEW");
    assert.equal(store.get(inconclusive.workflow.workflow_id, "parent", inconclusive.capabilities.parent).version, inconclusiveBefore.version);
    assert.equal(store.submitReview({ workflow_id: inconclusive.workflow.workflow_id, capability: inconclusive.capabilities.reviewer, expected_version: 1, review_status: "INCONCLUSIVE", blocking_findings: [], optional_findings: [], review_receipt: null, review_target: target, prior_finding_classifications: {} }).phase, "STOPPED_INCONCLUSIVE");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects stale review and denies v2 legacy commit recording without mutation", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "receipts" });
    implementation(store, created, root, 0, "implemented");
    const stale = receipt(root);
    writeFileSync(join(root, "note.txt"), "reviewed\n");
    const before = store.get(created.workflow.workflow_id, "parent", created.capabilities.parent);
    const auditBefore = store.audit(created.workflow.workflow_id, "parent", created.capabilities.parent).length;
    const target = { review_mode: "working_tree", base_revision: created.workflow.base_head, head_revision: null, approved_paths: ["note.txt"], include_staged: true, include_unstaged: true, include_untracked: true };
    assert.equal(errorCategory(() => store.submitReview({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.reviewer, expected_version: 1, review_status: "APPROVED", blocking_findings: [], optional_findings: [], review_receipt: stale, review_target: target, prior_finding_classifications: {} })), "ERROR_STALE_RECEIPT");
    assert.equal(store.get(created.workflow.workflow_id, "parent", created.capabilities.parent).version, before.version);
    assert.equal(store.audit(created.workflow.workflow_id, "parent", created.capabilities.parent).length, auditBefore);
    const approved = review(store, created, root, 1, "APPROVED", [], []);
    store.authorizeCommit({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.parent, expected_version: 2, user_authorization: "authorized" });
    writeFileSync(join(root, "note.txt"), "tampered\n");
    git("add", "note.txt");
    git("commit", "-qm", "tampered");
    const commitBefore = store.get(created.workflow.workflow_id, "parent", created.capabilities.parent);
    const commitAuditBefore = store.audit(created.workflow.workflow_id, "parent", created.capabilities.parent).length;
    assert.equal(errorCategory(() => store.recordCommit({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.committer, expected_version: 3, commit_hash: git("rev-parse", "HEAD") })), "ERROR_LEGACY_WORKFLOW");
    assert.equal(store.get(created.workflow.workflow_id, "parent", created.capabilities.parent).version, commitBefore.version);
    assert.equal(store.audit(created.workflow.workflow_id, "parent", created.capabilities.parent).length, commitAuditBefore);
    assert.equal(approved.phase, "STOPPED_APPROVED");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("v2 creation constructs every normative state key and stores a verified digest", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "v2 state" });
    const workflow = created.workflow;
    assert.equal(workflow.schema_version, 2);
    assert.equal(workflow.version, 0);
    assert.equal(workflow.workflow_type, "change");
    assert.equal(workflow.legacy_v1, false);
    assert.equal(workflow.phase, "IMPLEMENTING");
    assert.equal(workflow.objective, "v2 state");
    assert.equal(workflow.base_head, created.workflow.base_head);
    assert.deepEqual(workflow.approved_paths, ["note.txt"]);
    assert.deepEqual(workflow.acceptance_criteria, [
      { criterion_id: "AC-001", description: "criterion A" },
    ]);
    assert.deepEqual(workflow.validation_requirements, [
      { validation_id: "VAL-001", description: "validation A" },
    ]);
    assert.deepEqual(workflow.review_target, {
      review_mode: "working_tree",
      base_revision: workflow.base_head,
      head_revision: null,
      approved_paths: ["note.txt"],
      include_staged: true,
      include_unstaged: true,
      include_untracked: true,
    });
    assert.deepEqual(workflow.initial_receipt, receipt(root));
    assert.deepEqual(workflow.dirty_baseline_paths, []);
    assert.equal(workflow.repair_cycle, 0);
    assert.equal(workflow.max_repair_cycles, 2);
    assert.equal(workflow.parent_workflow_id, null);
    assert.equal(workflow.source_workflow_id, null);
    assert.deepEqual(workflow.linked_findings, []);
    assert.equal(workflow.remediation_context, null);
    assert.equal(workflow.implementation_summary, null);
    assert.equal(workflow.implementation_status, null);
    assert.deepEqual(workflow.agent_touched_paths, []);
    assert.deepEqual(workflow.scope_changed_paths, []);
    assert.deepEqual(workflow.acceptance_results, []);
    assert.deepEqual(workflow.validation_results, []);
    assert.equal(workflow.implementation_receipt, null);
    assert.deepEqual(workflow.implementation_known_failures, []);
    assert.deepEqual(workflow.finding_resolution_map, {});
    assert.deepEqual(workflow.prior_finding_classifications, {});
    assert.deepEqual(workflow.blocking_findings, []);
    assert.deepEqual(workflow.optional_findings, []);
    assert.equal(workflow.review_receipt, null);
    assert.equal(workflow.stop_context, null);
    assert.equal(workflow.recovery_context, null);
    assert.deepEqual(workflow.repair_authorized_ids, []);
    assert.equal(workflow.concern_acceptance, null);
    assert.equal(workflow.commit_authorization, null);
    assert.equal(workflow.commit_preparation, null);
    assert.equal(workflow.commit_result, null);
    for (const key of [
      "implementation_changed_paths",
      "implementation_acceptance_evidence",
      "implementation_validation_evidence",
      "authorized_optional_ids",
      "user_authorization_summary",
      "legacy_evidence",
    ]) {
      assert.equal(key in workflow, false, `parent view exposes ${key}`);
    }
    const row = store.db.prepare("SELECT state_json, state_digest FROM workflows WHERE workflow_id = ?").get(created.workflow.workflow_id);
    const rawState = JSON.parse(row.state_json);
    assert.equal("implementation_changed_paths" in rawState, false);
    assert.equal("implementation_acceptance_evidence" in rawState, false);
    assert.equal("implementation_validation_evidence" in rawState, false);
    assert.equal("authorized_optional_ids" in rawState, false);
    assert.equal("user_authorization_summary" in rawState, false);
    assert.equal(row.state_digest, objectDigest(rawState));
    assert.equal(store.get(created.workflow.workflow_id, "parent", created.capabilities.parent).phase, "IMPLEMENTING");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("records dirty baseline paths from the initial receipt", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    writeFileSync(join(root, "note.txt"), "modified\n");
    writeFileSync(join(root, "new.txt"), "added\n");
    const created = create(store, root, git, { objective: "baseline", approved_paths: ["note.txt", "new.txt"] });
    assert.deepEqual(created.workflow.dirty_baseline_paths, ["new.txt", "note.txt"]);
    writeFileSync(join(root, "note.txt"), "before\n");
    const clean = create(store, root, git, { objective: "clean" });
    assert.deepEqual(clean.workflow.dirty_baseline_paths, []);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects digest and JSON tampering and preserves state on failed mutation", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "tamper" });
    const id = created.workflow.workflow_id;
    const read = () => store.db.prepare("SELECT state_json, state_digest FROM workflows WHERE workflow_id = ?").get(id);
    const original = read();
    const submit = (expected_version: any) => store.submitImplementation({ workflow_id: id, capability: created.capabilities.implementer, expected_version, status: "DONE", summary: "x", agent_touched_paths: [], acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "e" }], validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "v" }], implementation_receipt: receipt(root), known_failures: [], finding_resolution_map: {} });

    const tamperedState = JSON.parse(original.state_json);
    tamperedState.objective = "tampered";
    store.db.prepare("UPDATE workflows SET state_json = ? WHERE workflow_id = ?").run(JSON.stringify(tamperedState), id);
    const tampered = read();
    assert.equal(errorCategory(() => store.get(id, "parent", created.capabilities.parent)), "ERROR_STATE_CORRUPT");
    assert.equal(errorCategory(() => submit(0)), "ERROR_STATE_CORRUPT");
    assert.deepEqual(read(), tampered);
    store.db.prepare("UPDATE workflows SET state_json = ? WHERE workflow_id = ?").run(original.state_json, id);

    store.db.prepare("UPDATE workflows SET state_digest = ? WHERE workflow_id = ?").run("0".repeat(64), id);
    assert.equal(errorCategory(() => store.get(id, "parent", created.capabilities.parent)), "ERROR_STATE_CORRUPT");
    store.db.prepare("UPDATE workflows SET state_digest = ? WHERE workflow_id = ?").run(original.state_digest, id);

    store.db.prepare("UPDATE workflows SET state_digest = NULL WHERE workflow_id = ?").run(id);
    assert.equal(errorCategory(() => store.get(id, "parent", created.capabilities.parent)), "ERROR_MIGRATION_REQUIRED");
    store.db.prepare("UPDATE workflows SET state_digest = ? WHERE workflow_id = ?").run(original.state_digest, id);
    assert.equal(store.get(id, "parent", created.capabilities.parent).phase, "IMPLEMENTING");

    assert.equal(errorCategory(() => submit(99)), "ERROR_VERSION_CONFLICT");
    assert.deepEqual(read(), original);

    const progressed = submit(0);
    assert.equal(progressed.phase, "REVIEWING");
    const after = read();
    assert.equal(after.state_digest, objectDigest(JSON.parse(after.state_json)));
    assert.equal(store.get(id, "parent", created.capabilities.parent).phase, "REVIEWING");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects digest-consistent v2 rows that violate runtime validation", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "runtime validate" });
    const id = created.workflow.workflow_id;
    const read = () => store.db.prepare("SELECT state_json, state_digest FROM workflows WHERE workflow_id = ?").get(id);
    const original = read();
    const reinsert = (mutate: (state: any) => void) => {
      const state = JSON.parse(original.state_json);
      mutate(state);
      store.db.prepare("UPDATE workflows SET state_json = ?, state_digest = ? WHERE workflow_id = ?").run(JSON.stringify(state), objectDigest(state), id);
    };
    const blocked = () => store.get(id, "parent", created.capabilities.parent);

    reinsert((state: any) => { state.phase = "NOT_A_PHASE"; });
    assert.equal(errorCategory(blocked), "ERROR_STATE_CORRUPT");
    reinsert((state: any) => { state.phase = "IMPLEMENTING"; });

    const p3Blocker = { finding_id: "F-9", severity: "P3", blocking: false, file_and_line: "note.txt:1", failure_scenario: "fails", impact: "bad", violated_requirement: "safe", remediation: "fix", missing_or_inadequate_test: "test" };
    reinsert((state: any) => { state.blocking_findings = [p3Blocker]; });
    assert.equal(errorCategory(blocked), "ERROR_STATE_CORRUPT");
    reinsert((state: any) => { state.blocking_findings = []; });

    reinsert((state: any) => { state.extra_key = true; });
    assert.equal(errorCategory(blocked), "ERROR_STATE_CORRUPT");
    reinsert((state: any) => { delete state.extra_key; });

    reinsert((state: any) => { state.commit_result = { outcome: "committed", commit_hash: "x".repeat(40), failure_summary: "tampered" }; });
    assert.equal(errorCategory(blocked), "ERROR_STATE_CORRUPT");
    reinsert((state: any) => { state.commit_result = null; });

    assert.equal(blocked().phase, "IMPLEMENTING");
    assert.deepEqual(read(), original);

    reinsert((state: any) => { state.repair_cycle = 7; });
    store.close();
    assert.equal(errorCategory(() => new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") })), "ERROR_STATE_CORRUPT");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("audit envelopes use exact sanitized keys and sorted changed fields", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "audit keys", max_repair_cycles: 0 });
    const id = created.workflow.workflow_id;
    const readAudit = () => store.audit(id, "parent", created.capabilities.parent);
    const envelopeKeys = [
      "changed_fields",
      "linked_workflow_id",
      "outcome",
      "phase_after",
      "phase_before",
      "schema_version",
      "state_digest_after",
      "state_digest_before",
    ];
    const rawState = JSON.parse(store.db.prepare("SELECT state_json FROM workflows WHERE workflow_id = ?").get(created.workflow.workflow_id).state_json);
    const stateKeys = Object.keys(rawState)
      .filter((key) => key !== "version")
      .sort();

    const createdEvent = readAudit()[0];
    assert.equal(createdEvent.event_type, "WORKFLOW_CREATED");
    assert.deepEqual(Object.keys(createdEvent.summary).sort(), envelopeKeys);
    assert.equal(createdEvent.summary.schema_version, 2);
    assert.equal(createdEvent.summary.phase_before, null);
    assert.equal(createdEvent.summary.phase_after, "IMPLEMENTING");
    assert.equal(createdEvent.summary.state_digest_before, null);
    assert.equal(createdEvent.summary.linked_workflow_id, null);
    assert.equal(createdEvent.summary.outcome, null);
    assert.deepEqual(createdEvent.summary.changed_fields, stateKeys);

    implementation(store, created, root, 0, "implemented");
    const implEvent = readAudit()[1];
    assert.equal(implEvent.event_type, "IMPLEMENTATION_SUBMITTED");
    assert.deepEqual(Object.keys(implEvent.summary).sort(), envelopeKeys);
    assert.equal(implEvent.summary.phase_before, "IMPLEMENTING");
    assert.equal(implEvent.summary.phase_after, "REVIEWING");
    assert.equal(implEvent.summary.linked_workflow_id, null);
    assert.equal(implEvent.summary.outcome, null);
    assert.ok(implEvent.summary.changed_fields.length > 0);
    assert.deepEqual(implEvent.summary.changed_fields, [...implEvent.summary.changed_fields].sort());

    const blocker = { finding_id: "AUDIT-1", severity: "P1", blocking: true, file_and_line: "note.txt:1", failure_scenario: "fails", impact: "bad", violated_requirement: "safe", remediation: "fix", missing_or_inadequate_test: "test" };
    review(store, created, root, 1, "CHANGES_REQUESTED", [blocker], []);
    const reviewEvent = readAudit()[2];
    assert.equal(reviewEvent.event_type, "REVIEW_SUBMITTED");
    assert.deepEqual(Object.keys(reviewEvent.summary).sort(), envelopeKeys);
    assert.equal(reviewEvent.summary.phase_before, "REVIEWING");
    assert.equal(reviewEvent.summary.phase_after, "REPAIR_REQUIRED");
    assert.equal(reviewEvent.summary.linked_workflow_id, null);
    assert.equal(reviewEvent.summary.outcome, "CHANGES_REQUESTED");
    assert.deepEqual(reviewEvent.summary.changed_fields, [...reviewEvent.summary.changed_fields].sort());

    store.finalizeRepairExhausted({ workflow_id: id, capability: created.capabilities.parent, expected_version: 2 });
    const stopEvent = readAudit()[3];
    assert.equal(stopEvent.event_type, "REPAIR_EXHAUSTED");
    assert.deepEqual(Object.keys(stopEvent.summary).sort(), envelopeKeys);
    assert.equal(stopEvent.summary.phase_before, "REPAIR_REQUIRED");
    assert.equal(stopEvent.summary.phase_after, "STOPPED_REPAIR_EXHAUSTED");
    assert.equal(stopEvent.summary.outcome, "STOPPED_REPAIR_EXHAUSTED");
    assert.equal(stopEvent.summary.linked_workflow_id, null);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("audit digests form a continuity chain across mutations", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "digest chain" });
    const id = created.workflow.workflow_id;
    const readAudit = () => store.audit(id, "parent", created.capabilities.parent);
    const rowDigest = () => store.db.prepare("SELECT state_digest FROM workflows WHERE workflow_id = ?").get(id).state_digest;
    const rawState = () => JSON.parse(store.db.prepare("SELECT state_json FROM workflows WHERE workflow_id = ?").get(id).state_json);

    const createdEvent = readAudit()[0];
    assert.equal(createdEvent.summary.state_digest_before, null);
    assert.equal(createdEvent.summary.state_digest_after, rowDigest());
    assert.equal(createdEvent.summary.state_digest_after, objectDigest(rawState()));

    implementation(store, created, root, 0, "implemented");
    const implEvent = readAudit()[1];
    assert.equal(implEvent.summary.state_digest_before, createdEvent.summary.state_digest_after);
    assert.equal(implEvent.summary.state_digest_after, rowDigest());
    assert.equal(implEvent.summary.state_digest_after, objectDigest(rawState()));

    const blocker = { finding_id: "CHAIN-1", severity: "P1", blocking: true, file_and_line: "note.txt:1", failure_scenario: "fails", impact: "bad", violated_requirement: "safe", remediation: "fix", missing_or_inadequate_test: "test" };
    review(store, created, root, 1, "CHANGES_REQUESTED", [blocker], []);
    const reviewEvent = readAudit()[2];
    assert.equal(reviewEvent.summary.state_digest_before, implEvent.summary.state_digest_after);
    assert.equal(reviewEvent.summary.state_digest_after, rowDigest());
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("serialized audit envelopes contain none of the prohibited data", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "SECRET-OBJECTIVE-AUDIT" });
    const id = created.workflow.workflow_id;
    implementation(store, created, root, 0, "SECRET-SUMMARY-AUDIT");
    writeFileSync(join(root, "note.txt"), "changed\n");
    const finding = { finding_id: "SECRET-FINDING", severity: "P1", blocking: true, file_and_line: "note.txt:1", failure_scenario: "secret failure scenario text", impact: "bad", violated_requirement: "safe", remediation: "fix", missing_or_inadequate_test: "test" };
    review(store, created, root, 1, "CHANGES_REQUESTED", [finding], []);
    const serialized = JSON.stringify(store.audit(id, "parent", created.capabilities.parent));
    for (const prohibited of [
      "SECRET-OBJECTIVE-AUDIT",
      "SECRET-SUMMARY-AUDIT",
      "SECRET-FINDING",
      "secret failure scenario text",
      "note.txt",
      created.capabilities.parent,
      created.capabilities.implementer,
      created.capabilities.reviewer,
      created.capabilities.committer,
    ]) {
      assert.equal(serialized.includes(prohibited), false, `audit envelope contains ${prohibited}`);
    }
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("audit history is append-only and versioned across mutations", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "append" });
    const id = created.workflow.workflow_id;
    const readAudit = () => store.audit(id, "parent", created.capabilities.parent);
    const rawIds = () =>
      store.db.prepare("SELECT event_id FROM audit_events WHERE workflow_id = ? ORDER BY event_id").all(id).map((row: any) => row.event_id);
    assert.equal(readAudit().length, 1);
    assert.deepEqual(rawIds(), [1]);

    implementation(store, created, root, 0, "implemented");
    assert.equal(readAudit().length, 2);
    assert.equal(readAudit().at(-1).version, store.get(id, "parent", created.capabilities.parent).version);

    const blocker = { finding_id: "APPEND-1", severity: "P1", blocking: true, file_and_line: "note.txt:1", failure_scenario: "fails", impact: "bad", violated_requirement: "safe", remediation: "fix", missing_or_inadequate_test: "test" };
    const before = readAudit().length;
    assert.equal(errorCategory(() => review(store, created, root, 99, "CHANGES_REQUESTED", [blocker], [])), "ERROR_VERSION_CONFLICT");
    assert.equal(readAudit().length, before);
    review(store, created, root, 1, "CHANGES_REQUESTED", [blocker], []);
    assert.equal(readAudit().length, before + 1);
    const events = readAudit();
    assert.deepEqual(events.map((event: any) => event.version), [0, 1, 2]);
    assert.deepEqual(events.map((event: any) => event.event_type), ["WORKFLOW_CREATED", "IMPLEMENTATION_SUBMITTED", "REVIEW_SUBMITTED"]);
    const ids = rawIds();
    assert.deepEqual(ids, [...ids].sort((a: any, b: any) => a - b));
    assert.equal(new Set(ids).size, ids.length);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("create assigns ordered contract IDs and preserves duplicate descriptions", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, {
      acceptance_criteria: ["alpha", "beta", "alpha"],
      validation_requirements: ["lint", "unit"],
    });
    assert.deepEqual(created.workflow.acceptance_criteria, [
      { criterion_id: "AC-001", description: "alpha" },
      { criterion_id: "AC-002", description: "beta" },
      { criterion_id: "AC-003", description: "alpha" },
    ]);
    assert.deepEqual(created.workflow.validation_requirements, [
      { validation_id: "VAL-001", description: "lint" },
      { validation_id: "VAL-002", description: "unit" },
    ]);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("create rejects empty and oversized contract lists", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    assert.equal(errorCategory(() => create(store, root, git, { acceptance_criteria: [] })), "ERROR_INVALID_SHAPE");
    assert.equal(errorCategory(() => create(store, root, git, { validation_requirements: [] })), "ERROR_INVALID_SHAPE");
    const many = Array.from({ length: 1000 }, (_, index) => `item ${index}`);
    assert.equal(errorCategory(() => create(store, root, git, { acceptance_criteria: many })), "ERROR_INVALID_SHAPE");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("create rejects unknown fields and invalid target combinations", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const head = git("rev-parse", "HEAD");
    const base = createInput(root, git, { objective: "shape" });
    assert.equal(errorCategory(() => store.create({ ...base, extra: true })), "ERROR_INVALID_SHAPE");
    const reviewOnly = store.create(createInput(root, git, { objective: "shape", workflow_type: "review_only" }));
    assert.equal(reviewOnly.workflow.phase, "REVIEWING");
    assert.equal(reviewOnly.workflow.workflow_type, "review_only");
    assert.equal(
      errorCategory(() =>
        store.create(
          createInput(root, git, {
            review_target: {
              review_mode: "commit_range",
              base_revision: head,
              head_revision: head,
              approved_paths: ["note.txt"],
              include_staged: false,
              include_unstaged: false,
              include_untracked: false,
            },
          }),
        ),
      ),
      "ERROR_UNSUPPORTED_WORKFLOW_TYPE",
    );
    assert.equal(
      errorCategory(() =>
        store.create(
          createInput(root, git, {
            review_target: {
              review_mode: "working_tree",
              base_revision: head,
              head_revision: null,
              approved_paths: ["other.txt"],
              include_staged: true,
              include_unstaged: true,
              include_untracked: true,
            },
          }),
        ),
      ),
      "ERROR_INVALID_SHAPE",
    );
    assert.equal(
      errorCategory(() =>
        store.create(
          createInput(root, git, {
            review_target: {
              review_mode: "working_tree",
              base_revision: "b".repeat(40),
              head_revision: null,
              approved_paths: ["note.txt"],
              include_staged: true,
              include_unstaged: true,
              include_untracked: true,
            },
          }),
        ),
      ),
      "ERROR_STALE_BASE",
    );
    assert.equal(
      errorCategory(() =>
        store.create(
          createInput(root, git, {
            review_target: {
              review_mode: "working_tree",
              base_revision: head,
              head_revision: head,
              approved_paths: ["note.txt"],
              include_staged: true,
              include_unstaged: true,
              include_untracked: true,
            },
          }),
        ),
      ),
      "ERROR_INVALID_SHAPE",
    );
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("create persists planned absent initial receipt and dirty baseline", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const planned = create(store, root, git, { objective: "planned absent", approved_paths: ["new/file.txt"] });
    assert.deepEqual(planned.workflow.initial_receipt.paths, [
      { path: "new/file.txt", state: "absent", kind: "missing" },
    ]);
    assert.equal("mode" in planned.workflow.initial_receipt.paths[0], false);
    assert.equal("digest" in planned.workflow.initial_receipt.paths[0], false);
    assert.deepEqual(planned.workflow.dirty_baseline_paths, []);
    writeFileSync(join(root, "note.txt"), "modified\n");
    writeFileSync(join(root, "new.txt"), "added\n");
    const dirty = create(store, root, git, { objective: "dirty baseline", approved_paths: ["note.txt", "new.txt"] });
    assert.deepEqual(dirty.workflow.dirty_baseline_paths, ["new.txt", "note.txt"]);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("restart persists execution contracts and review target", () => {
  const { root, git } = fixture();
  try {
    const path = join(root, "state.sqlite");
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const created = create(store, root, git, {
      objective: "restart contract",
      acceptance_criteria: ["restart criterion"],
      validation_requirements: ["restart validation"],
    });
    const id = created.workflow.workflow_id;
    const capabilities = created.capabilities;
    store.close();
    const reopened: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const persisted = reopened.get(id, "parent", capabilities.parent);
    assert.equal(persisted.schema_version, 2);
    assert.equal(persisted.version, 0);
    assert.equal(persisted.phase, "IMPLEMENTING");
    assert.equal(persisted.objective, "restart contract");
    assert.deepEqual(persisted.acceptance_criteria, [
      { criterion_id: "AC-001", description: "restart criterion" },
    ]);
    assert.deepEqual(persisted.validation_requirements, [
      { validation_id: "VAL-001", description: "restart validation" },
    ]);
    assert.deepEqual(persisted.review_target, {
      review_mode: "working_tree",
      base_revision: created.workflow.base_head,
      head_revision: null,
      approved_paths: ["note.txt"],
      include_staged: true,
      include_unstaged: true,
      include_untracked: true,
    });
    assert.deepEqual(persisted.initial_receipt, created.workflow.initial_receipt);
    reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const COMMON_KEYS = [
  "workflow_id",
  "schema_version",
  "version",
  "workflow_type",
  "phase",
  "objective",
  "approved_paths",
  "repair_cycle",
  "max_repair_cycles",
  "review_target",
  "permitted_next_actions",
];
const PARENT_EXTRA_KEYS = [
  "legacy_v1",
  "base_head",
  "acceptance_criteria",
  "validation_requirements",
  "initial_receipt",
  "dirty_baseline_paths",
  "parent_workflow_id",
  "source_workflow_id",
  "linked_findings",
  "remediation_context",
  "implementation_summary",
  "implementation_status",
  "agent_touched_paths",
  "scope_changed_paths",
  "acceptance_results",
  "validation_results",
  "implementation_receipt",
  "implementation_known_failures",
  "finding_resolution_map",
  "prior_finding_classifications",
  "blocking_findings",
  "optional_findings",
  "review_receipt",
  "stop_context",
  "recovery_context",
  "repair_authorized_ids",
  "concern_acceptance",
  "commit_authorization",
  "commit_preparation",
  "commit_result",
];
const IMPLEMENTER_EXTRA_KEYS = [
  "acceptance_criteria",
  "validation_requirements",
  "initial_receipt",
  "dirty_baseline_paths",
  "linked_findings",
  "remediation_context",
  "implementation_summary",
  "implementation_status",
  "implementation_receipt",
  "implementation_known_failures",
  "agent_touched_paths",
  "scope_changed_paths",
  "acceptance_results",
  "validation_results",
  "finding_resolution_map",
  "blocking_findings",
  "repair_authorized_ids",
  "stop_context",
  "recovery_context",
];
const REVIEWER_EXTRA_KEYS = [
  "acceptance_criteria",
  "validation_requirements",
  "dirty_baseline_paths",
  "implementation_summary",
  "implementation_status",
  "implementation_receipt",
  "implementation_known_failures",
  "agent_touched_paths",
  "scope_changed_paths",
  "acceptance_results",
  "validation_results",
  "finding_resolution_map",
  "blocking_findings",
  "optional_findings",
  "prior_finding_classifications",
  "concern_acceptance",
  "review_receipt",
  "stop_context",
  "recovery_context",
];
const COMMITTER_EXTRA_KEYS = [
  "acceptance_criteria",
  "validation_requirements",
  "dirty_baseline_paths",
  "agent_touched_paths",
  "scope_changed_paths",
  "implementation_summary",
  "implementation_status",
  "implementation_receipt",
  "implementation_known_failures",
  "acceptance_results",
  "validation_results",
  "blocking_findings",
  "optional_findings",
  "prior_finding_classifications",
  "concern_acceptance",
  "review_receipt",
  "commit_authorization",
  "commit_preparation",
  "commit_result",
  "stop_context",
  "recovery_context",
];

test("role views expose exact projection keys and sorted permitted actions", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "role views", max_repair_cycles: 1 });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;

    const parentView = store.get(id, "parent", caps.parent);
    assert.deepEqual(Object.keys(parentView), [...COMMON_KEYS, ...PARENT_EXTRA_KEYS]);
    assert.deepEqual(parentView.permitted_next_actions, []);

    const implementerView = store.get(id, "implementer", caps.implementer);
    assert.deepEqual(Object.keys(implementerView), [...COMMON_KEYS, ...IMPLEMENTER_EXTRA_KEYS]);
    assert.deepEqual(implementerView.permitted_next_actions, ["workflow_submit_implementation"]);

    const reviewerView = store.get(id, "reviewer", caps.reviewer);
    assert.deepEqual(Object.keys(reviewerView), [...COMMON_KEYS, ...REVIEWER_EXTRA_KEYS]);
    assert.deepEqual(reviewerView.permitted_next_actions, []);

    const committerView = store.get(id, "committer", caps.committer);
    assert.deepEqual(Object.keys(committerView), [...COMMON_KEYS, ...COMMITTER_EXTRA_KEYS]);
    assert.deepEqual(committerView.permitted_next_actions, []);

    implementation(store, created, root, 0, "implemented");
    assert.deepEqual(store.get(id, "reviewer", caps.reviewer).permitted_next_actions, ["workflow_submit_review"]);
    assert.deepEqual(store.get(id, "implementer", caps.implementer).permitted_next_actions, []);

    const blocker = { finding_id: "ROLE-1", severity: "P1", blocking: true, file_and_line: "note.txt:1", failure_scenario: "fails", impact: "bad", violated_requirement: "safe", remediation: "fix", missing_or_inadequate_test: "test" };
    review(store, created, root, 1, "CHANGES_REQUESTED", [blocker], []);
    assert.deepEqual(store.get(id, "parent", caps.parent).permitted_next_actions, ["workflow_authorize_repair", "workflow_finalize_repair_exhausted"]);

    store.authorizeRepair({ workflow_id: id, capability: caps.parent, expected_version: 2, finding_ids: ["ROLE-1"] });
    assert.deepEqual(store.get(id, "implementer", caps.implementer).permitted_next_actions, ["workflow_submit_implementation"]);

    implementation(store, created, root, 3, "repaired", { "ROLE-1": "resolved" });
    writeFileSync(join(root, "note.txt"), "changed\n");
    review(store, created, root, 4, "APPROVED", [], [], { "ROLE-1": "resolved" });
    assert.deepEqual(store.get(id, "parent", caps.parent).permitted_next_actions, ["workflow_authorize_commit", "workflow_create_linked_followup"]);

    store.authorizeCommit({ workflow_id: id, capability: caps.parent, expected_version: 5, user_authorization: "authorized" });
    assert.deepEqual(store.get(id, "committer", caps.committer).permitted_next_actions, ["workflow_prepare_commit"]);

    git("add", "note.txt");
    const prepared = store.prepareCommit({ workflow_id: id, capability: caps.committer, expected_version: 6 });
    git("commit", "-qm", "role views commit");
    store.submitCommitResult({ workflow_id: id, capability: caps.committer, expected_version: 7, attempt_id: prepared.commit_preparation.attempt_id, outcome: "committed", commit_hash: git("rev-parse", "HEAD"), failure_summary: null });
    assert.deepEqual(store.get(id, "committer", caps.committer).permitted_next_actions, []);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("role views exclude capabilities, hashes, and compatibility fields in serialized output", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "role view secrets" });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    implementation(store, created, root, 0, "implemented");
    const views = [
      store.get(id, "parent", caps.parent),
      store.get(id, "implementer", caps.implementer),
      store.get(id, "reviewer", caps.reviewer),
      store.get(id, "committer", caps.committer),
    ];
    for (const view of views) {
      const serialized = JSON.stringify(view);
      assert.equal(serialized.includes("legacy_evidence"), false);
      for (const token of Object.values(caps)) {
        assert.equal(serialized.includes(token as string), false, `view contains capability ${token}`);
      }
      assert.equal("capability" in view, false);
      assert.deepEqual(view.permitted_next_actions, [...view.permitted_next_actions].sort());
    }
    for (const key of [
      "implementation_changed_paths",
      "implementation_acceptance_evidence",
      "implementation_validation_evidence",
      "authorized_optional_ids",
      "user_authorization_summary",
      "legacy_evidence",
    ]) {
      assert.equal(key in views[0], false, `parent view exposes ${key}`);
    }
    assert.equal("initial_receipt" in views[2], false);
    assert.equal("initial_receipt" in views[3], false);
    assert.equal("commit_authorization" in views[1], false);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("restart preserves role view versions and projections", () => {
  const { root, git } = fixture();
  const path = join(root, "state.sqlite");
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const created = create(store, root, git, { objective: "restart views" });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    implementation(store, created, root, 0, "implemented");
    store.close();
    const reopened: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    for (const role of ["parent", "implementer", "reviewer", "committer"]) {
      const view = reopened.get(id, role, caps[role]);
      assert.equal(view.workflow_id, id);
      assert.equal(view.version, 1);
      assert.equal(view.phase, "REVIEWING");
      assert.deepEqual(view.permitted_next_actions, [...view.permitted_next_actions].sort());
    }
    reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("permittedNextActions and roleView are pure and follow the role and phase matrix", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "pure actions" });
    const id = created.workflow.workflow_id;
    const raw = JSON.parse(store.db.prepare("SELECT state_json FROM workflows WHERE workflow_id = ?").get(id).state_json);
    const before = JSON.stringify(raw);
    assert.deepEqual(permittedNextActions(raw, "implementer"), ["workflow_submit_implementation"]);
    assert.deepEqual(permittedNextActions(raw, "parent"), []);
    assert.deepEqual(permittedNextActions(raw, "reviewer"), []);
    const view = roleView(raw, "implementer");
    assert.equal(JSON.stringify(raw), before);
    assert.deepEqual(view.permitted_next_actions, ["workflow_submit_implementation"]);
    assert.equal("legacy_evidence" in view, false);
    assert.equal("capability" in view, false);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("cross-role tokens are denied on role views", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "cross role" });
    const id = created.workflow.workflow_id;
    const roles = ["parent", "implementer", "reviewer", "committer"];
    for (const actor of roles) {
      for (const token of roles) {
        if (actor === token) continue;
        assert.equal(errorCategory(() => store.get(id, actor, created.capabilities[token])), "ERROR_CAPABILITY_DENIED");
      }
    }
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("implementation evidence requires exact contract IDs in contract order", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, {
      acceptance_criteria: ["alpha", "beta"],
      validation_requirements: ["lint", "unit"],
    });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    const submit = (acceptance: any, validation: any) => store.submitImplementation({
      workflow_id: id,
      capability: caps.implementer,
      expected_version: 0,
      status: "DONE",
      summary: "evidence",
      agent_touched_paths: [],
      acceptance_results: acceptance,
      validation_results: validation,
      implementation_receipt: receipt(root),
      known_failures: [],
      finding_resolution_map: {},
    });
    const validAcceptance = [
      { criterion_id: "AC-001", status: "satisfied", evidence: "a" },
      { criterion_id: "AC-002", status: "satisfied", evidence: "a" },
    ];
    const validValidation = [
      { validation_id: "VAL-001", status: "passed", evidence: "v" },
      { validation_id: "VAL-002", status: "passed", evidence: "v" },
    ];
    const invalidAcceptance = [
      [{ criterion_id: "AC-001", status: "satisfied", evidence: "a" }],
      [
        { criterion_id: "AC-001", status: "satisfied", evidence: "a" },
        { criterion_id: "AC-001", status: "satisfied", evidence: "a" },
      ],
      [
        { criterion_id: "AC-001", status: "satisfied", evidence: "a" },
        { criterion_id: "AC-999", status: "satisfied", evidence: "a" },
      ],
      [
        { criterion_id: "AC-002", status: "satisfied", evidence: "a" },
        { criterion_id: "AC-001", status: "satisfied", evidence: "a" },
      ],
      [
        { criterion_id: "AC-001", status: "bad", evidence: "a" },
        { criterion_id: "AC-002", status: "satisfied", evidence: "a" },
      ],
    ];
    for (const acceptance of invalidAcceptance) {
      assert.equal(errorCategory(() => submit(acceptance, validValidation)), "ERROR_INVALID_IMPLEMENTATION");
    }
    assert.equal(errorCategory(() => submit(validAcceptance, [])), "ERROR_INVALID_IMPLEMENTATION");
    assert.equal(
      errorCategory(() =>
        submit(validAcceptance, [
          { validation_id: "VAL-002", status: "passed", evidence: "v" },
          { validation_id: "VAL-001", status: "passed", evidence: "v" },
        ]),
      ),
      "ERROR_INVALID_IMPLEMENTATION",
    );
    assert.equal(store.get(id, "parent", caps.parent).version, 0);
    assert.equal(store.audit(id, "parent", caps.parent).length, 1);
    const done = submit(validAcceptance, validValidation);
    assert.equal(done.phase, "REVIEWING");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("every implementation status persists and advances or stops explicitly", () => {
  const { root, git } = fixture();
  const path = join(root, "state.sqlite");
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const results = {
      acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "a" }],
      validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "v" }],
    };
    const submittedReceipt = receipt(root);
    const submit = (created: any, status: any, options: any = {}) => store.submitImplementation({
      workflow_id: created.workflow.workflow_id,
      capability: created.capabilities.implementer,
      expected_version: 0,
      status,
      summary: `summary ${status}`,
      agent_touched_paths: ["note.txt"],
      acceptance_results: results.acceptance_results,
      validation_results: results.validation_results,
      implementation_receipt: submittedReceipt,
      known_failures: options.knownFailures ?? [],
      finding_resolution_map: {},
    });
    const statuses = [
      ["DONE", "REVIEWING"],
      ["DONE_WITH_CONCERNS", "STOPPED_CONCERNS"],
      ["NEEDS_CONTEXT", "STOPPED_NEEDS_CONTEXT"],
      ["BLOCKED", "STOPPED_IMPLEMENTATION_BLOCKED"],
    ];
    const ids = [];
    for (const [status, phase] of statuses) {
      const created = create(store, root, git, { objective: `status ${status}`, acceptance_criteria: ["c"], validation_requirements: ["v"] });
      ids.push({ id: created.workflow.workflow_id, caps: created.capabilities });
      const result = submit(created, status, { knownFailures: status === "DONE_WITH_CONCERNS" ? ["flaky"] : [] });
      assert.equal(result.phase, phase);
      assert.equal(result.implementation_status, status);
      assert.equal(result.implementation_summary, `summary ${status}`);
      assert.deepEqual(result.agent_touched_paths, ["note.txt"]);
      assert.deepEqual(result.acceptance_results, results.acceptance_results);
      assert.deepEqual(result.validation_results, results.validation_results);
    }
    const [done] = ids;
    store.close();
    const reopened: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const persisted = reopened.get(done.id, "implementer", done.caps.implementer);
    assert.equal(persisted.phase, "REVIEWING");
    assert.equal(persisted.implementation_status, "DONE");
    assert.equal(persisted.implementation_summary, "summary DONE");
    assert.deepEqual(persisted.acceptance_results, results.acceptance_results);
    assert.deepEqual(persisted.validation_results, results.validation_results);
    assert.deepEqual(persisted.implementation_receipt, submittedReceipt);
    reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed and not-run validation, unsatisfied criteria, and known failures block DONE", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "done gates" });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    const attempts = [
      { criterionStatus: "not_satisfied", validationStatus: "passed", knownFailures: [] },
      { criterionStatus: "satisfied", validationStatus: "failed", knownFailures: [] },
      { criterionStatus: "satisfied", validationStatus: "not_run", knownFailures: [] },
      { criterionStatus: "satisfied", validationStatus: "passed", knownFailures: ["flaky"] },
    ];
    for (const attempt of attempts) {
      assert.equal(
        errorCategory(() =>
          implementation(store, created, root, 0, "blocked", {}, "DONE", {
            criterionStatus: attempt.criterionStatus,
            validationStatus: attempt.validationStatus,
            knownFailures: attempt.knownFailures,
          }),
        ),
        "ERROR_INVALID_IMPLEMENTATION",
      );
      assert.equal(store.get(id, "parent", caps.parent).version, 0);
    }
    const done = implementation(store, created, root, 0, "complete");
    assert.equal(done.phase, "REVIEWING");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("agent touched paths must be a subset of the approved scope", () => {
  const { root, git } = fixture();
  try {
    writeFileSync(join(root, "note.txt"), "modified\n");
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "touched scope", approved_paths: ["note.txt"] });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    assert.equal(
      errorCategory(() => implementation(store, created, root, 0, "touched", {}, "DONE", { touched: ["other.txt"] })),
      "ERROR_INVALID_IMPLEMENTATION",
    );
    assert.equal(store.get(id, "parent", caps.parent).version, 0);
    const done = implementation(store, created, root, 0, "touched", {}, "DONE", { touched: ["note.txt"] });
    assert.equal(done.phase, "REVIEWING");
    assert.deepEqual(done.agent_touched_paths, ["note.txt"]);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("derives scope changes from baseline receipt comparison and ignores self-reported touched paths", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    writeFileSync(join(root, "note.txt"), "modified\n");
    const baseline = create(store, root, git, { objective: "dirty baseline", approved_paths: ["note.txt"] });
    assert.deepEqual(baseline.workflow.dirty_baseline_paths, ["note.txt"]);
    const unchanged = implementation(store, baseline, root, 0, "unchanged baseline");
    assert.equal(unchanged.phase, "REVIEWING");
    assert.deepEqual(unchanged.scope_changed_paths, []);

    mkdirSync(join(root, "new"), { recursive: true });
    const planned = create(store, root, git, { objective: "absent to added", approved_paths: ["new/file.txt"] });
    assert.deepEqual(planned.workflow.initial_receipt.paths, [
      { path: "new/file.txt", state: "absent", kind: "missing" },
    ]);
    assert.deepEqual(planned.workflow.dirty_baseline_paths, []);
    writeFileSync(join(root, "new", "file.txt"), "content\n");
    const added = implementation(store, planned, root, 0, "added", {}, "DONE", {
      touched: [],
      receipt: absentReceipt(root, ["new/file.txt"]),
    });
    assert.equal(added.phase, "REVIEWING");
    assert.deepEqual(added.agent_touched_paths, []);
    assert.deepEqual(added.scope_changed_paths, ["new/file.txt"]);

    const claimed = create(store, root, git, { objective: "claimed", approved_paths: ["note.txt", "new/file.txt"] });
    assert.deepEqual(claimed.workflow.dirty_baseline_paths, ["new/file.txt", "note.txt"]);
    writeFileSync(join(root, "new", "file.txt"), "more\n");
    const claimedResult = implementation(store, claimed, root, 0, "claimed", {}, "DONE", {
      touched: [],
      receipt: absentReceipt(root, ["note.txt", "new/file.txt"]),
    });
    assert.equal(claimedResult.phase, "REVIEWING");
    assert.deepEqual(claimedResult.agent_touched_paths, []);
    assert.deepEqual(claimedResult.scope_changed_paths, ["new/file.txt"]);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stale implementation receipt is rejected and restart preserves submission evidence", () => {
  const { root, git } = fixture();
  const path = join(root, "state.sqlite");
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const created = create(store, root, git, { objective: "stale receipt" });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    const stale = receipt(root);
    writeFileSync(join(root, "note.txt"), "changed after receipt\n");
    assert.equal(errorCategory(() => implementation(store, created, root, 0, "stale", {}, "DONE", { receipt: stale })), "ERROR_STALE_RECEIPT");
    assert.equal(store.get(id, "parent", caps.parent).version, 0);
    const submitted = receipt(root);
    const done = implementation(store, created, root, 0, "complete", {}, "DONE", { receipt: submitted });
    assert.equal(done.phase, "REVIEWING");
    store.close();

    const reopened: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const persisted = reopened.get(id, "implementer", caps.implementer);
    assert.equal(persisted.phase, "REVIEWING");
    assert.equal(persisted.implementation_status, "DONE");
    assert.deepEqual(persisted.acceptance_results, [
      { criterion_id: "AC-001", status: "satisfied", evidence: "acceptance evidence" },
    ]);
    assert.deepEqual(persisted.validation_results, [
      { validation_id: "VAL-001", status: "passed", evidence: "validation evidence" },
    ]);
    assert.deepEqual(persisted.implementation_receipt, submitted);
    reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("migrated workflows with empty contracts cannot submit implementation", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "legacy gate" });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    const raw = JSON.parse(store.db.prepare("SELECT state_json FROM workflows WHERE workflow_id = ?").get(id).state_json);
    raw.legacy_v1 = true;
    raw.acceptance_criteria = [];
    raw.validation_requirements = [];
    raw.implementation_changed_paths = [];
    raw.implementation_acceptance_evidence = [];
    raw.implementation_validation_evidence = [];
    store.db
      .prepare("UPDATE workflows SET state_json = ?, state_digest = ? WHERE workflow_id = ?")
      .run(JSON.stringify(raw), objectDigest(raw), id);
    assert.equal(errorCategory(() => implementation(store, created, root, 0, "legacy")), "ERROR_LEGACY_WORKFLOW");
    assert.equal(store.get(id, "parent", caps.parent).version, 0);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("implementation stops persist stop context and resume restores the exact source phase", () => {
  const { root, git } = fixture();
  const path = join(root, "state.sqlite");
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const created = create(store, root, git, { objective: "resume initial" });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;

    const stopped = implementation(store, created, root, 0, "needs context", {}, "NEEDS_CONTEXT");
    assert.equal(stopped.phase, "STOPPED_NEEDS_CONTEXT");
    assert.deepEqual(stopped.stop_context, {
      status: "NEEDS_CONTEXT",
      summary: "needs context",
      stopped_from: "IMPLEMENTING",
    });
    assert.equal(stopped.recovery_context, null);

    const resumed = store.resumeImplementation({
      workflow_id: id,
      capability: caps.parent,
      expected_version: 1,
      resume_context: "context provided",
    });
    assert.equal(resumed.phase, "IMPLEMENTING");
    assert.equal(resumed.stop_context, null);
    assert.equal(resumed.recovery_context.kind, "implementation");
    assert.equal(resumed.recovery_context.context, "context provided");
    assert.match(resumed.recovery_context.recovered_at, /^[0-9]{4}-/u);
    store.close();

    const reopened: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const persisted = reopened.get(id, "implementer", caps.implementer);
    assert.equal(persisted.phase, "IMPLEMENTING");
    assert.equal(persisted.stop_context, null);
    assert.deepEqual(persisted.recovery_context, resumed.recovery_context);
    reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resume from repair preserves repair continuity and block stops restore REPAIRING", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "resume repair" });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    implementation(store, created, root, 0, "implemented");
    const blocker = { finding_id: "RESUME-1", severity: "P1", blocking: true, file_and_line: "note.txt:1", failure_scenario: "fails", impact: "bad", violated_requirement: "safe", remediation: "fix", missing_or_inadequate_test: "test" };
    review(store, created, root, 1, "CHANGES_REQUESTED", [blocker], []);
    store.authorizeRepair({ workflow_id: id, capability: caps.parent, expected_version: 2, finding_ids: ["RESUME-1"] });
    const stopped = implementation(store, created, root, 3, "blocked repair", { "RESUME-1": "still_present" }, "BLOCKED");
    assert.equal(stopped.phase, "STOPPED_IMPLEMENTATION_BLOCKED");
    assert.deepEqual(stopped.stop_context, {
      status: "BLOCKED",
      summary: "blocked repair",
      stopped_from: "REPAIRING",
    });
    const resumed = store.resumeImplementation({
      workflow_id: id,
      capability: caps.parent,
      expected_version: 4,
      resume_context: "repair context",
    });
    assert.equal(resumed.phase, "REPAIRING");
    assert.equal(resumed.repair_cycle, 1);
    assert.deepEqual(resumed.blocking_findings, [blocker]);
    assert.deepEqual(resumed.finding_resolution_map, { "RESUME-1": "still_present" });
    assert.equal(resumed.recovery_context.kind, "implementation");
    assert.equal(resumed.recovery_context.context, "repair context");
    assert.equal(resumed.implementation_status, "BLOCKED");
    const repaired = implementation(store, created, root, 5, "repaired", { "RESUME-1": "resolved" });
    assert.equal(repaired.phase, "REVIEWING");
    assert.equal(repaired.repair_cycle, 1);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resume and concern acceptance reject wrong role, phase, version, and extra fields", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "resume guards" });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    implementation(store, created, root, 0, "needs context", {}, "NEEDS_CONTEXT");

    assert.equal(errorCategory(() => store.resumeImplementation({ workflow_id: id, capability: caps.implementer, expected_version: 1, resume_context: "x" })), "ERROR_CAPABILITY_DENIED");
    assert.equal(errorCategory(() => store.resumeImplementation({ workflow_id: id, capability: caps.parent, expected_version: 0, resume_context: "x" })), "ERROR_VERSION_CONFLICT");
    assert.equal(errorCategory(() => store.resumeImplementation({ workflow_id: id, capability: caps.parent, expected_version: 1 })), "ERROR_INVALID_SHAPE");
    assert.equal(errorCategory(() => store.resumeImplementation({ workflow_id: id, capability: caps.parent, expected_version: 1, resume_context: "x", extra: true })), "ERROR_INVALID_SHAPE");
    assert.equal(errorCategory(() => store.acceptConcerns({ workflow_id: id, capability: caps.parent, expected_version: 1, user_authorization: "auth" })), "ERROR_INVALID_TRANSITION");
    assert.equal(store.get(id, "parent", caps.parent).version, 1);

    const resumed = store.resumeImplementation({ workflow_id: id, capability: caps.parent, expected_version: 1, resume_context: "x" });
    assert.equal(resumed.phase, "IMPLEMENTING");
    assert.equal(errorCategory(() => store.resumeImplementation({ workflow_id: id, capability: caps.parent, expected_version: 2, resume_context: "x" })), "ERROR_INVALID_TRANSITION");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("terminals cannot resume implementation or accept concerns", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "terminal resume" });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    implementation(store, created, root, 0, "implemented");
    writeFileSync(join(root, "note.txt"), "after\n");
    review(store, created, root, 1, "APPROVED", [], []);
    store.authorizeCommit({ workflow_id: id, capability: caps.parent, expected_version: 2, user_authorization: "authorized" });
    git("add", "note.txt");
    const prepared = store.prepareCommit({ workflow_id: id, capability: caps.committer, expected_version: 3 });
    git("commit", "-qm", "terminal");
    store.submitCommitResult({ workflow_id: id, capability: caps.committer, expected_version: 4, attempt_id: prepared.commit_preparation.attempt_id, outcome: "committed", commit_hash: git("rev-parse", "HEAD"), failure_summary: null });
    assert.equal(errorCategory(() => store.resumeImplementation({ workflow_id: id, capability: caps.parent, expected_version: 5, resume_context: "x" })), "ERROR_INVALID_TRANSITION");
    assert.equal(errorCategory(() => store.acceptConcerns({ workflow_id: id, capability: caps.parent, expected_version: 5, user_authorization: "x" })), "ERROR_INVALID_TRANSITION");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("concern acceptance requires authorization and retains failed evidence without commit authorization", () => {
  const { root, git } = fixture();
  const path = join(root, "state.sqlite");
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const created = create(store, root, git, { objective: "concerns", acceptance_criteria: ["c1", "c2"] });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    const stopped = implementation(store, created, root, 0, "concerns found", {}, "DONE_WITH_CONCERNS", {
      criterionStatus: "not_satisfied",
      validationStatus: "failed",
      knownFailures: ["flaky test"],
    });
    assert.equal(stopped.phase, "STOPPED_CONCERNS");
    assert.deepEqual(stopped.stop_context, {
      status: "DONE_WITH_CONCERNS",
      summary: "concerns found",
      stopped_from: "IMPLEMENTING",
    });

    assert.equal(errorCategory(() => store.acceptConcerns({ workflow_id: id, capability: caps.parent, expected_version: 1, user_authorization: "" })), "ERROR_INVALID_SHAPE");
    assert.equal(errorCategory(() => store.acceptConcerns({ workflow_id: id, capability: caps.parent, expected_version: 1, user_authorization: "x", extra: true })), "ERROR_INVALID_SHAPE");
    assert.equal(errorCategory(() => store.resumeImplementation({ workflow_id: id, capability: caps.parent, expected_version: 1, resume_context: "x" })), "ERROR_INVALID_TRANSITION");
    assert.equal(store.get(id, "parent", caps.parent).version, 1);

    const accepted = store.acceptConcerns({ workflow_id: id, capability: caps.parent, expected_version: 1, user_authorization: "user accepts concerns" });
    assert.equal(accepted.phase, "REVIEWING");
    assert.equal(accepted.stop_context, null);
    assert.equal(accepted.concern_acceptance.user_authorization, "user accepts concerns");
    assert.match(accepted.concern_acceptance.accepted_at, /^[0-9]{4}-/u);
    assert.deepEqual(accepted.acceptance_results, stopped.acceptance_results);
    assert.deepEqual(accepted.validation_results, stopped.validation_results);
    assert.deepEqual(accepted.implementation_known_failures, ["flaky test"]);
    assert.equal(accepted.commit_authorization, null);
    store.close();

    const reopened: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const persisted = reopened.get(id, "reviewer", caps.reviewer);
    assert.equal(persisted.phase, "REVIEWING");
    assert.deepEqual(persisted.concern_acceptance, {
      user_authorization: "user accepts concerns",
      accepted_at: accepted.concern_acceptance.accepted_at,
    });
    reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stop, resume, and concern events form a sanitized append-only chain", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "resume audit" });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    const readAudit = () => store.audit(id, "parent", caps.parent);

    implementation(store, created, root, 0, "needs context", {}, "NEEDS_CONTEXT");
    let events = readAudit();
    assert.equal(events.length, 2);
    const stop = events[1];
    assert.equal(stop.event_type, "IMPLEMENTATION_STOPPED");
    assert.equal(stop.summary.phase_before, "IMPLEMENTING");
    assert.equal(stop.summary.phase_after, "STOPPED_NEEDS_CONTEXT");
    assert.equal(stop.summary.outcome, "STOPPED_NEEDS_CONTEXT");
    assert.equal(stop.summary.linked_workflow_id, null);

    store.resumeImplementation({ workflow_id: id, capability: caps.parent, expected_version: 1, resume_context: "resumed" });
    events = readAudit();
    assert.equal(events.length, 3);
    const resume = events[2];
    assert.equal(resume.event_type, "IMPLEMENTATION_RESUMED");
    assert.equal(resume.summary.phase_before, "STOPPED_NEEDS_CONTEXT");
    assert.equal(resume.summary.phase_after, "IMPLEMENTING");
    assert.equal(resume.summary.outcome, null);

    implementation(store, created, root, 2, "concerns", {}, "DONE_WITH_CONCERNS", { knownFailures: ["flaky"] });
    store.acceptConcerns({ workflow_id: id, capability: caps.parent, expected_version: 3, user_authorization: "SECRET-CONCERN-AUTH" });
    events = readAudit();
    assert.equal(events.length, 5);
    assert.deepEqual(events.map((event: any) => event.event_type), [
      "WORKFLOW_CREATED",
      "IMPLEMENTATION_STOPPED",
      "IMPLEMENTATION_RESUMED",
      "IMPLEMENTATION_STOPPED",
      "CONCERNS_ACCEPTED",
    ]);
    const accepted = events[4];
    assert.equal(accepted.summary.phase_before, "STOPPED_CONCERNS");
    assert.equal(accepted.summary.phase_after, "REVIEWING");
    assert.equal(accepted.summary.outcome, null);
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("needs context"), false);
    assert.equal(serialized.includes("SECRET-CONCERN-AUTH"), false);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("parent gets resume and concern acceptance actions at implementation stops", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "stop actions" });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    implementation(store, created, root, 0, "context", {}, "NEEDS_CONTEXT");
    assert.deepEqual(store.get(id, "parent", caps.parent).permitted_next_actions, ["workflow_resume_implementation"]);
    assert.deepEqual(store.get(id, "implementer", caps.implementer).permitted_next_actions, []);

    const blocked = create(store, root, git, { objective: "blocked actions" });
    implementation(store, blocked, root, 0, "blocked", {}, "BLOCKED");
    assert.deepEqual(store.get(blocked.workflow.workflow_id, "parent", blocked.capabilities.parent).permitted_next_actions, ["workflow_resume_implementation"]);

    const concerns = create(store, root, git, { objective: "concerns actions" });
    implementation(store, concerns, root, 0, "concerns", {}, "DONE_WITH_CONCERNS", { knownFailures: ["flaky"] });
    assert.deepEqual(store.get(concerns.workflow.workflow_id, "parent", concerns.capabilities.parent).permitted_next_actions, ["workflow_accept_concerns"]);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function rangeFixture() {
  const { root, git } = fixture();
  mkdirSync(join(root, "dir"));
  writeFileSync(join(root, "dir", "f.txt"), "f\n");
  writeFileSync(join(root, "added.txt"), "added\n");
  git("add", "-A");
  git("commit", "-qm", "range head");
  return { root, git, base: git("rev-parse", "HEAD~1"), head: git("rev-parse", "HEAD") };
}

function rangeInput(root: string, git: (...args: string[]) => string, base: string, head: string, options: any = {}) {
  const paths = options.approved_paths ?? ["added.txt", "note.txt"];
  return createInput(root, git, {
    objective: options.objective ?? "range review",
    workflow_type: "review_only",
    approved_paths: paths,
    validation_requirements: [],
    review_target: {
      review_mode: "commit_range",
      base_revision: base,
      head_revision: head,
      approved_paths: paths,
      include_staged: false,
      include_unstaged: false,
      include_untracked: false,
    },
  });
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

test("review-only working-tree workflow starts reviewing with an initial receipt", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "review only working tree", workflow_type: "review_only" });
    assert.equal(created.workflow.workflow_type, "review_only");
    assert.equal(created.workflow.phase, "REVIEWING");
    assert.deepEqual(created.workflow.initial_receipt, receipt(root));
    assert.deepEqual(created.workflow.dirty_baseline_paths, []);
    assert.equal(created.workflow.implementation_summary, null);
    assert.deepEqual(store.get(created.workflow.workflow_id, "reviewer", created.capabilities.reviewer).permitted_next_actions, ["workflow_submit_review"]);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("review-only commit-range workflow stores null receipt and range-derived dirty baseline", () => {
  const { root, git, base, head } = rangeFixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, rangeInput(root, git, base, head));
    assert.equal(created.workflow.workflow_type, "review_only");
    assert.equal(created.workflow.phase, "REVIEWING");
    assert.equal(created.workflow.initial_receipt, null);
    assert.equal(created.workflow.base_head, base);
    assert.deepEqual(created.workflow.dirty_baseline_paths, ["added.txt"]);
    assert.deepEqual(created.workflow.review_target, {
      review_mode: "commit_range",
      base_revision: base,
      head_revision: head,
      approved_paths: ["added.txt", "note.txt"],
      include_staged: false,
      include_unstaged: false,
      include_untracked: false,
    });
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("review-only creation rejects bad flags, revisions, paths, and ancestry", () => {
  const { root, git, base, head } = rangeFixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const bad = (review_target: any, options: any = {}) =>
      store.create(
        createInput(root, git, {
          objective: "bad range",
          workflow_type: "review_only",
          approved_paths: review_target.approved_paths,
          validation_requirements: [],
          review_target,
          ...options,
        }),
      );
    const range = (overrides = {}, paths = ["added.txt", "note.txt"]) => ({
      review_mode: "commit_range",
      base_revision: base,
      head_revision: head,
      approved_paths: paths,
      include_staged: false,
      include_unstaged: false,
      include_untracked: false,
      ...overrides,
    });
    assert.equal(errorCategory(() => bad(range({ base_revision: head, head_revision: base }))), "ERROR_NON_ANCESTOR");
    assert.equal(errorCategory(() => bad(range({ base_revision: "0".repeat(40) }))), "ERROR_INVALID_REVISION");
    assert.equal(errorCategory(() => bad(range({ base_revision: head, head_revision: head }))), "ERROR_INVALID_REVISION");
    assert.equal(errorCategory(() => bad(range({ include_staged: true }))), "ERROR_INVALID_SHAPE");
    assert.equal(errorCategory(() => bad(range({}, ["dir"]))), "ERROR_INVALID_REVIEW_PATH");
    assert.equal(errorCategory(() => bad(range({}, ["nope.txt"]))), "ERROR_INVALID_REVIEW_PATH");
    const wt = createInput(root, git, { objective: "bad wt", workflow_type: "review_only" });
    wt.review_target.include_untracked = false;
    assert.equal(errorCategory(() => store.create(wt)), "ERROR_INVALID_SHAPE");
    const rangeTarget = range();
    const change = createInput(root, git, { objective: "change range", approved_paths: rangeTarget.approved_paths, review_target: rangeTarget });
    assert.equal(errorCategory(() => store.create(change)), "ERROR_UNSUPPORTED_WORKFLOW_TYPE");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("working-tree approval requires a receipt and range approval rejects receipts", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const wt = create(store, root, git, { objective: "wt receipt", workflow_type: "review_only" });
    const wtTarget = workingTarget(wt.workflow.base_head);
    const submit = (workflow: any, capability: any, target: any, receiptValue: any, version = 0) =>
      store.submitReview({
        workflow_id: workflow.workflow_id,
        capability,
        expected_version: version,
        review_status: "APPROVED",
        blocking_findings: [],
        optional_findings: [],
        review_receipt: receiptValue,
        review_target: target,
        prior_finding_classifications: {},
      });
    assert.equal(errorCategory(() => submit(wt.workflow, wt.capabilities.reviewer, wtTarget, null)), "ERROR_STALE_RECEIPT");
    const wtApproved = submit(wt.workflow, wt.capabilities.reviewer, wtTarget, receipt(root));
    assert.equal(wtApproved.phase, "STOPPED_APPROVED");

    writeFileSync(join(root, "added.txt"), "added\n");
    git("add", "added.txt");
    git("commit", "-qm", "range head");
    const base = git("rev-parse", "HEAD~1");
    const head = git("rev-parse", "HEAD");
    const range = create(store, root, git, rangeInput(root, git, base, head, { objective: "range receipt" }));
    const rangeTarget = range.workflow.review_target;
    assert.equal(errorCategory(() => submit(range.workflow, range.capabilities.reviewer, rangeTarget, receipt(root))), "ERROR_INVALID_REVIEW");
    const rangeApproved = submit(range.workflow, range.capabilities.reviewer, rangeTarget, null);
    assert.equal(rangeApproved.phase, "STOPPED_APPROVED");
    assert.equal(rangeApproved.review_receipt, null);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("range workflows reject commit authorization while working-tree review-only allows it", () => {
  const { root, git, base, head } = rangeFixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const wt = create(store, root, git, { objective: "wt commit", workflow_type: "review_only" });
    const wtTarget = workingTarget(wt.workflow.base_head);
    store.submitReview({ workflow_id: wt.workflow.workflow_id, capability: wt.capabilities.reviewer, expected_version: 0, review_status: "APPROVED", blocking_findings: [], optional_findings: [], review_receipt: receipt(root), review_target: wtTarget, prior_finding_classifications: {} });
    assert.deepEqual(store.get(wt.workflow.workflow_id, "parent", wt.capabilities.parent).permitted_next_actions, ["workflow_authorize_commit", "workflow_create_linked_followup"]);
    const authorized = store.authorizeCommit({ workflow_id: wt.workflow.workflow_id, capability: wt.capabilities.parent, expected_version: 1, user_authorization: "authorized" });
    assert.equal(authorized.phase, "COMMIT_AUTHORIZED");

    const range = create(store, root, git, rangeInput(root, git, base, head, { objective: "range commit" }));
    store.submitReview({ workflow_id: range.workflow.workflow_id, capability: range.capabilities.reviewer, expected_version: 0, review_status: "APPROVED", blocking_findings: [], optional_findings: [], review_receipt: null, review_target: range.workflow.review_target, prior_finding_classifications: {} });
    assert.deepEqual(store.get(range.workflow.workflow_id, "parent", range.capabilities.parent).permitted_next_actions, ["workflow_create_linked_followup"]);
    assert.equal(errorCategory(() => store.authorizeCommit({ workflow_id: range.workflow.workflow_id, capability: range.capabilities.parent, expected_version: 1, user_authorization: "authorized" })), "ERROR_COMMIT_NOT_ALLOWED");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reviewer views omit nonexistent implementer handoff for review-only workflows", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "review only view", workflow_type: "review_only" });
    const reviewer = store.get(created.workflow.workflow_id, "reviewer", created.capabilities.reviewer);
    assert.equal("initial_receipt" in reviewer, false);
    for (const key of [
      "implementation_summary",
      "implementation_status",
      "implementation_receipt",
      "implementation_known_failures",
      "agent_touched_paths",
      "scope_changed_paths",
      "acceptance_results",
      "validation_results",
      "finding_resolution_map",
    ]) {
      assert.equal(key in reviewer, false, `reviewer view exposes ${key}`);
    }
    for (const key of [
      "acceptance_criteria",
      "validation_requirements",
      "dirty_baseline_paths",
      "blocking_findings",
      "optional_findings",
      "prior_finding_classifications",
      "review_receipt",
      "stop_context",
      "recovery_context",
    ]) {
      assert.equal(key in reviewer, true, `reviewer view omits ${key}`);
    }
    const change = create(store, root, git, { objective: "change view" });
    implementation(store, change, root, 0, "implemented");
    assert.equal("implementation_summary" in store.get(change.workflow.workflow_id, "reviewer", change.capabilities.reviewer), true);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("review submission requires canonical target equality and rejects stale receipts", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "target equality", workflow_type: "review_only" });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    const correct = workingTarget(created.workflow.base_head);
    const submit = (target: any) =>
      store.submitReview({
        workflow_id: id,
        capability: caps.reviewer,
        expected_version: 0,
        review_status: "INCONCLUSIVE",
        blocking_findings: [],
        optional_findings: [],
        review_receipt: null,
        review_target: target,
        prior_finding_classifications: {},
      });
    const before = store.get(id, "parent", caps.parent).version;
    assert.equal(errorCategory(() => submit({ ...correct, head_revision: created.workflow.base_head })), "ERROR_INVALID_REVIEW");
    assert.equal(errorCategory(() => submit({ ...correct, include_untracked: false })), "ERROR_INVALID_REVIEW");
    assert.equal(errorCategory(() => submit({ ...correct, approved_paths: ["other.txt"] })), "ERROR_INVALID_REVIEW");
    assert.equal(store.get(id, "parent", caps.parent).version, before);
    assert.equal(submit(correct).phase, "STOPPED_INCONCLUSIVE");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("review-only restart preserves phase, receipt, and permitted actions", () => {
  const { root, git } = fixture();
  const path = join(root, "state.sqlite");
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const created = create(store, root, git, { objective: "restart review only", workflow_type: "review_only" });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    store.close();
    const reopened: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const parent = reopened.get(id, "parent", caps.parent);
    assert.equal(parent.phase, "REVIEWING");
    assert.equal(parent.workflow_type, "review_only");
    assert.deepEqual(parent.initial_receipt, created.workflow.initial_receipt);
    assert.deepEqual(reopened.get(id, "reviewer", caps.reviewer).permitted_next_actions, ["workflow_submit_review"]);
    reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function inconclusiveReview(store: any, workflow: any, caps: any, target: any, version = 0) {
  return store.submitReview({
    workflow_id: workflow.workflow_id,
    capability: caps.reviewer,
    expected_version: version,
    review_status: "INCONCLUSIVE",
    blocking_findings: [],
    optional_findings: [],
    review_receipt: null,
    review_target: target,
    prior_finding_classifications: {},
  });
}

test("inconclusive review resumes to reviewing in both working-tree and range modes", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const wt = create(store, root, git, { objective: "inconclusive wt", workflow_type: "review_only" });
    const wtId = wt.workflow.workflow_id;
    const wtCaps = wt.capabilities;
    const wtTarget = workingTarget(wt.workflow.base_head);
    const wtStopped = inconclusiveReview(store, wt.workflow, wtCaps, wtTarget);
    assert.equal(wtStopped.phase, "STOPPED_INCONCLUSIVE");
    assert.deepEqual(wtStopped.stop_context, {
      status: "INCONCLUSIVE",
      summary: "review context unavailable",
      stopped_from: "REVIEWING",
    });
    assert.deepEqual(store.get(wtId, "parent", wtCaps.parent).permitted_next_actions, ["workflow_resume_review"]);
    assert.deepEqual(store.get(wtId, "reviewer", wtCaps.reviewer).permitted_next_actions, []);

    const wtResumed = store.resumeReview({ workflow_id: wtId, capability: wtCaps.parent, expected_version: 1, resume_context: "context supplied" });
    assert.equal(wtResumed.phase, "REVIEWING");
    assert.equal(wtResumed.stop_context, null);
    assert.deepEqual(wtResumed.recovery_context, {
      kind: "review",
      context: "context supplied",
      recovered_at: wtResumed.recovery_context.recovered_at,
    });
    assert.equal(wtResumed.recovery_context.kind, "review");
    assert.equal(wtResumed.recovery_context.context, "context supplied");
    assert.match(wtResumed.recovery_context.recovered_at, /^[0-9]{4}-/u);

    const events = store.audit(wtId, "parent", wtCaps.parent);
    assert.deepEqual(events.map((event: any) => event.event_type), [
      "WORKFLOW_CREATED",
      "REVIEW_SUBMITTED",
      "REVIEW_RESUMED",
    ]);
    const resumeEvent = events[2];
    assert.equal(resumeEvent.summary.phase_before, "STOPPED_INCONCLUSIVE");
    assert.equal(resumeEvent.summary.phase_after, "REVIEWING");
    assert.equal(resumeEvent.summary.outcome, null);
    assert.equal(resumeEvent.summary.linked_workflow_id, null);

    const wtApproved = store.submitReview({
      workflow_id: wtId,
      capability: wtCaps.reviewer,
      expected_version: 2,
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [],
      review_receipt: receipt(root),
      review_target: wtTarget,
      prior_finding_classifications: {},
    });
    assert.equal(wtApproved.phase, "STOPPED_APPROVED");

    writeFileSync(join(root, "added.txt"), "added\n");
    git("add", "added.txt");
    git("commit", "-qm", "range head");
    const base = git("rev-parse", "HEAD~1");
    const head = git("rev-parse", "HEAD");
    const range = create(store, root, git, rangeInput(root, git, base, head, { objective: "inconclusive range" }));
    const rangeStopped = inconclusiveReview(store, range.workflow, range.capabilities, range.workflow.review_target);
    assert.equal(rangeStopped.phase, "STOPPED_INCONCLUSIVE");
    const rangeResumed = store.resumeReview({ workflow_id: range.workflow.workflow_id, capability: range.capabilities.parent, expected_version: 1, resume_context: "range context" });
    assert.equal(rangeResumed.phase, "REVIEWING");
    assert.equal(rangeResumed.stop_context, null);
    assert.equal(rangeResumed.recovery_context.kind, "review");
    assert.equal(rangeResumed.recovery_context.context, "range context");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("review resume rejects wrong role, phase, version, and extra fields", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "resume review guards", workflow_type: "review_only" });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    inconclusiveReview(store, created.workflow, caps, workingTarget(created.workflow.base_head));

    assert.equal(errorCategory(() => store.resumeReview({ workflow_id: id, capability: caps.reviewer, expected_version: 1, resume_context: "x" })), "ERROR_CAPABILITY_DENIED");
    assert.equal(errorCategory(() => store.resumeReview({ workflow_id: id, capability: caps.parent, expected_version: 0, resume_context: "x" })), "ERROR_VERSION_CONFLICT");
    assert.equal(errorCategory(() => store.resumeReview({ workflow_id: id, capability: caps.parent, expected_version: 1 })), "ERROR_INVALID_SHAPE");
    assert.equal(errorCategory(() => store.resumeReview({ workflow_id: id, capability: caps.parent, expected_version: 1, resume_context: "x", extra: true })), "ERROR_INVALID_SHAPE");
    assert.equal(store.get(id, "parent", caps.parent).version, 1);

    const resumed = store.resumeReview({ workflow_id: id, capability: caps.parent, expected_version: 1, resume_context: "x" });
    assert.equal(resumed.phase, "REVIEWING");
    assert.equal(errorCategory(() => store.resumeReview({ workflow_id: id, capability: caps.parent, expected_version: 2, resume_context: "x" })), "ERROR_INVALID_TRANSITION");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("repair exhaustion finalizes only at the max cycle and enters a terminal stop", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "exhaustion", max_repair_cycles: 1 });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    implementation(store, created, root, 0, "implemented");
    const blocker = { finding_id: "EXH-1", severity: "P1", blocking: true, file_and_line: "note.txt:1", failure_scenario: "fails", impact: "bad", violated_requirement: "safe", remediation: "fix", missing_or_inadequate_test: "test" };
    review(store, created, root, 1, "CHANGES_REQUESTED", [blocker], []);
    assert.equal(errorCategory(() => store.finalizeRepairExhausted({ workflow_id: id, capability: caps.parent, expected_version: 2 })), "ERROR_REPAIR_LIMIT");
    store.authorizeRepair({ workflow_id: id, capability: caps.parent, expected_version: 2, finding_ids: ["EXH-1"] });
    implementation(store, created, root, 3, "repaired", { "EXH-1": "still_present" });
    review(store, created, root, 4, "CHANGES_REQUESTED", [blocker], [], { "EXH-1": "still_present" });
    const exhausted = store.finalizeRepairExhausted({ workflow_id: id, capability: caps.parent, expected_version: 5 });
    assert.equal(exhausted.phase, "STOPPED_REPAIR_EXHAUSTED");
    assert.equal(exhausted.repair_cycle, 1);
    const events = store.audit(id, "parent", caps.parent);
    const stopEvent = events[events.length - 1];
    assert.equal(stopEvent.event_type, "REPAIR_EXHAUSTED");
    assert.equal(stopEvent.summary.phase_before, "REPAIR_REQUIRED");
    assert.equal(stopEvent.summary.phase_after, "STOPPED_REPAIR_EXHAUSTED");
    assert.equal(stopEvent.summary.outcome, "STOPPED_REPAIR_EXHAUSTED");
    assert.equal(stopEvent.summary.linked_workflow_id, null);
    const serialized = JSON.stringify(events);
    assert.equal(serialized.includes("EXH-1"), false);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("repair exhaustion is terminal and cannot resume or commit", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "terminal exhaust", max_repair_cycles: 0 });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    implementation(store, created, root, 0, "implemented");
    const blocker = { finding_id: "TERM-1", severity: "P1", blocking: true, file_and_line: "note.txt:1", failure_scenario: "fails", impact: "bad", violated_requirement: "safe", remediation: "fix", missing_or_inadequate_test: "test" };
    review(store, created, root, 1, "CHANGES_REQUESTED", [blocker], []);
    store.finalizeRepairExhausted({ workflow_id: id, capability: caps.parent, expected_version: 2 });
    for (const role of ["implementer", "reviewer", "committer"]) {
      assert.deepEqual(store.get(id, role, caps[role]).permitted_next_actions, []);
    }
    assert.deepEqual(store.get(id, "parent", caps.parent).permitted_next_actions, ["workflow_create_linked_followup"]);
    assert.equal(errorCategory(() => store.resumeImplementation({ workflow_id: id, capability: caps.parent, expected_version: 3, resume_context: "x" })), "ERROR_INVALID_TRANSITION");
    assert.equal(errorCategory(() => store.resumeReview({ workflow_id: id, capability: caps.parent, expected_version: 3, resume_context: "x" })), "ERROR_INVALID_TRANSITION");
    assert.equal(errorCategory(() => store.acceptConcerns({ workflow_id: id, capability: caps.parent, expected_version: 3, user_authorization: "x" })), "ERROR_INVALID_TRANSITION");
    assert.equal(errorCategory(() => store.authorizeCommit({ workflow_id: id, capability: caps.parent, expected_version: 3, user_authorization: "x" })), "ERROR_STALE_RECEIPT");
    assert.equal(errorCategory(() => store.submitReview({ workflow_id: id, capability: caps.reviewer, expected_version: 3, review_status: "APPROVED", blocking_findings: [], optional_findings: [], review_receipt: receipt(root), review_target: workingTarget(created.workflow.base_head), prior_finding_classifications: {} })), "ERROR_INVALID_TRANSITION");
    assert.equal(errorCategory(() => implementation(store, created, root, 3, "attempted")), "ERROR_INVALID_TRANSITION");
    assert.equal(store.get(id, "parent", caps.parent).version, 3);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("linked follow-up copies blocking findings from an exhausted source", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "exhausted source", max_repair_cycles: 0 });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    implementation(store, created, root, 0, "implemented");
    const blocker = { finding_id: "EXH-SRC", severity: "P1", blocking: true, file_and_line: "note.txt:1", failure_scenario: "fails", impact: "bad", violated_requirement: "safe", remediation: "fix", missing_or_inadequate_test: "test" };
    review(store, created, root, 1, "CHANGES_REQUESTED", [blocker], []);
    store.finalizeRepairExhausted({ workflow_id: id, capability: caps.parent, expected_version: 2 });
    assert.deepEqual(store.get(id, "parent", caps.parent).permitted_next_actions, ["workflow_create_linked_followup"]);
    const linked = store.createLinkedFollowup({ workflow_id: id, capability: caps.parent, expected_version: 3, objective: "exhausted follow-up", approved_paths: ["note.txt"], acceptance_criteria: ["child criterion"], validation_requirements: ["child validation"], finding_ids: ["EXH-SRC"], user_authorization: "user authorized follow-up" });
    assert.equal(linked.workflow.phase, "IMPLEMENTING");
    assert.equal(linked.workflow.repair_cycle, 0);
    assert.equal(linked.workflow.source_workflow_id, id);
    assert.equal(linked.workflow.parent_workflow_id, id);
    const childState = JSON.parse(store.db.prepare("SELECT state_json FROM workflows WHERE workflow_id = ?").get(linked.workflow.workflow_id).state_json);
    assert.deepEqual(childState.linked_findings, [blocker]);
    assert.deepEqual(childState.remediation_context, { policy: "explicitly_authorized", authorized_finding_ids: ["EXH-SRC"], repair_cycle: 0, user_authorization: "user authorized follow-up" });
    assert.deepEqual(childState.blocking_findings, []);
    assert.deepEqual(childState.optional_findings, []);
    assert.equal(store.get(id, "parent", caps.parent).version, 4);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("linked follow-up rejects unknown, duplicate, and mixed finding IDs and missing auth or bad phase", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "linked shape", max_repair_cycles: 0 });
    implementation(store, created, root, 0, "implemented");
    const blocker = { finding_id: "LINK-BLK", severity: "P1", blocking: true, file_and_line: "note.txt:1", failure_scenario: "fails", impact: "bad", violated_requirement: "safe", remediation: "fix", missing_or_inadequate_test: "test" };
    const optional = { finding_id: "LINK-OPT", severity: "P3", blocking: false, file_and_line: "note.txt:1", failure_scenario: "might fail", impact: "small", violated_requirement: "quality", remediation: "consider", missing_or_inadequate_test: "optional" };
    review(store, created, root, 1, "CHANGES_REQUESTED", [blocker], [optional]);
    store.finalizeRepairExhausted({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.parent, expected_version: 2 });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    assert.deepEqual(store.get(id, "parent", caps.parent).permitted_next_actions, ["workflow_create_linked_followup"]);
    const base = { workflow_id: id, capability: caps.parent, expected_version: 3, objective: "linked", approved_paths: ["note.txt"], acceptance_criteria: ["criterion"], validation_requirements: ["validation"], user_authorization: "authorized" };
    assert.equal(errorCategory(() => store.createLinkedFollowup({ ...base, finding_ids: ["UNKNOWN"] })), "ERROR_INVALID_FOLLOWUP");
    assert.equal(errorCategory(() => store.createLinkedFollowup({ ...base, finding_ids: ["LINK-BLK", "LINK-BLK"] })), "ERROR_INVALID_FOLLOWUP");
    assert.equal(errorCategory(() => store.createLinkedFollowup({ ...base, finding_ids: ["LINK-BLK", "LINK-OPT"] })), "ERROR_INVALID_FOLLOWUP");
    assert.equal(errorCategory(() => store.createLinkedFollowup({ ...base, finding_ids: [] })), "ERROR_INVALID_FOLLOWUP");
    assert.equal(errorCategory(() => store.createLinkedFollowup({ ...base, finding_ids: ["LINK-OPT"], user_authorization: undefined })), "ERROR_INVALID_SHAPE");
    assert.equal(errorCategory(() => store.createLinkedFollowup({ ...base, finding_ids: ["LINK-OPT"], objective: "" })), "ERROR_INVALID_SHAPE");
    assert.equal(store.get(id, "parent", caps.parent).version, 3);
    const approving = create(store, root, git, { objective: "linked phase" });
    implementation(store, approving, root, 0, "implemented");
    assert.equal(errorCategory(() => store.createLinkedFollowup({ workflow_id: approving.workflow.workflow_id, capability: approving.capabilities.parent, expected_version: 1, objective: "linked", approved_paths: ["note.txt"], acceptance_criteria: ["criterion"], validation_requirements: ["validation"], finding_ids: ["X"], user_authorization: "authorized" })), "ERROR_INVALID_TRANSITION");
    assert.equal(errorCategory(() => store.createLinkedFollowup({ workflow_id: approving.workflow.workflow_id, capability: approving.capabilities.parent, expected_version: 1, objective: "linked", approved_paths: ["note.txt"], acceptance_criteria: ["criterion"], validation_requirements: ["validation"], finding_ids: ["X"], user_authorization: "authorized", extra: true })), "ERROR_INVALID_SHAPE");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("linked follow-up child from a commit-range review source accepts absent child paths", () => {
  const { root, git, base, head } = rangeFixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const range = create(store, root, git, rangeInput(root, git, base, head, { objective: "range linked" }));
    const optional = { finding_id: "RANGE-OPT", severity: "P3", blocking: false, file_and_line: "note.txt:1", failure_scenario: "might fail", impact: "small", violated_requirement: "quality", remediation: "consider", missing_or_inadequate_test: "optional" };
    store.submitReview({ workflow_id: range.workflow.workflow_id, capability: range.capabilities.reviewer, expected_version: 0, review_status: "APPROVED", blocking_findings: [], optional_findings: [optional], review_receipt: null, review_target: range.workflow.review_target, prior_finding_classifications: {} });
    assert.deepEqual(store.get(range.workflow.workflow_id, "parent", range.capabilities.parent).permitted_next_actions, ["workflow_create_linked_followup"]);
    const linked = store.createLinkedFollowup({ workflow_id: range.workflow.workflow_id, capability: range.capabilities.parent, expected_version: 1, objective: "range child", approved_paths: ["new/file.txt", "note.txt"], acceptance_criteria: ["criterion"], validation_requirements: ["validation"], finding_ids: ["RANGE-OPT"], user_authorization: "authorized" });
    assert.equal(linked.workflow.phase, "IMPLEMENTING");
    assert.equal(linked.workflow.source_workflow_id, range.workflow.workflow_id);
    assert.deepEqual(linked.workflow.review_target.review_mode, "working_tree");
    const childState = JSON.parse(store.db.prepare("SELECT state_json FROM workflows WHERE workflow_id = ?").get(linked.workflow.workflow_id).state_json);
    const absentEntry = childState.initial_receipt.paths.find((entry: any) => entry.path === "new/file.txt");
    assert.deepEqual(absentEntry, { path: "new/file.txt", state: "absent", kind: "missing" });
    assert.deepEqual(childState.dirty_baseline_paths, []);
    assert.deepEqual(childState.remediation_context, { policy: "explicitly_authorized", authorized_finding_ids: ["RANGE-OPT"], repair_cycle: 0, user_authorization: "authorized" });
    assert.equal(store.get(range.workflow.workflow_id, "parent", range.capabilities.parent).version, 2);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function authorizedWorkflow(store: any, root: string, git: (...args: string[]) => string, options: any = {}) {
  const created = create(store, root, git, { objective: "prepare deny", ...options });
  const id = created.workflow.workflow_id;
  const caps = created.capabilities;
  implementation(store, created, root, 0, "implemented");
  writeFileSync(join(root, "note.txt"), options.content ?? "v2\n");
  const reviewReceipt = JSON.parse(execFileSync(process.execPath, [realpathSync(join(root, ".codex", "agents", "change-receipt.ts")), "--", "note.txt"], { cwd: root, encoding: "utf8" }));
  store.submitReview({ workflow_id: id, capability: caps.reviewer, expected_version: 1, review_status: "APPROVED", blocking_findings: [], optional_findings: [], review_receipt: reviewReceipt, review_target: workingTarget(created.workflow.base_head), prior_finding_classifications: {} });
  store.authorizeCommit({ workflow_id: id, capability: caps.parent, expected_version: 2, user_authorization: "authorized" });
  return { created, id, caps, reviewReceipt };
}

function implReceipt(root: string, paths: string[]) {
  return JSON.parse(execFileSync(process.execPath, [realpathSync(join(root, ".codex", "agents", "change-receipt.ts")), "--allow-absent", "--", ...paths], { cwd: root, encoding: "utf8" }));
}

test("commit preparation succeeds across modify, add, delete, and mode and persists exact fields", () => {
  const { root, git } = fixture();
  try {
    writeFileSync(join(root, "mod.txt"), "v1\n");
    writeFileSync(join(root, "del.txt"), "gone\n");
    writeFileSync(join(root, "mode.txt"), "run\n");
    git("add", ".");
    git("commit", "-qm", "prepare fixture");
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const approved = ["add.txt", "del.txt", "mod.txt", "mode.txt"];
    const created = create(store, root, git, { objective: "prepare", approved_paths: approved });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    implementation(store, created, root, 0, "implemented", {}, "DONE", { receipt: implReceipt(root, approved) });
    writeFileSync(join(root, "mod.txt"), "v2\n");
    writeFileSync(join(root, "add.txt"), "new\n");
    unlinkSync(join(root, "del.txt"));
    chmodSync(join(root, "mode.txt"), 0o755);
    const reviewReceipt = JSON.parse(execFileSync(process.execPath, [realpathSync(join(root, ".codex", "agents", "change-receipt.ts")), "--", ...approved], { cwd: root, encoding: "utf8" }));
    const wtTarget = { review_mode: "working_tree", base_revision: created.workflow.base_head, head_revision: null, approved_paths: approved, include_staged: true, include_unstaged: true, include_untracked: true };
    store.submitReview({ workflow_id: id, capability: caps.reviewer, expected_version: 1, review_status: "APPROVED", blocking_findings: [], optional_findings: [], review_receipt: reviewReceipt, review_target: wtTarget, prior_finding_classifications: {} });
    store.authorizeCommit({ workflow_id: id, capability: caps.parent, expected_version: 2, user_authorization: "prepare authorized" });
    assert.deepEqual(store.get(id, "committer", caps.committer).permitted_next_actions, ["workflow_prepare_commit"]);
    git("add", "mod.txt");
    git("add", "add.txt");
    git("add", "del.txt");
    git("add", "mode.txt");
    const head = git("rev-parse", "HEAD");
    const indexTree = git("write-tree");
    const prepared = store.prepareCommit({ workflow_id: id, capability: caps.committer, expected_version: 3 });
    assert.equal(prepared.phase, "COMMIT_PREPARED");
    assert.equal(prepared.version, 4);
    assert.match(prepared.commit_preparation.attempt_id, /^[0-9a-f-]{36}$/u);
    assert.equal(prepared.commit_preparation.prepared_head, head);
    assert.equal(prepared.commit_preparation.prepared_tree, indexTree);
    assert.deepEqual(prepared.commit_preparation.expected_paths, approved);
    assert.equal(prepared.commit_preparation.review_receipt_digest, objectDigest(reviewReceipt));
    assert.match(prepared.commit_preparation.prepared_at, /^[0-9]{4}-/u);
    assert.deepEqual(store.get(id, "committer", caps.committer).permitted_next_actions, ["workflow_submit_commit_result"]);
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.equal(git("write-tree"), indexTree);
    assert.deepEqual(git("diff", "--cached", "--name-only").split("\n").filter(Boolean).sort(), approved);
    const events = store.audit(id, "parent", caps.parent);
    const preparedEvent = events[events.length - 1];
    assert.equal(preparedEvent.event_type, "COMMIT_PREPARED");
    assert.equal(preparedEvent.version, 4);
    assert.equal(preparedEvent.summary.phase_before, "COMMIT_AUTHORIZED");
    assert.equal(preparedEvent.summary.phase_after, "COMMIT_PREPARED");
    assert.equal(preparedEvent.summary.outcome, null);
    assert.equal(preparedEvent.summary.linked_workflow_id, null);
    store.close();
    const reopened: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const parentAfter = reopened.get(id, "parent", caps.parent);
    assert.equal(parentAfter.phase, "COMMIT_PREPARED");
    assert.deepEqual(parentAfter.commit_preparation, prepared.commit_preparation);
    reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("commit preparation rejects empty, partial, extra, and untracked staging without mutation", () => {
  const { root, git } = fixture();
  try {
    writeFileSync(join(root, "other.txt"), "o1\n");
    git("add", ".");
    git("commit", "-qm", "prepare guards fixture");
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const approved = ["new.txt", "note.txt", "other.txt"];
    const created = create(store, root, git, { objective: "prepare guards", approved_paths: approved });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    implementation(store, created, root, 0, "implemented", {}, "DONE", { receipt: implReceipt(root, approved) });
    writeFileSync(join(root, "note.txt"), "n2\n");
    writeFileSync(join(root, "other.txt"), "o2\n");
    writeFileSync(join(root, "new.txt"), "added\n");
    const reviewReceipt = JSON.parse(execFileSync(process.execPath, [realpathSync(join(root, ".codex", "agents", "change-receipt.ts")), "--", ...approved], { cwd: root, encoding: "utf8" }));
    const wtTarget = { review_mode: "working_tree", base_revision: created.workflow.base_head, head_revision: null, approved_paths: approved, include_staged: true, include_unstaged: true, include_untracked: true };
    store.submitReview({ workflow_id: id, capability: caps.reviewer, expected_version: 1, review_status: "APPROVED", blocking_findings: [], optional_findings: [], review_receipt: reviewReceipt, review_target: wtTarget, prior_finding_classifications: {} });
    store.authorizeCommit({ workflow_id: id, capability: caps.parent, expected_version: 2, user_authorization: "guards" });
    const prepare = () => store.prepareCommit({ workflow_id: id, capability: caps.committer, expected_version: 3 });
    const versionBefore = store.get(id, "parent", caps.parent).version;
    const auditBefore = store.audit(id, "parent", caps.parent).length;
    assert.equal(errorCategory(prepare), "ERROR_STAGED_SCOPE");
    git("add", "note.txt");
    assert.equal(errorCategory(prepare), "ERROR_STAGED_SCOPE");
    git("reset", "-q");
    git("add", "note.txt");
    git("add", "other.txt");
    writeFileSync(join(root, "unrelated.txt"), "extra\n");
    git("add", "unrelated.txt");
    assert.equal(errorCategory(prepare), "ERROR_STAGED_SCOPE");
    git("reset", "-q");
    git("add", "note.txt");
    git("add", "other.txt");
    assert.equal(errorCategory(prepare), "ERROR_STAGED_SCOPE");
    assert.equal(store.get(id, "parent", caps.parent).version, versionBefore);
    assert.equal(store.audit(id, "parent", caps.parent).length, auditBefore);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("commit preparation rejects stale receipts, content and mode mismatches, and changed HEAD without mutation", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });

    const stale = authorizedWorkflow(store, root, git);
    writeFileSync(join(root, "note.txt"), "v3\n");
    assert.equal(errorCategory(() => store.prepareCommit({ workflow_id: stale.id, capability: stale.caps.committer, expected_version: 3 })), "ERROR_STALE_RECEIPT");
    assert.equal(store.get(stale.id, "parent", stale.caps.parent).version, 3);
    assert.equal(store.audit(stale.id, "parent", stale.caps.parent).length, 4);

    const content = authorizedWorkflow(store, root, git);
    git("add", "note.txt");
    const tamperedBlob = execFileSync("git", ["-C", root, "hash-object", "-w", "--stdin"], { input: "tampered\n", encoding: "utf8" }).trim();
    git("update-index", "--cacheinfo", "100644", tamperedBlob, "note.txt");
    assert.equal(errorCategory(() => store.prepareCommit({ workflow_id: content.id, capability: content.caps.committer, expected_version: 3 })), "ERROR_STAGED_CONTENT");
    assert.equal(store.get(content.id, "parent", content.caps.parent).version, 3);

    const mode = authorizedWorkflow(store, root, git);
    git("add", "note.txt");
    git("update-index", "--chmod=+x", "note.txt");
    assert.equal(errorCategory(() => store.prepareCommit({ workflow_id: mode.id, capability: mode.caps.committer, expected_version: 3 })), "ERROR_STAGED_CONTENT");
    assert.equal(store.get(mode.id, "parent", mode.caps.parent).version, 3);

    const changed = authorizedWorkflow(store, root, git);
    git("add", "note.txt");
    git("commit", "-qm", "unexpected commit");
    assert.equal(errorCategory(() => store.prepareCommit({ workflow_id: changed.id, capability: changed.caps.committer, expected_version: 3 })), "ERROR_STALE_RECEIPT");
    assert.equal(store.get(changed.id, "parent", changed.caps.parent).version, 3);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("commit preparation rejects range workflows without mutation", () => {
  const { root, git, base, head } = rangeFixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const range = create(store, root, git, rangeInput(root, git, base, head, { objective: "range prepare" }));
    const id = range.workflow.workflow_id;
    const caps = range.capabilities;
    store.submitReview({ workflow_id: id, capability: caps.reviewer, expected_version: 0, review_status: "APPROVED", blocking_findings: [], optional_findings: [], review_receipt: null, review_target: range.workflow.review_target, prior_finding_classifications: {} });
    const before = store.get(id, "parent", caps.parent).version;
    assert.equal(errorCategory(() => store.prepareCommit({ workflow_id: id, capability: caps.committer, expected_version: 1 })), "ERROR_COMMIT_NOT_ALLOWED");
    assert.equal(store.get(id, "parent", caps.parent).version, before);
    assert.equal(store.audit(id, "parent", caps.parent).length, 2);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("commit preparation executes no hooks and leaves Git state untouched", () => {
  const { root, git } = fixture();
  try {
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    writeFileSync(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\ntouch hook-ran\n");
    chmodSync(join(root, ".git", "hooks", "pre-commit"), 0o755);
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "prepare hooks" });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    implementation(store, created, root, 0, "implemented");
    writeFileSync(join(root, "note.txt"), "v2\n");
    const reviewReceipt = JSON.parse(execFileSync(process.execPath, [realpathSync(join(root, ".codex", "agents", "change-receipt.ts")), "--", "note.txt"], { cwd: root, encoding: "utf8" }));
    store.submitReview({ workflow_id: id, capability: caps.reviewer, expected_version: 1, review_status: "APPROVED", blocking_findings: [], optional_findings: [], review_receipt: reviewReceipt, review_target: workingTarget(created.workflow.base_head), prior_finding_classifications: {} });
    store.authorizeCommit({ workflow_id: id, capability: caps.parent, expected_version: 2, user_authorization: "authorized" });
    const head = git("rev-parse", "HEAD");
    const logBefore = git("log", "--oneline");
    git("add", "note.txt");
    const statusBefore = git("status", "--porcelain");
    const prepared = store.prepareCommit({ workflow_id: id, capability: caps.committer, expected_version: 3 });
    assert.equal(prepared.phase, "COMMIT_PREPARED");
    assert.equal(git("rev-parse", "HEAD"), head);
    assert.equal(git("log", "--oneline"), logBefore);
    assert.equal(git("status", "--porcelain"), statusBefore);
    assert.equal(existsSync(join(root, "hook-ran")), false);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("commit result records a verified single-parent success", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "commit result" });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    implementation(store, created, root, 0, "implemented");
    writeFileSync(join(root, "note.txt"), "v2\n");
    const reviewReceipt = JSON.parse(execFileSync(process.execPath, [realpathSync(join(root, ".codex", "agents", "change-receipt.ts")), "--", "note.txt"], { cwd: root, encoding: "utf8" }));
    store.submitReview({ workflow_id: id, capability: caps.reviewer, expected_version: 1, review_status: "APPROVED", blocking_findings: [], optional_findings: [], review_receipt: reviewReceipt, review_target: workingTarget(created.workflow.base_head), prior_finding_classifications: {} });
    store.authorizeCommit({ workflow_id: id, capability: caps.parent, expected_version: 2, user_authorization: "authorized" });
    const headBefore = git("rev-parse", "HEAD");
    git("add", "note.txt");
    const prepared = store.prepareCommit({ workflow_id: id, capability: caps.committer, expected_version: 3 });
    assert.equal(prepared.phase, "COMMIT_PREPARED");
    git("commit", "-qm", "external change");
    const hash = git("rev-parse", "HEAD");
    assert.equal(git("rev-parse", "HEAD~1"), headBefore);
    const committed = store.submitCommitResult({ workflow_id: id, capability: caps.committer, expected_version: 4, attempt_id: prepared.commit_preparation.attempt_id, outcome: "committed", commit_hash: hash, failure_summary: null });
    assert.equal(committed.phase, "COMMITTED");
    assert.equal(committed.version, 5);
    assert.deepEqual(committed.commit_result, { outcome: "committed", commit_hash: hash, failure_summary: null });
    assert.deepEqual(committed.commit_preparation, prepared.commit_preparation);
    assert.deepEqual(store.get(id, "committer", caps.committer).permitted_next_actions, []);
    const events = store.audit(id, "parent", caps.parent);
    const resultEvent = events[events.length - 1];
    assert.equal(resultEvent.event_type, "COMMIT_RESULT_SUBMITTED");
    assert.equal(resultEvent.version, 5);
    assert.equal(resultEvent.summary.phase_before, "COMMIT_PREPARED");
    assert.equal(resultEvent.summary.phase_after, "COMMITTED");
    assert.equal(resultEvent.summary.outcome, "committed");
    assert.equal(resultEvent.summary.linked_workflow_id, null);
    assert.equal(JSON.stringify(events).includes(hash), false);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("commit result rejects attempt, field combination, role, version, and phase errors without mutation", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const { created, id, caps } = authorizedWorkflow(store, root, git);
    git("add", "note.txt");
    const prepared = store.prepareCommit({ workflow_id: id, capability: caps.committer, expected_version: 3 });
    const attemptId = prepared.commit_preparation.attempt_id;
    const versionBefore = store.get(id, "parent", caps.parent).version;
    const auditBefore = store.audit(id, "parent", caps.parent).length;
    const submit = (overrides: any) => store.submitCommitResult({ workflow_id: id, capability: caps.committer, expected_version: 4, attempt_id: attemptId, outcome: "committed", commit_hash: git("rev-parse", "HEAD"), failure_summary: null, ...overrides });
    const cases = [
      [{ attempt_id: "0".repeat(36) }, "ERROR_COMMIT_MISMATCH"],
      [{ outcome: "mismatch" }, "ERROR_INVALID_SHAPE"],
      [{ outcome: "committed", commit_hash: null }, "ERROR_INVALID_SHAPE"],
      [{ outcome: "committed", commit_hash: "xyz" }, "ERROR_INVALID_SHAPE"],
      [{ outcome: "committed", failure_summary: "failed" }, "ERROR_INVALID_SHAPE"],
      [{ outcome: "not_committed", commit_hash: "0".repeat(40) }, "ERROR_INVALID_SHAPE"],
      [{ outcome: "not_committed", failure_summary: null }, "ERROR_INVALID_SHAPE"],
      [{ outcome: "not_committed", failure_summary: "" }, "ERROR_INVALID_SHAPE"],
      [{ outcome: "not_committed", failure_summary: "x".repeat(2001) }, "ERROR_INVALID_SHAPE"],
      [{ extra: true }, "ERROR_INVALID_SHAPE"],
    ];
    for (const [overrides, expected] of cases) {
      assert.equal(errorCategory(() => submit(overrides)), expected, JSON.stringify(overrides));
    }
    assert.equal(errorCategory(() => store.submitCommitResult({ workflow_id: id, capability: caps.committer, expected_version: 4, outcome: "committed", commit_hash: git("rev-parse", "HEAD"), failure_summary: null })), "ERROR_INVALID_SHAPE");
    assert.equal(errorCategory(() => store.submitCommitResult({ workflow_id: id, capability: caps.reviewer, expected_version: 4, attempt_id: attemptId, outcome: "committed", commit_hash: git("rev-parse", "HEAD"), failure_summary: null })), "ERROR_CAPABILITY_DENIED");
    assert.equal(errorCategory(() => store.submitCommitResult({ workflow_id: id, capability: caps.committer, expected_version: 3, attempt_id: attemptId, outcome: "committed", commit_hash: git("rev-parse", "HEAD"), failure_summary: null })), "ERROR_VERSION_CONFLICT");
    const fresh = create(store, root, git, { objective: "wrong phase result" });
    assert.equal(errorCategory(() => store.submitCommitResult({ workflow_id: fresh.workflow.workflow_id, capability: fresh.capabilities.committer, expected_version: 0, attempt_id: attemptId, outcome: "committed", commit_hash: git("rev-parse", "HEAD"), failure_summary: null })), "ERROR_INVALID_TRANSITION");
    assert.equal(store.get(id, "parent", caps.parent).version, versionBefore);
    assert.equal(store.audit(id, "parent", caps.parent).length, auditBefore);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("hook and command failure with unchanged HEAD enters a retryable stop", () => {
  const { root, git } = fixture();
  try {
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    writeFileSync(join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(root, ".git", "hooks", "pre-commit"), 0o755);
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const { created, id, caps } = authorizedWorkflow(store, root, git);
    git("add", "note.txt");
    const prepared = store.prepareCommit({ workflow_id: id, capability: caps.committer, expected_version: 3 });
    assert.equal(prepared.phase, "COMMIT_PREPARED");
    const headBefore = git("rev-parse", "HEAD");
    let failed = false;
    try { git("commit", "-qm", "blocked attempt"); } catch { failed = true; }
    assert.equal(failed, true);
    assert.equal(git("rev-parse", "HEAD"), headBefore);
    const failureSummary = "pre-commit hook rejected the commit";
    const stopped = store.submitCommitResult({ workflow_id: id, capability: caps.committer, expected_version: 4, attempt_id: prepared.commit_preparation.attempt_id, outcome: "not_committed", commit_hash: null, failure_summary: failureSummary });
    assert.equal(stopped.phase, "STOPPED_NOT_COMMITTED");
    assert.equal(stopped.version, 5);
    assert.deepEqual(stopped.commit_result, { outcome: "not_committed", commit_hash: null, failure_summary: failureSummary });
    assert.deepEqual(stopped.commit_preparation, prepared.commit_preparation);
    assert.deepEqual(store.get(id, "parent", caps.parent).permitted_next_actions, ["workflow_retry_commit"]);
    assert.deepEqual(store.get(id, "committer", caps.committer).permitted_next_actions, []);
    const events = store.audit(id, "parent", caps.parent);
    const resultEvent = events[events.length - 1];
    assert.equal(resultEvent.event_type, "COMMIT_RESULT_SUBMITTED");
    assert.equal(resultEvent.summary.phase_before, "COMMIT_PREPARED");
    assert.equal(resultEvent.summary.phase_after, "STOPPED_NOT_COMMITTED");
    assert.equal(resultEvent.summary.outcome, "not_committed");
    assert.equal(resultEvent.summary.linked_workflow_id, null);
    assert.equal(JSON.stringify(events).includes(failureSummary), false);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("bounded commit failure is retained in state but absent from audit", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const { created, id, caps } = authorizedWorkflow(store, root, git);
    git("add", "note.txt");
    const prepared = store.prepareCommit({ workflow_id: id, capability: caps.committer, expected_version: 3 });
    const failureSummary = "command rejected: " + "x".repeat(1982);
    assert.equal(failureSummary.length, 2000);
    const stopped = store.submitCommitResult({ workflow_id: id, capability: caps.committer, expected_version: 4, attempt_id: prepared.commit_preparation.attempt_id, outcome: "not_committed", commit_hash: null, failure_summary: failureSummary });
    assert.equal(stopped.phase, "STOPPED_NOT_COMMITTED");
    assert.equal(stopped.commit_result.failure_summary, failureSummary);
    assert.equal(stopped.commit_result.failure_summary.length, 2000);
    const serializedAudit = JSON.stringify(store.audit(id, "parent", caps.parent));
    assert.equal(serializedAudit.includes("command rejected"), false);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("retry clears the attempt and result and permits preparation again", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const { created, id, caps } = authorizedWorkflow(store, root, git);
    git("add", "note.txt");
    const prepared = store.prepareCommit({ workflow_id: id, capability: caps.committer, expected_version: 3 });
    const stopped = store.submitCommitResult({ workflow_id: id, capability: caps.committer, expected_version: 4, attempt_id: prepared.commit_preparation.attempt_id, outcome: "not_committed", commit_hash: null, failure_summary: "hook rejected" });
    assert.equal(stopped.phase, "STOPPED_NOT_COMMITTED");

    assert.equal(errorCategory(() => store.retryCommit({ workflow_id: id, capability: caps.committer, expected_version: 5, retry_context: "x" })), "ERROR_CAPABILITY_DENIED");
    assert.equal(errorCategory(() => store.retryCommit({ workflow_id: id, capability: caps.parent, expected_version: 4, retry_context: "x" })), "ERROR_VERSION_CONFLICT");
    assert.equal(errorCategory(() => store.retryCommit({ workflow_id: id, capability: caps.parent, expected_version: 5 })), "ERROR_INVALID_SHAPE");
    assert.equal(errorCategory(() => store.retryCommit({ workflow_id: id, capability: caps.parent, expected_version: 5, retry_context: "x", extra: true })), "ERROR_INVALID_SHAPE");
    assert.equal(store.get(id, "parent", caps.parent).version, 5);

    const retried = store.retryCommit({ workflow_id: id, capability: caps.parent, expected_version: 5, retry_context: "hook fixed" });
    assert.equal(retried.phase, "COMMIT_AUTHORIZED");
    assert.equal(retried.version, 6);
    assert.equal(retried.commit_preparation, null);
    assert.equal(retried.commit_result, null);
    assert.deepEqual(retried.commit_authorization, stopped.commit_authorization);
    assert.equal(retried.recovery_context.kind, "commit");
    assert.equal(retried.recovery_context.context, "hook fixed");
    assert.match(retried.recovery_context.recovered_at, /^[0-9]{4}-/u);
    assert.deepEqual(store.get(id, "committer", caps.committer).permitted_next_actions, ["workflow_prepare_commit"]);
    const events = store.audit(id, "parent", caps.parent);
    const retryEvent = events[events.length - 1];
    assert.equal(retryEvent.event_type, "COMMIT_RETRY_AUTHORIZED");
    assert.equal(retryEvent.summary.phase_before, "STOPPED_NOT_COMMITTED");
    assert.equal(retryEvent.summary.phase_after, "COMMIT_AUTHORIZED");
    assert.equal(retryEvent.summary.outcome, "retry");
    assert.equal(retryEvent.summary.linked_workflow_id, null);
    assert.equal(JSON.stringify(events).includes("hook fixed"), false);

    const reprepared = store.prepareCommit({ workflow_id: id, capability: caps.committer, expected_version: 6 });
    assert.equal(reprepared.phase, "COMMIT_PREPARED");
    assert.notEqual(reprepared.commit_preparation.attempt_id, prepared.commit_preparation.attempt_id);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("committed results are terminal and cannot retry", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const { created, id, caps } = authorizedWorkflow(store, root, git);
    git("add", "note.txt");
    const prepared = store.prepareCommit({ workflow_id: id, capability: caps.committer, expected_version: 3 });
    git("commit", "-qm", "successful commit");
    const hash = git("rev-parse", "HEAD");
    const committed = store.submitCommitResult({ workflow_id: id, capability: caps.committer, expected_version: 4, attempt_id: prepared.commit_preparation.attempt_id, outcome: "committed", commit_hash: hash, failure_summary: null });
    assert.equal(committed.phase, "COMMITTED");
    for (const role of ["parent", "implementer", "reviewer", "committer"]) {
      assert.deepEqual(store.get(id, role, caps[role]).permitted_next_actions, []);
    }
    assert.equal(errorCategory(() => store.retryCommit({ workflow_id: id, capability: caps.parent, expected_version: 5, retry_context: "x" })), "ERROR_INVALID_TRANSITION");
    assert.equal(errorCategory(() => store.submitCommitResult({ workflow_id: id, capability: caps.committer, expected_version: 5, attempt_id: prepared.commit_preparation.attempt_id, outcome: "committed", commit_hash: hash, failure_summary: null })), "ERROR_INVALID_TRANSITION");
    assert.equal(store.get(id, "parent", caps.parent).version, 5);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

function insertV1Workflow(path: string, state: any) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE workflows (
      workflow_id TEXT PRIMARY KEY,
      version INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      parent_capability_hash TEXT NOT NULL,
      implementer_capability_hash TEXT NOT NULL,
      reviewer_capability_hash TEXT NOT NULL,
      committer_capability_hash TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE audit_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      workflow_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      summary_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (workflow_id) REFERENCES workflows(workflow_id)
    );
    CREATE INDEX audit_events_workflow ON audit_events(workflow_id, event_id);
  `);
  const caps = {
    parent: issueCapability(),
    implementer: issueCapability(),
    reviewer: issueCapability(),
    committer: issueCapability(),
  };
  db.prepare(
    "INSERT INTO workflows (workflow_id, version, state_json, parent_capability_hash, implementer_capability_hash, reviewer_capability_hash, committer_capability_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    state.workflow_id,
    state.version,
    JSON.stringify(state),
    hashCapability(caps.parent),
    hashCapability(caps.implementer),
    hashCapability(caps.reviewer),
    hashCapability(caps.committer),
    "2024-01-01T00:00:00.000Z",
    "2024-01-01T00:00:00.000Z",
  );
  db.close();
  return caps;
}

function v1AuthorizedState(root: string, git: (...args: string[]) => string, overrides: any = {}) {
  const base = git("rev-parse", "HEAD");
  writeFileSync(join(root, "note.txt"), "after\n");
  const reviewReceipt = JSON.parse(
    execFileSync(process.execPath, [realpathSync(join(root, ".codex", "agents", "change-receipt.ts")), "--", "note.txt"], { cwd: root, encoding: "utf8" }),
  );
  return {
    schema_version: 1,
    version: 0,
    workflow_id: randomUUID(),
    phase: "COMMIT_AUTHORIZED",
    objective: "legacy objective",
    base_head: base,
    approved_paths: ["note.txt"],
    repair_cycle: 0,
    max_repair_cycles: 2,
    parent_workflow_id: null,
    implementation_summary: null,
    implementation_status: null,
    implementation_changed_paths: ["note.txt"],
    implementation_acceptance_evidence: [],
    implementation_validation_evidence: [],
    implementation_receipt: null,
    implementation_known_failures: [],
    finding_resolution_map: {},
    prior_finding_classifications: {},
    blocking_findings: [],
    optional_findings: [],
    review_receipt: reviewReceipt,
    commit_authorization: { user_authorization: "legacy auth" },
    commit_result: null,
    repair_authorized_ids: [],
    authorized_optional_ids: [],
    user_authorization_summary: null,
    ...overrides,
  };
}

test("new v2 workflows deny legacy commit recording without mutation", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const { created, id, caps } = authorizedWorkflow(store, root, git);
    const before = store.get(id, "parent", caps.parent);
    const auditBefore = store.audit(id, "parent", caps.parent).length;
    assert.deepEqual(store.get(id, "committer", caps.committer).permitted_next_actions, ["workflow_prepare_commit"]);
    assert.equal(errorCategory(() => store.recordCommit({ workflow_id: id, capability: caps.committer, expected_version: 3, commit_hash: git("rev-parse", "HEAD") })), "ERROR_LEGACY_WORKFLOW");
    assert.equal(store.get(id, "parent", caps.parent).version, before.version);
    assert.equal(store.audit(id, "parent", caps.parent).length, auditBefore);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("commit result verification mismatches stop terminally with deterministic categories", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });

    const headChanged = authorizedWorkflow(store, root, git, { content: "m1\n" });
    git("add", "note.txt");
    const preparedHead = store.prepareCommit({ workflow_id: headChanged.id, capability: headChanged.caps.committer, expected_version: 3 });
    git("commit", "-qm", "moved head");
    const headResult = store.submitCommitResult({ workflow_id: headChanged.id, capability: headChanged.caps.committer, expected_version: 4, attempt_id: preparedHead.commit_preparation.attempt_id, outcome: "committed", commit_hash: headChanged.created.workflow.base_head, failure_summary: null });
    assert.equal(headResult.phase, "STOPPED_COMMIT_MISMATCH");
    assert.equal(headResult.commit_result.mismatch_category, "HEAD_CHANGED");

    const parentMismatch = authorizedWorkflow(store, root, git, { content: "m2\n" });
    git("add", "note.txt");
    const preparedParent = store.prepareCommit({ workflow_id: parentMismatch.id, capability: parentMismatch.caps.committer, expected_version: 3 });
    git("commit", "-qm", "intended commit");
    git("commit", "--allow-empty", "-qm", "extra commit");
    const parentResult = store.submitCommitResult({ workflow_id: parentMismatch.id, capability: parentMismatch.caps.committer, expected_version: 4, attempt_id: preparedParent.commit_preparation.attempt_id, outcome: "committed", commit_hash: git("rev-parse", "HEAD"), failure_summary: null });
    assert.equal(parentResult.phase, "STOPPED_COMMIT_MISMATCH");
    assert.equal(parentResult.commit_result.mismatch_category, "PARENT_MISMATCH");

    const treeMismatch = authorizedWorkflow(store, root, git, { content: "m3\n" });
    git("add", "note.txt");
    const preparedTree = store.prepareCommit({ workflow_id: treeMismatch.id, capability: treeMismatch.caps.committer, expected_version: 3 });
    writeFileSync(join(root, "note.txt"), "tampered\n");
    git("add", "note.txt");
    git("commit", "-qm", "tampered content");
    const treeResult = store.submitCommitResult({ workflow_id: treeMismatch.id, capability: treeMismatch.caps.committer, expected_version: 4, attempt_id: preparedTree.commit_preparation.attempt_id, outcome: "committed", commit_hash: git("rev-parse", "HEAD"), failure_summary: null });
    assert.equal(treeResult.phase, "STOPPED_COMMIT_MISMATCH");
    assert.equal(treeResult.commit_result.mismatch_category, "TREE_MISMATCH");

    const pathMismatch = authorizedWorkflow(store, root, git, { content: "m4\n" });
    git("add", "note.txt");
    const preparedPath = store.prepareCommit({ workflow_id: pathMismatch.id, capability: pathMismatch.caps.committer, expected_version: 3 });
    const tamperedState = JSON.parse(store.db.prepare("SELECT state_json FROM workflows WHERE workflow_id = ?").get(pathMismatch.id).state_json);
    tamperedState.commit_preparation.expected_paths = ["note.txt", "phantom.txt"];
    store.db.prepare("UPDATE workflows SET state_json = ?, state_digest = ? WHERE workflow_id = ?").run(JSON.stringify(tamperedState), objectDigest(tamperedState), pathMismatch.id);
    git("commit", "-qm", "path mismatch");
    const pathResult = store.submitCommitResult({ workflow_id: pathMismatch.id, capability: pathMismatch.caps.committer, expected_version: 4, attempt_id: preparedPath.commit_preparation.attempt_id, outcome: "committed", commit_hash: git("rev-parse", "HEAD"), failure_summary: null });
    assert.equal(pathResult.phase, "STOPPED_COMMIT_MISMATCH");
    assert.equal(pathResult.commit_result.mismatch_category, "PATH_MISMATCH");

    for (const result of [headResult, parentResult, treeResult, pathResult]) {
      assert.deepEqual(result.commit_result, { outcome: "mismatch", mismatch_category: result.commit_result.mismatch_category });
      assert.equal("failure_summary" in result.commit_result, false);
    }
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("not committed claim after a changed HEAD enters a terminal mismatch", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const { created, id, caps } = authorizedWorkflow(store, root, git);
    git("add", "note.txt");
    const prepared = store.prepareCommit({ workflow_id: id, capability: caps.committer, expected_version: 3 });
    git("commit", "-qm", "unexpected commit");
    const mismatched = store.submitCommitResult({ workflow_id: id, capability: caps.committer, expected_version: 4, attempt_id: prepared.commit_preparation.attempt_id, outcome: "not_committed", commit_hash: null, failure_summary: "the commit did not run" });
    assert.equal(mismatched.phase, "STOPPED_COMMIT_MISMATCH");
    assert.deepEqual(mismatched.commit_result, { outcome: "mismatch", mismatch_category: "HEAD_CHANGED" });
    assert.equal(mismatched.commit_result.failure_summary, undefined);
    const serialized = JSON.stringify(store.audit(id, "parent", caps.parent));
    assert.equal(serialized.includes("the commit did not run"), false);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("hook-created unexpected commit ends in a terminal mismatch", () => {
  const { root, git } = fixture();
  try {
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    writeFileSync(join(root, ".git", "hooks", "post-commit"), "#!/bin/sh\nif [ -z \"${HOOK_GUARD:-}\" ]; then\n  export HOOK_GUARD=1\n  git commit --allow-empty --no-verify -m \"hook unexpected commit\"\nfi\n");
    chmodSync(join(root, ".git", "hooks", "post-commit"), 0o755);
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const { created, id, caps } = authorizedWorkflow(store, root, git);
    git("add", "note.txt");
    const prepared = store.prepareCommit({ workflow_id: id, capability: caps.committer, expected_version: 3 });
    git("commit", "-qm", "intended commit");
    const mismatched = store.submitCommitResult({ workflow_id: id, capability: caps.committer, expected_version: 4, attempt_id: prepared.commit_preparation.attempt_id, outcome: "committed", commit_hash: git("rev-parse", "HEAD"), failure_summary: null });
    assert.equal(mismatched.phase, "STOPPED_COMMIT_MISMATCH");
    assert.equal(mismatched.commit_result.mismatch_category, "PARENT_MISMATCH");
    assert.equal(JSON.stringify(store.audit(id, "parent", caps.parent)).includes("hook unexpected commit"), false);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("commit mismatch stops are terminal and cannot retry or resume", () => {
  const { root, git } = fixture();
  try {
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const { created, id, caps } = authorizedWorkflow(store, root, git);
    git("add", "note.txt");
    const prepared = store.prepareCommit({ workflow_id: id, capability: caps.committer, expected_version: 3 });
    writeFileSync(join(root, "note.txt"), "tampered\n");
    git("add", "note.txt");
    git("commit", "-qm", "mismatch");
    const mismatched = store.submitCommitResult({ workflow_id: id, capability: caps.committer, expected_version: 4, attempt_id: prepared.commit_preparation.attempt_id, outcome: "committed", commit_hash: git("rev-parse", "HEAD"), failure_summary: null });
    assert.equal(mismatched.phase, "STOPPED_COMMIT_MISMATCH");
    assert.deepEqual(mismatched.commit_result, { outcome: "mismatch", mismatch_category: "TREE_MISMATCH" });
    assert.deepEqual(mismatched.commit_preparation, prepared.commit_preparation);
    for (const role of ["parent", "implementer", "reviewer", "committer"]) {
      assert.deepEqual(store.get(id, role, caps[role]).permitted_next_actions, []);
    }
    assert.equal(errorCategory(() => store.retryCommit({ workflow_id: id, capability: caps.parent, expected_version: 5, retry_context: "x" })), "ERROR_INVALID_TRANSITION");
    assert.equal(errorCategory(() => store.prepareCommit({ workflow_id: id, capability: caps.committer, expected_version: 5 })), "ERROR_STALE_RECEIPT");
    assert.equal(errorCategory(() => store.submitCommitResult({ workflow_id: id, capability: caps.committer, expected_version: 5, attempt_id: prepared.commit_preparation.attempt_id, outcome: "committed", commit_hash: git("rev-parse", "HEAD"), failure_summary: null })), "ERROR_INVALID_TRANSITION");
    assert.equal(store.get(id, "parent", caps.parent).version, 5);
    const events = store.audit(id, "parent", caps.parent);
    const resultEvent = events[events.length - 1];
    assert.equal(resultEvent.event_type, "COMMIT_RESULT_SUBMITTED");
    assert.equal(resultEvent.summary.phase_before, "COMMIT_PREPARED");
    assert.equal(resultEvent.summary.phase_after, "STOPPED_COMMIT_MISMATCH");
    assert.equal(resultEvent.summary.outcome, "mismatch");
    assert.equal(resultEvent.summary.linked_workflow_id, null);
    assert.equal(JSON.stringify(events).includes("tampered"), false);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("migrated legacy commit recording succeeds into COMMITTED", () => {
  const { root, git } = fixture();
  const path = join(root, "state.sqlite");
  try {
    const state = v1AuthorizedState(root, git);
    const caps = insertV1Workflow(path, state);
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    assert.deepEqual(store.get(state.workflow_id, "committer", caps.committer).permitted_next_actions, ["workflow_prepare_commit", "workflow_record_commit"]);
    git("add", "note.txt");
    git("commit", "-qm", "legacy change");
    const hash = git("rev-parse", "HEAD");
    const committed = store.recordCommit({ workflow_id: state.workflow_id, capability: caps.committer, expected_version: 1, commit_hash: hash });
    assert.equal(committed.phase, "COMMITTED");
    assert.equal(committed.version, 2);
    assert.deepEqual(committed.commit_result, { outcome: "committed", commit_hash: hash, failure_summary: null });
    assert.deepEqual(committed.commit_authorization, { user_authorization: "legacy auth" });
    assert.deepEqual(store.get(state.workflow_id, "committer", caps.committer).permitted_next_actions, []);
    const events = store.audit(state.workflow_id, "parent", caps.parent);
    const resultEvent = events[events.length - 1];
    assert.equal(resultEvent.event_type, "COMMIT_RECORDED");
    assert.equal(resultEvent.summary.phase_before, "COMMIT_AUTHORIZED");
    assert.equal(resultEvent.summary.phase_after, "COMMITTED");
    assert.equal(resultEvent.summary.outcome, "committed");
    assert.equal(resultEvent.summary.linked_workflow_id, null);
    assert.equal(JSON.stringify(events).includes(hash), false);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("migrated legacy commit recording failure stops terminally as a mismatch", () => {
  const { root, git } = fixture();
  const path = join(root, "state.sqlite");
  try {
    const state = v1AuthorizedState(root, git);
    const caps = insertV1Workflow(path, state);
    const store: any = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    writeFileSync(join(root, "note.txt"), "tampered\n");
    git("add", "note.txt");
    git("commit", "-qm", "tampered legacy commit");
    const mismatched = store.recordCommit({ workflow_id: state.workflow_id, capability: caps.committer, expected_version: 1, commit_hash: git("rev-parse", "HEAD") });
    assert.equal(mismatched.phase, "STOPPED_COMMIT_MISMATCH");
    assert.deepEqual(mismatched.commit_result, { outcome: "mismatch", mismatch_category: "TREE_MISMATCH" });
    assert.equal("failure_summary" in mismatched.commit_result, false);
    for (const role of ["parent", "implementer", "reviewer", "committer"]) {
      assert.deepEqual(store.get(state.workflow_id, role, (caps as any)[role]).permitted_next_actions, []);
    }
    const events = store.audit(state.workflow_id, "parent", caps.parent);
    const resultEvent = events[events.length - 1];
    assert.equal(resultEvent.event_type, "COMMIT_RECORDED");
    assert.equal(resultEvent.summary.phase_before, "COMMIT_AUTHORIZED");
    assert.equal(resultEvent.summary.phase_after, "STOPPED_COMMIT_MISMATCH");
    assert.equal(resultEvent.summary.outcome, "mismatch");
    assert.equal(resultEvent.summary.linked_workflow_id, null);
    assert.equal(JSON.stringify(events).includes("tampered"), false);
    assert.equal(JSON.stringify(events).includes("TREE_MISMATCH"), false);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
