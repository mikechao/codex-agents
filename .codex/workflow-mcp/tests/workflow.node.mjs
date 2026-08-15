import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { WorkflowError } from "../errors.mjs";
import { resolveStatePath, WorkflowStore } from "../store.mjs";
import { permittedNextActions, roleView } from "../transitions.mjs";
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

function absentReceipt(root, paths) {
  return JSON.parse(execFileSync(process.execPath, [realpathSync(join(root, ".codex", "agents", "change-receipt.mjs")), "--allow-absent", "--", ...paths], { cwd: root, encoding: "utf8" }));
}

function implementation(store, created, root, version, summary, resolution = {}, status = "DONE", options = {}) {
  return store.submitImplementation({
    workflow_id: created.workflow.workflow_id,
    capability: created.capabilities.implementer,
    expected_version: version,
    status,
    summary,
    agent_touched_paths: options.touched ?? [],
    acceptance_results: created.workflow.acceptance_criteria.map(({ criterion_id }) => ({ criterion_id, status: options.criterionStatus ?? "satisfied", evidence: "acceptance evidence" })),
    validation_results: created.workflow.validation_requirements.map(({ validation_id }) => ({ validation_id, status: options.validationStatus ?? "passed", evidence: "validation evidence" })),
    implementation_receipt: options.receipt ?? receipt(root),
    known_failures: options.knownFailures ?? [],
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

function createInput(root, git, options = {}) {
  const approvedPaths = options.approved_paths ?? ["note.txt"];
  return {
    workflow_type: "change",
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

function create(store, root, git, options = {}) {
  return store.create(createInput(root, git, options));
}

test("persists workflow, rejects stale versions and enforces role capabilities", () => {
  const { root, git } = fixture();
  const path = join(root, "state.sqlite");
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const created = create(store, root, git, { objective: "test workflow" });
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
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
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
    assert.equal(store.finalizeBlocked({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.parent, expected_version: 5 }).phase, "STOPPED_BLOCKED");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("optional findings require a fresh linked workflow", () => {
  const { root, git } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "optional" });
    implementation(store, created, root, 0, "implemented");
    writeFileSync(join(root, "note.txt"), "changed\n");
    const approved = review(store, created, root, 1, "APPROVED", [], [{ finding_id: "F-3", severity: "P3", blocking: false, file_and_line: "note.txt:1", failure_scenario: "might fail", impact: "small", violated_requirement: "quality", remediation: "consider", missing_or_inadequate_test: "optional" }]);
    assert.equal(approved.phase, "STOPPED_APPROVED");
    const linked = store.createOptionalFollowup({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.parent, expected_version: 2, objective: "authorized optional", approved_paths: ["note.txt"], optional_finding_ids: ["F-3"], user_authorization: "user approved optional follow-up" });
    assert.equal(linked.workflow.phase, "IMPLEMENTING");
    assert.equal(linked.workflow.repair_cycle, 0);
    assert.equal(linked.workflow.parent_workflow_id, created.workflow.workflow_id);
    const childState = JSON.parse(store.db.prepare("SELECT state_json FROM workflows WHERE workflow_id = ?").get(linked.workflow.workflow_id).state_json);
    assert.deepEqual(childState.authorized_optional_ids, ["F-3"]);
    assert.equal("authorized_optional_ids" in linked.workflow, false);
    assert.equal(store.get(created.workflow.workflow_id, "parent", created.capabilities.parent).version, 3);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("approved receipt gates commit and commit evidence", () => {
  const { root, git } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "commit" });
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
  const { root, git } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
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
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
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
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite"), faultAfterChildInsert: true });
    const created = create(store, root, git, { objective: "atomic" });
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
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
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
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
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
    assert.equal(errorCategory(() => store.finalizeBlocked({ workflow_id: repairing.workflow.workflow_id, capability: repairing.capabilities.parent, expected_version: 2, extra: true })), "ERROR_INVALID_SHAPE");
    assert.equal(store.get(repairing.workflow.workflow_id, "parent", repairing.capabilities.parent).version, repairBefore.version);
    assert.equal(store.audit(repairing.workflow.workflow_id, "parent", repairing.capabilities.parent).length, repairAudit);

    const approved = create(store, root, git, { objective: "commit shape" });
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
  const { root, git } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
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

test("rejects stale review and committed digest mismatches without mutation", () => {
  const { root, git } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
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
    assert.equal(errorCategory(() => store.recordCommit({ workflow_id: created.workflow.workflow_id, capability: created.capabilities.committer, expected_version: 3, commit_hash: git("rev-parse", "HEAD") })), "ERROR_COMMIT_MISMATCH");
    assert.equal(store.get(created.workflow.workflow_id, "parent", created.capabilities.parent).version, commitBefore.version);
    assert.equal(store.audit(created.workflow.workflow_id, "parent", created.capabilities.parent).length, commitAuditBefore);
    assert.equal(approved.phase, "STOPPED_APPROVED");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("v2 creation constructs every normative state key and stores a verified digest", () => {
  const { root, git } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
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
    assert.deepEqual(rawState.authorized_optional_ids, []);
    assert.equal(rawState.user_authorization_summary, null);
    assert.equal(row.state_digest, objectDigest(rawState));
    assert.equal(store.get(created.workflow.workflow_id, "parent", created.capabilities.parent).phase, "IMPLEMENTING");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("records dirty baseline paths from the initial receipt", () => {
  const { root, git } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
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
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "tamper" });
    const id = created.workflow.workflow_id;
    const read = () => store.db.prepare("SELECT state_json, state_digest FROM workflows WHERE workflow_id = ?").get(id);
    const original = read();
    const submit = (expected_version) => store.submitImplementation({ workflow_id: id, capability: created.capabilities.implementer, expected_version, status: "DONE", summary: "x", agent_touched_paths: [], acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "e" }], validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "v" }], implementation_receipt: receipt(root), known_failures: [], finding_resolution_map: {} });

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

test("audit envelopes use exact sanitized keys and sorted changed fields", () => {
  const { root, git } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
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

    store.finalizeBlocked({ workflow_id: id, capability: created.capabilities.parent, expected_version: 2 });
    const stopEvent = readAudit()[3];
    assert.equal(stopEvent.event_type, "WORKFLOW_BLOCKED");
    assert.deepEqual(Object.keys(stopEvent.summary).sort(), envelopeKeys);
    assert.equal(stopEvent.summary.phase_before, "REPAIR_REQUIRED");
    assert.equal(stopEvent.summary.phase_after, "STOPPED_BLOCKED");
    assert.equal(stopEvent.summary.outcome, "STOPPED_BLOCKED");
    assert.equal(stopEvent.summary.linked_workflow_id, null);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("audit digests form a continuity chain across mutations", () => {
  const { root, git } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
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
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
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
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, { objective: "append" });
    const id = created.workflow.workflow_id;
    const readAudit = () => store.audit(id, "parent", created.capabilities.parent);
    const rawIds = () =>
      store.db.prepare("SELECT event_id FROM audit_events WHERE workflow_id = ? ORDER BY event_id").all(id).map((row) => row.event_id);
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
    assert.deepEqual(events.map((event) => event.version), [0, 1, 2]);
    assert.deepEqual(events.map((event) => event.event_type), ["WORKFLOW_CREATED", "IMPLEMENTATION_SUBMITTED", "REVIEW_SUBMITTED"]);
    const ids = rawIds();
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    assert.equal(new Set(ids).size, ids.length);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("create assigns ordered contract IDs and preserves duplicate descriptions", () => {
  const { root, git } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
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
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    assert.equal(errorCategory(() => create(store, root, git, { acceptance_criteria: [] })), "ERROR_INVALID_SHAPE");
    assert.equal(errorCategory(() => create(store, root, git, { validation_requirements: [] })), "ERROR_INVALID_SHAPE");
    const many = Array.from({ length: 1000 }, (_, index) => `item ${index}`);
    assert.equal(errorCategory(() => create(store, root, git, { acceptance_criteria: many })), "ERROR_INVALID_SHAPE");
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("create rejects unknown fields and unsupported type and target mismatches", () => {
  const { root, git } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const head = git("rev-parse", "HEAD");
    const base = createInput(root, git, { objective: "shape" });
    assert.equal(errorCategory(() => store.create({ ...base, extra: true })), "ERROR_INVALID_SHAPE");
    assert.equal(
      errorCategory(() => store.create({ ...base, workflow_type: "review_only" })),
      "ERROR_UNSUPPORTED_WORKFLOW_TYPE",
    );
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
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
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
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const created = create(store, root, git, {
      objective: "restart contract",
      acceptance_criteria: ["restart criterion"],
      validation_requirements: ["restart validation"],
    });
    const id = created.workflow.workflow_id;
    const capabilities = created.capabilities;
    store.close();
    const reopened = new WorkflowStore({ repositoryRoot: root, databasePath: path });
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
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
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
    assert.deepEqual(store.get(id, "parent", caps.parent).permitted_next_actions, ["workflow_authorize_repair", "workflow_finalize_blocked"]);

    store.authorizeRepair({ workflow_id: id, capability: caps.parent, expected_version: 2, finding_ids: ["ROLE-1"] });
    assert.deepEqual(store.get(id, "implementer", caps.implementer).permitted_next_actions, ["workflow_submit_implementation"]);

    implementation(store, created, root, 3, "repaired", { "ROLE-1": "resolved" });
    writeFileSync(join(root, "note.txt"), "changed\n");
    review(store, created, root, 4, "APPROVED", [], [], { "ROLE-1": "resolved" });
    assert.deepEqual(store.get(id, "parent", caps.parent).permitted_next_actions, ["workflow_authorize_commit", "workflow_create_optional_followup"]);

    store.authorizeCommit({ workflow_id: id, capability: caps.parent, expected_version: 5, user_authorization: "authorized" });
    assert.deepEqual(store.get(id, "committer", caps.committer).permitted_next_actions, ["workflow_record_commit"]);

    git("add", "note.txt");
    git("commit", "-qm", "role views commit");
    store.recordCommit({ workflow_id: id, capability: caps.committer, expected_version: 6, commit_hash: git("rev-parse", "HEAD") });
    assert.deepEqual(store.get(id, "committer", caps.committer).permitted_next_actions, []);
    store.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("role views exclude capabilities, hashes, and compatibility fields in serialized output", () => {
  const { root, git } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
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
        assert.equal(serialized.includes(token), false, `view contains capability ${token}`);
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
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const created = create(store, root, git, { objective: "restart views" });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    implementation(store, created, root, 0, "implemented");
    store.close();
    const reopened = new WorkflowStore({ repositoryRoot: root, databasePath: path });
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
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
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
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
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
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
    const created = create(store, root, git, {
      acceptance_criteria: ["alpha", "beta"],
      validation_requirements: ["lint", "unit"],
    });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    const submit = (acceptance, validation) => store.submitImplementation({
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
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const results = {
      acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "a" }],
      validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "v" }],
    };
    const submit = (created, status, options = {}) => store.submitImplementation({
      workflow_id: created.workflow.workflow_id,
      capability: created.capabilities.implementer,
      expected_version: 0,
      status,
      summary: `summary ${status}`,
      agent_touched_paths: ["note.txt"],
      acceptance_results: results.acceptance_results,
      validation_results: results.validation_results,
      implementation_receipt: receipt(root),
      known_failures: options.knownFailures ?? [],
      finding_resolution_map: {},
    });
    const statuses = [
      ["DONE", "REVIEWING"],
      ["DONE_WITH_CONCERNS", "STOPPED_CONCERNS"],
      ["NEEDS_CONTEXT", "STOPPED_NEEDS_CONTEXT"],
      ["BLOCKED", "STOPPED_BLOCKED"],
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
    const reopened = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const persisted = reopened.get(done.id, "implementer", done.caps.implementer);
    assert.equal(persisted.phase, "REVIEWING");
    assert.equal(persisted.implementation_status, "DONE");
    assert.equal(persisted.implementation_summary, "summary DONE");
    assert.deepEqual(persisted.acceptance_results, results.acceptance_results);
    assert.deepEqual(persisted.validation_results, results.validation_results);
    assert.deepEqual(persisted.implementation_receipt, absentReceipt(root, ["note.txt"]));
    reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("failed and not-run validation, unsatisfied criteria, and known failures block DONE", () => {
  const { root, git } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
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
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
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
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
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
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const created = create(store, root, git, { objective: "stale receipt" });
    const id = created.workflow.workflow_id;
    const caps = created.capabilities;
    const stale = receipt(root);
    writeFileSync(join(root, "note.txt"), "changed after receipt\n");
    assert.equal(errorCategory(() => implementation(store, created, root, 0, "stale", {}, "DONE", { receipt: stale })), "ERROR_STALE_RECEIPT");
    assert.equal(store.get(id, "parent", caps.parent).version, 0);
    const done = implementation(store, created, root, 0, "complete");
    assert.equal(done.phase, "REVIEWING");
    store.close();

    const reopened = new WorkflowStore({ repositoryRoot: root, databasePath: path });
    const persisted = reopened.get(id, "implementer", caps.implementer);
    assert.equal(persisted.phase, "REVIEWING");
    assert.equal(persisted.implementation_status, "DONE");
    assert.deepEqual(persisted.acceptance_results, [
      { criterion_id: "AC-001", status: "satisfied", evidence: "acceptance evidence" },
    ]);
    assert.deepEqual(persisted.validation_results, [
      { validation_id: "VAL-001", status: "passed", evidence: "validation evidence" },
    ]);
    assert.deepEqual(persisted.implementation_receipt, absentReceipt(root, ["note.txt"]));
    reopened.close();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("migrated workflows with empty contracts cannot submit implementation", () => {
  const { root, git } = fixture();
  try {
    const store = new WorkflowStore({ repositoryRoot: root, databasePath: join(root, "state.sqlite") });
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
