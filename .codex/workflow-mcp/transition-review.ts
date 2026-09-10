import { fail, WorkflowError } from "./errors.js";
import {
  allRequiredValidationsPassed,
  effectiveBlockingFindings,
  hasFailedRequiredValidation,
  pendingInspectionValidations,
  reviewBlockedByPendingInspection,
} from "./transition-queries.js";
import { applyRecovery, clone, ensurePhase } from "./transition-shared.js";
import type {
  BlockingFinding,
  ChangeReceipt,
  FindingAdjudication,
  FindingAdjudicationDisposition,
  FindingId,
  FindingSeverity,
  ValidationRequirement,
  ValidationResult,
  WorkflowState,
  WorkflowVersion,
} from "./types.js";
import {
  boundedString,
  canonicalJson,
  evidenceResults,
  exactKeys,
  findingIdList,
  findings,
  isoNow,
  MAX_DETAIL,
  repairConformance,
  repairDirective,
  resolutionMap,
  userAuthorization,
  VALIDATION_STATUSES,
} from "./validation.js";
import { FINDING_ADJUDICATION_VALUES, isValue, REVIEW_STATUS_VALUES } from "./values.js";

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
