import { randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import { allRequiredValidationsPassed } from "./transition-queries.js";
import {
  applyRecovery,
  clearFullCommitEvidence,
  clearStaleReviewEvidence,
  clone,
  ensurePhase,
} from "./transition-shared.js";
import type {
  CommitAttemptId,
  CommitMismatchCategory,
  CommitPreparationEvidence,
  CommitPreparationFailureCategory,
  GitCommitSha,
  WorkflowState,
  WorkflowVersion,
} from "./types.js";
import { boundedString, exactKeys, isoNow, objectDigest, userAuthorization } from "./validation.js";
import {
  COMMIT_MISMATCH_CATEGORY_SET,
  COMMIT_SUBMISSION_OUTCOME_VALUES,
  isValue,
} from "./values.js";

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
