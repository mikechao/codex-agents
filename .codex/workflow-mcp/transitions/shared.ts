import { fail } from "../errors.js";
import type { RecoveryContext, WorkflowPhase, WorkflowState } from "../types.js";
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

export function invalidateImplementationSubmissionEvidence(state: WorkflowState): void {
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

export function invalidateReviewReceipts(state: WorkflowState): void {
  state.review_start_receipt = null;
  state.review_receipt = null;
}

export function invalidateRepairAuthorization(state: WorkflowState): void {
  state.repair_authorized_ids = [];
  state.repair_directive = null;
}

export function invalidateCurrentReviewResultAndRepairAuthority(state: WorkflowState): void {
  state.blocking_findings = [];
  state.optional_findings = [];
  state.prior_finding_classifications = {};
  state.review_result_version = null;
  invalidateRepairAuthorization(state);
}

export function invalidateFullCommitAuthorityAndEvidence(state: WorkflowState): void {
  state.commit_authorization = null;
  state.commit_preparation = null;
  state.commit_result = null;
}

export function invalidateLinkedReviewProgress(state: WorkflowState): void {
  if (!state.linked_continuation) return;
  state.linked_continuation.remediation_review_receipt = null;
  state.linked_continuation.review_stage = "remediation";
}
