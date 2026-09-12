import { randomUUID } from "node:crypto";
import { fail } from "../errors.js";
import type {
  ChangeReceipt,
  StoppingImplementationStatus,
  WorkflowPhase,
  WorkflowState,
  WorkflowVersion,
} from "../types.js";
import {
  ACCEPTANCE_STATUSES,
  boundedString,
  canonicalJson,
  evidenceResults,
  exactKeys,
  exactPaths,
  isoNow,
  MAX_DETAIL,
  MAX_PATHS,
  resolutionMap,
  stringList,
  userAuthorization,
  VALIDATION_STATUSES,
} from "../validation.js";
import { IMPLEMENTATION_STATUS_VALUES, isValue } from "../values.js";
import {
  hasFailedRequiredValidation,
  implementationRecoveryStateReady,
  scopeMutationReadiness,
} from "./queries.js";
import { scopeChangedPaths } from "./receipts.js";
import {
  applyRecovery,
  clearFullCommitEvidence,
  clearStaleReviewEvidence,
  clone,
  ensurePhase,
} from "./shared.js";

export const IMPLEMENTATION_STOP_PHASES: Record<StoppingImplementationStatus, WorkflowPhase> = {
  DONE_WITH_CONCERNS: "STOPPED_CONCERNS",
  NEEDS_CONTEXT: "STOPPED_NEEDS_CONTEXT",
  BLOCKED: "STOPPED_IMPLEMENTATION_BLOCKED",
};

function scopeExpansion(
  state: WorkflowState,
  input: unknown,
  addedReceipt: ChangeReceipt,
  repositoryRoot: string,
): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "scope expansion input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "expected_version", "added_paths", "reason", "user_authorization"],
    "scope expansion",
  );
  ensurePhase(
    state,
    "IMPLEMENTING",
    "REPAIR_REQUIRED",
    "REPAIRING",
    "STOPPED_NEEDS_CONTEXT",
    "STOPPED_IMPLEMENTATION_BLOCKED",
  );
  const readiness = scopeMutationReadiness(state);
  if (readiness === "wrong_workflow") {
    fail(
      "ERROR_UNSUPPORTED_WORKFLOW_TYPE",
      "scope expansion requires a working-tree change workflow",
    );
  }
  if (readiness === "path_limit_reached") {
    fail("ERROR_INVALID_PATHS", "scope expansion exceeds the path limit");
  }
  const addedPaths = exactPaths(args.added_paths, repositoryRoot);
  if (addedPaths.some((path) => state.approved_paths.includes(path))) {
    fail("ERROR_INVALID_PATHS", "scope expansion path is already approved");
  }
  if (state.approved_paths.length + addedPaths.length > MAX_PATHS) {
    fail("ERROR_INVALID_PATHS", "scope expansion exceeds the path limit");
  }
  if (addedReceipt.base_head !== state.base_head) {
    fail("ERROR_STALE_RECEIPT", "scope expansion baseline is stale");
  }
  if (
    addedReceipt.approved_paths.length !== addedPaths.length ||
    addedReceipt.approved_paths.some((path, index) => path !== addedPaths[index])
  ) {
    fail("ERROR_INVALID_PATHS", "scope expansion baseline scope is invalid");
  }
  if (addedReceipt.paths.some((entry) => entry.state !== "unchanged" && entry.state !== "absent")) {
    fail(
      "ERROR_SCOPE_EXPANSION_DIRTY",
      "scope expansion paths must have clean or absent baselines",
    );
  }
  const priorVersion = state.version;
  const next = clone<WorkflowState>(state);
  const resultingPaths = [...state.approved_paths, ...addedPaths].sort();
  next.approved_paths = resultingPaths;
  const combinedPaths = next.linked_continuation?.combined_review_paths ?? resultingPaths;
  if (next.linked_continuation) {
    next.linked_continuation.combined_review_paths = [
      ...new Set([...combinedPaths, ...addedPaths]),
    ].sort();
  }
  next.review_target = {
    ...next.review_target,
    approved_paths:
      next.linked_continuation?.review_stage === "combined"
        ? next.linked_continuation.combined_review_paths
        : resultingPaths,
  };
  next.scope_expansions.push({
    expansion_id: randomUUID(),
    added_paths: addedPaths,
    reason: boundedString(args.reason, "reason", MAX_DETAIL),
    user_authorization: userAuthorization(args.user_authorization),
    prior_version: priorVersion,
    resulting_version: (priorVersion + 1) as WorkflowVersion,
    authorized_at: isoNow(),
  });
  next.approved_path_baselines.push(
    ...addedReceipt.paths.map((entry) => ({
      path: entry.path,
      approved_at_version: (priorVersion + 1) as WorkflowVersion,
      baseline: clone(entry),
    })),
  );
  clearStaleImplementationEvidence(next);
  clearStaleReviewEvidence(next);
  clearFullCommitEvidence(next);
  return next;
}

function clearStaleImplementationEvidence(state: WorkflowState): void {
  state.implementation_summary = null;
  state.implementation_status = null;
  state.implementation_known_failures = [];
  state.agent_touched_paths = [];
  state.scope_changed_paths = [];
  state.acceptance_results = [];
  state.validation_results = [];
  state.finding_resolution_map = {};
  state.implementation_receipt = null;
}

function samePathList(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return canonicalJson([...left].sort()) === canonicalJson([...right].sort());
}

export function submitImplementation(
  state: WorkflowState,
  input: unknown,
  repositoryRoot: string,
  freshReceipt: ChangeReceipt,
): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "implementation input is invalid");
  }
  const args = exactKeys(
    input,
    [
      "workflow_id",
      "expected_version",
      "status",
      "summary",
      "agent_touched_paths",
      "acceptance_results",
      "validation_results",
      "known_failures",
      "finding_resolution_map",
    ],
    "implementation submission",
  );
  ensurePhase(state, "IMPLEMENTING", "REPAIRING");
  if (!isValue(IMPLEMENTATION_STATUS_VALUES, args.status)) {
    fail("ERROR_INVALID_IMPLEMENTATION", "implementation status is invalid");
  }
  const touchedPaths = exactPaths(args.agent_touched_paths, repositoryRoot, true);
  const approved = new Set(state.approved_paths);
  if (touchedPaths.some((path) => !approved.has(path))) {
    fail("ERROR_INVALID_IMPLEMENTATION", "touched path is not in approved scope");
  }
  const acceptanceResults = evidenceResults(
    args.acceptance_results,
    "acceptance",
    state.acceptance_criteria,
    "criterion_id",
    ACCEPTANCE_STATUSES,
  );
  const validationResults = evidenceResults(
    args.validation_results,
    "validation",
    state.validation_requirements,
    "validation_id",
    VALIDATION_STATUSES,
  );
  if (
    validationResults.some(
      (result) =>
        state.validation_requirements.find(
          (requirement) => requirement.validation_id === result.validation_id,
        )?.kind === "inspection" && result.status !== "not_run",
    )
  ) {
    fail("ERROR_INVALID_IMPLEMENTATION", "implementers cannot submit terminal inspection evidence");
  }
  const knownFailures = stringList(args.known_failures, "known_failures");
  const priorIds = (
    state.phase === "REPAIRING"
      ? [
          ...(state.linked_continuation?.review_stage === "remediation"
            ? state.linked_findings.map((finding) => finding.finding_id)
            : []),
          ...state.repair_authorized_ids,
        ]
      : state.linked_continuation?.review_stage === "remediation"
        ? state.linked_findings.map((finding) => finding.finding_id)
        : []
  ).filter((id, index, ids) => ids.indexOf(id) === index);
  const resolution = resolutionMap(args.finding_resolution_map, priorIds, "finding_resolution_map");
  if (
    state.phase === "IMPLEMENTING" &&
    state.linked_findings.length === 0 &&
    Object.keys(resolution).length > 0
  ) {
    fail("ERROR_INVALID_FINDING", "initial implementation has prior resolutions");
  }
  const next = clone<WorkflowState>(state);
  next.implementation_summary = boundedString(args.summary, "summary", 4000);
  next.implementation_status = args.status;
  next.agent_touched_paths = touchedPaths;
  next.acceptance_results = acceptanceResults;
  next.validation_results = validationResults;
  // The store verified canonical equality with the fresh receipt first.
  next.implementation_receipt = clone(freshReceipt);
  next.implementation_known_failures = knownFailures;
  next.finding_resolution_map = resolution;
  next.scope_changed_paths = scopeChangedPaths(
    state.initial_receipt,
    state.approved_path_baselines,
    next.implementation_receipt,
  );
  if (args.status === "DONE" || args.status === "DONE_WITH_CONCERNS") {
    if (acceptanceResults.some((item) => item.status !== "satisfied")) {
      fail("ERROR_INVALID_IMPLEMENTATION", "complete implementation requires satisfied criteria");
    }
  }
  if (args.status === "DONE") {
    if (
      validationResults.some(
        (item) =>
          state.validation_requirements.find(
            (requirement) => requirement.validation_id === item.validation_id,
          )?.kind === "command" && item.status !== "passed",
      )
    ) {
      fail(
        "ERROR_INVALID_IMPLEMENTATION",
        "done implementation requires passed executable validations",
      );
    }
    if (knownFailures.length > 0) {
      fail("ERROR_INVALID_IMPLEMENTATION", "done implementation has known failures");
    }
    next.phase = "REVIEWING";
  }
  if (
    args.status === "DONE_WITH_CONCERNS" &&
    state.workflow_type === "change" &&
    hasFailedRequiredValidation(next)
  ) {
    next.phase = "REVIEWING";
    next.stop_context = null;
    next.concern_acceptance = null;
  }
  if (
    args.status !== "DONE" &&
    args.status !== "INCOMPLETE" &&
    !(args.status === "DONE_WITH_CONCERNS" && hasFailedRequiredValidation(next))
  ) {
    next.stop_context = {
      status: args.status,
      summary: boundedString(args.summary, "summary", 4000),
      stopped_from: state.phase,
    };
    if (state.phase === "IMPLEMENTING") next.repair_authorized_ids = [];
  }
  if (
    args.status !== "DONE" &&
    args.status !== "INCOMPLETE" &&
    !(args.status === "DONE_WITH_CONCERNS" && hasFailedRequiredValidation(next))
  ) {
    next.phase = IMPLEMENTATION_STOP_PHASES[args.status];
  }
  return next;
}

export function expandScope(
  state: WorkflowState,
  input: unknown,
  addedReceipt: ChangeReceipt,
  repositoryRoot: string,
): WorkflowState {
  return scopeExpansion(state, input, addedReceipt, repositoryRoot);
}

export function adoptDirtyScope(
  state: WorkflowState,
  input: unknown,
  addedReceipt: ChangeReceipt,
  repositoryRoot: string,
  indexDirtyPaths: ReadonlyArray<string> = [],
): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "dirty scope adoption input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "expected_version", "reason", "user_authorization"],
    "dirty scope adoption",
    ["added_paths", "adopted_paths"],
  );
  ensurePhase(state, "STOPPED_INCONCLUSIVE");
  if (state.workflow_type !== "change" || state.review_target.review_mode !== "working_tree") {
    fail("ERROR_UNSUPPORTED_WORKFLOW_TYPE", "dirty scope adoption requires a working-tree review");
  }
  if ((args.added_paths === undefined) === (args.adopted_paths === undefined)) {
    fail("ERROR_INVALID_SHAPE", "dirty scope adoption paths are invalid");
  }
  const adoptedPaths = exactPaths(args.adopted_paths ?? args.added_paths, repositoryRoot);
  const expansion = state.scope_expansions.find((candidate) =>
    samePathList(candidate.added_paths, adoptedPaths),
  );
  if (!expansion) {
    fail("ERROR_INVALID_PATHS", "dirty scope adoption paths are not from a scope expansion");
  }
  if (addedReceipt.base_head !== state.base_head) {
    fail("ERROR_STALE_RECEIPT", "dirty scope adoption baseline is stale");
  }
  if (
    addedReceipt.approved_paths.length !== adoptedPaths.length ||
    addedReceipt.approved_paths.some((path, index) => path !== adoptedPaths[index])
  ) {
    fail("ERROR_INVALID_PATHS", "dirty scope adoption scope is invalid");
  }
  const indexDirty = new Set(indexDirtyPaths);
  if (
    addedReceipt.paths.some(
      (entry) =>
        !["added", "modified", "deleted"].includes(entry.state) && !indexDirty.has(entry.path),
    )
  ) {
    fail("ERROR_SCOPE_EXPANSION_DIRTY", "scope adoption paths must be dirty");
  }
  const next = clone<WorkflowState>(state);
  // Adoption changes only the authorization/audit version. The existing expansion remains the
  // immutable provenance for the paths and its historical baseline.
  next.review_start_receipt = null;
  next.review_receipt = null;
  return next;
}

export function resumeImplementation(state: WorkflowState, input: unknown): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "resume input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "expected_version", "resume_context"],
    "implementation resume",
  );
  ensurePhase(state, "STOPPED_NEEDS_CONTEXT", "STOPPED_IMPLEMENTATION_BLOCKED");
  if (!implementationRecoveryStateReady(state)) {
    fail("ERROR_STATE_CORRUPT", "stop context is invalid");
  }
  const stoppedFrom = state.stop_context?.stopped_from as "IMPLEMENTING" | "REPAIRING";
  const next = clone<WorkflowState>(state);
  applyRecovery(next, stoppedFrom, "implementation", args.resume_context, "resume_context");
  return next;
}

export function acceptConcerns(state: WorkflowState, input: unknown): WorkflowState {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail("ERROR_INVALID_SHAPE", "concern acceptance input is invalid");
  }
  const args = exactKeys(
    input,
    ["workflow_id", "expected_version", "user_authorization"],
    "concern acceptance",
  );
  ensurePhase(state, "STOPPED_CONCERNS");
  const next = clone<WorkflowState>(state);
  next.concern_acceptance = {
    user_authorization: userAuthorization(args.user_authorization),
    accepted_at: isoNow(),
  };
  next.phase = "REVIEWING";
  next.stop_context = null;
  return next;
}
