import { test } from "bun:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { WorkflowError } from "../errors.js";
import { lineageReferences, MAX_LINEAGE_RECORDS } from "../lineage.js";
import { deriveOperatorDecision } from "../operator-decision.js";
import { WorkflowStore } from "../store.js";
import { hasFailedRequiredValidation, permittedNextActions } from "../transitions.js";
import type { WorkflowId, WorkflowState } from "../types.js";
import { objectDigest } from "../validation.js";
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

function assertDirectActionProjection(store: WorkflowStore, state: any) {
  const comparableState = structuredClone(state);
  if (comparableState.linked_continuation === undefined) comparableState.linked_continuation = null;
  const actions = {
    parent: permittedNextActions(comparableState, "parent"),
    implementer: permittedNextActions(comparableState, "implementer"),
    reviewer: permittedNextActions(comparableState, "reviewer"),
    committer: permittedNextActions(comparableState, "committer"),
  };
  const directDecision = deriveOperatorDecision(comparableState, [
    { state: comparableState, actions },
  ]);
  assert.deepEqual(directDecision, store.operatorDecisionGet(state.workflow_id));
  assert.deepEqual(store.parentGet(state.workflow_id).permitted_next_actions, actions.parent);
  assert.deepEqual(
    store.implementerGet(state.workflow_id).permitted_next_actions,
    actions.implementer,
  );
  assert.deepEqual(store.reviewerGet(state.workflow_id).permitted_next_actions, actions.reviewer);
  assert.deepEqual(store.committerGet(state.workflow_id).permitted_next_actions, actions.committer);
}

test("operator projection matches direct action derivation across representative states", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "operator-direct-actions.sqlite");
  const store = new WorkflowStore({ repositoryRoot: root, databasePath });
  try {
    const implementing = create(store, git);
    assertDirectActionProjection(store, implementing);

    store.submitImplementation({
      workflow_id: implementing.workflow_id,
      expected_version: 0,
      status: "DONE",
      summary: "implemented",
      agent_touched_paths: [],
      acceptance_results: [{ criterion_id: "AC-001", status: "satisfied", evidence: "ok" }],
      validation_results: [{ validation_id: "VAL-001", status: "passed", evidence: "ok" }],
      known_failures: [],
      finding_resolution_map: {},
    });
    assertDirectActionProjection(store, store.parentGet(implementing.workflow_id));

    const reviewOnly = create(store, git, "review_only");
    assertDirectActionProjection(store, reviewOnly);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator projection requests parent-owned manual evidence before review", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "operator-manual.sqlite");
  const store: any = new WorkflowStore({ repositoryRoot: root, databasePath });
  try {
    const created = create(store, git, "change", [
      { description: "executable", argv: ["bun", "run", "check"] },
      { description: "manual inspection", argv: null },
    ]);
    const id = created.workflow_id;
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

    const stopped = JSON.parse(
      store.db.prepare("SELECT state_json FROM workflows WHERE workflow_id = ?").get(id).state_json,
    ) as any;
    stopped.phase = "STOPPED_INCONCLUSIVE";
    stopped.stop_context = {
      status: "INCONCLUSIVE",
      summary: "review context unavailable",
      stopped_from: "REVIEWING",
    };
    store.db
      .prepare("UPDATE workflows SET state_json = ?, state_digest = ? WHERE workflow_id = ?")
      .run(JSON.stringify(stopped), objectDigest(stopped), id);
    assert.deepEqual(store.operatorDecisionGet(id).primary, {
      kind: "manual_validation_required",
      validations: [{ validation_id: "VAL-002", description: "manual inspection" }],
    });
    store.recordManualValidation({
      workflow_id: id,
      expected_version: 1,
      validation_id: "VAL-002",
      status: "passed",
      evidence: "inspected",
    });
    assert.deepEqual(store.parentGet(id).permitted_next_actions, [
      "workflow_adopt_dirty_scope",
      "workflow_resume_review",
    ]);
    assert.deepEqual(store.operatorDecisionGet(id).primary, {
      kind: "approve_recovery",
      recovery: "resume_review",
      authorization_required: true,
    });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator projection routes failed-plus-pending change review and preserves review-only gating", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "operator-failed-pending.sqlite");
  const store = new WorkflowStore({ repositoryRoot: root, databasePath });
  try {
    const change = create(store, git, "change", [
      { description: "executable", argv: ["bun", "run", "check"] },
      { description: "manual inspection", argv: null },
    ]);
    const changeState = structuredClone(change) as any;
    changeState.phase = "REVIEWING";
    changeState.linked_continuation = null;
    changeState.validation_results = [
      { validation_id: "VAL-001", status: "failed", evidence: "failed" },
      { validation_id: "VAL-002", status: "not_run", evidence: "pending" },
    ];
    assert.equal(hasFailedRequiredValidation(changeState), true);
    assert.deepEqual(
      deriveOperatorDecision(changeState, [
        {
          state: changeState,
          actions: {
            parent: ["workflow_record_manual_validation"],
            reviewer: ["workflow_begin_review"],
          },
        },
      ]).primary,
      { kind: "no_user_action", route: "review" },
    );

    const stoppedChange = structuredClone(changeState) as any;
    stoppedChange.phase = "STOPPED_INCONCLUSIVE";
    stoppedChange.stop_context = {
      status: "INCONCLUSIVE",
      summary: "review context unavailable",
      stopped_from: "REVIEWING",
    };
    assert.deepEqual(
      deriveOperatorDecision(stoppedChange, [
        {
          state: stoppedChange,
          actions: {
            parent: ["workflow_adopt_dirty_scope", "workflow_record_manual_validation"],
          },
        },
      ]).primary,
      {
        kind: "manual_validation_required",
        validations: [{ validation_id: "VAL-002", description: "manual inspection" }],
      },
    );

    const reviewOnly = create(store, git, "review_only", [
      { description: "executable", argv: ["bun", "run", "check"] },
      { description: "manual inspection", argv: null },
    ]);
    const reviewOnlyState = structuredClone(reviewOnly) as any;
    reviewOnlyState.phase = "REVIEWING";
    reviewOnlyState.linked_continuation = null;
    reviewOnlyState.validation_results = [
      { validation_id: "VAL-001", status: "failed", evidence: "failed" },
      { validation_id: "VAL-002", status: "not_run", evidence: "pending" },
    ];
    assert.equal(hasFailedRequiredValidation(reviewOnlyState), true);
    assert.deepEqual(
      deriveOperatorDecision(reviewOnlyState, [
        {
          state: reviewOnlyState,
          actions: { parent: ["workflow_record_manual_validation"], reviewer: [] },
        },
      ]).primary,
      {
        kind: "manual_validation_required",
        validations: [{ validation_id: "VAL-002", description: "manual inspection" }],
      },
    );

    for (const malformed of [
      [
        { validation_id: "VAL-002", status: "not_run", evidence: "pending" },
        { validation_id: "VAL-001", status: "failed", evidence: "failed" },
      ],
      [
        { validation_id: "VAL-001", status: "failed", evidence: "failed" },
        { validation_id: "VAL-001", status: "failed", evidence: "duplicate" },
      ],
    ]) {
      const invalid = structuredClone(changeState) as any;
      invalid.validation_results = malformed;
      assert.equal(hasFailedRequiredValidation(invalid), false);
    }
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
      const approved = structuredClone(created) as any;
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
    const id = created.workflow_id;
    const before = store.parentGet(id);
    const first = store.operatorDecisionGet(id);
    const second = store.operatorDecisionGet(id);
    assert.deepEqual(first, second);
    assert.deepEqual(first.primary, { kind: "no_user_action", route: "implement" });
    assert.equal(first.intent.scope_kind, "direct");
    assert.equal("workflow_id" in first, false);
    assert.equal(JSON.stringify(first).includes("permitted_next_actions"), false);
    const serialized = JSON.stringify(first);
    for (const internal of [
      id ?? "",
      "workflow_authorize_commit",
      "workflow_retry_commit",
      "STOPPED_APPROVED",
      "REPAIR_REQUIRED",
      "capability",
      "receipt",
      "audit",
      "plan_id",
    ]) {
      assert.equal(serialized.includes(internal), false, `projection leaked ${internal}`);
    }
    assert.equal(store.parentGet(id).version, before.version);
    assert.deepEqual(
      store.audit(id).map((event) => event.version),
      [0],
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator projection preserves semantic decision enums across explicit boundaries", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "operator-semantic-enums.sqlite");
  const store = new WorkflowStore({ repositoryRoot: root, databasePath });
  try {
    const created = create(store, git);
    const base = structuredClone(created) as any;
    const repair = structuredClone(base) as any;
    repair.phase = "REPAIR_REQUIRED";
    repair.blocking_findings = [finding("BLOCKER-ENUM")];
    assert.equal(
      deriveOperatorDecision(repair, [
        { state: repair, actions: { parent: ["workflow_authorize_repair"] } },
      ]).primary.kind,
      "approve_exact_repairs",
    );

    const concern = structuredClone(base) as any;
    concern.phase = "STOPPED_CONCERNS";
    assert.deepEqual(
      deriveOperatorDecision(concern, [
        { state: concern, actions: { parent: ["workflow_accept_concerns"] } },
      ]).primary,
      { kind: "approve_recovery", recovery: "accept_concerns", authorization_required: true },
    );

    const retry = structuredClone(base) as any;
    retry.phase = "STOPPED_NOT_COMMITTED";
    retry.commit_result = { outcome: "not_committed", failure_summary: "retry" };
    assert.deepEqual(
      deriveOperatorDecision(retry, [
        { state: retry, actions: { parent: ["workflow_retry_commit"] } },
      ]).primary,
      { kind: "approve_recovery", recovery: "retry_commit", authorization_required: true },
    );

    const approved = structuredClone(base) as any;
    approved.phase = "STOPPED_APPROVED";
    approved.validation_results = [{ validation_id: "VAL-001", status: "passed", evidence: "ok" }];
    assert.deepEqual(
      deriveOperatorDecision(approved, [
        { state: approved, actions: { parent: ["workflow_authorize_commit"] } },
      ]).primary,
      { kind: "approve_commit", authorization_required: true },
    );

    const exhausted = structuredClone(base) as any;
    exhausted.phase = "STOPPED_REPAIR_EXHAUSTED";
    assert.deepEqual(
      deriveOperatorDecision(exhausted, [
        { state: exhausted, actions: { parent: ["workflow_create_linked_followup"] } },
      ]).primary,
      {
        kind: "approve_bounded_continuation",
        reason: "the bounded linked continuation is supported",
        authorization_required: true,
      },
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
    const id = created.workflow_id;
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
    assert.deepEqual(store.operatorDecisionGet(reviewOnly.workflow_id).primary, {
      kind: "no_user_action",
      route: "review",
    });

    const reviewed = structuredClone(reviewOnly) as any;
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
    const exhaustedReview = structuredClone(created) as any;
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
    const approved = structuredClone(created) as any;
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

    const stopped = structuredClone(created) as any;
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
    const notCommitted = structuredClone(created) as any;
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

    const mismatch = structuredClone(created) as any;
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
  const root = structuredClone(created) as any;
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

test("operator lineage references share the exact bounded relationship definition", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "operator-lineage-bound.sqlite");
  const store = new WorkflowStore({ repositoryRoot: root, databasePath });
  try {
    const state = structuredClone(create(store, git)) as unknown as WorkflowState;
    const ids = ["parent", "source", "successor", "root", "predecessor", "lineage"] as WorkflowId[];
    state.parent_workflow_id = ids[0];
    state.source_workflow_id = ids[1];
    state.superseded_by_workflow_id = ids[2];
    state.linked_continuation = {
      root_workflow_id: ids[3],
      predecessor_workflow_id: ids[4],
      lineage_workflow_ids: [ids[5], ids[0], ids[5], ids[3]],
      original_base_head: state.base_head,
      combined_review_paths: state.approved_paths,
      review_stage: "remediation",
      remediation_review_receipt: null,
    };

    assert.deepEqual(lineageReferences(state), ids);
    const empty = structuredClone(state);
    empty.parent_workflow_id = null;
    empty.source_workflow_id = null;
    empty.superseded_by_workflow_id = null;
    empty.linked_continuation = null;
    assert.deepEqual(lineageReferences(empty), []);
    assert.equal(MAX_LINEAGE_RECORDS, 32);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator lineage validation accepts the bound and rejects records over it", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "operator-lineage-limit.sqlite");
  const store = new WorkflowStore({ repositoryRoot: root, databasePath });
  try {
    const base = structuredClone(create(store, git)) as unknown as WorkflowState;
    const buildRecords = (count: number) => {
      const states = Array.from({ length: count }, (_, index) => {
        const state = structuredClone(base) as WorkflowState;
        state.workflow_id = `lineage-${index}` as WorkflowId;
        state.parent_workflow_id = null;
        state.source_workflow_id = null;
        state.superseded_by_workflow_id = null;
        state.linked_continuation = null;
        return state;
      });
      for (let index = 0; index < states.length - 1; index += 1) {
        const current = states[index] as WorkflowState;
        const successor = states[index + 1] as WorkflowState;
        const lineage = states.slice(0, index + 1).map((state) => state.workflow_id as WorkflowId);
        current.superseded_by_workflow_id = successor.workflow_id;
        successor.parent_workflow_id = current.workflow_id;
        successor.source_workflow_id = current.workflow_id;
        successor.linked_continuation = {
          root_workflow_id: states[0]?.workflow_id as WorkflowId,
          predecessor_workflow_id: current.workflow_id as WorkflowId,
          lineage_workflow_ids: lineage,
          original_base_head: base.base_head,
          combined_review_paths: base.approved_paths,
          review_stage: "remediation",
          remediation_review_receipt: null,
        };
      }
      return states.map((state) => ({ state, actions: {} }));
    };

    const withinRecords = buildRecords(MAX_LINEAGE_RECORDS);
    const withinBound = deriveOperatorDecision(
      withinRecords[0]?.state as WorkflowState,
      withinRecords,
    );
    assert.equal(withinBound.primary.kind, "no_user_action");

    const overRecords = buildRecords(MAX_LINEAGE_RECORDS + 1);
    const overBound = deriveOperatorDecision(overRecords[0]?.state as WorkflowState, overRecords);
    assert.deepEqual(overBound.primary, {
      kind: "operator_intervention",
      reason: "explicit lineage exceeds the bounded traversal limit",
    });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("persisted operator lineage traversal accepts the bound and rejects records over it", () => {
  const { root, git } = fixture();
  const seedPersistedLineage = (store: any, count: number) => {
    const created = create(store, git);
    const rootId = created.workflow_id as WorkflowId;
    const base = JSON.parse(
      store.db.prepare("SELECT state_json FROM workflows WHERE workflow_id = ?").get(rootId)
        .state_json,
    ) as WorkflowState;
    const ids = [
      rootId,
      ...Array.from(
        { length: count - 1 },
        (_, index) => `00000000-0000-4000-8000-${(index + 1).toString(16).padStart(12, "0")}`,
      ),
    ] as WorkflowId[];
    const states = ids.map((workflowId, index) => {
      const state = structuredClone(base) as WorkflowState;
      state.workflow_id = workflowId;
      state.parent_workflow_id = index === 0 ? null : ids[index - 1];
      state.source_workflow_id = index === 0 ? null : ids[index - 1];
      state.superseded_by_workflow_id = ids[index + 1] ?? null;
      state.linked_continuation =
        index === 0
          ? null
          : {
              root_workflow_id: rootId,
              predecessor_workflow_id: ids[index - 1] as WorkflowId,
              lineage_workflow_ids: ids.slice(0, index),
              original_base_head: state.base_head,
              combined_review_paths: state.approved_paths,
              review_stage: "remediation",
              remediation_review_receipt: null,
            };
      return state;
    });
    const now = new Date().toISOString();
    store.db
      .prepare(
        "UPDATE workflows SET state_json = ?, state_digest = ?, updated_at = ? WHERE workflow_id = ?",
      )
      .run(JSON.stringify(states[0]), objectDigest(states[0]), now, rootId);
    const insert = store.db.prepare(
      "INSERT INTO workflows (workflow_id, version, state_json, state_digest, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const state of states.slice(1)) {
      insert.run(
        state.workflow_id,
        state.version,
        JSON.stringify(state),
        objectDigest(state),
        now,
        now,
      );
    }
    return rootId;
  };

  const exactDatabasePath = join(root, "operator-lineage-persisted-bound.sqlite");
  const exactStore = new WorkflowStore({
    repositoryRoot: root,
    databasePath: exactDatabasePath,
  }) as any;
  try {
    const rootId = seedPersistedLineage(exactStore, MAX_LINEAGE_RECORDS);
    assert.equal(exactStore.operatorDecisionGet(rootId).primary.kind, "no_user_action");
  } finally {
    exactStore.close();
  }

  const overDatabasePath = join(root, "operator-lineage-persisted-over-bound.sqlite");
  const overStore = new WorkflowStore({
    repositoryRoot: root,
    databasePath: overDatabasePath,
  }) as any;
  try {
    const rootId = seedPersistedLineage(overStore, MAX_LINEAGE_RECORDS + 1);
    assert.throws(
      () => overStore.operatorDecisionGet(rootId),
      (error: unknown) =>
        error instanceof WorkflowError && error.category === "ERROR_STATE_CORRUPT",
    );
  } finally {
    overStore.close();
    rmSync(root, { recursive: true, force: true });
  }
});
