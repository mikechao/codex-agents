import { CURRENT_STATE_SCHEMA_VERSION } from "./migration.js";
import {
  changedReceiptPaths,
  dirtyBaselinePaths,
  rangeDirtyBaselinePaths,
  scopeChangedPaths,
} from "./transitions/receipts.js";

export {
  authorizeCommit,
  commitMismatch,
  commitPreparationFailed,
  MISMATCH_CATEGORIES,
  prepareCommit,
  retryCommit,
  retryCommitPreparation,
  returnCommitToReview,
  submitCommitResult,
  validateCommitResult,
} from "./transitions/commit.js";
export {
  acceptConcerns,
  adoptDirtyScope,
  expandScope,
  IMPLEMENTATION_STOP_PHASES,
  resumeImplementation,
  submitImplementation,
} from "./transitions/implementation.js";
export {
  adjudicateFindings,
  authorizeRepair,
  beginReview,
  finalizeRepairExhausted,
  recordManualValidation,
  resumeReview,
  submitReview,
} from "./transitions/review.js";
export { ensurePhase } from "./transitions/shared.js";

import type { WorkflowPhase } from "./types.js";
import { WORKFLOW_PHASE_VALUES } from "./values.js";

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
} from "./transitions/queries.js";
export { changedReceiptPaths, dirtyBaselinePaths, rangeDirtyBaselinePaths, scopeChangedPaths };

export const SCHEMA_VERSION = CURRENT_STATE_SCHEMA_VERSION;

export type { LinkedFollowupPlan } from "./transitions/linked-followup.js";
export {
  linkedFollowupChildState,
  linkedFollowupInput,
  linkedFollowupInputFromPlan,
} from "./transitions/linked-followup.js";
export { createState, createStateFromPlan } from "./transitions/state.js";

export const PHASES: readonly WorkflowPhase[] = WORKFLOW_PHASE_VALUES;
