import { randomUUID } from "node:crypto";
import { fail, WorkflowError } from "./errors.js";
import { CURRENT_STATE_SCHEMA_VERSION } from "./migration.js";
import {
  allRequiredValidationsPassed,
  effectiveBlockingFindings,
  hasFailedRequiredValidation,
  pendingInspectionValidations,
  reviewBlockedByPendingInspection,
} from "./transition-queries.js";
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
export { ensurePhase } from "./transition-shared.js";

import { baseState } from "./transition-state.js";
import type {
  AcceptanceCriterion,
  BlockingFinding,
  ChangeReceipt,
  CommitAttemptId,
  CommitMismatchCategory,
  CommitPreparationEvidence,
  CommitPreparationFailureCategory,
  ExactRepoPath,
  FindingAdjudication,
  FindingAdjudicationDisposition,
  FindingId,
  FindingSeverity,
  GitCommitSha,
  PlanProvenance,
  PlanRevisionArtifact,
  ReviewFinding,
  ValidationAuthoringRequirement,
  ValidationRequirement,
  ValidationResult,
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
  canonicalJson,
  contractList,
  evidenceResults,
  exactKeys,
  exactPaths,
  findingIdList,
  findings,
  isoNow,
  MAX_DETAIL,
  objectDigest,
  repairConformance,
  repairDirective,
  resolutionMap,
  revision,
  userAuthorization,
  VALIDATION_STATUSES,
} from "./validation.js";
import {
  COMMIT_MISMATCH_CATEGORY_SET,
  COMMIT_SUBMISSION_OUTCOME_VALUES,
  FINDING_ADJUDICATION_VALUES,
  isValue,
  REVIEW_STATUS_VALUES,
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

function parseReviewerValidationResults(
  value: unknown,
  contracts: ReadonlyArray<ValidationRequirement>,
): ValidationResult[] {
  try {
    return evidenceResults(value, "validation", contracts, "validation_id", VALIDATION_STATUSES);
  } catch (error) {
    if (error instanceof WorkflowError && error.category === "ERROR_INVALID_IMPLEMENTATION") {
      fail("ERROR_INVALID_REVIEW", error.detail);
    }
    throw error;
  }
}

/** Merge fresh reviewer command evidence into the authoritative ordered result set. */
function mergeReviewerValidationResults(
  state: WorkflowState,
  reviewerResults: ReadonlyArray<ValidationResult>,
): ValidationResult[] {
  const reviewerById = new Map(
    reviewerResults.map((result) => [result.validation_id, result] as const),
  );
  const currentById = new Map(
    state.validation_results.map((result) => [result.validation_id, result] as const),
  );
  return state.validation_requirements.map((requirement) => {
    const result =
      requirement.kind === "command"
        ? reviewerById.get(requirement.validation_id)
        : currentById.get(requirement.validation_id);
    if (!result) fail("ERROR_INVALID_REVIEW", "validation results are incomplete");
    return result;
  });
}

export function beginReview(
  state: WorkflowState,
  input: unknown,
  startReceipt: ChangeReceipt,
): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_REVIEW", "review begin input is invalid");
  }
  exactKeys(input, ["workflow_id", "expected_version"], "review begin");
  ensurePhase(state, "REVIEWING");
  if (reviewBlockedByPendingInspection(state))
    fail("ERROR_INVALID_REVIEW", "required inspection evidence is pending");
  if (state.review_target.review_mode !== "working_tree") {
    fail("ERROR_INVALID_REVIEW", "commit-range reviews do not use review snapshots");
  }
  if (startReceipt.base_head !== state.base_head) {
    fail("ERROR_STALE_RECEIPT", "review snapshot base is stale; begin review again");
  }
  if (
    state.review_start_receipt &&
    canonicalJson(state.review_start_receipt) === canonicalJson(startReceipt)
  ) {
    fail(
      "ERROR_INVALID_REVIEW",
      "review has already begun; submit the review before beginning again",
    );
  }
  const next = clone<WorkflowState>(state);
  next.review_start_receipt = clone(startReceipt);
  return next;
}

export function submitReview(
  state: WorkflowState,
  input: unknown,
  finalReceipt: ChangeReceipt | null = null,
): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_REVIEW", "review input is invalid");
  }
  ensurePhase(state, "REVIEWING");
  if (reviewBlockedByPendingInspection(state))
    fail("ERROR_INVALID_REVIEW", "required inspection evidence is pending");
  const args = exactKeys(
    input,
    [
      "workflow_id",
      "expected_version",
      "review_status",
      "blocking_findings",
      "optional_findings",
      "prior_finding_classifications",
      "validation_results",
      "repair_conformance",
    ],
    "review submission",
    ["validation_results", "repair_conformance"],
  );
  if (!isValue(REVIEW_STATUS_VALUES, args.review_status)) {
    fail("ERROR_INVALID_REVIEW", "review status is invalid");
  }
  const executableRequirements = state.validation_requirements.filter(
    (requirement) => requirement.kind === "command",
  );
  let reviewerValidationResults: ValidationResult[] | null = null;
  if (executableRequirements.length > 0) {
    if (args.review_status === "APPROVED" && !("validation_results" in args)) {
      fail("ERROR_INVALID_REVIEW", "approved review requires executable validation results");
    }
    if ("validation_results" in args) {
      reviewerValidationResults = parseReviewerValidationResults(
        args.validation_results,
        executableRequirements,
      );
    }
  } else if ("validation_results" in args) {
    reviewerValidationResults = parseReviewerValidationResults(
      args.validation_results,
      executableRequirements,
    );
  }
  const blockingFindings = findings(args.blocking_findings ?? [], "blocking_findings", true);
  const optionalFindings = findings(args.optional_findings ?? [], "optional_findings", false);
  const unionIds = [...blockingFindings, ...optionalFindings].map((item) => item.finding_id);
  if (new Set(unionIds).size !== unionIds.length) {
    fail("ERROR_INVALID_FINDING", "finding ID is duplicated across buckets");
  }
  const carriedIds =
    state.linked_continuation?.review_stage === "remediation"
      ? state.linked_findings.map((item) => item.finding_id)
      : [];
  const priorIds = [
    ...carriedIds,
    ...state.blocking_findings.map((item) => item.finding_id),
    ...state.optional_findings.map((item) => item.finding_id),
  ].filter((id, index, ids) => ids.indexOf(id) === index);
  const classifications = resolutionMap(
    args.prior_finding_classifications,
    priorIds,
    "prior_finding_classifications",
  );
  const adjudicatedIds = new Set(state.finding_adjudications.map((item) => item.finding_id));
  for (const finding of [...blockingFindings, ...optionalFindings]) {
    if (adjudicatedIds.has(finding.finding_id)) {
      fail("ERROR_INVALID_FINDING", "an adjudicated finding cannot be re-emitted");
    }
  }
  for (const finding of state.blocking_findings) {
    if (
      adjudicatedIds.has(finding.finding_id) &&
      classifications[finding.finding_id] !== "superseded"
    ) {
      fail("ERROR_INVALID_FINDING", "adjudicated findings must be classified superseded");
    }
  }
  for (const [id, status] of Object.entries(classifications)) {
    if (status === "still_present") {
      const prior =
        state.blocking_findings.find((item) => item.finding_id === id) ??
        state.optional_findings.find((item) => item.finding_id === id) ??
        (state.linked_continuation?.review_stage === "remediation"
          ? state.linked_findings.find((item) => item.finding_id === id)
          : undefined);
      if (prior) {
        const current = (prior.blocking ? blockingFindings : optionalFindings).find(
          (item) => item.finding_id === id,
        );
        if (
          !current ||
          current.severity !== prior.severity ||
          current.blocking !== prior.blocking
        ) {
          fail("ERROR_INVALID_FINDING", "still-present blocker changed bucket or severity");
        }
        continue;
      }
      fail("ERROR_INVALID_FINDING", "still-present finding changed bucket or severity");
    }
  }
  if (
    blockingFindings.some((item) => (item.severity as FindingSeverity) === "P3") ||
    optionalFindings.some((item) => item.severity !== "P3")
  ) {
    fail("ERROR_INVALID_REVIEW", "finding severity does not match list");
  }
  if (args.review_status === "APPROVED" && blockingFindings.length > 0) {
    fail("ERROR_INVALID_REVIEW", "approved review contains blockers");
  }
  if (args.review_status === "CHANGES_REQUESTED" && blockingFindings.length === 0) {
    fail("ERROR_INVALID_REVIEW", "changes requested without blockers");
  }
  const hasActiveRepairDirective = state.repair_directive !== null;
  let conformance: ReturnType<typeof repairConformance> | null = null;
  if ("repair_conformance" in args) {
    if (!hasActiveRepairDirective) {
      fail("ERROR_INVALID_REVIEW", "repair conformance requires an active repair directive");
    }
    conformance = repairConformance(args.repair_conformance);
  } else if (args.review_status === "APPROVED" && hasActiveRepairDirective) {
    fail("ERROR_INVALID_REVIEW", "approved repair review requires conformance evidence");
  }
  if (
    args.review_status === "APPROVED" &&
    hasActiveRepairDirective &&
    conformance?.status !== "conforming"
  ) {
    fail("ERROR_INVALID_REVIEW", "approved repair review is nonconforming");
  }
  const next = clone<WorkflowState>(state);
  if (reviewerValidationResults !== null)
    next.validation_results = mergeReviewerValidationResults(state, reviewerValidationResults);
  if (args.review_status === "APPROVED" && !allRequiredValidationsPassed(next)) {
    fail("ERROR_INVALID_REVIEW", "approved review requires all required validations to pass");
  }
  next.blocking_findings = blockingFindings;
  next.optional_findings = optionalFindings;
  next.prior_finding_classifications = classifications;
  next.review_result_version = (state.version + 1) as WorkflowVersion;
  next.review_receipt = finalReceipt ? clone(finalReceipt) : null;
  next.review_start_receipt = null;
  // A completed review result replaces any prior repair authorization. An inconclusive review
  // remains recoverable, so retain the directive for the resumed reviewer.
  if (args.review_status !== "INCONCLUSIVE") {
    next.repair_authorized_ids = [];
    next.repair_directive = null;
  }
  if (args.review_status === "APPROVED") {
    const continuation = state.linked_continuation;
    if (continuation?.review_stage === "remediation") {
      const unresolvedFinding = state.linked_findings.some(
        (finding) =>
          classifications[finding.finding_id] !== "resolved" &&
          classifications[finding.finding_id] !== "superseded",
      );
      if (unresolvedFinding) {
        fail("ERROR_INVALID_REVIEW", "carried findings must be resolved before combined review");
      }
      if (!finalReceipt) fail("ERROR_INVALID_REVIEW", "remediation approval requires a receipt");
      next.linked_continuation = {
        ...continuation,
        remediation_review_receipt: clone(finalReceipt),
        review_stage: "combined",
      };
      next.review_receipt = null;
      next.review_target = {
        ...next.review_target,
        approved_paths: continuation.combined_review_paths,
        base_revision: continuation.original_base_head,
      };
      next.phase = "REVIEWING";
    } else {
      next.phase = "STOPPED_APPROVED";
    }
  }
  if (args.review_status === "INCONCLUSIVE") {
    next.phase = "STOPPED_INCONCLUSIVE";
    next.stop_context = {
      status: "INCONCLUSIVE",
      summary: "review context unavailable",
      stopped_from: "REVIEWING",
    };
  }
  if (args.review_status === "CHANGES_REQUESTED") next.phase = "REPAIR_REQUIRED";
  return next;
}

export function adjudicateFindings(state: WorkflowState, input: unknown): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_REPAIR", "finding adjudication input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "expected_version", "findings", "user_authorization"],
    "finding adjudication",
  );
  ensurePhase(state, "REPAIR_REQUIRED");
  const authorization = userAuthorization(args.user_authorization);
  if (state.review_result_version === null) {
    fail("ERROR_INVALID_FINDING", "latest review result is missing");
  }
  const current = effectiveBlockingFindings(state);
  if (current.length === 0) fail("ERROR_INVALID_FINDING", "no effective blockers remain");
  if (
    !Array.isArray(args.findings) ||
    args.findings.length === 0 ||
    args.findings.length > current.length
  ) {
    fail("ERROR_INVALID_FINDING", "finding adjudications are invalid");
  }
  const currentById = new Map(current.map((finding) => [finding.finding_id, finding]));
  const historical = new Set(state.finding_adjudications.map((item) => item.finding_id));
  const records: FindingAdjudication[] = [];
  const seen = new Set<string>();
  for (const raw of args.findings) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      fail("ERROR_INVALID_FINDING", "finding adjudication is invalid");
    }
    const item = exactKeys(raw, ["finding_id", "disposition", "reason"], "finding adjudication");
    const id = item.finding_id as FindingId;
    if (
      typeof item.finding_id !== "string" ||
      seen.has(id) ||
      historical.has(id) ||
      !currentById.has(id)
    ) {
      fail("ERROR_INVALID_FINDING", "finding ID is stale, reused, or not an effective blocker");
    }
    if (!isValue(FINDING_ADJUDICATION_VALUES, item.disposition)) {
      fail("ERROR_INVALID_FINDING", "finding disposition is invalid");
    }
    seen.add(id);
    records.push({
      finding_id: id as FindingId,
      finding_snapshot: clone(currentById.get(id as FindingId) as BlockingFinding),
      source_review_version: state.review_result_version,
      disposition: item.disposition as FindingAdjudicationDisposition,
      reason: boundedString(item.reason, "reason", MAX_DETAIL),
      user_authorization: authorization,
      adjudicated_at: isoNow(),
      resulting_workflow_version: (state.version + 1) as WorkflowVersion,
    });
  }
  const next = clone<WorkflowState>(state);
  next.finding_adjudications.push(...records);
  if (effectiveBlockingFindings(next).length === 0) {
    next.phase = "REVIEWING";
    next.repair_authorized_ids = [];
    next.repair_directive = null;
  }
  return next;
}

export function authorizeRepair(
  state: WorkflowState,
  input: unknown,
  repositoryRoot = process.cwd(),
): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_REPAIR", "repair input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "expected_version", "finding_ids", "repair_directive"],
    "repair authorization",
  );
  ensurePhase(state, "REPAIR_REQUIRED");
  const ids = findingIdList(args.finding_ids, "finding_ids", "ERROR_INVALID_REPAIR");
  const effective = effectiveBlockingFindings(state);
  if (ids.length > effective.length) {
    fail("ERROR_INVALID_REPAIR", "finding IDs are invalid");
  }
  const existing = new Set(effective.map((item) => item.finding_id));
  if (ids.some((id) => !existing.has(id)))
    fail("ERROR_INVALID_REPAIR", "finding ID is not a blocker");
  if (state.review_result_version === null) {
    fail("ERROR_INVALID_REPAIR", "latest review result is missing");
  }
  const directive = repairDirective(args.repair_directive, repositoryRoot, state.approved_paths);
  if (state.repair_cycle >= state.max_repair_cycles) {
    fail("ERROR_REPAIR_LIMIT", "repair cycle limit reached");
  }
  const next = clone<WorkflowState>(state);
  next.repair_cycle += 1;
  next.repair_authorized_ids = [...ids].sort();
  next.repair_directive = directive;
  next.phase = "REPAIRING";
  return next;
}

export function resumeReview(state: WorkflowState, input: unknown): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "review resume input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "expected_version", "resume_context"],
    "review resume",
  );
  ensurePhase(state, "STOPPED_INCONCLUSIVE");
  if (pendingInspectionValidations(state).length > 0)
    fail("ERROR_INVALID_REVIEW", "required inspection evidence is pending");
  const next = clone<WorkflowState>(state);
  applyRecovery(next, "REVIEWING", "review", args.resume_context, "resume_context");
  return next;
}

export function finalizeRepairExhausted(state: WorkflowState, input: unknown): WorkflowState {
  exactKeys(input, ["workflow_id", "expected_version"], "repair exhaustion");
  ensurePhase(state, "REPAIR_REQUIRED");
  if (effectiveBlockingFindings(state).length === 0)
    fail("ERROR_INVALID_REPAIR", "no effective blockers remain");
  if (state.repair_cycle < state.max_repair_cycles)
    fail("ERROR_REPAIR_LIMIT", "repair cycles remain");
  const next = clone<WorkflowState>(state);
  next.phase = "STOPPED_REPAIR_EXHAUSTED";
  return next;
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

export function recordManualValidation(state: WorkflowState, input: unknown): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input))
    fail("ERROR_INVALID_SHAPE", "manual validation input is invalid");
  const args = exactKeys(
    input,
    ["workflow_id", "expected_version", "validation_id", "status", "evidence"],
    "manual validation",
  );
  ensurePhase(state, "REVIEWING", "STOPPED_CONCERNS", "STOPPED_INCONCLUSIVE");
  if (state.phase === "STOPPED_INCONCLUSIVE" && pendingInspectionValidations(state).length === 0) {
    fail("ERROR_INVALID_TRANSITION", "manual validation evidence is not required for recovery");
  }
  if (args.status !== "passed" && args.status !== "failed")
    fail("ERROR_INVALID_SHAPE", "manual validation status is invalid");
  const validationId = args.validation_id;
  const requirement = state.validation_requirements.find(
    (candidate) => candidate.validation_id === validationId,
  );
  if (!requirement) fail("ERROR_INVALID_SHAPE", "manual validation ID is unknown");
  if (requirement.kind !== "inspection")
    fail("ERROR_INVALID_SHAPE", "validation requirement is executable");
  const matching = state.validation_results.filter(
    (result) => result.validation_id === validationId,
  );
  if (matching.length > 1)
    fail("ERROR_INVALID_TRANSITION", "manual validation result is duplicated");
  const current = matching[0];
  if (current && current.status !== "not_run")
    fail("ERROR_INVALID_TRANSITION", "manual validation result is already terminal");
  const result: ValidationResult = {
    validation_id: validationId as ValidationResult["validation_id"],
    status: args.status,
    evidence: boundedString(args.evidence, "evidence", MAX_DETAIL),
  };
  const next = clone<WorkflowState>(state);
  const existingIndex = next.validation_results.findIndex(
    (item) => item.validation_id === validationId,
  );
  if (existingIndex >= 0) next.validation_results[existingIndex] = result;
  else {
    const requirementIndex = state.validation_requirements.findIndex(
      (item) => item.validation_id === validationId,
    );
    const insertAt = next.validation_results.findIndex((item) => {
      const index = state.validation_requirements.findIndex(
        (requirement) => requirement.validation_id === item.validation_id,
      );
      return index > requirementIndex;
    });
    if (insertAt < 0) next.validation_results.push(result);
    else next.validation_results.splice(insertAt, 0, result);
  }
  if (
    state.phase !== "STOPPED_INCONCLUSIVE" &&
    state.workflow_type === "change" &&
    hasFailedRequiredValidation(next)
  ) {
    next.phase = "REVIEWING";
    next.stop_context = null;
    next.concern_acceptance = null;
  }
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
