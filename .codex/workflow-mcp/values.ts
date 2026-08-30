/** Runtime representatives for the finite Workflow MCP domains.
 *
 * Keep this module deliberately value-only. `types.ts` imports these tuples with
 * `import type`, so the domain declarations remain safe under verbatim module syntax.
 */
export const ROLE_VALUES = ["parent", "implementer", "reviewer", "committer"] as const;
export const WORKFLOW_PHASE_VALUES = [
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
export const WORKFLOW_TYPE_VALUES = ["change", "review_only"] as const;
export const REVIEW_MODE_VALUES = ["working_tree", "commit_range"] as const;
export const IMPLEMENTATION_STATUS_VALUES = [
  "DONE",
  "DONE_WITH_CONCERNS",
  "INCOMPLETE",
  "NEEDS_CONTEXT",
  "BLOCKED",
] as const;
export const REVIEW_STATUS_VALUES = ["APPROVED", "CHANGES_REQUESTED", "INCONCLUSIVE"] as const;
export const COMMIT_SUBMISSION_OUTCOME_VALUES = ["committed", "not_committed"] as const;
export const FINDING_SEVERITY_VALUES = ["P0", "P1", "P2", "P3"] as const;
export const FINDING_RESOLUTION_VALUES = ["resolved", "still_present", "superseded"] as const;
export const FINDING_ADJUDICATION_VALUES = [
  "CONTRACT_INCONSISTENT",
  "OUTSIDE_APPROVED_SCOPE",
] as const;
export const ACCEPTANCE_STATUS_VALUES = ["satisfied", "not_satisfied"] as const;
export const VALIDATION_STATUS_VALUES = ["passed", "failed", "not_run"] as const;
export const RANGE_PATH_KIND_VALUES = ["added", "modified", "deleted", "unchanged"] as const;
export const GIT_FILE_MODE_VALUES = ["100644", "100755", "120000"] as const;
export const RECEIPT_PATH_STATE_VALUES = [
  "added",
  "modified",
  "deleted",
  "unchanged",
  "absent",
] as const;
export const COMMIT_OUTCOME_VALUES = ["committed", "not_committed", "mismatch"] as const;
export const COMMIT_MISMATCH_CATEGORY_VALUES = [
  "HEAD_CHANGED",
  "PARENT_MISMATCH",
  "TREE_MISMATCH",
  "PATH_MISMATCH",
] as const;
export const WORKFLOW_ACTION_VALUES = [
  "workflow_create",
  "workflow_adopt_dirty_scope",
  "workflow_expand_scope",
  "workflow_parent_get",
  "workflow_implementer_get",
  "workflow_reviewer_get",
  "workflow_committer_get",
  "workflow_get_audit",
  "workflow_submit_implementation",
  "workflow_resume_implementation",
  "workflow_accept_concerns",
  "workflow_begin_review",
  "workflow_submit_review",
  "workflow_authorize_repair",
  "workflow_adjudicate_findings",
  "workflow_resume_review",
  "workflow_finalize_repair_exhausted",
  "workflow_create_linked_followup",
  "workflow_create_linked_followup_from_plan",
  "workflow_authorize_commit",
  "workflow_prepare_commit",
  "workflow_submit_commit_result",
  "workflow_reconcile_commit_result",
  "workflow_retry_commit_preparation",
  "workflow_return_commit_to_review",
  "workflow_retry_commit",
] as const;

export const FINDING_SEVERITIES = new Set(FINDING_SEVERITY_VALUES);
export const RESOLUTION_STATUS_SET = new Set(FINDING_RESOLUTION_VALUES);
export const ACCEPTANCE_STATUS_SET = new Set(ACCEPTANCE_STATUS_VALUES);
export const VALIDATION_STATUS_SET = new Set(VALIDATION_STATUS_VALUES);
export const ROLE_SET = new Set(ROLE_VALUES);
export const WORKFLOW_PHASE_SET = new Set(WORKFLOW_PHASE_VALUES);
export const GIT_FILE_MODE_SET = new Set(GIT_FILE_MODE_VALUES);
export const COMMIT_MISMATCH_CATEGORY_SET = new Set(COMMIT_MISMATCH_CATEGORY_VALUES);
export const COMMIT_SUBMISSION_OUTCOME_SET = new Set(COMMIT_SUBMISSION_OUTCOME_VALUES);

export function isValue<const T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}
