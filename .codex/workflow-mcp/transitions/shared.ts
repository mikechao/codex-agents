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

export function clearStaleReviewEvidence(state: WorkflowState): void {
  state.review_start_receipt = null;
  state.review_receipt = null;
}

export function clearFullCommitEvidence(state: WorkflowState): void {
  state.commit_authorization = null;
  state.commit_preparation = null;
  state.commit_result = null;
}
