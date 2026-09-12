import { test } from "bun:test";
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorkflowError } from "../errors.js";
import { lineageReferences, MAX_LINEAGE_RECORDS } from "../lineage.js";
import { deriveOperatorDecision } from "../operator-decision.js";
import { WorkflowStore } from "../store.js";
import {
  hasFailedRequiredValidation,
  permittedNextActions,
  resumeImplementation,
  workflowLegality,
} from "../transitions.js";
import type { WorkflowAction, WorkflowId, WorkflowState } from "../types.js";
import { MAX_PATHS, objectDigest } from "../validation.js";
import { WORKFLOW_ACTION_VALUES } from "../values.js";
import { fixture } from "./test-fixtures.js";

function create(
  store: WorkflowStore,
  git: (...args: string[]) => string,
  workflowType: "change" | "review_only" = "change",
  validationRequirements: Array<{
    description: string;
    kind: "command" | "inspection";
    argv?: string[];
  }> = [{ description: "validation", kind: "command", argv: ["bun", "run", "check"] }],
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
  const readiness = {
    head: { status: "readable" as const, current_head: comparableState.base_head },
    implementation_submission: { status: "ready" as const },
    review_recovery: { status: "resume" as const },
    review: {
      status: (comparableState.review_start_receipt ? "submit" : "begin") as "submit" | "begin",
    },
    approved_review: { status: "current" as const },
    commit_preparation: { status: "ready" as const },
    commit_review_return: { status: "ready" as const },
    commit_result: { status: "ready" as const, authority: "committer" as const },
  };
  const actions = {
    parent: permittedNextActions(comparableState, "parent", readiness),
    implementer: permittedNextActions(comparableState, "implementer", readiness),
    reviewer: permittedNextActions(comparableState, "reviewer", readiness),
    committer: permittedNextActions(comparableState, "committer", readiness),
  };
  const directDecision = deriveOperatorDecision(comparableState, [
    { state: comparableState, readiness },
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

type ActionPreconditionAudit = {
  surface: "projected_transition" | "protocol_boundary";
  durable_state: readonly string[];
  projection_readiness: readonly string[];
  payload_or_mutation_time: readonly string[];
};

const ACTION_PRECONDITION_AUDIT = {
  workflow_create: {
    surface: "protocol_boundary",
    durable_state: [],
    projection_readiness: ["repository root, HEAD, and initial receipt/range"],
    payload_or_mutation_time: ["new workflow contract"],
  },
  workflow_parent_get: {
    surface: "protocol_boundary",
    durable_state: [],
    projection_readiness: ["runtime ownership or reconciled attestation"],
    payload_or_mutation_time: ["workflow identity"],
  },
  workflow_implementer_get: {
    surface: "protocol_boundary",
    durable_state: [],
    projection_readiness: ["runtime ownership"],
    payload_or_mutation_time: ["workflow identity"],
  },
  workflow_reviewer_get: {
    surface: "protocol_boundary",
    durable_state: [],
    projection_readiness: ["runtime ownership"],
    payload_or_mutation_time: ["workflow identity"],
  },
  workflow_committer_get: {
    surface: "protocol_boundary",
    durable_state: [],
    projection_readiness: ["runtime ownership"],
    payload_or_mutation_time: ["workflow identity"],
  },
  workflow_get_audit: {
    surface: "protocol_boundary",
    durable_state: [],
    projection_readiness: ["runtime ownership or reconciled attestation"],
    payload_or_mutation_time: ["workflow identity and audit pagination"],
  },
  workflow_adopt_dirty_scope: {
    surface: "projected_transition",
    durable_state: ["reviewRecoveryStateReady"],
    projection_readiness: ["review_recovery: adopt"],
    payload_or_mutation_time: ["exact expansion paths and authorization"],
  },
  workflow_expand_scope: {
    surface: "projected_transition",
    durable_state: ["scopeMutationReadiness", "eligible phase"],
    projection_readiness: ["readable HEAD equal to base"],
    payload_or_mutation_time: ["new paths, clean candidate baseline, and authorization"],
  },
  workflow_submit_implementation: {
    surface: "projected_transition",
    durable_state: ["implementation phase"],
    projection_readiness: ["implementation_submission receipt readiness"],
    payload_or_mutation_time: ["implementation evidence and claimed paths"],
  },
  workflow_record_manual_validation: {
    surface: "projected_transition",
    durable_state: ["eligible phase and pending inspection"],
    projection_readiness: [],
    payload_or_mutation_time: ["inspection ID, status, and evidence"],
  },
  workflow_resume_implementation: {
    surface: "projected_transition",
    durable_state: ["implementationRecoveryStateReady"],
    projection_readiness: [],
    payload_or_mutation_time: ["resume context"],
  },
  workflow_accept_concerns: {
    surface: "projected_transition",
    durable_state: ["concern stop phase and context"],
    projection_readiness: [],
    payload_or_mutation_time: ["user authorization"],
  },
  workflow_begin_review: {
    surface: "projected_transition",
    durable_state: ["reviewTargetStateReady and inspection readiness", "working-tree target"],
    projection_readiness: ["review: begin or refresh"],
    payload_or_mutation_time: [],
  },
  workflow_submit_review: {
    surface: "projected_transition",
    durable_state: ["reviewTargetStateReady and inspection readiness"],
    projection_readiness: ["review: submit"],
    payload_or_mutation_time: ["result, findings, classifications, and evidence"],
  },
  workflow_authorize_repair: {
    surface: "projected_transition",
    durable_state: ["repairCycleReadiness: authorize"],
    projection_readiness: [],
    payload_or_mutation_time: ["finding IDs and repair directive"],
  },
  workflow_adjudicate_findings: {
    surface: "projected_transition",
    durable_state: ["repair phase, current review result, and effective blockers"],
    projection_readiness: [],
    payload_or_mutation_time: ["finding dispositions and authorization"],
  },
  workflow_resume_review: {
    surface: "projected_transition",
    durable_state: ["reviewRecoveryStateReady"],
    projection_readiness: ["review_recovery: resume"],
    payload_or_mutation_time: ["resume context"],
  },
  workflow_finalize_repair_exhausted: {
    surface: "projected_transition",
    durable_state: ["repairCycleReadiness: finalize"],
    projection_readiness: [],
    payload_or_mutation_time: [],
  },
  workflow_create_linked_followup: {
    surface: "projected_transition",
    durable_state: ["linkedFollowupStateReadiness"],
    projection_readiness: ["readable/current HEAD"],
    payload_or_mutation_time: ["finding IDs, child scope, and authorization"],
  },
  workflow_create_linked_followup_from_plan: {
    surface: "projected_transition",
    durable_state: ["linkedFollowupStateReadiness"],
    projection_readiness: ["readable/current HEAD"],
    payload_or_mutation_time: ["current approved plan and finding IDs"],
  },
  workflow_authorize_commit: {
    surface: "projected_transition",
    durable_state: ["commitAuthorizationStateReady"],
    projection_readiness: ["approved_review: current"],
    payload_or_mutation_time: ["user authorization"],
  },
  workflow_prepare_commit: {
    surface: "projected_transition",
    durable_state: ["commit-authorized phase"],
    projection_readiness: ["commit_preparation receipt/Git preflight"],
    payload_or_mutation_time: [],
  },
  workflow_submit_commit_result: {
    surface: "projected_transition",
    durable_state: ["commit-prepared phase"],
    projection_readiness: ["commit_result: committer"],
    payload_or_mutation_time: ["attempt ID and outcome claim"],
  },
  workflow_reconcile_commit_result: {
    surface: "projected_transition",
    durable_state: ["commit-prepared phase"],
    projection_readiness: ["commit_result: reconciliation"],
    payload_or_mutation_time: ["attempt ID"],
  },
  workflow_retry_commit_preparation: {
    surface: "projected_transition",
    durable_state: ["retryable preparation stop context"],
    projection_readiness: [],
    payload_or_mutation_time: ["retry context"],
  },
  workflow_return_commit_to_review: {
    surface: "projected_transition",
    durable_state: ["review-recovery preparation stop context"],
    projection_readiness: ["commit_review_return receipt-reconstruction preflight"],
    payload_or_mutation_time: ["review context"],
  },
  workflow_retry_commit: {
    surface: "projected_transition",
    durable_state: ["not-committed stop phase"],
    projection_readiness: [],
    payload_or_mutation_time: ["retry context"],
  },
} as const satisfies Record<WorkflowAction, ActionPreconditionAudit>;

test("every workflow action has an explicit #141 precondition classification", () => {
  assert.deepEqual(
    Object.keys(ACTION_PRECONDITION_AUDIT).sort(),
    [...WORKFLOW_ACTION_VALUES].sort(),
  );
  for (const [action, audit] of Object.entries(ACTION_PRECONDITION_AUDIT)) {
    assert.ok(audit.surface === "protocol_boundary" || audit.durable_state.length > 0, action);
  }
});

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
      { description: "executable", kind: "command", argv: ["bun", "run", "check"] },
      { description: "manual inspection", kind: "inspection" },
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
      kind: "inspection_required",
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
      kind: "inspection_required",
      validations: [{ validation_id: "VAL-002", description: "manual inspection" }],
    });
    store.recordManualValidation({
      workflow_id: id,
      expected_version: 1,
      validation_id: "VAL-002",
      status: "passed",
      evidence: "inspected",
    });
    assert.deepEqual(store.parentGet(id).permitted_next_actions, ["workflow_resume_review"]);
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
      { description: "executable", kind: "command", argv: ["bun", "run", "check"] },
      { description: "manual inspection", kind: "inspection" },
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
          readiness: { review: { status: "begin" } },
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
        },
      ]).primary,
      {
        kind: "inspection_required",
        validations: [{ validation_id: "VAL-002", description: "manual inspection" }],
      },
    );

    const reviewOnly = create(store, git, "review_only", [
      { description: "executable", kind: "command", argv: ["bun", "run", "check"] },
      { description: "manual inspection", kind: "inspection" },
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
          readiness: { review: { status: "begin" } },
        },
      ]).primary,
      {
        kind: "inspection_required",
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
      { description: "manual inspection", kind: "inspection" },
    ]);
    for (const validationResults of [
      [],
      [{ validation_id: "VAL-001", status: "not_run", evidence: "pending" }],
      [{ validation_id: "VAL-001", status: "failed", evidence: "failed" }],
    ]) {
      const approved = structuredClone(created) as any;
      approved.phase = "STOPPED_APPROVED";
      approved.validation_results = validationResults;
      const decision = deriveOperatorDecision(approved, [{ state: approved }]);
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
    repair.review_result_version = 1;
    repair.blocking_findings = [finding("BLOCKER-ENUM")];
    assert.equal(
      deriveOperatorDecision(repair, [{ state: repair }]).primary.kind,
      "approve_exact_repairs",
    );

    const concern = structuredClone(base) as any;
    concern.phase = "STOPPED_CONCERNS";
    assert.deepEqual(deriveOperatorDecision(concern, [{ state: concern }]).primary, {
      kind: "approve_recovery",
      recovery: "accept_concerns",
      authorization_required: true,
    });

    const retry = structuredClone(base) as any;
    retry.phase = "STOPPED_NOT_COMMITTED";
    retry.commit_result = { outcome: "not_committed", failure_summary: "retry" };
    assert.deepEqual(deriveOperatorDecision(retry, [{ state: retry }]).primary, {
      kind: "approve_recovery",
      recovery: "retry_commit",
      authorization_required: true,
    });

    const approved = structuredClone(base) as any;
    approved.phase = "STOPPED_APPROVED";
    approved.validation_results = [{ validation_id: "VAL-001", status: "passed", evidence: "ok" }];
    approved.review_receipt = {};
    assert.deepEqual(
      deriveOperatorDecision(approved, [
        { state: approved, readiness: { approved_review: { status: "current" } } },
      ]).primary,
      {
        kind: "approve_commit",
        authorization_required: true,
      },
    );

    const exhausted = structuredClone(base) as any;
    exhausted.phase = "STOPPED_REPAIR_EXHAUSTED";
    exhausted.blocking_findings = [finding("BLOCKER-EXHAUSTED")];
    assert.deepEqual(
      deriveOperatorDecision(exhausted, [
        {
          state: exhausted,
          readiness: { head: { status: "readable", current_head: exhausted.base_head } },
        },
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
        readiness: { review: { status: "begin" } },
      },
    ]);
    assert.deepEqual(decision.primary, { kind: "no_user_action", route: "re_review" });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator projection distinguishes review-only completion, changed work, and missing evidence", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "operator-review-completion.sqlite");
  const store = new WorkflowStore({ repositoryRoot: root, databasePath });
  try {
    const base = structuredClone(create(store, git, "review_only", [])) as any;
    const receipt = (state: "unchanged" | "modified" | "absent") => ({
      schema_version: 1,
      base_head: base.base_head,
      approved_paths: ["note.txt"],
      paths:
        state === "absent"
          ? [{ path: "note.txt", state, kind: "missing" }]
          : [
              {
                path: "note.txt",
                state,
                kind: "file",
                mode: "100644",
                digest: "a".repeat(64),
              },
            ],
      overall_scope_hash: "b".repeat(64),
    });

    const clean = structuredClone(base);
    clean.phase = "STOPPED_APPROVED";
    clean.review_receipt = receipt("unchanged");
    const currentEvidence = { approved_review: { status: "current" as const } };
    assert.deepEqual(permittedNextActions(clean, "parent", currentEvidence), []);
    const cleanDecision = deriveOperatorDecision(clean, [
      { state: clean, readiness: currentEvidence },
    ]);
    assert.deepEqual(cleanDecision.primary, {
      kind: "terminal",
      outcome: "approved_no_commit_required",
      reason:
        "review completed successfully and authoritative evidence shows no commit is required",
    });
    assert.equal(cleanDecision.outcome.status, "completed");

    const absent = structuredClone(clean);
    absent.review_receipt = receipt("absent");
    assert.deepEqual(permittedNextActions(absent, "parent", currentEvidence), []);
    assert.equal(
      deriveOperatorDecision(absent, [{ state: absent, readiness: currentEvidence }]).primary.kind,
      "terminal",
    );

    const changed = structuredClone(clean);
    changed.review_receipt = receipt("modified");
    assert.deepEqual(permittedNextActions(changed, "parent", currentEvidence), [
      "workflow_authorize_commit",
    ]);
    assert.deepEqual(
      deriveOperatorDecision(changed, [{ state: changed, readiness: currentEvidence }]).primary,
      {
        kind: "approve_commit",
        authorization_required: true,
      },
    );
    assert.deepEqual(
      permittedNextActions(changed, "parent", {
        approved_review: { status: "unavailable" },
      }),
      [],
    );

    const range = structuredClone(clean);
    range.review_target.review_mode = "commit_range";
    range.review_target.head_revision = range.base_head;
    range.review_receipt = null;
    assert.deepEqual(
      deriveOperatorDecision(range, [{ state: range, readiness: currentEvidence }]).primary,
      {
        kind: "terminal",
        outcome: "approved_no_commit_required",
        reason:
          "review completed successfully and authoritative evidence shows no commit is required",
      },
    );

    const contradictory = structuredClone(range);
    contradictory.validation_requirements = [
      {
        validation_id: "VAL-001",
        description: "required validation",
        kind: "command",
        argv: ["bun", "run", "check"],
      },
    ];
    contradictory.validation_results = [];
    assert.deepEqual(permittedNextActions(contradictory, "parent"), []);
    assert.deepEqual(deriveOperatorDecision(contradictory).primary, {
      kind: "operator_intervention",
      reason: "approved workflow commit authority is unavailable",
    });

    const missing = structuredClone(changed);
    missing.workflow_type = "change";
    missing.review_receipt = null;
    assert.deepEqual(permittedNextActions(missing, "parent"), []);
    assert.deepEqual(deriveOperatorDecision(missing).primary, {
      kind: "operator_intervention",
      reason: "approved workflow commit authority is unavailable",
    });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator projection revalidates no-commit working-tree evidence", () => {
  const { root, git } = fixture();
  const store = new WorkflowStore({
    repositoryRoot: root,
    databasePath: join(root, "operator-current-review.sqlite"),
  });
  try {
    const created = create(store, git, "review_only", []);
    store.beginReview({ workflow_id: created.workflow_id, expected_version: 0 });
    store.submitReview({
      workflow_id: created.workflow_id,
      expected_version: 1,
      review_status: "APPROVED",
      blocking_findings: [],
      optional_findings: [],
      prior_finding_classifications: {},
    });
    assert.equal(store.operatorDecisionGet(created.workflow_id).primary.kind, "terminal");

    writeFileSync(join(root, "note.txt"), "changed after approval\n");
    assert.deepEqual(store.parentGet(created.workflow_id).permitted_next_actions, []);
    assert.deepEqual(store.operatorDecisionGet(created.workflow_id).primary, {
      kind: "operator_intervention",
      reason: "approved workflow commit authority is unavailable",
    });
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("review readiness refreshes stale snapshots and fails closed for unavailable ranges", () => {
  const { root, git } = fixture();
  const store: any = new WorkflowStore({
    repositoryRoot: root,
    databasePath: join(root, "operator-review-readiness.sqlite"),
  });
  try {
    const workingTree = create(store, git, "review_only", []);
    store.beginReview({ workflow_id: workingTree.workflow_id, expected_version: 0 });
    assert.deepEqual(store.reviewerGet(workingTree.workflow_id).permitted_next_actions, [
      "workflow_submit_review",
    ]);
    writeFileSync(join(root, "note.txt"), "changed after snapshot\n");
    assert.deepEqual(store.reviewerGet(workingTree.workflow_id).permitted_next_actions, [
      "workflow_begin_review",
    ]);
    assert.deepEqual(store.operatorDecisionGet(workingTree.workflow_id).primary, {
      kind: "no_user_action",
      route: "review",
    });
    const staleVersion = store.parentGet(workingTree.workflow_id).version;
    const staleAuditLength = store.audit(workingTree.workflow_id).length;
    for (const reviewStatus of ["APPROVED", "CHANGES_REQUESTED", "INCONCLUSIVE"] as const) {
      assert.throws(
        () =>
          store.submitReview({
            workflow_id: workingTree.workflow_id,
            expected_version: staleVersion,
            review_status: reviewStatus,
            blocking_findings: [],
            optional_findings: [],
            prior_finding_classifications: {},
          }),
        (error: unknown) =>
          error instanceof WorkflowError && error.category === "ERROR_INVALID_REVIEW",
      );
      assert.equal(store.parentGet(workingTree.workflow_id).version, staleVersion);
      assert.equal(store.audit(workingTree.workflow_id).length, staleAuditLength);
    }
    store.beginReview({ workflow_id: workingTree.workflow_id, expected_version: 1 });
    assert.deepEqual(store.reviewerGet(workingTree.workflow_id).permitted_next_actions, [
      "workflow_submit_review",
    ]);

    const base = git("rev-parse", "HEAD");
    git("add", "note.txt");
    git("commit", "-m", "range head");
    const head = git("rev-parse", "HEAD");
    const range = store.create({
      workflow_type: "review_only",
      objective: "range recovery readiness",
      approved_plan: null,
      approved_paths: ["note.txt"],
      acceptance_criteria: ["criterion"],
      validation_requirements: [],
      review_target: {
        review_mode: "commit_range",
        base_revision: base,
        head_revision: head,
        approved_paths: ["note.txt"],
        include_staged: false,
        include_unstaged: false,
        include_untracked: false,
      },
    });
    store.submitReview({
      workflow_id: range.workflow_id,
      expected_version: 0,
      review_status: "INCONCLUSIVE",
      blocking_findings: [],
      optional_findings: [],
      prior_finding_classifications: {},
    });
    const persisted = JSON.parse(
      store.db
        .prepare("SELECT state_json FROM workflows WHERE workflow_id = ?")
        .get(range.workflow_id).state_json,
    );
    persisted.review_target.head_revision = "0000000000000000000000000000000000000000";
    store.db
      .prepare("UPDATE workflows SET state_json = ?, state_digest = ? WHERE workflow_id = ?")
      .run(JSON.stringify(persisted), objectDigest(persisted), range.workflow_id);
    assert.deepEqual(store.parentGet(range.workflow_id).permitted_next_actions, []);
    assert.equal(
      store.operatorDecisionGet(range.workflow_id).primary.kind,
      "operator_intervention",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("runtime Git facts suppress deterministically rejected actions", () => {
  const { root, git } = fixture();
  const store = new WorkflowStore({
    repositoryRoot: root,
    databasePath: join(root, "operator-runtime-facts.sqlite"),
  });
  try {
    const change = create(store, git);
    assert.deepEqual(
      workflowLegality(change as any, {
        head: { status: "readable", current_head: change.base_head },
      }).actions.implementer,
      [],
    );
    writeFileSync(join(root, "head-only.txt"), "advance HEAD\n");
    git("add", "head-only.txt");
    git("commit", "-m", "advance fixture head");

    assert.equal(
      store.parentGet(change.workflow_id).permitted_next_actions.includes("workflow_expand_scope"),
      false,
    );
    assert.deepEqual(store.implementerGet(change.workflow_id).permitted_next_actions, []);
    assert.equal(
      store.operatorDecisionGet(change.workflow_id).primary.kind,
      "operator_intervention",
    );

    const review = structuredClone(change) as any;
    review.workflow_type = "review_only";
    review.phase = "REVIEWING";
    assert.deepEqual(
      workflowLegality(review, {
        head: { status: "readable", current_head: review.base_head },
      }).actions.reviewer,
      [],
    );
    assert.deepEqual(
      workflowLegality(review, {
        head: { status: "readable", current_head: git("rev-parse", "HEAD") as any },
      }).actions.reviewer,
      [],
    );
    const incoherentReviewTarget = structuredClone(review);
    incoherentReviewTarget.review_target.base_revision = git("rev-parse", "HEAD");
    assert.deepEqual(
      workflowLegality(incoherentReviewTarget, {
        review: { status: "begin" },
      }).actions.reviewer,
      [],
    );

    const exhausted = structuredClone(change) as any;
    exhausted.phase = "STOPPED_REPAIR_EXHAUSTED";
    exhausted.blocking_findings = [finding("STALE-FOLLOWUP")];
    assert.equal(
      workflowLegality(exhausted, {
        head: { status: "readable", current_head: git("rev-parse", "HEAD") as any },
      }).actions.parent.some(
        (action) =>
          action === "workflow_create_linked_followup" ||
          action === "workflow_create_linked_followup_from_plan",
      ),
      false,
    );

    const commitRangeFollowup = structuredClone(exhausted);
    commitRangeFollowup.review_target.review_mode = "commit_range";
    assert.deepEqual(
      workflowLegality(commitRangeFollowup, { head: { status: "unavailable" } }).actions.parent,
      [],
    );

    const reviewRecovery = structuredClone(change) as any;
    reviewRecovery.phase = "STOPPED_COMMIT_PREPARATION";
    reviewRecovery.stop_context = {
      status: "COMMIT_PREPARATION_FAILED",
      category: "ERROR_STALE_RECEIPT",
      summary: "stale",
      recovery: "review",
      failed_at: "2026-08-29T00:00:00.000Z",
      failed_version: 1,
      stopped_from: "COMMIT_AUTHORIZED",
    };
    assert.deepEqual(
      workflowLegality(reviewRecovery, { head: { status: "unavailable" } }).actions.parent,
      [],
    );
    assert.deepEqual(
      workflowLegality(reviewRecovery, {
        head: { status: "readable", current_head: git("rev-parse", "HEAD") as any },
        commit_review_return: { status: "ready" },
      }).actions.parent,
      ["workflow_return_commit_to_review"],
    );

    const range = structuredClone(review);
    range.review_target.review_mode = "commit_range";
    range.review_target.head_revision = git("rev-parse", "HEAD");
    assert.deepEqual(
      workflowLegality(range, {
        head: { status: "readable", current_head: git("rev-parse", "HEAD") as any },
        review: { status: "unavailable" },
      }).actions.reviewer,
      [],
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("legality fails closed for omitted dynamic authority and full scope", () => {
  const { root, git } = fixture();
  const store = new WorkflowStore({
    repositoryRoot: root,
    databasePath: join(root, "exact.sqlite"),
  });
  try {
    const base = structuredClone(create(store, git)) as any;
    const stopped = structuredClone(base);
    stopped.phase = "STOPPED_INCONCLUSIVE";
    stopped.scope_expansions = [{ added_paths: ["extra.txt"] }];
    assert.equal(
      workflowLegality(stopped).actions.parent.includes("workflow_adopt_dirty_scope"),
      false,
    );
    assert.equal(
      workflowLegality(stopped).actions.parent.includes("workflow_resume_review"),
      false,
    );
    assert.equal(
      workflowLegality(stopped, {
        head: { status: "readable", current_head: stopped.base_head },
        review_recovery: { status: "unavailable" },
      }).actions.parent.includes("workflow_resume_review"),
      false,
    );
    assert.equal(
      workflowLegality(stopped, {
        head: { status: "readable", current_head: stopped.base_head },
        review_recovery: { status: "resume" },
      }).actions.parent.includes("workflow_resume_review"),
      true,
    );
    assert.equal(
      workflowLegality(stopped, {
        head: { status: "readable", current_head: stopped.base_head },
        review_recovery: { status: "adopt" },
      }).actions.parent.includes("workflow_adopt_dirty_scope"),
      true,
    );
    assert.equal(
      workflowLegality(stopped, {
        head: { status: "readable", current_head: stopped.base_head },
        review_recovery: { status: "adopt" },
      }).actions.parent.includes("workflow_resume_review"),
      false,
    );
    assert.deepEqual(
      deriveOperatorDecision(stopped, [
        {
          state: stopped,
          readiness: {
            head: { status: "readable", current_head: stopped.base_head },
            review_recovery: { status: "adopt" },
          },
        },
      ]).primary,
      {
        kind: "approve_recovery",
        recovery: "adopt_dirty_scope",
        authorization_required: true,
      },
    );

    const full = structuredClone(base);
    full.approved_paths = Array.from({ length: MAX_PATHS }, (_, index) => `path-${index}.txt`);
    assert.equal(
      permittedNextActions(full, "parent", {
        head: { status: "readable", current_head: full.base_head },
      }).includes("workflow_expand_scope"),
      false,
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("implementation recovery requires a coherent durable stop context", () => {
  const { root, git } = fixture();
  const store = new WorkflowStore({
    repositoryRoot: root,
    databasePath: join(root, "implementation-recovery-context.sqlite"),
  });
  try {
    const base = structuredClone(create(store, git)) as any;
    const missing = structuredClone(base);
    missing.phase = "STOPPED_NEEDS_CONTEXT";
    missing.stop_context = null;
    assert.deepEqual(workflowLegality(missing).actions.parent, []);
    assert.throws(
      () =>
        resumeImplementation(missing, {
          workflow_id: missing.workflow_id,
          expected_version: missing.version,
          resume_context: "resume",
        }),
      (error: unknown) =>
        error instanceof WorkflowError && error.category === "ERROR_STATE_CORRUPT",
    );

    const incompatible = structuredClone(missing);
    incompatible.stop_context = {
      status: "INCONCLUSIVE",
      summary: "wrong recovery domain",
      stopped_from: "REVIEWING",
    };
    assert.deepEqual(workflowLegality(incompatible).actions.parent, []);

    const ready = structuredClone(missing);
    ready.stop_context = {
      status: "NEEDS_CONTEXT",
      summary: "context needed",
      stopped_from: "REPAIRING",
    };
    assert.deepEqual(workflowLegality(ready).actions.parent, ["workflow_resume_implementation"]);
    assert.equal(
      resumeImplementation(ready, {
        workflow_id: ready.workflow_id,
        expected_version: ready.version,
        resume_context: "resume repair",
      }).phase,
      "REPAIRING",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator projection routes reconciliation and classifies committed state from legality", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "operator-terminal-legality.sqlite");
  const store = new WorkflowStore({ repositoryRoot: root, databasePath });
  try {
    const base = structuredClone(create(store, git)) as any;
    const prepared = structuredClone(base);
    prepared.phase = "COMMIT_PREPARED";
    const reconciliation = deriveOperatorDecision(prepared, [
      {
        state: prepared,
        readiness: { commit_result: { status: "ready", authority: "reconciliation" } },
      },
    ]);
    assert.deepEqual(reconciliation.primary, {
      kind: "reconcile_commit",
      reason: "an existing commit requires server-owned result reconciliation",
    });

    const committed = structuredClone(base);
    committed.phase = "COMMITTED";
    const terminal = deriveOperatorDecision(committed);
    assert.deepEqual(terminal.primary, {
      kind: "terminal",
      outcome: "committed",
      reason: "the workflow commit is verified and complete",
    });
    assert.equal(terminal.outcome.status, "completed");
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
    exhaustedReview.review_result_version = 1;
    exhaustedReview.repair_cycle = 1;
    exhaustedReview.max_repair_cycles = 1;
    exhaustedReview.blocking_findings = [finding("BLOCKER-1")];
    const decision = deriveOperatorDecision(exhaustedReview);
    assert.deepEqual(decision.primary, {
      kind: "finalize_repair_exhausted",
      reason: "the repair cycle limit is reached; finalize the exhausted workflow",
    });
    assert.equal(decision.outcome.status, "exhausted");

    const missingReview = structuredClone(exhaustedReview);
    missingReview.review_result_version = null;
    assert.equal(
      workflowLegality(missingReview).actions.parent.some(
        (action) =>
          action === "workflow_authorize_repair" || action === "workflow_finalize_repair_exhausted",
      ),
      false,
    );
    assert.equal(deriveOperatorDecision(missingReview).primary.kind, "operator_intervention");

    const linked = linkedStates(store, git);
    linked.child.phase = "STOPPED_REPAIR_EXHAUSTED";
    linked.child.blocking_findings = [finding("BLOCKER-CONTINUATION")];
    const continuation = deriveOperatorDecision(linked.child, [
      {
        state: linked.root,
        readiness: { head: { status: "readable", current_head: linked.root.base_head } },
      },
      {
        state: linked.child,
        readiness: { head: { status: "readable", current_head: linked.child.base_head } },
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
      { state: stopped, readiness: { review_recovery: { status: "resume" } } },
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
    const failureDecision = deriveOperatorDecision(notCommitted, [{ state: notCommitted }]);
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
      kind: "terminal",
      outcome: "commit_mismatch",
      reason: "commit verification failed and the mismatch is terminal",
    });
    assert.equal(mismatchDecision.outcome.status, "failed");
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

test("operator projection preserves supersession over no-commit approval", () => {
  const { root, git } = fixture();
  const store = new WorkflowStore({
    repositoryRoot: root,
    databasePath: join(root, "operator-superseded-approval.sqlite"),
  });
  try {
    const linked = linkedStates(store, git);
    linked.root.workflow_type = "review_only";
    linked.root.phase = "STOPPED_APPROVED";
    linked.root.review_target.review_mode = "commit_range";
    linked.root.review_target.head_revision = linked.root.base_head;
    linked.root.validation_results = [
      { validation_id: "VAL-001", status: "passed", evidence: "validated" },
    ];

    const decision = deriveOperatorDecision(linked.root, [
      { state: linked.root },
      { state: linked.child },
    ]);
    assert.deepEqual(decision.primary, {
      kind: "operator_intervention",
      reason: "the workflow has been superseded",
    });
    assert.equal(decision.outcome.status, "superseded");

    linked.child.workflow_type = "review_only";
    linked.child.phase = "STOPPED_APPROVED";
    linked.child.review_target.review_mode = "commit_range";
    linked.child.review_target.head_revision = linked.child.base_head;
    linked.child.validation_results = [
      { validation_id: "VAL-001", status: "passed", evidence: "validated" },
    ];
    const childLegality = workflowLegality(linked.child, {
      approved_review: { status: "current" },
    });
    assert.equal(childLegality.next.kind, "terminal");
    const relatedCompletion = deriveOperatorDecision(linked.root, [
      { state: linked.root },
      { state: linked.child, legality: childLegality },
    ]);
    assert.equal(relatedCompletion.related_workflows[0]?.status, "completed");

    linked.root.phase = "STOPPED_REPAIR_EXHAUSTED";
    linked.root.blocking_findings = [finding("SUPERSEDED-EXHAUSTED")];
    const exhausted = deriveOperatorDecision(linked.root, [
      { state: linked.root },
      { state: linked.child },
    ]);
    assert.deepEqual(exhausted.primary, {
      kind: "operator_intervention",
      reason: "the workflow has been superseded",
    });
    assert.equal(exhausted.outcome.status, "superseded");
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator projection rejects branch merges, divergent order, and extra unrelated records", () => {
  const { root, git } = fixture();
  const databasePath = join(root, "operator-lineage.sqlite");
  const store = new WorkflowStore({ repositoryRoot: root, databasePath });
  try {
    const valid = linkedStates(store, git);
    const validDecision = deriveOperatorDecision(valid.root, [
      { state: valid.root },
      { state: valid.child },
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
      { state: valid.root },
      { state: branchMerge },
      { state: branch },
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
      { state: valid.root },
      { state: divergentPredecessor },
      { state: divergent },
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
      { state: rootWithExtraLineage },
      { state: extraLineage },
      { state: extraLineageRecord },
    ]);
    assert.equal(extraLineageDecision.primary.kind, "operator_intervention");

    const unrelated = structuredClone(valid.root) as any;
    unrelated.workflow_id = "unrelated-workflow";
    unrelated.superseded_by_workflow_id = null;
    const extraDecision = deriveOperatorDecision(valid.root, [
      { state: valid.root },
      { state: valid.child },
      { state: unrelated },
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
      return states.map((state) => ({
        state,
        readiness: {
          head: { status: "readable" as const, current_head: state.base_head },
          implementation_submission: { status: "ready" as const },
        },
      }));
    };

    const withinRecords = buildRecords(MAX_LINEAGE_RECORDS);
    const withinBound = deriveOperatorDecision(
      withinRecords[0]?.state as WorkflowState,
      withinRecords,
    );
    assert.deepEqual(withinBound.primary, {
      kind: "operator_intervention",
      reason: "the workflow has been superseded",
    });

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
    assert.deepEqual(exactStore.operatorDecisionGet(rootId).primary, {
      kind: "operator_intervention",
      reason: "the workflow has been superseded",
    });
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
