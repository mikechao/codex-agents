import { test } from "bun:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { deriveOperatorDecision } from "../operator-decision.js";
import { WorkflowStore } from "../store.js";
import { fixture } from "./test-fixtures.js";

function create(
  store: WorkflowStore,
  git: (...args: string[]) => string,
  workflowType: "change" | "review_only" = "change",
  validationRequirements: Array<{ description: string; argv: string[] | null }> = [
    { description: "validation", argv: ["bun", "run", "check"] },
  ],
) {
  const paths = ["note.txt"];
  return store.create({
    workflow_type: workflowType,
    objective: "operator projection test",
    approved_plan: null,
    approved_paths: paths,
    acceptance_criteria: ["criterion"],
    validation_requirements: validationRequirements,
    review_target: {
      review_mode: "working_tree",
      base_revision: git("rev-parse", "HEAD"),
      head_revision: null,
      approved_paths: paths,
      include_staged: true,
      include_unstaged: true,
      include_untracked: true,
    },
  });
}

test("operator projection requests parent-owned manual evidence before review", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "operator-manual.sqlite");
  const store = new WorkflowStore({ repositoryRoot: root, databasePath });
  try {
    const created = create(store, git, "change", [
      { description: "executable", argv: ["bun", "run", "check"] },
      { description: "manual inspection", argv: null },
    ]);
    const id = created.workflow.workflow_id;
    store.submitImplementation({
      workflow_id: id,
      expected_version: 0,
      status: "DONE",
      summary: "implemented",
      agent_touched_paths: [],
      acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "ok" }],
      validation_results: [
        { validation_id: "VAL-001", status: "passed", evidence: "ok" },
        { validation_id: "VAL-002", status: "not_run", evidence: "parent check pending" },
      ],
      known_failures: [],
      finding_resolution_map: {},
    });
    assert.deepEqual(store.operatorDecisionGet(id).primary, {
      kind: "manual_validation_required",
      validations: [{ validation_id: "VAL-002", description: "manual inspection" }],
    });
    assert.deepEqual(store.reviewerGet(id).permitted_next_actions, []);
    store.recordManualValidation({
      workflow_id: id,
      capability: created.capability,
      expected_version: 1,
      validation_id: "VAL-002",
      status: "passed",
      evidence: "inspected",
    });
    assert.deepEqual(store.operatorDecisionGet(id).primary, {
      kind: "no_user_action",
      route: "review",
    });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator projection never offers commit for incomplete or failed validation", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "operator-commit-validation.sqlite");
  const store = new WorkflowStore({ repositoryRoot: root, databasePath });
  try {
    const created = create(store, git, "change", [
      { description: "manual inspection", argv: null },
    ]);
    for (const validationResults of [
      [],
      [{ validation_id: "VAL-001", status: "not_run", evidence: "pending" }],
      [{ validation_id: "VAL-001", status: "failed", evidence: "failed" }],
    ]) {
      const approved = structuredClone(created.workflow) as any;
      approved.phase = "STOPPED_APPROVED";
      approved.validation_results = validationResults;
      const decision = deriveOperatorDecision(approved, [
        { state: approved, actions: { parent: ["workflow_authorize_commit"] } },
      ]);
      assert.equal(decision.commit.eligible, false);
      assert.notEqual(decision.primary.kind, "approve_commit");
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function finding(id: string, severity: "P1" | "P3" = "P1") {
  return {
    finding_id: id,
    severity,
    blocking: severity !== "P3",
    file_and_line: "operator-decision.ts:1",
    failure_scenario: "the bounded projection does not route the state correctly",
    impact: "the operator needs a deterministic bounded decision",
    violated_requirement: "the projection must preserve the workflow contract",
    remediation: "use the available semantic route",
    missing_or_inadequate_test: "a focused projection test",
  };
}

test("operator projection routes implementation and is read-only and sanitized", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "operator.sqlite");
  const store = new WorkflowStore({ repositoryRoot: root, databasePath });
  try {
    const created = create(store, git);
    const id = created.workflow.workflow_id;
    const before = store.parentGet(id);
    const first = store.operatorDecisionGet(id);
    const second = store.operatorDecisionGet(id);
    assert.deepEqual(first, second);
    assert.deepEqual(first.primary, { kind: "no_user_action", route: "implement" });
    assert.equal(first.intent.scope_kind, "direct");
    assert.equal("workflow_id" in first, false);
    assert.equal(JSON.stringify(first).includes("permitted_next_actions"), false);
    assert.equal(store.parentGet(id).version, before.version);
    assert.deepEqual(
      store.audit(id, created.capability).map((event) => event.version),
      [0],
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator projection routes a fresh review without treating retained blockers as repair", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "operator-review.sqlite");
  const store = new WorkflowStore({ repositoryRoot: root, databasePath });
  try {
    const created = create(store, git);
    const id = created.workflow.workflow_id;
    store.submitImplementation({
      workflow_id: id,
      expected_version: 0,
      status: "DONE",
      summary: "implemented",
      agent_touched_paths: [],
      acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "ok" }],
      validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "ok" }],
      known_failures: [],
      finding_resolution_map: {},
    });
    const decision = store.operatorDecisionGet(id);
    assert.deepEqual(decision.primary, { kind: "no_user_action", route: "review" });
    assert.equal(decision.outcome.status, "awaiting_review");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator projection distinguishes review-only and completed review refreshes", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "operator-review-modes.sqlite");
  const store = new WorkflowStore({ repositoryRoot: root, databasePath });
  try {
    const reviewOnly = create(store, git, "review_only");
    assert.deepEqual(store.operatorDecisionGet(reviewOnly.workflow.workflow_id).primary, {
      kind: "no_user_action",
      route: "review",
    });

    const reviewed = structuredClone(reviewOnly.workflow) as any;
    reviewed.review_result_version = 1;
    reviewed.review_start_receipt = null;
    reviewed.phase = "REVIEWING";
    const decision = deriveOperatorDecision(reviewed, [
      {
        state: reviewed,
        actions: { reviewer: ["workflow_begin_review"] },
      },
    ]);
    assert.deepEqual(decision.primary, { kind: "no_user_action", route: "re_review" });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator projection finalizes rather than authorizes repair at the cycle limit", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "operator-exhaustion.sqlite");
  const store = new WorkflowStore({ repositoryRoot: root, databasePath });
  try {
    const created = create(store, git);
    const exhaustedReview = structuredClone(created.workflow) as any;
    exhaustedReview.phase = "REPAIR_REQUIRED";
    exhaustedReview.repair_cycle = 1;
    exhaustedReview.max_repair_cycles = 1;
    exhaustedReview.blocking_findings = [finding("BLOCKER-1")];
    const decision = deriveOperatorDecision(exhaustedReview);
    assert.deepEqual(decision.primary, {
      kind: "finalize_repair_exhausted",
      reason: "the repair cycle limit is reached; finalize the exhausted workflow",
    });
    assert.equal(decision.outcome.status, "exhausted");

    const linked = linkedStates(store, git);
    linked.child.phase = "STOPPED_REPAIR_EXHAUSTED";
    const continuation = deriveOperatorDecision(linked.child, [
      { state: linked.root, actions: {} },
      {
        state: linked.child,
        actions: { parent: ["workflow_create_linked_followup"] },
      },
    ]);
    assert.deepEqual(continuation.primary, {
      kind: "approve_bounded_continuation",
      reason: "the bounded linked continuation is supported",
      authorization_required: true,
    });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator projection includes sanitized optional findings and recovery summaries", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "operator-summary.sqlite");
  const store = new WorkflowStore({ repositoryRoot: root, databasePath });
  try {
    const created = create(store, git);
    const approved = structuredClone(created.workflow) as any;
    approved.phase = "STOPPED_APPROVED";
    approved.optional_findings = [
      {
        ...finding("OPTIONAL-1", "P3"),
        impact: "  optional   P3   concern  ".repeat(30),
      },
    ];
    const approvalDecision = deriveOperatorDecision(approved, [
      {
        state: approved,
        actions: { parent: ["workflow_authorize_commit"] },
      },
    ]);
    assert.equal(approvalDecision.optional_findings.length, 1);
    assert.equal(approvalDecision.optional_findings[0].severity, "P3");
    assert.ok(approvalDecision.optional_findings[0].summary.length <= 240);
    assert.equal(JSON.stringify(approvalDecision).includes("OPTIONAL-1"), false);

    const stopped = structuredClone(created.workflow) as any;
    stopped.phase = "STOPPED_INCONCLUSIVE";
    stopped.stop_context = {
      status: "INCONCLUSIVE",
      summary: "  review needs bounded external context  ",
      stopped_from: "REVIEWING",
    };
    stopped.recovery_context = {
      kind: "review",
      context: "  operator supplied the missing context  ",
      recovered_at: "2026-08-29T00:00:00.000Z",
    };
    const recoveryDecision = deriveOperatorDecision(stopped, [
      { state: stopped, actions: { parent: ["workflow_resume_review"] } },
    ]);
    assert.deepEqual(recoveryDecision.recovery_summary, {
      choice: "resume_review",
      stop_reason: "review needs bounded external context",
      recovery_context: "operator supplied the missing context",
    });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator projection summarizes commit failure and keeps verification mismatch fail-closed", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "operator-commit-stops.sqlite");
  const store = new WorkflowStore({ repositoryRoot: root, databasePath });
  try {
    const created = create(store, git);
    const notCommitted = structuredClone(created.workflow) as any;
    notCommitted.phase = "STOPPED_NOT_COMMITTED";
    notCommitted.commit_result = {
      outcome: "not_committed",
      commit_hash: null,
      failure_summary: "  commit   command   failed  ".repeat(30),
    };
    const failureDecision = deriveOperatorDecision(notCommitted, [
      { state: notCommitted, actions: { parent: ["workflow_retry_commit"] } },
    ]);
    assert.deepEqual(failureDecision.primary, {
      kind: "approve_recovery",
      recovery: "retry_commit",
      authorization_required: true,
    });
    assert.equal(failureDecision.recovery_summary.choice, "retry_commit");
    assert.equal(failureDecision.recovery_summary.recovery_context, null);
    assert.ok((failureDecision.recovery_summary.stop_reason?.length ?? 0) <= 240);
    assert.equal(failureDecision.recovery_summary.stop_reason?.includes("  "), false);

    const mismatch = structuredClone(created.workflow) as any;
    mismatch.phase = "STOPPED_COMMIT_MISMATCH";
    mismatch.commit_result = {
      outcome: "mismatch",
      mismatch_category: "HEAD_CHANGED",
    };
    const mismatchDecision = deriveOperatorDecision(mismatch);
    assert.deepEqual(mismatchDecision.primary, {
      kind: "operator_intervention",
      reason: "no supported recovery is available",
    });
    assert.deepEqual(mismatchDecision.recovery_summary, {
      choice: null,
      stop_reason: "commit verification failed; repository state did not match the prepared commit",
      recovery_context: null,
    });
    assert.equal(mismatchDecision.recovery_summary.stop_reason?.includes("HEAD_CHANGED"), false);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function linkedStates(store: WorkflowStore, git: (...args: string[]) => string) {
  const created = create(store, git);
  const root = structuredClone(created.workflow) as any;
  const child = structuredClone(root) as any;
  const rootId = root.workflow_id;
  const childId = "child-workflow";
  root.parent_workflow_id = null;
  root.source_workflow_id = null;
  root.linked_continuation = null;
  root.superseded_by_workflow_id = childId;
  child.workflow_id = childId;
  child.parent_workflow_id = rootId;
  child.source_workflow_id = rootId;
  child.superseded_by_workflow_id = null;
  child.linked_continuation = {
    root_workflow_id: rootId,
    predecessor_workflow_id: rootId,
    lineage_workflow_ids: [rootId],
    original_base_head: root.base_head,
    combined_review_paths: root.approved_paths,
    review_stage: "remediation",
    remediation_review_receipt: null,
  };
  return { root, child };
}

test("operator projection rejects branch merges, divergent order, and extra unrelated records", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "operator-lineage.sqlite");
  const store = new WorkflowStore({ repositoryRoot: root, databasePath });
  try {
    const valid = linkedStates(store, git);
    const validDecision = deriveOperatorDecision(valid.root, [
      { state: valid.root, actions: {} },
      { state: valid.child, actions: {} },
    ]);
    assert.equal(validDecision.reconciliation.status, "remediation_then_combined_review");

    const branch = structuredClone(valid.root) as any;
    branch.workflow_id = "branch-workflow";
    branch.superseded_by_workflow_id = "child-workflow";
    const branchMerge = structuredClone(valid.child) as any;
    branchMerge.parent_workflow_id = valid.root.workflow_id;
    branchMerge.source_workflow_id = branch.workflow_id;
    branchMerge.linked_continuation.predecessor_workflow_id = branch.workflow_id;
    const branchDecision = deriveOperatorDecision(valid.root, [
      { state: valid.root, actions: {} },
      { state: branchMerge, actions: {} },
      { state: branch, actions: {} },
    ]);
    assert.equal(branchDecision.primary.kind, "operator_intervention");

    const divergentPredecessor = structuredClone(valid.child) as any;
    divergentPredecessor.workflow_id = "divergent-predecessor";
    divergentPredecessor.superseded_by_workflow_id = null;
    divergentPredecessor.parent_workflow_id = valid.root.workflow_id;
    divergentPredecessor.source_workflow_id = valid.root.workflow_id;
    divergentPredecessor.linked_continuation.predecessor_workflow_id = valid.root.workflow_id;
    const divergent = structuredClone(valid.child) as any;
    divergent.parent_workflow_id = divergentPredecessor.workflow_id;
    divergent.source_workflow_id = divergentPredecessor.workflow_id;
    divergent.linked_continuation.predecessor_workflow_id = divergentPredecessor.workflow_id;
    divergent.linked_continuation.lineage_workflow_ids = [
      valid.root.workflow_id,
      divergentPredecessor.workflow_id,
    ];
    const divergentDecision = deriveOperatorDecision(valid.root, [
      { state: valid.root, actions: {} },
      { state: divergentPredecessor, actions: {} },
      { state: divergent, actions: {} },
    ]);
    assert.equal(divergentDecision.primary.kind, "operator_intervention");

    const extraLineage = structuredClone(valid.child) as any;
    const rootWithExtraLineage = structuredClone(valid.root) as any;
    const extraLineageRecord = structuredClone(valid.root) as any;
    extraLineageRecord.workflow_id = "extra-lineage-workflow";
    extraLineage.workflow_id = "extra-lineage-child";
    rootWithExtraLineage.superseded_by_workflow_id = extraLineage.workflow_id;
    extraLineage.linked_continuation.lineage_workflow_ids = [
      valid.root.workflow_id,
      extraLineageRecord.workflow_id,
    ];
    const extraLineageDecision = deriveOperatorDecision(rootWithExtraLineage, [
      { state: rootWithExtraLineage, actions: {} },
      { state: extraLineage, actions: {} },
      { state: extraLineageRecord, actions: {} },
    ]);
    assert.equal(extraLineageDecision.primary.kind, "operator_intervention");

    const unrelated = structuredClone(valid.root) as any;
    unrelated.workflow_id = "unrelated-workflow";
    unrelated.superseded_by_workflow_id = null;
    const extraDecision = deriveOperatorDecision(valid.root, [
      { state: valid.root, actions: {} },
      { state: valid.child, actions: {} },
      { state: unrelated, actions: {} },
    ]);
    assert.equal(extraDecision.primary.kind, "operator_intervention");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
