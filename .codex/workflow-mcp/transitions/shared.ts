import { fail } from "../errors.js";
import type {
  RecoveryContext,
  WorkflowEvidenceState,
  WorkflowPhase,
  WorkflowState,
} from "../types.js";
import { boundedString, isoNow } from "../validation.js";

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function ensurePhase<const P extends WorkflowPhase>(
  state: WorkflowState,
  ...allowed: readonly P[]
): asserts state is WorkflowState & { phase: P } {
  if (!(allowed as readonly WorkflowPhase[]).includes(state.phase))
    fail("ERROR_INVALID_TRANSITION", `phase ${state.phase}`);
}

export function applyRecovery(
  state: WorkflowState,
  phase: WorkflowPhase,
  kind: RecoveryContext["kind"],
  context: unknown,
  contextLabel: string,
): void {
  state.phase = phase;
  state.stop_context = null;
  state.recovery_context = {
    kind,
    context: boundedString(context, contextLabel, 2000),
    recovered_at: isoNow(),
  };
}

export function invalidateImplementationSubmissionEvidence(
  state: WorkflowEvidenceState<"implementation_submission">,
): void {
  Object.assign(state, {
    implementation_summary: null,
    implementation_status: null,
    implementation_known_failures: [],
    agent_touched_paths: [],
    scope_changed_paths: [],
    acceptance_results: [],
    validation_results: [],
    finding_resolution_map: {},
    implementation_receipt: null,
  } satisfies WorkflowEvidenceState<"implementation_submission">);
}

export function invalidateReviewReceipts(state: WorkflowEvidenceState<"review_receipts">): void {
  Object.assign(state, {
    review_start_receipt: null,
    review_receipt: null,
  } satisfies WorkflowEvidenceState<"review_receipts">);
}

export function invalidateRepairAuthorization(
  state: WorkflowEvidenceState<"repair_authority">,
): void {
  Object.assign(state, {
    repair_authorized_ids: [],
    repair_directive: null,
  } satisfies WorkflowEvidenceState<"repair_authority">);
}

function invalidateCurrentReviewResult(
  state: WorkflowEvidenceState<"current_review_result">,
): void {
  Object.assign(state, {
    blocking_findings: [],
    optional_findings: [],
    prior_finding_classifications: {},
    review_result_version: null,
  } satisfies WorkflowEvidenceState<"current_review_result">);
}

export function invalidateCurrentReviewResultAndRepairAuthority(
  state: WorkflowEvidenceState<"current_review_result"> & WorkflowEvidenceState<"repair_authority">,
): void {
  invalidateCurrentReviewResult(state);
  invalidateRepairAuthorization(state);
}

export function invalidateFullCommitAuthorityAndEvidence(
  state: WorkflowEvidenceState<"commit_authorization"> &
    WorkflowEvidenceState<"commit_attempt_evidence">,
): void {
  Object.assign(state, {
    commit_authorization: null,
  } satisfies WorkflowEvidenceState<"commit_authorization">);
  Object.assign(state, {
    commit_preparation: null,
    commit_result: null,
  } satisfies WorkflowEvidenceState<"commit_attempt_evidence">);
}

export function invalidateLinkedReviewProgress(
  state: WorkflowEvidenceState<"linked_continuation">,
): void {
  if (!state.linked_continuation) return;
  state.linked_continuation.remediation_review_receipt = null;
  state.linked_continuation.review_stage = "remediation";
}
