import { randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import { CURRENT_STATE_SCHEMA_VERSION } from "./migration.js";
import { allRequiredValidationsPassed, effectiveBlockingFindings } from "./transition-queries.js";
import {
  changedReceiptPaths,
  dirtyBaselinePaths,
  rangeDirtyBaselinePaths,
  scopeChangedPaths,
} from "./transition-receipts.js";
import {
  applyRecovery,
  clearFullCommitEvidence,
  clearStaleReviewEvidence,
  clone,
  ensurePhase,
} from "./transition-shared.js";

export {
  acceptConcerns,
  adoptDirtyScope,
  expandScope,
  IMPLEMENTATION_STOP_PHASES,
  resumeImplementation,
  submitImplementation,
} from "./transition-implementation.js";
export {
  adjudicateFindings,
  authorizeRepair,
  beginReview,
  finalizeRepairExhausted,
  recordManualValidation,
  resumeReview,
  submitReview,
} from "./transition-review.js";
export { ensurePhase } from "./transition-shared.js";

import { baseState } from "./transition-state.js";
import type {
  AcceptanceCriterion,
  CommitAttemptId,
  CommitMismatchCategory,
  CommitPreparationEvidence,
  CommitPreparationFailureCategory,
  ExactRepoPath,
  FindingId,
  GitCommitSha,
  PlanProvenance,
  PlanRevisionArtifact,
  ReviewFinding,
  ValidationAuthoringRequirement,
  ValidationRequirement,
  WorkflowId,
  WorkflowPhase,
  WorkflowState,
  WorkflowType,
  WorkflowVersion,
  WorkItemReference,
} from "./types.js";
import {
  approvedPlan,
  boundedString,
  contractList,
  exactKeys,
  exactPaths,
  findingIdList,
  isoNow,
  objectDigest,
  revision,
  userAuthorization,
} from "./validation.js";
import {
  COMMIT_MISMATCH_CATEGORY_SET,
  COMMIT_SUBMISSION_OUTCOME_VALUES,
  isValue,
  WORKFLOW_PHASE_VALUES,
} from "./values.js";

export { V10_STATE_KEYS, validateWorkflowStateV10 } from "./state-validation.js";
export {
  allRequiredValidationsPassed,
  approvedPathBaselineView,
  effectiveBlockingFindings,
  hasFailedRequiredValidation,
  pendingInspectionValidations,
  permittedNextActions,
  REVIEWER_IMPLEMENTER_HANDOFF,
  ROLE_VIEW_COMMON,
  ROLE_VIEW_EXTRA,
  reviewBlockedByPendingInspection,
  roleView,
} from "./transition-queries.js";
export { changedReceiptPaths, dirtyBaselinePaths, rangeDirtyBaselinePaths, scopeChangedPaths };

export const SCHEMA_VERSION = CURRENT_STATE_SCHEMA_VERSION;

export { createState, createStateFromPlan } from "./transition-state.js";

export const PHASES: readonly WorkflowPhase[] = WORKFLOW_PHASE_VALUES;

export const MISMATCH_CATEGORIES: ReadonlySet<CommitMismatchCategory> =
  COMMIT_MISMATCH_CATEGORY_SET;

function clearRetryablePreparedAttempt(state: WorkflowState): void {
  state.commit_preparation = null;
  state.commit_result = null;
}

export function authorizeCommit(state: WorkflowState, authorization: unknown): WorkflowState {
  if (!authorization || typeof authorization !== "object" || Array.isArray(authorization)) {
    fail("ERROR_INVALID_SHAPE", "commit authorization is invalid");
  }
  const args = exactKeys(
    authorization,
    ["workflow_id", "expected_version", "user_authorization"],
    "commit authorization",
  );
  ensurePhase(state, "STOPPED_APPROVED");
  if (!allRequiredValidationsPassed(state))
    fail(
      "ERROR_COMMIT_NOT_ALLOWED",
      "all required validations must pass before commit authorization",
    );
  const next = clone<WorkflowState>(state);
  next.commit_authorization = {
    user_authorization: userAuthorization(args.user_authorization),
    authorized_at: isoNow(),
  };
  next.phase = "COMMIT_AUTHORIZED";
  return next;
}

export function commitMismatch(
  state: WorkflowState,
  category: CommitMismatchCategory,
): WorkflowState {
  if (!MISMATCH_CATEGORIES.has(category)) {
    fail("ERROR_STATE_CORRUPT", "mismatch category is invalid");
  }
  const next = clone<WorkflowState>(state);
  next.commit_result = { outcome: "mismatch", mismatch_category: category };
  next.phase = "STOPPED_COMMIT_MISMATCH";
  return next;
}

export function commitPreparationFailed(
  state: WorkflowState,
  category: CommitPreparationFailureCategory,
  summary: string,
): WorkflowState {
  ensurePhase(state, "COMMIT_AUTHORIZED");
  const next = clone<WorkflowState>(state);
  next.phase = "STOPPED_COMMIT_PREPARATION";
  next.stop_context = {
    status: "COMMIT_PREPARATION_FAILED",
    category,
    summary: boundedString(summary, "preparation failure summary", 2000),
    recovery: category === "ERROR_STALE_RECEIPT" ? "review" : "retry",
    failed_at: isoNow(),
    failed_version: (state.version + 1) as WorkflowVersion,
    stopped_from: "COMMIT_AUTHORIZED",
  };
  clearRetryablePreparedAttempt(next);
  return next;
}

export function prepareCommit(
  state: WorkflowState,
  input: unknown,
  evidence: CommitPreparationEvidence,
): WorkflowState {
  exactKeys(input, ["workflow_id", "expected_version"], "commit preparation");
  ensurePhase(state, "COMMIT_AUTHORIZED");
  const next = clone<WorkflowState>(state);
  next.commit_preparation = {
    attempt_id: randomUUID() as CommitAttemptId, // documented brand cast
    prepared_head: evidence.prepared_head,
    prepared_tree: evidence.prepared_tree,
    expected_paths: evidence.expected_paths,
    review_receipt_digest: objectDigest(state.review_receipt),
    prepared_at: isoNow(),
  };
  next.phase = "COMMIT_PREPARED";
  return next;
}

export function retryCommitPreparation(state: WorkflowState, input: unknown): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "commit preparation retry input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "expected_version", "retry_context"],
    "commit preparation retry",
  );
  ensurePhase(state, "STOPPED_COMMIT_PREPARATION");
  if (
    state.stop_context?.status !== "COMMIT_PREPARATION_FAILED" ||
    state.stop_context.recovery !== "retry"
  ) {
    fail("ERROR_INVALID_TRANSITION", "preparation failure requires review recovery");
  }
  const next = clone<WorkflowState>(state);
  clearRetryablePreparedAttempt(next);
  applyRecovery(next, "COMMIT_AUTHORIZED", "commit", args.retry_context, "retry_context");
  return next;
}

export function returnCommitToReview(state: WorkflowState, input: unknown): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "commit review recovery input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "expected_version", "review_context"],
    "commit review recovery",
  );
  ensurePhase(state, "STOPPED_COMMIT_PREPARATION");
  if (
    state.stop_context?.status !== "COMMIT_PREPARATION_FAILED" ||
    state.stop_context.recovery !== "review"
  ) {
    fail("ERROR_INVALID_TRANSITION", "preparation failure is retryable");
  }
  const next = clone<WorkflowState>(state);
  clearStaleReviewEvidence(next);
  clearFullCommitEvidence(next);
  applyRecovery(next, "REVIEWING", "review", args.review_context, "review_context");
  return next;
}

function commitResultInput(state: WorkflowState, input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "commit result input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "expected_version", "attempt_id", "outcome", "failure_summary"],
    "commit result",
  );
  ensurePhase(state, "COMMIT_PREPARED");
  if (state.commit_preparation?.attempt_id !== args.attempt_id) {
    fail("ERROR_COMMIT_MISMATCH", "attempt ID does not match the prepared attempt");
  }
  if (!isValue(COMMIT_SUBMISSION_OUTCOME_VALUES, args.outcome)) {
    fail("ERROR_INVALID_SHAPE", "commit outcome is invalid");
  }
  if (args.outcome === "committed" && args.failure_summary !== null) {
    fail("ERROR_INVALID_SHAPE", "committed result cannot include a failure summary");
  }
  if (args.outcome === "not_committed") {
    if (args.failure_summary === null || typeof args.failure_summary !== "string") {
      fail("ERROR_INVALID_SHAPE", "not-committed result requires a failure summary");
    }
    boundedString(args.failure_summary, "failure_summary", 2000);
  }
  return args;
}

export function validateCommitResult(state: WorkflowState, input: unknown): void {
  commitResultInput(state, input);
}

export function submitCommitResult(
  state: WorkflowState,
  input: unknown,
  verifiedCommitHash: GitCommitSha | null,
): WorkflowState {
  const args = commitResultInput(state, input);
  const next = clone<WorkflowState>(state);
  if (args.outcome === "committed") {
    if (verifiedCommitHash === null) {
      fail("ERROR_COMMIT_MISMATCH", "committed result was not verified");
    }
    next.commit_result = {
      outcome: "committed",
      commit_hash: verifiedCommitHash,
      failure_summary: null,
    };
    next.phase = "COMMITTED";
  } else {
    next.commit_result = {
      outcome: "not_committed",
      commit_hash: null,
      failure_summary: boundedString(args.failure_summary, "failure_summary", 2000),
    };
    next.phase = "STOPPED_NOT_COMMITTED";
  }
  return next;
}

export function retryCommit(state: WorkflowState, input: unknown): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "commit retry input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "expected_version", "retry_context"],
    "commit retry",
  );
  ensurePhase(state, "STOPPED_NOT_COMMITTED");
  const next = clone<WorkflowState>(state);
  clearRetryablePreparedAttempt(next);
  applyRecovery(next, "COMMIT_AUTHORIZED", "commit", args.retry_context, "retry_context");
  return next;
}

export interface LinkedFollowupPlan {
  workflow_type: WorkflowType;
  objective: string;
  approved_plan: string | null;
  execution_brief: string | null;
  plan_provenance: PlanProvenance | null;
  approved_paths: ExactRepoPath[];
  acceptance_criteria: AcceptanceCriterion[] | string[];
  validation_requirements: ValidationRequirement[] | ValidationAuthoringRequirement[];
  base_head: GitCommitSha;
  max_repair_cycles: number;
  parent_workflow_id: WorkflowId | null;
  source_workflow_id: WorkflowId | null;
  authorized_finding_ids: FindingId[];
  linked_findings: ReviewFinding[];
  user_authorization: string;
  combined_review_paths: ExactRepoPath[];
  original_base_head: GitCommitSha;
  root_workflow_id: WorkflowId;
  lineage_workflow_ids: WorkflowId[];
  review_stage: "remediation";
  work_items: WorkItemReference[];
}

export function linkedFollowupInput(
  state: WorkflowState,
  input: unknown,
  repositoryRoot: string,
  currentHead: GitCommitSha,
): LinkedFollowupPlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_FOLLOWUP", "follow-up input is invalid");
  }
  const args = exactKeys(
    input,
    [
      "workflow_id",
      "expected_version",
      "objective",
      "approved_plan",
      "approved_paths",
      "acceptance_criteria",
      "validation_requirements",
      "finding_ids",
      "user_authorization",
    ],
    "linked follow-up",
  );
  return linkedFollowupInputCore(
    state,
    args,
    exactPaths(args.approved_paths, repositoryRoot),
    currentHead,
    {
      workflow_type: "change",
      objective: boundedString(args.objective, "objective"),
      approved_plan: approvedPlan(args.approved_plan),
      execution_brief: null,
      plan_provenance: null,
      acceptance_criteria: args.acceptance_criteria as string[],
      validation_requirements: args.validation_requirements as ValidationAuthoringRequirement[],
    },
  );
}

/** Adapt a server-resolved approved PlanArtifact to the shared linked-follow-up checks. */
export function linkedFollowupInputFromPlan(
  state: WorkflowState,
  input: unknown,
  artifact: PlanRevisionArtifact,
  provenance: PlanProvenance,
  currentHead: GitCommitSha,
): LinkedFollowupPlan {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_FOLLOWUP", "plan linked follow-up input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "expected_version", "plan_id", "revision", "finding_ids", "user_authorization"],
    "plan linked follow-up",
  );
  if (args.plan_id !== artifact.plan_id || args.revision !== artifact.revision) {
    fail("ERROR_INVALID_FOLLOWUP", "resolved plan identity does not match request");
  }
  return linkedFollowupInputCore(state, args, artifact.approved_paths, currentHead, {
    workflow_type: artifact.workflow_type,
    objective: artifact.objective,
    approved_plan: artifact.full_plan,
    execution_brief: artifact.execution_brief,
    plan_provenance: provenance,
    acceptance_criteria: clone(artifact.acceptance_criteria),
    validation_requirements: clone(artifact.validation_requirements),
  });
}

interface LinkedFollowupContract {
  workflow_type: WorkflowType;
  objective: string;
  approved_plan: string | null;
  execution_brief: string | null;
  plan_provenance: PlanProvenance | null;
  acceptance_criteria: AcceptanceCriterion[] | string[];
  validation_requirements: ValidationRequirement[] | ValidationAuthoringRequirement[];
}

function linkedFollowupInputCore(
  state: WorkflowState,
  args: Record<string, unknown>,
  remediationPaths: ExactRepoPath[],
  currentHead: GitCommitSha,
  contract: LinkedFollowupContract,
): LinkedFollowupPlan {
  ensurePhase(state, "STOPPED_APPROVED", "STOPPED_REPAIR_EXHAUSTED");
  if (state.superseded_by_workflow_id) {
    fail("ERROR_INVALID_FOLLOWUP", "workflow already has an active linked successor");
  }
  const ids = findingIdList(args.finding_ids, "finding_ids", "ERROR_INVALID_FOLLOWUP");
  const blocking = new Set(effectiveBlockingFindings(state).map((finding) => finding.finding_id));
  const optional = new Set(state.optional_findings.map((finding) => finding.finding_id));
  const fromBlocking = ids.every((id) => blocking.has(id));
  const fromOptional = ids.every((id) => optional.has(id));
  if (fromBlocking === fromOptional) {
    fail("ERROR_INVALID_FOLLOWUP", "finding IDs must come from one bucket");
  }
  const linkedFindings = [...effectiveBlockingFindings(state), ...state.optional_findings].filter(
    (finding) => ids.includes(finding.finding_id),
  );
  const isWorkingTree = state.review_target.review_mode === "working_tree";
  const inheritedCombined =
    state.linked_continuation?.combined_review_paths ?? state.review_target.approved_paths;
  const combinedPaths = [...new Set([...inheritedCombined, ...remediationPaths])].sort();
  const originalBase = isWorkingTree
    ? (state.linked_continuation?.original_base_head ?? state.base_head)
    : currentHead;
  if (currentHead !== originalBase) fail("ERROR_STALE_BASE", "linked follow-up base is stale");
  const root = state.linked_continuation?.root_workflow_id ?? state.workflow_id;
  if (!root || !state.workflow_id)
    fail("ERROR_STATE_CORRUPT", "linked workflow provenance is missing");
  const lineage = state.linked_continuation
    ? [...state.linked_continuation.lineage_workflow_ids, state.workflow_id]
    : [state.workflow_id];
  return {
    workflow_type: contract.workflow_type,
    objective: contract.objective,
    approved_plan: contract.approved_plan,
    execution_brief: contract.execution_brief,
    plan_provenance: contract.plan_provenance,
    approved_paths: remediationPaths,
    acceptance_criteria: contract.acceptance_criteria,
    validation_requirements: contract.validation_requirements,
    base_head: revision(originalBase, "base_head"),
    max_repair_cycles: state.max_repair_cycles,
    parent_workflow_id: state.workflow_id,
    source_workflow_id: state.workflow_id,
    authorized_finding_ids: ids.slice().sort(),
    linked_findings: linkedFindings,
    user_authorization: userAuthorization(args.user_authorization),
    combined_review_paths: combinedPaths,
    original_base_head: revision(originalBase, "original_base_head"),
    root_workflow_id: root,
    lineage_workflow_ids: lineage,
    review_stage: "remediation",
    work_items: clone(state.work_items),
  };
}

export function linkedFollowupChildState(followup: LinkedFollowupPlan): WorkflowState {
  const state = baseState({
    workflowType: followup.workflow_type,
    objective: followup.objective,
    approvedPlan: followup.approved_plan,
    executionBrief: followup.execution_brief,
    planProvenance: followup.plan_provenance,
    approvedPaths: followup.approved_paths,
    baseHead: followup.base_head,
    maxRepairCycles: followup.max_repair_cycles,
    parentWorkflowId: followup.parent_workflow_id,
    sourceWorkflowId: followup.source_workflow_id,
    linkedFindings: followup.linked_findings,
    linkedContinuation: {
      root_workflow_id: followup.root_workflow_id,
      predecessor_workflow_id: followup.source_workflow_id as WorkflowId,
      lineage_workflow_ids: followup.lineage_workflow_ids,
      original_base_head: followup.original_base_head,
      combined_review_paths: followup.combined_review_paths,
      review_stage: followup.review_stage,
      remediation_review_receipt: null,
    },
    workItems: followup.work_items,
    remediationContext: {
      policy: "explicitly_authorized",
      authorized_finding_ids: followup.authorized_finding_ids,
      repair_cycle: 0,
      user_authorization: followup.user_authorization,
    },
  });
  if (followup.plan_provenance) {
    state.acceptance_criteria = clone(followup.acceptance_criteria) as AcceptanceCriterion[];
    state.validation_requirements = clone(
      followup.validation_requirements,
    ) as ValidationRequirement[];
  } else {
    state.acceptance_criteria = contractList(
      followup.acceptance_criteria,
      "acceptance_criteria",
      "AC",
      "criterion_id",
    );
    state.validation_requirements = contractList(
      followup.validation_requirements,
      "validation_requirements",
      "VAL",
      "validation_id",
    );
  }
  return state;
}
