import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkflowError } from "../errors.mjs";
import { resolveStatePath, WorkflowStore } from "../store.mjs";
import { objectDigest } from "../validation.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "workflow-state-"));
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-q");
  git("config", "user.email", "workflow@example.invalid");
  git("config", "user.name", "Workflow Tests");
  writeFileSync(join(root, "note.txt"), "before\n");
  git("add", ".");
  git("commit", "-qm", "fixture");
  mkdirSync(join(root, ".codex", "agents"), { recursive: true });
  cpSync(join(process.cwd(), ".codex", "agents", "change-receipt.mjs"), join(root, ".codex", "agents", "change-receipt.mjs"));
  return { root, git };
}

function receipt(root) {
  return JSON.parse(execFileSync(process.execPath, [realpathSync(join(root, ".codex", "agents", "change-receipt.mjs")), "--", "note.txt"], { cwd: root, encoding: "utf8" }));
}

function implementation(store, created, root, version, summary, resolution = {}, status = "DONE") {
  return store.submitImplementation({
    workflow_id: created.workflow.workflow_id,
    capability: created.capabilities.implementer,
    expected_version: version,
    status,
    summary,
    changed_paths: receipt(root).paths.filter((entry) => entry.state !== "unchanged").map((entry) => entry.path),
    acceptance_evidence: status === "DONE" ? ["acceptance evidence"] : [],
    validation_evidence: status === "DONE" ? ["validation evidence"] : [],
    implementation_receipt: receipt(root),
    known_failures: [],
    finding_resolution_map: resolution,
  });
}

function review(store, created, root, version, status, blocking, optional, prior = {}) {
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

function errorCategory(callback) {
  try { callback(); } catch (error) { assert.ok(error instanceof WorkflowError); return error.category; }
  assert.fail("expected workflow error");
}

test("persists workflow, rejects stale versions and enforces role capabilities", () => {
  const { root } = fixture();
  const path = join(root, "state.sqlite");
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const created = store.create({ objective: "test workflow", approved_paths: ["note.txt"] });
    assert.equal(created.workflow.phase, "IMPLEMENTING");
    assert.equal(errorCategory(() => store.get(created.workflow.workflow_id, "reviewer", created.capabilities.parent)), "ERROR_CAPABILITY_DENIED");
    const reviewing = implementation(store, created, root, 0, "implemented");
    assert.equal(reviewing.phase, "REVIEWING");
    assert.equal(errorCategory(() => implementation(store, created, root, 0, "stale")), "ERROR_VERSION_CONFLICT");
    store.close();
    const reopened = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    assert.equal(reopened.get(created.workflow.workflow_id, "parent", created.capabilities.parent).phase, "REVIEWING");
    reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("production state path is stable and outside the repository", () => {
  const { root } = fixture();
  try {
    const path = resolveStatePath(root);
    assert.equal(path.startsWith(root), false);
    assert.match(path, /[\\/]\.codex[\\/]state[\\/]workflow-mcp[\\/][0-9a-f]{24}[\\/]state\.sqlite$/u);
    assert.equal(path.includes("state.sqlite"), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("enforces P3 stopping and blocking repair cycle limit", () => {
  const { root } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = store.create({ objective: "findings", approved_paths: ["note.txt"], max_repair_cycles: 1 });
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
    assert.equal(store.finalizeBlocked({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.parent, expected_version: 5 }).phase, "STOPPED_BLOCKED");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("optional findings require a fresh linked workflow", () => {
  const { root } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = store.create({ objective: "optional", approved_paths: ["note.txt"] });
    implementation(store, created, root, 0, "implemented");
    writeFileSync(join(root, "note.txt"), "changed\n");
    const approved = review(store, created, root, 1, "APPROVED", [], [{ finding_id: "F-3", severity: "P3", blocking: false, file_and_line: "note.txt:1", failure_scenario: "might fail", impact: "small", violated_requirement: "quality", remediation: "consider", missing_or_inadequate_test: "optional" }]);
    assert.equal(approved.phase, "STOPPED_APPROVED");
    const linked = store.createOptionalFollowup({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.parent, expected_version: 2, objective: "authorized optional", approved_paths: ["note.txt"], optional_finding_ids: ["F-3"], user_authorization: "user approved optional follow-up" });
    assert.equal(linked.workflow.phase, "IMPLEMENTING");
    assert.equal(linked.workflow.repair_cycle, 0);
    assert.equal(linked.workflow.parent_workflow_id, created.workflow.workflow_id);
    assert.deepEqual(linked.workflow.authorized_optional_ids, ["F-3"]);
    assert.equal(store.get(created.workflow.workflow_id, "parent", created.capabilities.parent).version, 3);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("approved receipt gates commit and commit evidence", () => {
  const { root, git } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = store.create({ objective: "commit", approved_paths: ["note.txt"] });
    implementation(store, created, root, 0, "implemented");
    writeFileSync(join(root, "note.txt"), "after\n");
    const reviewResult = review(store, created, root, 1, "APPROVED", [], []);
    assert.equal(reviewResult.phase, "STOPPED_APPROVED");
    const authorized = store.authorizeCommit({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.parent, expected_version: 2, user_authorization: "user requested commit" });
    assert.equal(authorized.phase, "COMMIT_AUTHORIZED");
    git("add", "note.txt");
    git("commit", "-qm", "fixture change");
    const hash = git("rev-parse", "HEAD");
    const committed = store.recordCommit({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.committer, expected_version: 3, commit_hash: hash });
    assert.equal(committed.phase, "COMMITTED");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("implementation statuses stop explicitly and require complete repair continuity", () => {
  const { root } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = store.create({ objective: "status", approved_paths: ["note.txt"] });
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
  const { root } = fixture();
  try {
    mkdirSync(join(root, "folder"));
    writeFileSync(join(root, "socket-target"), "x");
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    for (const [paths, expected] of [[["folder"], "ERROR_DIRECTORY_PATH"], [["*.txt"], "ERROR_INVALID_PATHS"], [["../note.txt"], "ERROR_INVALID_PATHS"], [["./note.txt", "note.txt"], "ERROR_INVALID_PATHS"], [["absent.txt"], "ERROR_UNTRACKED_PATH"]]) {
      assert.equal(errorCategory(() => store.create({ objective: "invalid", approved_paths: paths })), expected);
    }
    const created = store.create({ objective: "valid", approved_paths: ["note.txt"] });
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
  const { root } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite"), faultAfterChildInsert: true });
    const created = store.create({ objective: "atomic", approved_paths: ["note.txt"] });
    implementation(store, created, root, 0, "implemented");
    writeFileSync(join(root, "note.txt"), "changed\n");
    review(store, created, root, 1, "APPROVED", [], [{ finding_id: "OPT", severity: "P3", blocking: false, file_and_line: "note.txt:1", failure_scenario: "might fail", impact: "small", violated_requirement: "quality", remediation: "consider", missing_or_inadequate_test: "optional" }]);
    const before = store.audit(created.workflow.workflow_id, "parent", created.capabilities.parent);
    assert.equal(errorCategory(() => store.createOptionalFollowup({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.parent, expected_version: 2, objective: "atomic child", approved_paths: ["note.txt"], optional_finding_ids: ["OPT"], user_authorization: "authorized" })), "ERROR_INJECTED_FAILURE");
    const after = store.audit(created.workflow.workflow_id, "parent", created.capabilities.parent);
    assert.deepEqual(after, before);
    assert.equal(store.get(created.workflow.workflow_id, "parent", created.capabilities.parent).version, 2);
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM workflows").get().count, 1);
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
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const deleted = store.create({ objective: "deletion", approved_paths: ["note.txt"] });
    assert.equal(deleted.workflow.phase, "IMPLEMENTING");
    const symlink = store.create({ objective: "symlink", approved_paths: ["link.txt"] });
    assert.equal(symlink.workflow.phase, "IMPLEMENTING");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects missing implementation and review continuity classifications without mutation", () => {
  const { root } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = store.create({ objective: "continuity", approved_paths: ["note.txt"] });
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
  const { root } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    assert.equal(
      errorCategory(() => store.create({ objective: "extra", approved_paths: ["note.txt"], extra: true })),
      "ERROR_INVALID_SHAPE",
    );

    const repairing = store.create({ objective: "repair shape", approved_paths: ["note.txt"], max_repair_cycles: 0 });
    implementation(store, repairing, root, 0, "implemented");
    const blocker = { finding_id: "SHAPE-1", severity: "P1", blocking: true, file_and_line: "note.txt:1", failure_scenario: "fails", impact: "bad", violated_requirement: "safe", remediation: "fix", missing_or_inadequate_test: "test" };
    review(store, repairing, root, 1, "CHANGES_REQUESTED", [blocker], []);
    const repairBefore = store.get(repairing.workflow.workflow_id, "parent", repairing.capabilities.parent);
    const repairAudit = store.audit(repairing.workflow.workflow_id, "parent", repairing.capabilities.parent).length;
    assert.equal(errorCategory(() => store.authorizeRepair({ workflow_id: repairing.workflow.workflow_id, capability: repairing.capabilities.parent, expected_version: 2, finding_ids: ["SHAPE-1"], extra: true })), "ERROR_INVALID_SHAPE");
    assert.equal(errorCategory(() => store.finalizeBlocked({ workflow_id: repairing.workflow.workflow_id, capability: repairing.capabilities.parent, expected_version: 2, extra: true })), "ERROR_INVALID_SHAPE");
    assert.equal(store.get(repairing.workflow.workflow_id, "parent", repairing.capabilities.parent).version, repairBefore.version);
    assert.equal(store.audit(repairing.workflow.workflow_id, "parent", repairing.capabilities.parent).length, repairAudit);

    const approved = store.create({ objective: "commit shape", approved_paths: ["note.txt"] });
    implementation(store, approved, root, 0, "implemented");
    writeFileSync(join(root, "note.txt"), "shape\n");
    review(store, approved, root, 1, "APPROVED", [], [{ finding_id: "OPT-SHAPE", severity: "P3", blocking: false, file_and_line: "note.txt:1", failure_scenario: "might fail", impact: "small", violated_requirement: "quality", remediation: "consider", missing_or_inadequate_test: "optional" }]);
    const approvedBefore = store.get(approved.workflow.workflow_id, "parent", approved.capabilities.parent);
    const approvedAudit = store.audit(approved.workflow.workflow_id, "parent", approved.capabilities.parent).length;
    assert.equal(errorCategory(() => store.createOptionalFollowup({ workflow_id: approved.workflow.workflow_id, capability: approved.capabilities.parent, expected_version: 2, objective: "child", approved_paths: ["note.txt"], optional_finding_ids: ["OPT-SHAPE"], user_authorization: "authorized", extra: true })), "ERROR_INVALID_SHAPE");
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
  const { root } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = store.create({ objective: "continuity", approved_paths: ["note.txt"] });
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

    const inconclusive = store.create({ objective: "inconclusive", approved_paths: ["note.txt"] });
    implementation(store, inconclusive, root, 0, "implemented");
    const inconclusiveBefore = store.get(inconclusive.workflow.workflow_id, "parent", inconclusive.capabilities.parent);
    const target = { review_mode: "working_tree", base_revision: inconclusive.workflow.base_head, head_revision: null, approved_paths: ["note.txt"], include_staged: true, include_unstaged: true, include_untracked: true };
    assert.equal(errorCategory(() => store.submitReview({ workflow_id: inconclusive.workflow.workflow_id, capability: inconclusive.capabilities.reviewer, expected_version: 1, review_status: "INCONCLUSIVE", blocking_findings: [], optional_findings: [], review_receipt: receipt(root), review_target: target, prior_finding_classifications: {} })), "ERROR_INVALID_REVIEW");
    assert.equal(store.get(inconclusive.workflow.workflow_id, "parent", inconclusive.capabilities.parent).version, inconclusiveBefore.version);
    assert.equal(store.submitReview({ workflow_id: inconclusive.workflow.workflow_id, capability: inconclusive.capabilities.reviewer, expected_version: 1, review_status: "INCONCLUSIVE", blocking_findings: [], optional_findings: [], review_receipt: null, review_target: target, prior_finding_classifications: {} }).phase, "STOPPED_INCONCLUSIVE");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects stale review and committed digest mismatches without mutation", () => {
  const { root, git } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = store.create({ objective: "receipts", approved_paths: ["note.txt"] });
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
    assert.equal(errorCategory(() => store.recordCommit({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.committer, expected_version: 3, commit_hash: git("rev-parse", "HEAD") })), "ERROR_COMMIT_MISMATCH");
    assert.equal(store.get(created.workflow.workflow_id, "parent", created.capabilities.parent).version, commitBefore.version);
    assert.equal(store.audit(created.workflow.workflow_id, "parent", created.capabilities.parent).length, commitAuditBefore);
    assert.equal(approved.phase, "STOPPED_APPROVED");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("v2 creation constructs every normative state key and stores a verified digest", () => {
  const { root } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = store.create({ objective: "v2 state", approved_paths: ["note.txt"] });
    const workflow = created.workflow;
    assert.equal(workflow.schema_version, 2);
    assert.equal(workflow.version, 0);
    assert.equal(workflow.workflow_type, "change");
    assert.equal(workflow.legacy_v1, false);
    assert.equal(workflow.phase, "IMPLEMENTING");
    assert.equal(workflow.objective, "v2 state");
    assert.equal(workflow.base_head, created.workflow.base_head);
    assert.deepEqual(workflow.approved_paths, ["note.txt"]);
    assert.deepEqual(workflow.acceptance_criteria, []);
    assert.deepEqual(workflow.validation_requirements, []);
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
    assert.deepEqual(workflow.implementation_changed_paths, []);
    assert.deepEqual(workflow.implementation_acceptance_evidence, []);
    assert.deepEqual(workflow.implementation_validation_evidence, []);
    assert.deepEqual(workflow.authorized_optional_ids, []);
    assert.equal(workflow.user_authorization_summary, null);
    const row = store.db.prepare("SELECT state_json, state_digest FROM workflows WHERE workflow_id = ?").get(created.workflow.workflow_id);
    assert.equal(row.state_digest, objectDigest(JSON.parse(row.state_json)));
    assert.equal(store.get(created.workflow.workflow_id, "parent", created.capabilities.parent).phase, "IMPLEMENTING");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("records dirty baseline paths from the initial receipt", () => {
  const { root } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    writeFileSync(join(root, "note.txt"), "modified\n");
    writeFileSync(join(root, "new.txt"), "added\n");
    const created = store.create({ objective: "baseline", approved_paths: ["note.txt", "new.txt"] });
    assert.deepEqual(created.workflow.dirty_baseline_paths, ["new.txt", "note.txt"]);
    writeFileSync(join(root, "note.txt"), "before\n");
    const clean = store.create({ objective: "clean", approved_paths: ["note.txt"] });
    assert.deepEqual(clean.workflow.dirty_baseline_paths, []);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("rejects digest and JSON tampering and preserves state on failed mutation", () => {
  const { root } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = store.create({ objective: "tamper", approved_paths: ["note.txt"] });
    const id = created.workflow.workflow_id;
    const read = () => store.db.prepare("SELECT state_json, state_digest FROM workflows WHERE workflow_id = ?").get(id);
    const original = read();
    const submit = (expected_version) => store.submitImplementation({ workflow_id: id, capability: created.capabilities.implementer, expected_version, status: "DONE", summary: "x", changed_paths: [], acceptance_evidence: ["e"], validation_evidence: ["v"], implementation_receipt: receipt(root), known_failures: [], finding_resolution_map: {} });

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
