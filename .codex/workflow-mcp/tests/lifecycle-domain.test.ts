import { test } from "bun:test";
import assert from "node:assert/strict";
import { WorkflowError } from "../errors.js";
import { authoritativeImplementationContract } from "../implementation-contract.js";
import { repairProposalForFindings } from "../repair-proposal.js";
import { requiredPriorFindingClassificationIds } from "../transitions/queries.js";
import { replaceAuthoritativeImplementationContract } from "../transitions/state.js";
import {
  adjudicateFindings,
  adoptDirtyScope,
  authorizeRepair,
  beginReview,
  commitPreparationFailed,
  expandScope,
  linkedFollowupChildState,
  linkedFollowupInput,
  rebindImplementationPlan,
  reconcileStagedScope,
  retryCommit,
  retryCommitPreparation,
  returnCommitToReview,
  roleView,
  submitImplementation,
  submitReview,
  validateWorkflowStateV10,
  workflowLegality,
} from "../transitions.js";
import type {
  AcceptanceCriterionId,
  ChangeReceipt,
  ContentDigest,
  ExactRepoPath,
  FindingId,
  GitCommitSha,
  IsoTimestamp,
  PlanId,
  PlanRevision,
  PlanRevisionArtifact,
  ValidationRequirementId,
  WorkflowEvidenceFamily,
  WorkflowEvidenceField,
  WorkflowId,
  WorkflowState,
  WorkflowVersion,
} from "../types.js";
import { objectDigest } from "../validation.js";
import {
  blockingFinding,
  deterministicReadiness,
  optionalFinding,
  syntheticReceipt,
  workflowState,
} from "./workflow-state-fixtures.js";

const ROLES = ["parent", "implementer", "reviewer", "committer"] as const;
const TEST_ROOT = "/deterministic-workflow-fixture";

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? true
    : false;
type Expect<Value extends true> = Value;

const TEST_EVIDENCE_FIELDS = {
  contract_authority: [
    "approved_plan",
    "execution_brief",
    "plan_provenance",
    "acceptance_criteria",
    "validation_requirements",
  ],
  scope_history: ["initial_receipt", "scope_expansions", "approved_path_baselines"],
  work_items: ["work_items"],
  implementation_submission: [
    "implementation_summary",
    "implementation_status",
    "implementation_known_failures",
    "agent_touched_paths",
    "scope_changed_paths",
    "acceptance_results",
    "validation_results",
    "finding_resolution_map",
    "implementation_receipt",
  ],
  review_receipts: ["review_start_receipt", "review_receipt"],
  current_review_result: [
    "blocking_findings",
    "optional_findings",
    "prior_finding_classifications",
    "review_result_version",
  ],
  adjudications: ["finding_adjudications"],
  repair_authority: ["repair_authorized_ids", "repair_directive"],
  repair_cycle: ["repair_cycle"],
  concern_acceptance: ["concern_acceptance"],
  commit_authorization: ["commit_authorization"],
  commit_attempt_evidence: ["commit_preparation", "commit_result"],
  lineage: ["parent_workflow_id", "source_workflow_id", "superseded_by_workflow_id"],
  linked_continuation: ["linked_continuation"],
  linked_findings: ["linked_findings"],
  remediation_context: ["remediation_context"],
} as const satisfies Record<WorkflowEvidenceFamily, readonly (keyof WorkflowState)[]>;

type TestEvidenceField<Family extends WorkflowEvidenceFamily> =
  (typeof TEST_EVIDENCE_FIELDS)[Family][number];
type _EveryTestEvidenceInventoryIsExact = Expect<
  Equal<
    {
      [Family in WorkflowEvidenceFamily]: Equal<
        TestEvidenceField<Family>,
        WorkflowEvidenceField<Family>
      >;
    }[WorkflowEvidenceFamily],
    true
  >
>;

function actions(state: WorkflowState, readiness = deterministicReadiness(state)) {
  return workflowLegality(state, readiness).actions;
}

function projectEvidenceFamily<Family extends WorkflowEvidenceFamily>(
  state: WorkflowState,
  family: Family,
): Pick<WorkflowState, TestEvidenceField<Family>> {
  return Object.fromEntries(
    TEST_EVIDENCE_FIELDS[family].map((field) => [field, state[field]]),
  ) as Pick<WorkflowState, TestEvidenceField<Family>>;
}

function evidenceProjection(state: WorkflowState) {
  return Object.fromEntries(
    (Object.keys(TEST_EVIDENCE_FIELDS) as WorkflowEvidenceFamily[]).map((family) => [
      family,
      projectEvidenceFamily(state, family),
    ]),
  ) as {
    [Family in WorkflowEvidenceFamily]: Pick<WorkflowState, TestEvidenceField<Family>>;
  };
}

type EvidenceProjection = ReturnType<typeof evidenceProjection>;
type EvidenceKey = keyof EvidenceProjection;

function verifyEvidenceTransition(
  name: string,
  before: WorkflowState,
  after: WorkflowState,
  changed: ReadonlyArray<EvidenceKey>,
  expected: Partial<EvidenceProjection> = {},
): void {
  const beforeEvidence = evidenceProjection(before);
  const afterEvidence = evidenceProjection(after);
  const changedSet = new Set(changed);
  for (const key of Object.keys(beforeEvidence) as EvidenceKey[]) {
    if (changedSet.has(key)) {
      assert.notDeepEqual(afterEvidence[key], beforeEvidence[key], `${name}: ${key} changed`);
    } else {
      assert.deepEqual(afterEvidence[key], beforeEvidence[key], `${name}: ${key} survived`);
    }
  }
  for (const [key, value] of Object.entries(expected) as Array<
    [EvidenceKey, EvidenceProjection[EvidenceKey]]
  >) {
    assert.deepEqual(afterEvidence[key], value, `${name}: ${key} expected value`);
  }
}

function receiptFor(path: string, state: "absent" | "modified"): ChangeReceipt {
  const source = syntheticReceipt();
  return {
    ...source,
    approved_paths: [path as ExactRepoPath],
    paths:
      state === "absent"
        ? [{ path: path as ExactRepoPath, state: "absent" as const, kind: "missing" as const }]
        : [
            {
              path: path as ExactRepoPath,
              state: "modified",
              kind: "file",
              mode: "100644",
              digest:
                "5555555555555555555555555555555555555555555555555555555555555555" as ContentDigest,
            },
          ],
  };
}

function submitCompletedRepair(state: WorkflowState): WorkflowState {
  return submitImplementation(
    state,
    {
      workflow_id: state.workflow_id,
      expected_version: state.version,
      status: "DONE",
      summary: "deterministic repair completed",
      agent_touched_paths: ["note.txt"],
      acceptance_results: state.acceptance_criteria.map(({ criterion_id }) => ({
        criterion_id,
        status: "satisfied",
        evidence: "repaired",
      })),
      validation_results: state.validation_requirements.map(({ validation_id }) => ({
        validation_id,
        status: "passed",
        evidence: "validated repair",
      })),
      known_failures: [],
      finding_resolution_map: Object.fromEntries(
        state.repair_authorized_ids.map((id) => [id, "resolved"]),
      ),
    },
    TEST_ROOT,
    syntheticReceipt(),
  );
}

function submitRepairReview(
  state: WorkflowState,
  reviewStatus: "APPROVED" | "INCONCLUSIVE",
): { before: WorkflowState; after: WorkflowState } {
  const reviewing = submitCompletedRepair(state);
  const begun = beginReview(
    reviewing,
    { workflow_id: reviewing.workflow_id, expected_version: reviewing.version },
    syntheticReceipt(),
  );
  const prior = Object.fromEntries(
    begun.blocking_findings.map((finding) => [
      finding.finding_id,
      reviewStatus === "APPROVED" ? "resolved" : "still_present",
    ]),
  );
  const after = submitReview(
    begun,
    {
      workflow_id: begun.workflow_id,
      expected_version: begun.version,
      review_status: reviewStatus,
      blocking_findings: reviewStatus === "APPROVED" ? [] : begun.blocking_findings,
      optional_findings: [],
      prior_finding_classifications: prior,
      validation_results: begun.validation_results,
      repair_conformance: {
        status: "conforming",
        evidence: "the deterministic repair follows its directive",
      },
    },
    syntheticReceipt(),
  );
  return { before: begun, after };
}

test("reviewer prior-finding binding preserves remediation order and de-duplicates IDs", () => {
  const state = workflowState({
    phase: "REVIEWING",
  });
  state.blocking_findings = [blockingFinding("BLOCKER")];
  state.optional_findings = [optionalFinding("OPTIONAL")];
  state.linked_continuation = {
    root_workflow_id: state.workflow_id as WorkflowId,
    predecessor_workflow_id: state.workflow_id as WorkflowId,
    lineage_workflow_ids: [state.workflow_id as WorkflowId],
    original_base_head: state.base_head,
    combined_review_paths: state.approved_paths,
    review_stage: "remediation",
    remediation_review_receipt: null,
  };
  state.linked_findings = [blockingFinding("CARRIED"), blockingFinding("BLOCKER")];

  assert.deepEqual(requiredPriorFindingClassificationIds(state), [
    "CARRIED",
    "BLOCKER",
    "OPTIONAL",
  ]);
  assert.deepEqual(roleView(state, "reviewer").required_prior_finding_ids, [
    "CARRIED",
    "BLOCKER",
    "OPTIONAL",
  ]);
  assert.equal("required_prior_finding_ids" in state, false);

  state.linked_continuation.review_stage = "combined";
  assert.deepEqual(requiredPriorFindingClassificationIds(state), ["BLOCKER", "OPTIONAL"]);
  assert.deepEqual(roleView(state, "reviewer").required_prior_finding_ids, ["BLOCKER", "OPTIONAL"]);
});

test("role projections preserve role-specific redaction and review-only omission", () => {
  const change = workflowState({ phase: "REVIEWING" });
  const parent = roleView(change, "parent");
  const implementer = roleView(change, "implementer");
  const reviewer = roleView(change, "reviewer");
  const committer = roleView(change, "committer");

  assert.equal("initial_receipt" in parent, false);
  assert.equal("validation_results" in parent, true);
  assert.equal("approved_plan" in implementer, true);
  assert.equal("implementation_receipt" in implementer, false);
  assert.equal("implementation_summary" in reviewer, true);
  assert.equal("required_prior_finding_ids" in reviewer, true);
  assert.equal("review_receipt" in reviewer, false);
  assert.equal("commit_preparation" in committer, true);
  assert.deepEqual(reviewer.permitted_next_actions, []);

  const reviewOnly = workflowState({ workflow_type: "review_only", phase: "REVIEWING" });
  const reviewOnlyView = roleView(reviewOnly, "reviewer");
  assert.equal("implementation_summary" in reviewOnlyView, false);
  assert.equal("agent_touched_paths" in reviewOnlyView, false);
  assert.equal("required_prior_finding_ids" in reviewOnlyView, true);

  parent.approved_paths.push("mutated-in-view" as never);
  assert.equal(change.approved_paths.includes("mutated-in-view" as never), false);
});

test("deterministic lifecycle phases expose the complete role action matrix", () => {
  const receipt = syntheticReceipt();
  const blocker = blockingFinding();
  const cases: Array<{
    name: string;
    state: WorkflowState;
    expected: Record<(typeof ROLES)[number], string[]>;
  }> = [
    {
      name: "implementing",
      state: workflowState({ phase: "IMPLEMENTING" }),
      expected: {
        parent: ["workflow_expand_scope"],
        implementer: ["workflow_submit_implementation"],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "reviewing",
      state: workflowState({ phase: "REVIEWING" }),
      expected: {
        parent: [],
        implementer: [],
        reviewer: ["workflow_begin_review"],
        committer: [],
      },
    },
    {
      name: "commit-range review",
      state: workflowState({
        workflow_type: "review_only",
        phase: "REVIEWING",
        review_target: {
          review_mode: "commit_range",
          base_revision: receipt.base_head,
          head_revision: "4444444444444444444444444444444444444444" as GitCommitSha,
          approved_paths: receipt.approved_paths,
          include_staged: false,
          include_unstaged: false,
          include_untracked: false,
        },
      }),
      expected: {
        parent: [],
        implementer: [],
        reviewer: ["workflow_submit_review"],
        committer: [],
      },
    },
    {
      name: "repair required",
      state: workflowState({
        phase: "REPAIR_REQUIRED",
        blocking_findings: [blocker],
      }),
      expected: {
        parent: [
          "workflow_adjudicate_findings",
          "workflow_authorize_repair",
          "workflow_expand_scope",
        ],
        implementer: [],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "repair exhausted",
      state: workflowState({
        phase: "REPAIR_REQUIRED",
        repair_cycle: 2,
        blocking_findings: [blocker],
      }),
      expected: {
        parent: [
          "workflow_adjudicate_findings",
          "workflow_expand_scope",
          "workflow_finalize_repair_exhausted",
        ],
        implementer: [],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "repairing",
      state: workflowState({ phase: "REPAIRING" }),
      expected: {
        parent: ["workflow_expand_scope"],
        implementer: ["workflow_submit_implementation"],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "review-only repair required",
      state: workflowState({
        workflow_type: "review_only",
        phase: "REPAIR_REQUIRED",
        blocking_findings: [blocker],
      }),
      expected: {
        parent: ["workflow_adjudicate_findings", "workflow_authorize_repair"],
        implementer: [],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "review-only repairing",
      state: workflowState({ workflow_type: "review_only", phase: "REPAIRING" }),
      expected: {
        parent: [],
        implementer: ["workflow_submit_implementation"],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "approved",
      state: workflowState({ phase: "STOPPED_APPROVED" }),
      expected: {
        parent: ["workflow_authorize_commit"],
        implementer: [],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "approved with a follow-up",
      state: workflowState({
        phase: "STOPPED_APPROVED",
        optional_findings: [optionalFinding()],
      }),
      expected: {
        parent: [
          "workflow_authorize_commit",
          "workflow_create_linked_followup",
          "workflow_create_linked_followup_from_plan",
        ],
        implementer: [],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "approved commit-range review",
      state: workflowState({
        workflow_type: "review_only",
        phase: "STOPPED_APPROVED",
        review_target: {
          review_mode: "commit_range",
          base_revision: receipt.base_head,
          head_revision: "4444444444444444444444444444444444444444" as GitCommitSha,
          approved_paths: receipt.approved_paths,
          include_staged: false,
          include_unstaged: false,
          include_untracked: false,
        },
      }),
      expected: { parent: [], implementer: [], reviewer: [], committer: [] },
    },
    {
      name: "inconclusive review",
      state: workflowState({ phase: "STOPPED_INCONCLUSIVE" }),
      expected: {
        parent: ["workflow_resume_review"],
        implementer: [],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "implementation concerns",
      state: workflowState({ phase: "STOPPED_CONCERNS" }),
      expected: {
        parent: ["workflow_accept_concerns"],
        implementer: [],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "implementation needs context",
      state: workflowState({ phase: "STOPPED_NEEDS_CONTEXT" }),
      expected: {
        parent: ["workflow_expand_scope", "workflow_resume_implementation"],
        implementer: [],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "implementation blocked",
      state: workflowState({ phase: "STOPPED_IMPLEMENTATION_BLOCKED" }),
      expected: {
        parent: ["workflow_expand_scope", "workflow_resume_implementation"],
        implementer: [],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "bounded continuation",
      state: workflowState({
        phase: "STOPPED_REPAIR_EXHAUSTED",
        blocking_findings: [blocker],
      }),
      expected: {
        parent: ["workflow_create_linked_followup", "workflow_create_linked_followup_from_plan"],
        implementer: [],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "commit authorized",
      state: workflowState({ phase: "COMMIT_AUTHORIZED" }),
      expected: {
        parent: [],
        implementer: [],
        reviewer: [],
        committer: ["workflow_prepare_commit"],
      },
    },
    {
      name: "commit prepared",
      state: workflowState({ phase: "COMMIT_PREPARED" }),
      expected: {
        parent: [],
        implementer: [],
        reviewer: [],
        committer: ["workflow_submit_commit_result"],
      },
    },
    {
      name: "commit retry",
      state: workflowState({ phase: "STOPPED_NOT_COMMITTED" }),
      expected: {
        parent: ["workflow_retry_commit"],
        implementer: [],
        reviewer: [],
        committer: [],
      },
    },
    {
      name: "committed terminal",
      state: workflowState({ phase: "COMMITTED" }),
      expected: { parent: [], implementer: [], reviewer: [], committer: [] },
    },
    {
      name: "commit mismatch terminal",
      state: workflowState({ phase: "STOPPED_COMMIT_MISMATCH" }),
      expected: { parent: [], implementer: [], reviewer: [], committer: [] },
    },
  ];

  for (const candidate of cases) {
    validateWorkflowStateV10(candidate.state);
    const readiness = deterministicReadiness(candidate.state);
    assert.deepEqual(actions(candidate.state, readiness), candidate.expected, candidate.name);
    for (const role of ROLES) {
      const view =
        role === "parent"
          ? roleView(candidate.state, "parent", readiness)
          : role === "implementer"
            ? roleView(candidate.state, "implementer", readiness)
            : role === "reviewer"
              ? roleView(candidate.state, "reviewer", readiness)
              : roleView(candidate.state, "committer", readiness);
      assert.deepEqual(
        view.permitted_next_actions,
        candidate.expected[role],
        `${candidate.name}: ${role}`,
      );
    }
  }
});

test("deterministic readiness fails closed without invoking repository integration", () => {
  const implementing = workflowState({ phase: "IMPLEMENTING" });
  assert.deepEqual(workflowLegality(implementing).actions.implementer, []);

  const approved = workflowState({ phase: "STOPPED_APPROVED" });
  assert.deepEqual(workflowLegality(approved).actions.parent, []);

  const prepared = workflowState({ phase: "COMMIT_PREPARED" });
  assert.deepEqual(workflowLegality(prepared).actions.committer, []);
});

function assertStateCorrupt(
  state: WorkflowState,
  mutate: (candidate: WorkflowState) => void,
  name: string,
): void {
  const candidate = structuredClone(state);
  mutate(candidate);
  assert.throws(
    () => validateWorkflowStateV10(candidate),
    (error) => error instanceof WorkflowError && error.category === "ERROR_STATE_CORRUPT",
    name,
  );
}

test("state validation rejects phase and authority-substate contradictions", () => {
  const phases = [
    "IMPLEMENTING",
    "REVIEWING",
    "REPAIR_REQUIRED",
    "REPAIRING",
    "STOPPED_APPROVED",
    "STOPPED_INCONCLUSIVE",
    "STOPPED_CONCERNS",
    "STOPPED_NEEDS_CONTEXT",
    "STOPPED_IMPLEMENTATION_BLOCKED",
    "STOPPED_REPAIR_EXHAUSTED",
    "COMMIT_AUTHORIZED",
    "COMMIT_PREPARED",
    "STOPPED_COMMIT_PREPARATION",
    "STOPPED_NOT_COMMITTED",
    "STOPPED_COMMIT_MISMATCH",
    "COMMITTED",
  ] as const;
  for (const phase of phases) {
    assert.doesNotThrow(() => validateWorkflowStateV10(workflowState({ phase })), phase);
  }

  const implementationStop = workflowState({ phase: "STOPPED_NEEDS_CONTEXT" });
  assertStateCorrupt(
    implementationStop,
    (candidate) => {
      candidate.stop_context = null;
    },
    "implementation stop without stop context",
  );
  assertStateCorrupt(
    implementationStop,
    (candidate) => {
      (candidate.stop_context as any).status = "BLOCKED";
    },
    "implementation stop with mismatched stop status",
  );
  assertStateCorrupt(
    workflowState({ phase: "IMPLEMENTING" }),
    (candidate) => {
      candidate.stop_context = structuredClone(implementationStop.stop_context);
    },
    "non-stopped phase with stop context",
  );

  const repairing = workflowState({ phase: "REPAIRING" });
  assertStateCorrupt(
    repairing,
    (candidate) => {
      candidate.repair_authorized_ids = [];
      candidate.repair_directive = null;
    },
    "repairing phase without repair authority",
  );
  for (const phase of ["REPAIR_REQUIRED", "STOPPED_REPAIR_EXHAUSTED"] as const) {
    const state = workflowState({ phase });
    assertStateCorrupt(
      state,
      (candidate) => {
        candidate.repair_authorized_ids = structuredClone(repairing.repair_authorized_ids);
        candidate.repair_directive = structuredClone(repairing.repair_directive);
      },
      `${phase} with active repair authority`,
    );
  }

  const repairOriginStop = structuredClone(repairing);
  repairOriginStop.phase = "STOPPED_NEEDS_CONTEXT";
  repairOriginStop.stop_context = {
    status: "NEEDS_CONTEXT",
    summary: "repair context is unavailable",
    stopped_from: "REPAIRING",
  };
  assertStateCorrupt(
    repairOriginStop,
    (candidate) => {
      candidate.repair_authorized_ids = [];
      candidate.repair_directive = null;
    },
    "repair-origin implementation stop without repair authority",
  );

  const authorized = workflowState({ phase: "COMMIT_AUTHORIZED" });
  const prepared = workflowState({ phase: "COMMIT_PREPARED" });
  const notCommitted = workflowState({ phase: "STOPPED_NOT_COMMITTED" });
  const mismatch = workflowState({ phase: "STOPPED_COMMIT_MISMATCH" });
  const committed = workflowState({ phase: "COMMITTED" });
  assertStateCorrupt(
    authorized,
    (candidate) => {
      candidate.commit_authorization = null;
    },
    "authorized phase without authorization",
  );
  assertStateCorrupt(
    authorized,
    (candidate) => {
      candidate.commit_preparation = structuredClone(prepared.commit_preparation);
    },
    "authorized phase with preparation evidence",
  );
  assertStateCorrupt(
    authorized,
    (candidate) => {
      candidate.commit_result = structuredClone(notCommitted.commit_result);
    },
    "authorized phase with result evidence",
  );
  assertStateCorrupt(
    prepared,
    (candidate) => {
      candidate.commit_preparation = null;
    },
    "prepared phase without preparation evidence",
  );
  assertStateCorrupt(
    notCommitted,
    (candidate) => {
      candidate.commit_result = structuredClone(mismatch.commit_result);
    },
    "not-committed phase with mismatch result",
  );
  assertStateCorrupt(
    mismatch,
    (candidate) => {
      candidate.commit_result = structuredClone(notCommitted.commit_result);
    },
    "mismatch phase with not-committed result",
  );
  assertStateCorrupt(
    committed,
    (candidate) => {
      candidate.commit_result = structuredClone(notCommitted.commit_result);
    },
    "committed phase with not-committed result",
  );

  const preparationStopped = workflowState({ phase: "STOPPED_COMMIT_PREPARATION" });
  assertStateCorrupt(
    preparationStopped,
    (candidate) => {
      candidate.stop_context = null;
    },
    "commit preparation stop without failure context",
  );
});

test("manual validation lifecycle metadata is closed, cross-bound, and legacy-compatible", () => {
  const observed = workflowState({ phase: "REVIEWING" });
  observed.validation_requirements = [
    {
      validation_id: "VAL-001" as ValidationRequirementId,
      description: "inspect exact path",
      kind: "inspection",
      dependencies: { kind: "repository_paths", paths: ["note.txt" as ExactRepoPath] },
    },
  ];
  observed.validation_results = [
    {
      validation_id: "VAL-001" as ValidationRequirementId,
      status: "passed",
      evidence: "observed",
      manual_lifecycle: {
        state: "observed",
        observed_at_version: observed.version,
        observed_repair_cycle: 0,
        dependency_receipt: syntheticReceipt(),
        retained_at: [],
      },
    },
  ];
  assert.doesNotThrow(() => validateWorkflowStateV10(observed));

  const legacy = structuredClone(observed);
  delete legacy.validation_results[0]?.manual_lifecycle;
  assert.doesNotThrow(() => validateWorkflowStateV10(legacy));
  const unscopedObserved = structuredClone(observed);
  unscopedObserved.version = (observed.version + 1) as WorkflowVersion;
  unscopedObserved.repair_cycle = 1;
  unscopedObserved.validation_requirements[0] = {
    validation_id: "VAL-001" as ValidationRequirementId,
    description: "inspection without path dependencies",
    kind: "inspection",
  };
  unscopedObserved.validation_results[0] = {
    validation_id: "VAL-001" as ValidationRequirementId,
    status: "passed",
    evidence: "unscoped observation",
    manual_lifecycle: {
      state: "observed",
      observed_at_version: observed.version,
      observed_repair_cycle: 0,
      dependency_receipt: null,
      retained_at: [],
    },
  };
  assert.doesNotThrow(() => validateWorkflowStateV10(unscopedObserved));
  assertStateCorrupt(
    unscopedObserved,
    (candidate) => {
      const lifecycle = candidate.validation_results[0]?.manual_lifecycle;
      if (lifecycle?.state === "observed") {
        lifecycle.retained_at = [{ repair_cycle: 1, workflow_version: candidate.version }];
      }
    },
    "unscoped evidence cannot claim repair retention",
  );
  assertStateCorrupt(
    observed,
    (candidate) => {
      const result = candidate.validation_results[0];
      if (result?.manual_lifecycle?.state === "observed") {
        result.manual_lifecycle.dependency_receipt = null;
      }
    },
    "dependency metadata without its authoritative receipt",
  );
  assertStateCorrupt(
    observed,
    (candidate) => {
      candidate.validation_requirements[0] = {
        validation_id: "VAL-001" as ValidationRequirementId,
        description: "command",
        kind: "command",
        argv: ["true"],
      };
    },
    "manual lifecycle metadata on an executable validation",
  );
  assertStateCorrupt(
    observed,
    (candidate) => {
      (candidate.validation_requirements[0] as any).dependencies.kind = "semantic_label";
    },
    "unsupported dependency domain",
  );

  const stale = structuredClone(observed);
  stale.version = (observed.version + 1) as WorkflowVersion;
  stale.repair_cycle = 1;
  stale.validation_results[0] = {
    validation_id: "VAL-001" as ValidationRequirementId,
    status: "not_run",
    evidence: "stale after repair",
    manual_lifecycle: {
      state: "stale",
      observed_at_version: observed.version,
      observed_repair_cycle: 0,
      stale_at_version: stale.version,
      stale_at_repair_cycle: 1,
      reason: "dependency_intersection",
      affected_paths: ["note.txt" as ExactRepoPath],
    },
  };
  assert.doesNotThrow(() => validateWorkflowStateV10(stale));
  assertStateCorrupt(
    stale,
    (candidate) => {
      const lifecycle = candidate.validation_results[0]?.manual_lifecycle;
      if (lifecycle?.state === "stale") lifecycle.stale_at_version = observed.version;
    },
    "staleness version must follow observation",
  );
  assertStateCorrupt(
    stale,
    (candidate) => {
      const lifecycle = candidate.validation_results[0]?.manual_lifecycle;
      if (lifecycle?.state === "stale") {
        if (lifecycle.observed_repair_cycle === null) {
          throw new Error("expected observation provenance fixture");
        }
        lifecycle.stale_at_repair_cycle = lifecycle.observed_repair_cycle;
      }
    },
    "staleness repair cycle must follow observation",
  );
  assertStateCorrupt(
    stale,
    (candidate) => {
      const lifecycle = candidate.validation_results[0]?.manual_lifecycle;
      if (lifecycle?.state === "stale") {
        lifecycle.observed_at_version = null;
        lifecycle.observed_repair_cycle = null;
      }
    },
    "proven dependency intersection requires observation provenance",
  );

  const repairing = workflowState({ phase: "REPAIRING" });
  repairing.validation_requirements = structuredClone(observed.validation_requirements);
  repairing.validation_results = [
    {
      validation_id: "VAL-001" as ValidationRequirementId,
      status: "passed",
      evidence: "legacy observation without lifecycle metadata",
    },
  ];
  const repaired = submitImplementation(
    repairing,
    {
      workflow_id: repairing.workflow_id,
      expected_version: repairing.version,
      status: "DONE",
      summary: "completed repair",
      agent_touched_paths: [],
      acceptance_results: repairing.acceptance_criteria.map(({ criterion_id }) => ({
        criterion_id,
        status: "satisfied",
        evidence: "satisfied",
      })),
      validation_results: [
        { validation_id: "VAL-001", status: "not_run", evidence: "parent-owned" },
      ],
      known_failures: [],
      finding_resolution_map: Object.fromEntries(
        repairing.repair_authorized_ids.map((id) => [id, "resolved"]),
      ),
    },
    TEST_ROOT,
    syntheticReceipt(),
  );
  assert.equal(repaired.validation_results[0]?.status, "not_run");
  assert.equal(
    repaired.validation_results[0]?.manual_lifecycle?.state === "stale"
      ? repaired.validation_results[0].manual_lifecycle.reason
      : null,
    "dependency_unprovable",
  );
  assert.equal(repaired.validation_results[0]?.manual_lifecycle?.observed_at_version, null);
  assert.equal(repaired.validation_results[0]?.manual_lifecycle?.observed_repair_cycle, null);

  const legacyUnprovable = structuredClone(stale);
  const legacyLifecycle = legacyUnprovable.validation_results[0]?.manual_lifecycle;
  if (legacyLifecycle?.state !== "stale") throw new Error("expected stale lifecycle fixture");
  legacyLifecycle.observed_at_version = null;
  legacyLifecycle.observed_repair_cycle = null;
  legacyLifecycle.reason = "dependency_unprovable";
  legacyLifecycle.affected_paths = [];
  assert.doesNotThrow(() => validateWorkflowStateV10(legacyUnprovable));

  const unscoped = structuredClone(repairing);
  unscoped.validation_requirements = [
    {
      validation_id: "VAL-001" as ValidationRequirementId,
      description: "inspection without path dependencies",
      kind: "inspection",
    },
  ];
  unscoped.validation_results[0] = {
    validation_id: "VAL-001" as ValidationRequirementId,
    status: "passed",
    evidence: "observed without a mechanically bounded dependency",
    manual_lifecycle: {
      state: "observed",
      observed_at_version: unscoped.version,
      observed_repair_cycle: unscoped.repair_cycle - 1,
      dependency_receipt: null,
      retained_at: [],
    },
  };
  const unscopedRepair = submitImplementation(
    unscoped,
    {
      workflow_id: unscoped.workflow_id,
      expected_version: unscoped.version,
      status: "DONE",
      summary: "completed repair",
      agent_touched_paths: [],
      acceptance_results: unscoped.acceptance_criteria.map(({ criterion_id }) => ({
        criterion_id,
        status: "satisfied",
        evidence: "satisfied",
      })),
      validation_results: [
        { validation_id: "VAL-001", status: "not_run", evidence: "parent-owned" },
      ],
      known_failures: [],
      finding_resolution_map: Object.fromEntries(
        unscoped.repair_authorized_ids.map((id) => [id, "resolved"]),
      ),
    },
    TEST_ROOT,
    syntheticReceipt(),
  );
  assert.equal(
    unscopedRepair.validation_results[0]?.manual_lifecycle?.state === "stale"
      ? unscopedRepair.validation_results[0].manual_lifecycle.reason
      : null,
    "dependency_unprovable",
  );
});

test("workflow transitions invalidate only their typed evidence families", () => {
  const evidenceCases: Array<Parameters<typeof verifyEvidenceTransition>> = [];
  const assertEvidenceTransition = (...args: Parameters<typeof verifyEvidenceTransition>) => {
    evidenceCases.push(args);
  };
  const emptyEvidence = evidenceProjection(workflowState({ phase: "IMPLEMENTING" }));
  const extraPath = "extra.txt" as ExactRepoPath;
  const extraBaseline = receiptFor(extraPath, "absent");

  const scopeBefore = workflowState({ phase: "REPAIRING" });
  const committed = workflowState({ phase: "COMMITTED" });
  scopeBefore.commit_authorization = structuredClone(committed.commit_authorization);
  scopeBefore.commit_preparation = structuredClone(committed.commit_preparation);
  scopeBefore.commit_result = structuredClone(committed.commit_result);
  const scopeAfter = expandScope(
    scopeBefore,
    {
      workflow_id: scopeBefore.workflow_id,
      expected_version: scopeBefore.version,
      added_paths: [extraPath],
      reason: "deterministic scope expansion",
      user_authorization: "authorize deterministic scope expansion",
    },
    extraBaseline,
    TEST_ROOT,
  );
  assertEvidenceTransition(
    "scope expansion",
    scopeBefore,
    scopeAfter,
    [
      "scope_history",
      "implementation_submission",
      "review_receipts",
      "commit_authorization",
      "commit_attempt_evidence",
    ],
    {
      implementation_submission: emptyEvidence.implementation_submission,
      review_receipts: emptyEvidence.review_receipts,
      commit_authorization: emptyEvidence.commit_authorization,
      commit_attempt_evidence: emptyEvidence.commit_attempt_evidence,
    },
  );

  const dirtyBefore = workflowState({ phase: "STOPPED_INCONCLUSIVE" });
  dirtyBefore.approved_paths = [...dirtyBefore.approved_paths, extraPath].sort();
  dirtyBefore.review_target.approved_paths = [...dirtyBefore.approved_paths];
  dirtyBefore.scope_expansions.push({
    expansion_id: "00000000-0000-4000-8000-000000000159",
    added_paths: [extraPath],
    reason: "authorize dirty path",
    user_authorization: "authorize deterministic dirty path",
    prior_version: 1 as WorkflowVersion,
    resulting_version: 2 as WorkflowVersion,
    authorized_at: "2026-01-01T00:00:00.000Z" as IsoTimestamp,
  });
  dirtyBefore.approved_path_baselines.push({
    path: extraPath,
    approved_at_version: 2 as WorkflowVersion,
    baseline: extraBaseline.paths[0],
  });
  validateWorkflowStateV10(dirtyBefore);
  const dirtyAfter = adoptDirtyScope(
    dirtyBefore,
    {
      workflow_id: dirtyBefore.workflow_id,
      expected_version: dirtyBefore.version,
      adopted_paths: [extraPath],
      reason: "adopt deterministic dirty path",
      user_authorization: "authorize dirty adoption",
    },
    receiptFor(extraPath, "modified"),
    TEST_ROOT,
  );
  assertEvidenceTransition("dirty-scope adoption", dirtyBefore, dirtyAfter, ["review_receipts"], {
    review_receipts: emptyEvidence.review_receipts,
  });

  const authorized = workflowState({ phase: "COMMIT_AUTHORIZED" });
  const reconciliationBefore = commitPreparationFailed(
    authorized,
    "ERROR_STAGED_SCOPE",
    "a staged path is outside reviewed scope",
    "choose",
    [extraPath],
  );
  const reconciliationAfter = reconcileStagedScope(
    reconciliationBefore,
    {
      workflow_id: reconciliationBefore.workflow_id,
      expected_version: reconciliationBefore.version,
      added_paths: [extraPath],
      review_context: "review the reconciled staged scope",
      user_authorization: "authorize staged scope reconciliation",
    },
    extraBaseline,
    TEST_ROOT,
    [extraPath],
  );
  assertEvidenceTransition(
    "staged-scope reconciliation",
    reconciliationBefore,
    reconciliationAfter,
    ["scope_history", "review_receipts", "commit_authorization"],
    {
      review_receipts: emptyEvidence.review_receipts,
      commit_authorization: emptyEvidence.commit_authorization,
      commit_attempt_evidence: emptyEvidence.commit_attempt_evidence,
    },
  );

  const repairBefore = workflowState({ phase: "REPAIR_REQUIRED" });
  const repairFindingIds = repairBefore.blocking_findings.map((finding) => finding.finding_id);
  const repairAfter = authorizeRepair(
    repairBefore,
    {
      workflow_id: repairBefore.workflow_id,
      expected_version: repairBefore.version,
      finding_ids: repairFindingIds,
      repair_directive: {
        selected_finding_ids: repairFindingIds,
        ...repairProposalForFindings(repairBefore.blocking_findings),
        user_authorization: "authorize deterministic repair",
      },
    },
    TEST_ROOT,
  );
  assertEvidenceTransition("repair authorization", repairBefore, repairAfter, [
    "repair_authority",
    "repair_cycle",
  ]);

  const completionBefore = workflowState({ phase: "REPAIRING" });
  const completionAfter = submitCompletedRepair(completionBefore);
  assertEvidenceTransition("repair completion", completionBefore, completionAfter, [
    "implementation_submission",
  ]);

  const conclusive = submitRepairReview(workflowState({ phase: "REPAIRING" }), "APPROVED");
  assertEvidenceTransition(
    "conclusive review",
    conclusive.before,
    conclusive.after,
    ["review_receipts", "current_review_result", "repair_authority"],
    { repair_authority: emptyEvidence.repair_authority },
  );

  const inconclusive = submitRepairReview(workflowState({ phase: "REPAIRING" }), "INCONCLUSIVE");
  assertEvidenceTransition("inconclusive review", inconclusive.before, inconclusive.after, [
    "review_receipts",
    "current_review_result",
  ]);

  const firstBlocker = blockingFinding("ADJUDICATE-1");
  const secondBlocker = blockingFinding("ADJUDICATE-2");
  const adjudicationBefore = workflowState({
    phase: "REPAIR_REQUIRED",
    blocking_findings: [firstBlocker, secondBlocker],
  });
  validateWorkflowStateV10(adjudicationBefore);
  const partialAdjudication = adjudicateFindings(adjudicationBefore, {
    workflow_id: adjudicationBefore.workflow_id,
    expected_version: adjudicationBefore.version,
    findings: [
      {
        finding_id: firstBlocker.finding_id,
        disposition: "CONTRACT_INCONSISTENT",
        reason: "accept one deterministic risk",
      },
    ],
    user_authorization: "authorize one adjudication",
  });
  assertEvidenceTransition(
    "partial finding adjudication",
    adjudicationBefore,
    partialAdjudication,
    ["adjudications"],
  );
  const allAdjudicated = adjudicateFindings(adjudicationBefore, {
    workflow_id: adjudicationBefore.workflow_id,
    expected_version: adjudicationBefore.version,
    findings: [firstBlocker, secondBlocker].map((finding) => ({
      finding_id: finding.finding_id,
      disposition: "CONTRACT_INCONSISTENT",
      reason: "accept deterministic risk",
    })),
    user_authorization: "authorize all adjudications",
  });
  assertEvidenceTransition("all findings adjudicated", adjudicationBefore, allAdjudicated, [
    "adjudications",
  ]);

  const returnBefore = commitPreparationFailed(
    workflowState({ phase: "COMMIT_AUTHORIZED" }),
    "ERROR_STALE_RECEIPT",
    "the reviewed tree changed",
  );
  const returnAfter = returnCommitToReview(returnBefore, {
    workflow_id: returnBefore.workflow_id,
    expected_version: returnBefore.version,
    review_context: "review the current tree",
  });
  assertEvidenceTransition(
    "return commit to review",
    returnBefore,
    returnAfter,
    ["review_receipts", "commit_authorization"],
    {
      review_receipts: emptyEvidence.review_receipts,
      commit_authorization: emptyEvidence.commit_authorization,
      commit_attempt_evidence: emptyEvidence.commit_attempt_evidence,
    },
  );

  const staleAttemptBefore = workflowState({ phase: "COMMIT_AUTHORIZED" });
  const prepared = workflowState({ phase: "COMMIT_PREPARED" });
  const notCommitted = workflowState({ phase: "STOPPED_NOT_COMMITTED" });
  staleAttemptBefore.commit_preparation = structuredClone(prepared.commit_preparation);
  staleAttemptBefore.commit_result = structuredClone(notCommitted.commit_result);
  const preparationFailure = commitPreparationFailed(
    staleAttemptBefore,
    "ERROR_STAGED_CONTENT",
    "the staged content is not ready",
  );
  assertEvidenceTransition(
    "commit-preparation failure",
    staleAttemptBefore,
    preparationFailure,
    ["commit_attempt_evidence"],
    {
      commit_attempt_evidence: {
        commit_preparation: null,
        commit_result: null,
      },
    },
  );
  const preparationRetry = retryCommitPreparation(preparationFailure, {
    workflow_id: preparationFailure.workflow_id,
    expected_version: preparationFailure.version,
    retry_context: "retry deterministic preparation",
  });
  assertEvidenceTransition("commit-preparation retry", preparationFailure, preparationRetry, []);

  const commitRetryBefore = workflowState({ phase: "STOPPED_NOT_COMMITTED" });
  const commitRetryAfter = retryCommit(commitRetryBefore, {
    workflow_id: commitRetryBefore.workflow_id,
    expected_version: commitRetryBefore.version,
    retry_context: "retry deterministic commit",
  });
  assertEvidenceTransition(
    "known-not-committed retry",
    commitRetryBefore,
    commitRetryAfter,
    ["commit_attempt_evidence"],
    {
      commit_attempt_evidence: {
        commit_preparation: null,
        commit_result: null,
      },
    },
  );

  for (const evidenceCase of evidenceCases) verifyEvidenceTransition(...evidenceCase);

  const source = workflowState({
    phase: "STOPPED_APPROVED",
    optional_findings: [optionalFinding("LINKED-1")],
  });
  const sourceBefore = structuredClone(source);
  const followup = linkedFollowupInput(
    source,
    {
      workflow_id: source.workflow_id,
      expected_version: source.version,
      objective: "deterministic linked remediation",
      approved_plan: null,
      approved_paths: ["note.txt"],
      acceptance_criteria: ["the linked remediation is complete"],
      validation_requirements: [
        { description: "deterministic linked validation", kind: "command", argv: ["true"] },
      ],
      finding_ids: ["LINKED-1"],
      user_authorization: "authorize deterministic linked remediation",
    },
    TEST_ROOT,
    source.base_head,
  );
  const child = linkedFollowupChildState(followup);
  assert.deepEqual(source, sourceBefore, "linked follow-up construction preserves source evidence");
  const childEvidence = evidenceProjection(child);
  assert.deepEqual(
    childEvidence.implementation_submission,
    emptyEvidence.implementation_submission,
  );
  assert.deepEqual(childEvidence.review_receipts, emptyEvidence.review_receipts);
  assert.deepEqual(childEvidence.current_review_result, emptyEvidence.current_review_result);
  assert.deepEqual(childEvidence.adjudications, { finding_adjudications: [] });
  assert.deepEqual(childEvidence.repair_authority, emptyEvidence.repair_authority);
  assert.deepEqual(childEvidence.commit_authorization, emptyEvidence.commit_authorization);
  assert.deepEqual(childEvidence.commit_attempt_evidence, emptyEvidence.commit_attempt_evidence);
  assert.deepEqual(childEvidence.linked_findings.linked_findings, [optionalFinding("LINKED-1")]);
  assert.equal(childEvidence.linked_continuation.linked_continuation?.review_stage, "remediation");
  assert.deepEqual(childEvidence.remediation_context.remediation_context?.authorized_finding_ids, [
    "LINKED-1",
  ]);
});

test("authoritative contract replacement reports scope reconciliation without clearing overlays", () => {
  const state = workflowState({ workflow_type: "review_only", phase: "REVIEWING" });
  const planId = "00000000-0000-4000-8000-000000000158" as PlanId;
  const artifact: PlanRevisionArtifact = {
    plan_schema_version: 3,
    plan_id: planId,
    revision: 2 as PlanRevision,
    workflow_type: "change",
    full_plan: "replacement plan",
    execution_brief: "replacement brief",
    objective: "replacement objective",
    approved_paths: [...state.approved_paths, "new.txt" as ExactRepoPath].sort(),
    acceptance_criteria: [
      {
        criterion_id: "AC-001" as AcceptanceCriterionId,
        description: "replacement acceptance",
      },
    ],
    validation_requirements: [
      {
        validation_id: "VAL-001" as ValidationRequirementId,
        description: "replacement validation",
        kind: "command",
        argv: ["true"],
      },
    ],
    created_at: "2026-01-02T00:00:00.000Z" as IsoTimestamp,
  };
  const provenance = {
    plan_id: planId,
    revision: artifact.revision,
    artifact_digest:
      "2222222222222222222222222222222222222222222222222222222222222222" as ContentDigest,
    approved_at: "2026-01-02T00:01:00.000Z" as IsoTimestamp,
  };
  const before = structuredClone(state);
  const replacement = replaceAuthoritativeImplementationContract(
    state,
    authoritativeImplementationContract(artifact, provenance),
  );

  assert.deepEqual(replacement.prior_effective_paths, before.approved_paths);
  assert.deepEqual(replacement.artifact_declared_paths, artifact.approved_paths);
  assert.deepEqual(replacement.added_paths, ["new.txt"]);
  assert.deepEqual(state, before);
  const changedFields = Object.keys(replacement.state)
    .filter(
      (key) =>
        JSON.stringify(replacement.state[key as keyof WorkflowState]) !==
        JSON.stringify(before[key as keyof WorkflowState]),
    )
    .sort();
  assert.deepEqual(changedFields, [
    "acceptance_criteria",
    "approved_paths",
    "approved_plan",
    "execution_brief",
    "objective",
    "plan_provenance",
    "validation_requirements",
    "workflow_type",
  ]);
});

test("plan rebind after a repair block clears active lifecycle authority and resumes fresh implementation", () => {
  const repairing = workflowState({ phase: "REPAIRING" });
  const planId = "00000000-0000-4000-8000-000000000155" as PlanId;
  repairing.approved_plan = "revision one plan";
  repairing.execution_brief = "revision one brief";
  repairing.plan_provenance = {
    plan_id: planId,
    revision: 1 as PlanRevision,
    artifact_digest:
      "1111111111111111111111111111111111111111111111111111111111111111" as ContentDigest,
    approved_at: "2026-01-01T00:00:00.000Z" as IsoTimestamp,
  };
  const blocked = submitImplementation(
    repairing,
    {
      workflow_id: repairing.workflow_id,
      expected_version: repairing.version,
      status: "BLOCKED",
      summary: "repair plan is blocked",
      agent_touched_paths: ["note.txt"],
      acceptance_results: repairing.acceptance_criteria.map(({ criterion_id }) => ({
        criterion_id,
        status: "not_satisfied",
        evidence: "blocked",
      })),
      validation_results: repairing.validation_requirements.map(({ validation_id }) => ({
        validation_id,
        status: "not_run",
        evidence: "blocked",
      })),
      known_failures: ["blocked repair"],
      finding_resolution_map: Object.fromEntries(
        repairing.repair_authorized_ids.map((id) => [id, "still_present"]),
      ),
    },
    "/deterministic-workflow-fixture",
    syntheticReceipt(),
  );
  blocked.version = (repairing.version + 1) as WorkflowVersion;
  blocked.work_items = [{ provider: "github", id: "159", display_ref: "#159", url: null }];
  blocked.parent_workflow_id = "00000000-0000-4000-8000-000000000150" as WorkflowId;
  blocked.source_workflow_id = "00000000-0000-4000-8000-000000000151" as WorkflowId;
  blocked.linked_findings = [blockingFinding("LINKED-REBIND")];
  blocked.remediation_context = {
    policy: "explicitly_authorized",
    authorized_finding_ids: [blocked.linked_findings[0].finding_id],
    repair_cycle: 0,
    user_authorization: "authorize linked rebind fixture",
  };
  blocked.linked_continuation = {
    root_workflow_id: "00000000-0000-4000-8000-000000000150" as WorkflowId,
    predecessor_workflow_id: blocked.source_workflow_id,
    lineage_workflow_ids: [
      "00000000-0000-4000-8000-000000000150" as WorkflowId,
      blocked.source_workflow_id,
    ],
    original_base_head: blocked.base_head,
    combined_review_paths: [...blocked.approved_paths],
    review_stage: "combined",
    remediation_review_receipt: syntheticReceipt(),
  };
  blocked.finding_adjudications = [
    {
      finding_id: "HISTORICAL-REBIND" as FindingId,
      finding_snapshot: blockingFinding("HISTORICAL-REBIND"),
      source_review_version: blocked.review_result_version as WorkflowVersion,
      disposition: "CONTRACT_INCONSISTENT",
      reason: "preserve historical adjudication",
      user_authorization: "authorize historical adjudication",
      adjudicated_at: "2026-01-01T00:00:00.000Z" as IsoTimestamp,
      resulting_workflow_version: blocked.version,
    },
  ];
  const adjudications = structuredClone(blocked.finding_adjudications);
  const remediation = structuredClone(blocked.remediation_context);
  const workItems = structuredClone(blocked.work_items);
  const linkedFindings = structuredClone(blocked.linked_findings);
  const lineage = {
    parent_workflow_id: blocked.parent_workflow_id,
    source_workflow_id: blocked.source_workflow_id,
    root_workflow_id: blocked.linked_continuation.root_workflow_id,
    predecessor_workflow_id: blocked.linked_continuation.predecessor_workflow_id,
    lineage_workflow_ids: structuredClone(blocked.linked_continuation.lineage_workflow_ids),
  };
  const replacementArtifact: PlanRevisionArtifact = {
    plan_schema_version: 3,
    plan_id: planId,
    revision: 2 as PlanRevision,
    workflow_type: "change",
    full_plan: "revision two plan",
    execution_brief: "revision two brief",
    objective: "revision two objective",
    approved_paths: blocked.approved_paths,
    acceptance_criteria: [
      {
        criterion_id: "AC-001" as AcceptanceCriterionId,
        description: "revision two acceptance",
      },
    ],
    validation_requirements: [
      {
        validation_id: "VAL-001" as ValidationRequirementId,
        description: "revision two validation",
        kind: "command",
        argv: ["true"],
      },
    ],
    created_at: "2026-01-02T00:00:00.000Z" as IsoTimestamp,
  };
  const replacementProvenance = {
    plan_id: planId,
    revision: 2 as PlanRevision,
    artifact_digest:
      "2222222222222222222222222222222222222222222222222222222222222222" as ContentDigest,
    approved_at: "2026-01-02T00:01:00.000Z" as IsoTimestamp,
  };
  const rebound = rebindImplementationPlan(
    blocked,
    authoritativeImplementationContract(replacementArtifact, replacementProvenance),
    syntheticReceipt(),
    "authorization must not enter semantic state",
  );

  assert.equal(rebound.phase, "IMPLEMENTING");
  assert.equal(rebound.repair_cycle, 0);
  assert.deepEqual(rebound.blocking_findings, []);
  assert.deepEqual(rebound.optional_findings, []);
  assert.deepEqual(rebound.prior_finding_classifications, {});
  assert.equal(rebound.review_result_version, null);
  assert.equal(rebound.review_start_receipt, null);
  assert.equal(rebound.review_receipt, null);
  assert.deepEqual(rebound.repair_authorized_ids, []);
  assert.equal(rebound.repair_directive, null);
  assert.equal(rebound.concern_acceptance, null);
  assert.equal(rebound.commit_authorization, null);
  assert.equal(rebound.commit_preparation, null);
  assert.equal(rebound.commit_result, null);
  assert.deepEqual(rebound.finding_adjudications, adjudications);
  assert.deepEqual(rebound.remediation_context, remediation);
  assert.deepEqual(rebound.work_items, workItems);
  assert.deepEqual(rebound.linked_findings, linkedFindings);
  assert.deepEqual(
    {
      parent_workflow_id: rebound.parent_workflow_id,
      source_workflow_id: rebound.source_workflow_id,
      root_workflow_id: rebound.linked_continuation?.root_workflow_id,
      predecessor_workflow_id: rebound.linked_continuation?.predecessor_workflow_id,
      lineage_workflow_ids: rebound.linked_continuation?.lineage_workflow_ids,
    },
    lineage,
  );
  assert.equal(rebound.linked_continuation?.review_stage, "remediation");
  assert.equal(rebound.linked_continuation?.remediation_review_receipt, null);
  assert.equal(
    JSON.stringify(rebound).includes("authorization must not enter semantic state"),
    false,
  );
  assert.doesNotThrow(() =>
    validateWorkflowStateV10({
      ...rebound,
      version: (blocked.version + 1) as WorkflowVersion,
    }),
  );
});

test("deterministic fixture histories preserve reachable versions and evidence", () => {
  const reviewing = workflowState({ phase: "REVIEWING" });
  assert.equal(reviewing.version, 1);
  assert.equal(reviewing.implementation_status, "DONE");
  assert.equal(reviewing.implementation_receipt?.paths[0]?.state, "modified");

  const approved = workflowState({ phase: "STOPPED_APPROVED" });
  assert.equal(approved.version, 3);
  assert.equal(approved.review_result_version, 3);
  assert.equal(approved.review_receipt?.paths[0]?.state, "modified");

  const authorized = workflowState({ phase: "COMMIT_AUTHORIZED" });
  const prepared = workflowState({ phase: "COMMIT_PREPARED" });
  const committed = workflowState({ phase: "COMMITTED" });
  assert.equal(authorized.version, 4);
  assert.equal(prepared.version, 5);
  assert.equal(
    prepared.commit_preparation?.review_receipt_digest,
    objectDigest(prepared.review_receipt),
  );
  assert.deepEqual(prepared.commit_preparation?.expected_paths, ["note.txt"]);
  assert.equal(committed.version, 6);
  assert.notEqual(
    committed.commit_result?.outcome === "committed" ? committed.commit_result.commit_hash : null,
    prepared.commit_preparation?.prepared_head,
  );

  const repairRequired = workflowState({ phase: "REPAIR_REQUIRED" });
  const repairing = workflowState({ phase: "REPAIRING" });
  const exhausted = workflowState({ phase: "STOPPED_REPAIR_EXHAUSTED" });
  assert.equal(repairRequired.version, 3);
  assert.equal(repairing.version, 4);
  assert.equal(repairing.repair_cycle, 1);
  assert.equal(exhausted.version, 12);
  assert.equal(exhausted.repair_cycle, 2);
});
