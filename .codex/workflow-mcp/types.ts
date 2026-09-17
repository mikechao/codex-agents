// Domain types for the workflow-state MCP server. This module is type-only. Runtime finite-domain
// values live in values.ts and are imported only as types here.
import type {
  ACCEPTANCE_STATUS_VALUES,
  COMMIT_MISMATCH_CATEGORY_VALUES,
  COMMIT_OUTCOME_VALUES,
  COMMIT_SUBMISSION_OUTCOME_VALUES,
  FINDING_ADJUDICATION_VALUES,
  FINDING_RESOLUTION_VALUES,
  FINDING_SEVERITY_VALUES,
  GIT_FILE_MODE_VALUES,
  IMPLEMENTATION_STATUS_VALUES,
  RANGE_PATH_KIND_VALUES,
  RECEIPT_PATH_STATE_VALUES,
  REVIEW_STATUS_VALUES,
  ROLE_VALUES,
  VALIDATION_KIND_VALUES,
  VALIDATION_STATUS_VALUES,
  WORKFLOW_PHASE_VALUES,
  WORKFLOW_TYPE_VALUES,
} from "./values.js";
import type {
  OperatorAuthorizationMetadata,
  OperatorExpectedNext,
  OperatorInputAlternative,
  OperatorParentMutationOperation,
  OperatorRecovery,
  OperatorRequiredInput,
  OperatorWorkerDispatchOperation,
  WorkflowAction,
} from "./workflow-action-registry.js";

export type {
  OperatorActionDescriptorMetadata,
  OperatorAuthorizationBinding,
  OperatorAuthorizationMetadata,
  OperatorExpectedNext,
  OperatorInputAlternative,
  OperatorInputSource,
  OperatorParentMutationOperation,
  OperatorRecovery,
  OperatorRequiredInput,
  OperatorWorkerDispatchOperation,
  WorkflowAction,
  WorkflowActionClassification,
  WorkflowNonProjectableOperation,
  WorkflowQueryOperation,
} from "./workflow-action-registry.js";

type TupleValue<T extends readonly string[]> = T[number];

// ---------------------------------------------------------------------------
// 1. Brand helper
// ---------------------------------------------------------------------------

declare const __brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [__brand]: B };

// ---------------------------------------------------------------------------
// 2. Identity / value types (selective branding)
// ---------------------------------------------------------------------------

export type WorkflowId = Brand<string, "WorkflowId">;
export type WorkflowVersion = Brand<number, "WorkflowVersion">;
export type RuntimeId = Brand<string, "RuntimeId">;
export type GitCommitSha = Brand<string, "GitCommitSha">;
export type GitTreeSha = Brand<string, "GitTreeSha">;
export type GitBlobSha = Brand<string, "GitBlobSha">;
export type ExactRepoPath = Brand<string, "ExactRepoPath">;
export type FindingId = Brand<string, "FindingId">;
export type StateDigest = Brand<string, "StateDigest">;
export type ContentDigest = Brand<string, "ContentDigest">;
export type IsoTimestamp = Brand<string, "IsoTimestamp">;
export type CommitAttemptId = Brand<string, "CommitAttemptId">;
export type PlanId = Brand<string, "PlanId">;
export type PlanRevision = Brand<number, "PlanRevision">;
export type AcceptanceCriterionId = Brand<string, "AcceptanceCriterionId">;
export type ValidationRequirementId = Brand<string, "ValidationRequirementId">;

export interface WorkItemReference {
  provider: string;
  id: string;
  display_ref: string;
  url: string | null;
}

// ---------------------------------------------------------------------------
// 3. Core unions
// ---------------------------------------------------------------------------

export type Role = TupleValue<typeof ROLE_VALUES>;

export type WorkflowPhase = TupleValue<typeof WORKFLOW_PHASE_VALUES>;

export type WorkflowType = TupleValue<typeof WORKFLOW_TYPE_VALUES>;
export type ImplementationStatus = TupleValue<typeof IMPLEMENTATION_STATUS_VALUES>;
export type StoppingImplementationStatus = Exclude<ImplementationStatus, "DONE" | "INCOMPLETE">;
export type ReviewStatus = TupleValue<typeof REVIEW_STATUS_VALUES>;
export type RepairConformanceStatus = "conforming" | "nonconforming";
export type FindingSeverity = TupleValue<typeof FINDING_SEVERITY_VALUES>;
export type FindingResolution = TupleValue<typeof FINDING_RESOLUTION_VALUES>;
export type FindingAdjudicationDisposition = TupleValue<typeof FINDING_ADJUDICATION_VALUES>;
export type AcceptanceStatus = TupleValue<typeof ACCEPTANCE_STATUS_VALUES>;
export type ValidationStatus = TupleValue<typeof VALIDATION_STATUS_VALUES>;
export type ValidationKind = TupleValue<typeof VALIDATION_KIND_VALUES>;
export type RangePathKind = TupleValue<typeof RANGE_PATH_KIND_VALUES>;
export type GitFileMode = TupleValue<typeof GIT_FILE_MODE_VALUES>;
export type CommitOutcome = TupleValue<typeof COMMIT_OUTCOME_VALUES>;
export type CommitSubmissionOutcome = TupleValue<typeof COMMIT_SUBMISSION_OUTCOME_VALUES>;
export type CommitMismatchCategory = TupleValue<typeof COMMIT_MISMATCH_CATEGORY_VALUES>;

// Normalized, read-only worktree data. These types deliberately do not expose the
// dependency used by the Git adapter (or Git's porcelain result objects).
export interface WorktreeEntry {
  path: string;
  head: GitCommitSha | null;
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  prunable: boolean;
}

export type NormalizedWorktree = WorktreeEntry;

export interface WorktreeLookup {
  found: boolean;
  worktree: WorktreeEntry | null;
}

export type WorktreeQueryResult = WorktreeLookup;

export type WorktreeValidationCategory =
  | "invalid_path"
  | "invalid_name"
  | "invalid_branch"
  | "branch_unavailable"
  | "invalid_ref"
  | "path_unavailable"
  | "main_worktree"
  | "current_worktree"
  | "ambiguous_path";

export interface WorktreeValidationIssue {
  category: WorktreeValidationCategory;
  field: string;
  detail: string;
}

export interface WorktreeValidationResult {
  valid: boolean;
  issues: WorktreeValidationIssue[];
}

export interface WorktreePlan {
  path: string;
  directory_name: string;
  branch: string;
  start_ref: string;
  create_branch: boolean;
}

export type WorktreePlanResult = WorktreePlan;

// Read-only semantic projection used by the parent orchestrator. Semantic fields intentionally
// contain no workflow or PlanArtifact identity, capabilities, receipts, audit data, or raw phase
// names; the versioned execution guidance carries only fixed invocation metadata and exact typed
// operation names. The persisted WorkflowState remains the sole authority.
export type OperatorRoute = "implement" | "review" | "re_review" | "commit";

export type OperatorBindingReference =
  | { kind: "finding"; finding_ids: FindingId[] }
  | {
      kind: "repair_selection";
      eligible_finding_ids: FindingId[];
      selected_finding_ids: FindingId[];
      proposal: OperatorRepairProposal;
    }
  | { kind: "validation"; validation_ids: ValidationRequirementId[] }
  | { kind: "plan"; plan_id: PlanId; revision: PlanRevision }
  | { kind: "scope"; paths: ExactRepoPath[] }
  | { kind: "commit_attempt"; attempt_id: CommitAttemptId }
  | { kind: "review_result"; version: WorkflowVersion }
  | { kind: "repair_cycle"; cycle: number; maximum: number };

export interface OperatorStaleBinding {
  workflow_id: WorkflowId;
  expected_version: WorkflowVersion;
  references: OperatorBindingReference[];
}

export interface OperatorMutationInvocation {
  operation: OperatorParentMutationOperation;
  semantic_choice: {
    id: string;
    label: string;
    summary: string;
  };
  fixed_arguments: Record<string, string | number | null>;
  required_inputs: OperatorRequiredInput[];
  input_alternatives?: OperatorInputAlternative[];
  authorization: OperatorAuthorizationMetadata;
  stale_binding: OperatorStaleBinding;
  repair_binding?: OperatorRepairBinding;
  adjudication_binding?: OperatorAdjudicationBinding;
  linked_followup_binding?: OperatorLinkedFollowupBinding;
  scope_reconciliation_binding?: OperatorScopeReconciliationBinding;
  plan_binding?: OperatorPlanBinding;
  on_success: {
    kind: "refresh_required";
    expected: OperatorExpectedNext[];
    dispatch_authority: false;
    committed_result?: {
      response_path: ["committed_execution"];
      dispatch_authority: false;
    };
  };
}

export interface OperatorParentMutationDescriptor {
  mode: "parent_mutation";
  selection: "single" | "choose_one";
  invocations: OperatorMutationInvocation[];
}

export interface OperatorRepairBinding {
  eligible_finding_ids: FindingId[];
  selected_finding_ids: FindingId[];
  proposal: OperatorRepairProposal;
}

export interface OperatorScopeReconciliationBinding {
  reviewed_paths: ExactRepoPath[];
  added_paths: ExactRepoPath[];
}

export interface OperatorAdjudicationBinding {
  finding_ids: FindingId[];
  user_input_paths: string[][];
}

export interface OperatorLinkedFollowupFinding {
  finding_id: FindingId;
  severity: FindingSeverity;
  summary: string;
}

export interface OperatorLinkedFollowupBinding {
  /** Select a non-empty subset from exactly one of these authoritative buckets. */
  selection_rule: "nonempty_subset_from_one_bucket";
  blocking_findings: OperatorLinkedFollowupFinding[];
  optional_findings: OperatorLinkedFollowupFinding[];
}

export interface OperatorPlanBinding {
  plan_id: PlanId;
  revision: PlanRevision;
  source: "approved_child_plan_context" | "approved_recovery_plan_context";
}

export interface OperatorRepairAuthorizationDescriptor extends OperatorParentMutationDescriptor {
  specialization: "repair_authorization";
  repair_binding: OperatorRepairBinding;
}

export interface OperatorWaitDescriptor {
  mode: "wait";
  reason: string;
}

export interface OperatorInspectionCollection {
  validation_id: ValidationRequirementId;
  outcomes: {
    observed: {
      passed: OperatorParentMutationDescriptor;
      failed: OperatorParentMutationDescriptor;
    };
    unavailable: OperatorWaitDescriptor;
  };
}

export interface OperatorCollectEvidenceDescriptor {
  mode: "collect_evidence";
  validation_id: ValidationRequirementId;
  outcomes: OperatorInspectionCollection["outcomes"];
  specialization: "recovery_inspection";
}

export type OperatorNextActionDescriptor =
  | {
      mode: "dispatch";
      route: OperatorRoute;
      operation: OperatorWorkerDispatchOperation;
      workflow_id: WorkflowId;
      expected_version: WorkflowVersion;
    }
  | OperatorParentMutationDescriptor
  | OperatorRepairAuthorizationDescriptor
  | OperatorCollectEvidenceDescriptor
  | OperatorWaitDescriptor
  | {
      mode: "terminal";
      outcome: "committed" | "approved_no_commit_required" | "commit_mismatch";
    };

export type OperatorParentActionDescriptor =
  | {
      action: WorkflowAction;
      status: "executable";
      descriptor: Extract<OperatorNextActionDescriptor, { mode: "parent_mutation" }>;
    }
  | {
      action: "workflow_record_manual_validation";
      status: "evidence_required";
      descriptor: OperatorCollectEvidenceDescriptor;
    };

export interface OperatorExecutionDescriptor {
  descriptor_version: 5;
  primary: OperatorNextActionDescriptor;
  parent_actions: OperatorParentActionDescriptor[];
}

export interface OperatorBlocker {
  severity: FindingSeverity;
  summary: string;
}

export interface OperatorRepairProposal {
  required_outcome: string;
  strategy_constraints: string;
  fallbacks: Array<{ strategy: string; condition: string }>;
  required_paths: string[];
  forbidden_paths: string[];
}

export type ParentMutationResult = ParentView & {
  committed_execution: OperatorExecutionDescriptor;
};

export type OperatorFinding = OperatorBlocker;

export interface OperatorRecoverySummary {
  choice: OperatorRecovery | null;
  stop_reason: string | null;
  recovery_context: string | null;
}

export type OperatorPrimaryDecision =
  | { kind: "no_user_action"; route: OperatorRoute }
  | { kind: "reconcile_commit"; reason: string }
  | {
      kind: "terminal";
      outcome: "committed" | "approved_no_commit_required" | "commit_mismatch";
      reason: string;
    }
  | {
      kind: "inspection_required";
      validations: Array<{ validation_id: ValidationRequirementId; description: string }>;
    }
  | {
      kind: "approve_exact_repairs";
      blocker_count: number;
      blockers: OperatorBlocker[];
      proposal: OperatorRepairProposal;
      authorization_required: true;
    }
  | { kind: "finalize_repair_exhausted"; reason: string }
  | { kind: "approve_bounded_continuation"; reason: string; authorization_required: true }
  | { kind: "approve_recovery"; recovery: OperatorRecovery; authorization_required: true }
  | {
      kind: "choose_recovery";
      recoveries: OperatorRecovery[];
      authorization_required: true;
    }
  | { kind: "approve_commit"; authorization_required: true }
  | { kind: "operator_intervention"; reason: string };

export type OperatorAuthorityAvailability =
  | "available"
  | "already_satisfied"
  | "requires_new_user_intent"
  | "requires_logical_change_topology"
  | "unavailable";

export interface OperatorAuthorityBoundary {
  availability: OperatorAuthorityAvailability;
  basis: string;
}

export interface OperatorDecision {
  primary: OperatorPrimaryDecision;
  execution: OperatorExecutionDescriptor;
  optional_findings: OperatorFinding[];
  recovery_summary: OperatorRecoverySummary;
  authority_boundaries: {
    approve_scope_change: OperatorAuthorityBoundary;
    approve_final_reconciliation: OperatorAuthorityBoundary;
  };
  intent: {
    objective: string;
    scope_kind: "direct" | "approved_plan";
    path_count: number;
    display_references: string[];
  };
  outcome: {
    status:
      | "in_progress"
      | "awaiting_review"
      | "repair_needed"
      | "recovery_needed"
      | "approved"
      | "committing"
      | "completed"
      | "failed"
      | "superseded"
      | "exhausted";
    blocker_count: number;
  };
  related_workflows: Array<{
    status: OperatorDecision["outcome"]["status"];
    relation: "ancestor" | "successor" | "lineage";
  }>;
  reconciliation: {
    status: "not_applicable" | "remediation_then_combined_review" | "combined_review_required";
    basis: string;
  };
  commit: {
    eligible: boolean;
    authorization: "required" | "satisfied" | "unavailable";
  };
}

export interface PlanRevisionArtifact {
  plan_schema_version: 3;
  plan_id: PlanId;
  revision: PlanRevision;
  workflow_type: WorkflowType;
  full_plan: string;
  execution_brief: string;
  objective: string;
  approved_paths: ExactRepoPath[];
  acceptance_criteria: AcceptanceCriterion[];
  validation_requirements: ValidationRequirement[];
  created_at: IsoTimestamp;
}

/** Plan-authored implementation content, excluding immutable revision envelope metadata. */
export type PlanRevisionContent = Omit<
  PlanRevisionArtifact,
  "plan_schema_version" | "plan_id" | "revision" | "created_at"
>;

/**
 * Exact approved PlanArtifact authority before workflow-local scope and lifecycle overlays.
 * `artifact_approved_paths` is deliberately distinct from a workflow's effective approved scope.
 */
export type AuthoritativeImplementationContract = Omit<
  PlanRevisionContent,
  "full_plan" | "approved_paths"
> & {
  approved_plan: PlanRevisionContent["full_plan"];
  artifact_approved_paths: PlanRevisionContent["approved_paths"];
  plan_provenance: PlanProvenance;
};

/** Contract fields that remain directly recoverable after effective workflow scope expands. */
export type AuthoritativeImplementationAuthority = Omit<
  AuthoritativeImplementationContract,
  "artifact_approved_paths"
>;

/** Persisted non-scope authority projection, including the separate nullable direct-workflow path. */
export type PersistedImplementationAuthority = Pick<
  WorkflowState,
  | "workflow_type"
  | "objective"
  | "approved_plan"
  | "execution_brief"
  | "plan_provenance"
  | "acceptance_criteria"
  | "validation_requirements"
>;

/** Caller-selected fields for a bounded copy-forward plan revision. */
export interface PlanRevisionReplacements {
  workflow_type?: WorkflowType;
  full_plan?: string;
  execution_brief?: string;
  objective?: string;
  approved_paths?: string[];
  acceptance_criteria?: string[];
  validation_requirements?: ValidationAuthoringRequirement[];
}

/** Complete authoring content accepted by plan_create and plan_revise replacements. */
export type PlanAuthoringContent = Required<PlanRevisionReplacements>;

export interface PlanApproval {
  plan_id: PlanId;
  revision: PlanRevision;
  artifact_digest: ContentDigest;
  user_authorization: string;
  approved_at: IsoTimestamp;
}

export interface PlanReadMetadata {
  current_revision: PlanRevision;
  status: "draft" | "approved";
  is_current: boolean;
  approval: PlanApproval | null;
}

export type PlanRead = PlanRevisionArtifact & {
  plan_ref: string;
  artifact_digest: ContentDigest;
  metadata: PlanReadMetadata;
};

export interface PlannerPlanReadMetadata {
  current_revision: PlanRevision;
  status: "draft" | "approved";
  is_current: boolean;
}

/** Planner-facing projection; persisted contract IDs and parent approval evidence stay hidden. */
export type PlannerPlanRead = PlanAuthoringContent & {
  plan_id: PlanId;
  plan_ref: string;
  revision: PlanRevision;
  artifact_digest: ContentDigest;
  created_at: IsoTimestamp;
  metadata: PlannerPlanReadMetadata;
};

export interface PlanProvenance {
  plan_id: PlanId;
  revision: PlanRevision;
  artifact_digest: ContentDigest;
  approved_at: IsoTimestamp;
}

// Every `ERROR_*` literal used by `fail(...)` in the server plus the child change-receipt CLI
// categories that `git.createReceipt` can re-throw (`/^ERROR_[A-Z_]+$/` from child stderr). The
// union forces completeness: any `fail(...)` literal not enumerated here is a compile error.
export type ErrorCategory =
  | "ERROR_INTERNAL"
  | "ERROR_UNKNOWN_TOOL"
  | "ERROR_INJECTED_FAILURE"
  | "ERROR_INVALID_SHAPE"
  | "ERROR_INVALID_PATHS"
  | "ERROR_INVALID_ROLE"
  | "ERROR_INVALID_VERSION"
  | "ERROR_INVALID_FINDING"
  | "ERROR_INVALID_IMPLEMENTATION"
  | "ERROR_STATE_CORRUPT"
  | "ERROR_MIGRATION_REQUIRED"
  | "ERROR_NOT_FOUND"
  | "ERROR_STORE_CLOSED"
  | "ERROR_VERSION_CONFLICT"
  | "ERROR_STALE_BASE"
  | "ERROR_STALE_RECEIPT"
  | "ERROR_INVALID_REVIEW"
  | "ERROR_COMMIT_NOT_ALLOWED"
  | "ERROR_INVALID_TRANSITION"
  | "ERROR_UNSUPPORTED_WORKFLOW_TYPE"
  | "ERROR_INVALID_REPAIR"
  | "ERROR_REPAIR_LIMIT"
  | "ERROR_INVALID_FOLLOWUP"
  | "ERROR_COMMIT_MISMATCH"
  | "ERROR_GIT"
  | "ERROR_NO_HEAD"
  | "ERROR_INVALID_REVISION"
  | "ERROR_NON_ANCESTOR"
  | "ERROR_INVALID_REVIEW_PATH"
  | "ERROR_UNSUPPORTED_MODE"
  | "ERROR_RECEIPT_UNAVAILABLE"
  | "ERROR_EMPTY_PATH"
  | "ERROR_UNSAFE_PATH"
  | "ERROR_DUPLICATE_PATH"
  | "ERROR_EMPTY_PATHS"
  | "ERROR_PATH_ACCESS"
  | "ERROR_UNTRACKED_PATH"
  | "ERROR_STAGED_CONTENT" // verified against codebase in addition to the spec working set
  | "ERROR_STAGED_SCOPE" // verified against codebase in addition to the spec working set
  | "ERROR_GIT_SIZE"
  | "ERROR_NOT_REPOSITORY"
  | "ERROR_DIRECTORY_PATH"
  | "ERROR_UNSUPPORTED_FILE_TYPE"
  | "ERROR_INVALID_ARGUMENTS"
  | "ERROR_STALE_ADOPTION"
  | "ERROR_RUNTIME_ISOLATION"
  | "ERROR_RUNTIME_RECOVERY"
  | "ERROR_RUNTIME_ARTIFACT"
  | "ERROR_SCOPE_EXPANSION_DIRTY"
  | "ERROR_PLAN_NOT_FOUND"
  | "ERROR_PLAN_STALE"
  | "ERROR_PLAN_UNAPPROVED"
  | "ERROR_PLAN_INVALID"
  | "ERROR_PLAN_APPROVAL_EXISTS";

export type CommitPreparationFailureCategory =
  | "ERROR_STAGED_SCOPE"
  | "ERROR_STAGED_CONTENT"
  | "ERROR_STALE_RECEIPT";

export type AuditEventType =
  | "WORKFLOW_CREATED"
  | "SCOPE_EXPANDED"
  | "WORKFLOW_RUNTIME_ADOPTED"
  | "IMPLEMENTATION_SUBMITTED"
  | "MANUAL_VALIDATION_RECORDED"
  | "IMPLEMENTATION_INCOMPLETE"
  | "IMPLEMENTATION_STOPPED"
  | "IMPLEMENTATION_RESUMED"
  | "IMPLEMENTATION_PLAN_REBOUND"
  | "CONCERNS_ACCEPTED"
  | "DIRTY_SCOPE_ADOPTED"
  | "REVIEW_STARTED"
  | "REVIEW_SUBMITTED"
  | "REPAIR_AUTHORIZED"
  | "FINDINGS_ADJUDICATED"
  | "REVIEW_RESUMED"
  | "REPAIR_EXHAUSTED"
  | "COMMIT_AUTHORIZED"
  | "COMMIT_PREPARED"
  | "COMMIT_PREPARATION_FAILED"
  | "COMMIT_PREPARATION_RETRY_AUTHORIZED"
  | "COMMIT_PREPARATION_REVIEW_AUTHORIZED"
  | "STAGED_SCOPE_RECONCILED"
  | "COMMIT_RESULT_SUBMITTED"
  | "COMMIT_RETRY_AUTHORIZED"
  | "LINKED_FOLLOWUP_CREATED";

export type ActorRole = Role;

// Values actually written to audit `outcome`.
export type AuditOutcome = WorkflowPhase | ReviewStatus | "retry" | CommitOutcome | null;

// ---------------------------------------------------------------------------
// 4. Review target (discriminated union — exact objective shape)
// ---------------------------------------------------------------------------

export interface WorkingTreeReviewTarget {
  review_mode: "working_tree";
  base_revision: GitCommitSha;
  head_revision: null;
  approved_paths: ExactRepoPath[];
  include_staged: true;
  include_unstaged: true;
  include_untracked: true;
}

export interface CommitRangeReviewTarget {
  review_mode: "commit_range";
  base_revision: GitCommitSha;
  head_revision: GitCommitSha;
  approved_paths: ExactRepoPath[];
  include_staged: false;
  include_unstaged: false;
  include_untracked: false;
}

export type ReviewTarget = WorkingTreeReviewTarget | CommitRangeReviewTarget;

// ---------------------------------------------------------------------------
// 5. Findings and remediation
// ---------------------------------------------------------------------------

export interface Finding {
  finding_id: FindingId;
  severity: FindingSeverity;
  blocking: boolean;
  file_and_line: string; // max 300
  failure_scenario: string; // max 2000
  impact: string; // max 2000
  violated_requirement: string; // max 2000
  remediation: string; // max 2000
  missing_or_inadequate_test: string; // max 2000
}

export type BlockingFinding = Finding & { severity: "P0" | "P1" | "P2"; blocking: true };
export type OptionalFinding = Finding & { severity: "P3"; blocking: false };
export type ReviewFinding = BlockingFinding | OptionalFinding;
export type FindingResolutionMap = Record<FindingId, FindingResolution>;

export interface FindingAdjudication {
  finding_id: FindingId;
  finding_snapshot: BlockingFinding;
  source_review_version: WorkflowVersion;
  disposition: FindingAdjudicationDisposition;
  reason: string;
  user_authorization: string;
  adjudicated_at: IsoTimestamp;
  resulting_workflow_version: WorkflowVersion;
}

export interface RemediationContext {
  policy: "explicitly_authorized"; // only value the runtime produces
  authorized_finding_ids: FindingId[];
  repair_cycle: number; // always 0 at creation
  user_authorization: string;
}

/** Semantic repair intent. Binding identity remains in the containing WorkflowState. */
export interface RepairFallback {
  strategy: string;
  condition: string;
}

export interface RepairDirective {
  required_outcome: string;
  strategy_constraints: string;
  fallbacks: RepairFallback[];
  required_paths: ExactRepoPath[];
  forbidden_paths: ExactRepoPath[];
  user_authorization: string;
}

export interface RepairConformance {
  status: RepairConformanceStatus;
  evidence: string;
}

// ---------------------------------------------------------------------------
// 6. Acceptance / validation contracts and results
// ---------------------------------------------------------------------------

export interface AcceptanceCriterion {
  criterion_id: AcceptanceCriterionId; // "AC-001".."AC-999"
  description: string;
}

export type ValidationAuthoringRequirement =
  | { description: string; kind: "command"; argv: string[] }
  | { description: string; kind: "inspection" };

export type ValidationRequirement =
  | ({ validation_id: ValidationRequirementId } & Extract<
      ValidationAuthoringRequirement,
      { kind: "command" }
    >)
  | ({ validation_id: ValidationRequirementId } & Extract<
      ValidationAuthoringRequirement,
      { kind: "inspection" }
    >);
export interface AcceptanceResult {
  criterion_id: AcceptanceCriterionId;
  status: AcceptanceStatus;
  evidence: string;
}

export interface ValidationResult {
  validation_id: ValidationRequirementId;
  status: ValidationStatus;
  evidence: string;
}

// ---------------------------------------------------------------------------
// 7. Receipts and Git metadata
// ---------------------------------------------------------------------------

export type ReceiptPathState = TupleValue<typeof RECEIPT_PATH_STATE_VALUES>;

export type ReceiptPath =
  | { path: ExactRepoPath; state: "absent"; kind: "missing" } // no mode/digest
  | { path: ExactRepoPath; state: "deleted"; kind: "missing"; mode: GitFileMode } // no digest
  | {
      path: ExactRepoPath;
      state: "added" | "modified" | "unchanged";
      kind: "file" | "symlink";
      mode: GitFileMode;
      digest: ContentDigest;
    };

export interface ChangeReceipt {
  schema_version: 1; // receipt schema stays version 1
  base_head: GitCommitSha;
  approved_paths: ExactRepoPath[];
  paths: ReceiptPath[];
  overall_scope_hash: ContentDigest;
}

export interface GitTreeEntry {
  mode: GitFileMode;
  object: GitBlobSha;
}

export type ReviewRangePath =
  | { path: ExactRepoPath; kind: "added"; base: null; head: GitTreeEntry }
  | { path: ExactRepoPath; kind: "deleted"; base: GitTreeEntry; head: null }
  | {
      path: ExactRepoPath;
      kind: "modified" | "unchanged";
      base: GitTreeEntry;
      head: GitTreeEntry;
    };

export interface ReviewRange {
  base_revision: GitCommitSha;
  head_revision: GitCommitSha;
  paths: ReviewRangePath[];
}

// ---------------------------------------------------------------------------
// 8. WorkflowState (flat; NOT phase-discriminated this sprint)
// ---------------------------------------------------------------------------

export interface WorkflowState {
  schema_version: 10;
  version: WorkflowVersion;
  workflow_id: WorkflowId | null; // null only during construction; always set when persisted
  workflow_type: WorkflowType;
  /** Immutable runtime that owns this workflow. */
  runtime_id: RuntimeId | null;
  runtime_revision: GitCommitSha | null;
  phase: WorkflowPhase;
  objective: string;
  approved_plan: string | null;
  execution_brief: string | null;
  plan_provenance: PlanProvenance | null;
  work_items: WorkItemReference[];
  base_head: GitCommitSha;
  approved_paths: ExactRepoPath[];
  scope_expansions: ScopeExpansion[];
  approved_path_baselines: ApprovedPathBaseline[];
  acceptance_criteria: AcceptanceCriterion[];
  validation_requirements: ValidationRequirement[];
  review_target: ReviewTarget;
  initial_receipt: ChangeReceipt | null;
  review_start_receipt: ChangeReceipt | null;
  dirty_baseline_paths: ExactRepoPath[];
  repair_cycle: number; // runtime-validated 0..2
  max_repair_cycles: number; // runtime-validated 0..2
  parent_workflow_id: WorkflowId | null;
  source_workflow_id: WorkflowId | null;
  superseded_by_workflow_id: WorkflowId | null;
  linked_continuation: LinkedContinuation | null;
  linked_findings: ReviewFinding[];
  remediation_context: RemediationContext | null;
  implementation_summary: string | null;
  implementation_status: ImplementationStatus | null;
  agent_touched_paths: ExactRepoPath[];
  scope_changed_paths: ExactRepoPath[];
  acceptance_results: AcceptanceResult[];
  validation_results: ValidationResult[];
  implementation_receipt: ChangeReceipt | null;
  implementation_known_failures: string[];
  finding_resolution_map: FindingResolutionMap;
  prior_finding_classifications: FindingResolutionMap;
  blocking_findings: BlockingFinding[];
  optional_findings: OptionalFinding[];
  finding_adjudications: FindingAdjudication[];
  review_result_version: WorkflowVersion | null;
  review_receipt: ChangeReceipt | null;
  stop_context: StopContext | null;
  recovery_context: RecoveryContext | null;
  repair_authorized_ids: FindingId[];
  repair_directive: RepairDirective | null;
  concern_acceptance: ConcernAcceptance | null;
  commit_authorization: CommitAuthorization | null;
  commit_preparation: CommitPreparation | null;
  commit_result: CommitResult | null;
}

export type WorkflowStateFieldClass =
  | "contract_authority"
  | "scope_history"
  | "work_items"
  | "implementation_submission"
  | "review_receipts"
  | "current_review_result"
  | "adjudications"
  | "repair_authority"
  | "repair_cycle"
  | "concern_acceptance"
  | "commit_authorization"
  | "commit_attempt_evidence"
  | "lineage"
  | "linked_continuation"
  | "linked_findings"
  | "remediation_context"
  | "outside_lifecycle_evidence";

type ClassifyWorkflowStateFields<
  Classification extends Record<keyof WorkflowState, WorkflowStateFieldClass>,
> = Classification;

/** Compile-time ownership classification only; this is not generated lifecycle policy. */
export type WorkflowStateFieldClassification = ClassifyWorkflowStateFields<{
  schema_version: "outside_lifecycle_evidence";
  version: "outside_lifecycle_evidence";
  workflow_id: "outside_lifecycle_evidence";
  workflow_type: "outside_lifecycle_evidence";
  runtime_id: "outside_lifecycle_evidence";
  runtime_revision: "outside_lifecycle_evidence";
  phase: "outside_lifecycle_evidence";
  objective: "outside_lifecycle_evidence";
  approved_plan: "contract_authority";
  execution_brief: "contract_authority";
  plan_provenance: "contract_authority";
  work_items: "work_items";
  base_head: "outside_lifecycle_evidence";
  approved_paths: "outside_lifecycle_evidence";
  scope_expansions: "scope_history";
  approved_path_baselines: "scope_history";
  acceptance_criteria: "contract_authority";
  validation_requirements: "contract_authority";
  review_target: "outside_lifecycle_evidence";
  initial_receipt: "scope_history";
  review_start_receipt: "review_receipts";
  dirty_baseline_paths: "outside_lifecycle_evidence";
  repair_cycle: "repair_cycle";
  max_repair_cycles: "outside_lifecycle_evidence";
  parent_workflow_id: "lineage";
  source_workflow_id: "lineage";
  superseded_by_workflow_id: "lineage";
  linked_continuation: "linked_continuation";
  linked_findings: "linked_findings";
  remediation_context: "remediation_context";
  implementation_summary: "implementation_submission";
  implementation_status: "implementation_submission";
  agent_touched_paths: "implementation_submission";
  scope_changed_paths: "implementation_submission";
  acceptance_results: "implementation_submission";
  validation_results: "implementation_submission";
  implementation_receipt: "implementation_submission";
  implementation_known_failures: "implementation_submission";
  finding_resolution_map: "implementation_submission";
  prior_finding_classifications: "current_review_result";
  blocking_findings: "current_review_result";
  optional_findings: "current_review_result";
  finding_adjudications: "adjudications";
  review_result_version: "current_review_result";
  review_receipt: "review_receipts";
  stop_context: "outside_lifecycle_evidence";
  recovery_context: "outside_lifecycle_evidence";
  repair_authorized_ids: "repair_authority";
  repair_directive: "repair_authority";
  concern_acceptance: "concern_acceptance";
  commit_authorization: "commit_authorization";
  commit_preparation: "commit_attempt_evidence";
  commit_result: "commit_attempt_evidence";
}>;

export type WorkflowEvidenceFamily = Exclude<WorkflowStateFieldClass, "outside_lifecycle_evidence">;

export type WorkflowEvidenceField<Family extends WorkflowEvidenceFamily> = {
  [Field in keyof WorkflowState]: WorkflowStateFieldClassification[Field] extends Family
    ? Field
    : never;
}[keyof WorkflowState];

export type WorkflowEvidenceState<Family extends WorkflowEvidenceFamily> = Pick<
  WorkflowState,
  WorkflowEvidenceField<Family>
>;

export type LinkedReviewStage = "remediation" | "combined";

export interface LinkedContinuation {
  root_workflow_id: WorkflowId;
  predecessor_workflow_id: WorkflowId;
  lineage_workflow_ids: WorkflowId[];
  original_base_head: GitCommitSha;
  combined_review_paths: ExactRepoPath[];
  review_stage: LinkedReviewStage;
  remediation_review_receipt: ChangeReceipt | null;
}

export type StopContext =
  | {
      status: StoppingImplementationStatus;
      summary: string;
      stopped_from: "IMPLEMENTING" | "REPAIRING";
    }
  | { status: "INCONCLUSIVE"; summary: string; stopped_from: "REVIEWING" }
  | {
      status: "COMMIT_PREPARATION_FAILED";
      category: CommitPreparationFailureCategory;
      summary: string;
      recovery: "retry" | "review" | "choose";
      /** Exact staged paths outside reviewed authority captured at failure time. */
      reconciliation_paths?: ExactRepoPath[];
      failed_at: IsoTimestamp;
      failed_version: WorkflowVersion;
      stopped_from: "COMMIT_AUTHORIZED";
    };

export type RecoveryContext =
  | { kind: "implementation"; context: string; recovered_at: IsoTimestamp }
  | { kind: "review"; context: string; recovered_at: IsoTimestamp }
  | { kind: "commit"; context: string; recovered_at: IsoTimestamp };

export interface ConcernAcceptance {
  user_authorization: string;
  accepted_at: IsoTimestamp;
}

// ---------------------------------------------------------------------------
// 9. Role views (concrete projections, least-authority preserved)
// ---------------------------------------------------------------------------

export interface RoleViewCommon {
  workflow_id: WorkflowId | null;
  schema_version: 10;
  version: WorkflowVersion;
  workflow_type: WorkflowType;
  phase: WorkflowPhase;
  objective: string;
  approved_paths: ExactRepoPath[];
  repair_cycle: number;
  max_repair_cycles: number;
  review_target: ReviewTarget;
  superseded_by_workflow_id: WorkflowId | null;
  linked_continuation:
    | (Omit<LinkedContinuation, "remediation_review_receipt"> & {
        remediation_review_receipt: null;
      })
    | null;
  permitted_next_actions: WorkflowAction[];
}

export interface ScopeExpansion {
  expansion_id: string;
  added_paths: ExactRepoPath[];
  reason: string;
  user_authorization: string;
  prior_version: WorkflowVersion;
  resulting_version: WorkflowVersion;
  authorized_at: IsoTimestamp;
}

export interface ApprovedPathBaseline {
  path: ExactRepoPath;
  approved_at_version: WorkflowVersion;
  baseline: ReceiptPath;
}

export type ApprovedPathBaselineView = Omit<ApprovedPathBaseline, "baseline"> & {
  baseline:
    | { path: ExactRepoPath; state: "absent"; kind: "missing" }
    | {
        path: ExactRepoPath;
        state: "deleted";
        kind: "missing";
        mode: GitFileMode;
      }
    | {
        path: ExactRepoPath;
        state: "added" | "modified" | "unchanged";
        kind: "file" | "symlink";
        mode: GitFileMode;
      };
};

export interface ScopeExpansionAudit {
  expansion: ScopeExpansion;
  baselines: ApprovedPathBaselineView[];
}

export type CommitPreparationView = Omit<CommitPreparation, "review_receipt_digest">;

export type ParentView = RoleViewCommon &
  Omit<
    WorkflowState,
    | "initial_receipt"
    | "review_start_receipt"
    | "implementation_receipt"
    | "review_receipt"
    | "approved_path_baselines"
    | "commit_preparation"
  > & {
    approved_path_baselines: ApprovedPathBaselineView[];
    commit_preparation: CommitPreparationView | null;
  };

export interface ImplementerView extends RoleViewCommon {
  approved_plan: string | null;
  execution_brief: string | null;
  plan_provenance: PlanProvenance | null;
  acceptance_criteria: AcceptanceCriterion[];
  validation_requirements: ValidationRequirement[];
  dirty_baseline_paths: ExactRepoPath[];
  linked_findings: ReviewFinding[];
  remediation_context: RemediationContext | null;
  implementation_summary: string | null;
  implementation_status: ImplementationStatus | null;
  implementation_known_failures: string[];
  agent_touched_paths: ExactRepoPath[];
  scope_changed_paths: ExactRepoPath[];
  acceptance_results: AcceptanceResult[];
  validation_results: ValidationResult[];
  finding_resolution_map: FindingResolutionMap;
  blocking_findings: BlockingFinding[];
  repair_authorized_ids: FindingId[];
  repair_directive: RepairDirective | null;
  stop_context: StopContext | null;
  recovery_context: RecoveryContext | null;
}

// Reviewer sees the implementer handoff only for `change` workflows; `review_only` omits it.
export type ImplementerHandoffView = {
  implementation_summary: string | null;
  implementation_status: ImplementationStatus | null;
  implementation_known_failures: string[];
  agent_touched_paths: ExactRepoPath[];
  scope_changed_paths: ExactRepoPath[];
  acceptance_results: AcceptanceResult[];
  finding_resolution_map: FindingResolutionMap;
};

export interface ReviewerViewBase extends RoleViewCommon {
  acceptance_criteria: AcceptanceCriterion[];
  validation_requirements: ValidationRequirement[];
  validation_results: ValidationResult[];
  dirty_baseline_paths: ExactRepoPath[];
  linked_findings: ReviewFinding[];
  blocking_findings: BlockingFinding[];
  optional_findings: OptionalFinding[];
  prior_finding_classifications: FindingResolutionMap;
  finding_adjudications: FindingAdjudication[];
  repair_authorized_ids: FindingId[];
  repair_directive: RepairDirective | null;
  review_result_version: WorkflowVersion | null;
  concern_acceptance: ConcernAcceptance | null;
  stop_context: StopContext | null;
  recovery_context: RecoveryContext | null;
}

export type ReviewerView = Omit<ReviewerViewBase, "workflow_type"> &
  (({ workflow_type: "change" } & ImplementerHandoffView) | { workflow_type: "review_only" });

export interface CommitterView extends RoleViewCommon {
  work_items: WorkItemReference[];
  acceptance_criteria: AcceptanceCriterion[];
  validation_requirements: ValidationRequirement[];
  dirty_baseline_paths: ExactRepoPath[];
  agent_touched_paths: ExactRepoPath[];
  scope_changed_paths: ExactRepoPath[];
  implementation_summary: string | null;
  implementation_status: ImplementationStatus | null;
  implementation_known_failures: string[];
  acceptance_results: AcceptanceResult[];
  validation_results: ValidationResult[];
  blocking_findings: BlockingFinding[];
  optional_findings: OptionalFinding[];
  prior_finding_classifications: FindingResolutionMap;
  concern_acceptance: ConcernAcceptance | null;
  commit_authorization: CommitAuthorization | null;
  commit_preparation: CommitPreparationView | null;
  commit_result: CommitResult | null;
  stop_context: StopContext | null;
  recovery_context: RecoveryContext | null;
}

export type RoleView = ParentView | ImplementerView | ReviewerView | CommitterView;

// ---------------------------------------------------------------------------
// 10. Persistence rows (distinct from parsed domain types)
// ---------------------------------------------------------------------------

export interface WorkflowRow {
  workflow_id: string; // raw DB values; branded only after parse boundary
  version: number;
  state_json: string;
  state_digest: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditEventRow {
  event_id: number;
  workflow_id: string;
  version: number;
  event_type: string;
  actor_role: string;
  summary_json: string;
  created_at: string;
}

// ---------------------------------------------------------------------------
// 11. Audit domain
// ---------------------------------------------------------------------------

export interface AuditEnvelope {
  schema_version: 2;
  phase_before: WorkflowPhase | null;
  phase_after: WorkflowPhase;
  state_digest_before: StateDigest | null;
  state_digest_after: StateDigest;
  changed_fields: string[]; // sorted top-level keys excluding "version"
  linked_workflow_id: WorkflowId | null;
  outcome: AuditOutcome;
  dirty_scope_adoption?: DirtyScopeAdoptionAudit;
  plan_rebind?: PlanRebindAudit;
}

export interface AuditEvent {
  version: number;
  event_type: AuditEventType;
  actor_role: ActorRole;
  summary: AuditEnvelope;
  scope_expansion?: ScopeExpansionAudit;
  dirty_scope_adoption?: DirtyScopeAdoptionAudit;
  plan_rebind?: PlanRebindAudit;
  finding_adjudications?: FindingAdjudication[];
  created_at: IsoTimestamp;
}

export interface PlanRebindAudit {
  prior_plan_provenance: PlanProvenance;
  replacement_plan_provenance: PlanProvenance;
  added_paths: ExactRepoPath[];
  user_authorization: string;
  rebound_at: IsoTimestamp;
}

export interface DirtyScopeAdoptionState {
  path: ExactRepoPath;
  state: "added" | "modified" | "deleted" | "unchanged" | "absent";
  kind: "file" | "symlink" | "missing";
  mode?: GitFileMode;
}

export type DirtyScopeAdoptionIndexState =
  | { path: ExactRepoPath; state: "absent"; kind: "missing" }
  | { path: ExactRepoPath; state: "deleted"; kind: "missing"; mode: GitFileMode }
  | {
      path: ExactRepoPath;
      state: "added" | "modified" | "unchanged";
      kind: "file" | "symlink";
      mode: GitFileMode;
      digest: ContentDigest;
    };

export interface DirtyScopeAdoptionAudit {
  scope_expansion_id: string;
  scope_expansion_version: WorkflowVersion;
  adopted_paths: ExactRepoPath[];
  base_head: GitCommitSha;
  current_states: DirtyScopeAdoptionState[];
  index_states: DirtyScopeAdoptionIndexState[];
  current_state_commitment: StateDigest;
  runtime_id: RuntimeId | null;
  runtime_revision: GitCommitSha | null;
  executing_runtime_id: RuntimeId | null;
  executing_runtime_revision: GitCommitSha | null;
  cross_runtime: boolean;
  reason: string;
  user_authorization: string;
}

// ---------------------------------------------------------------------------
// 12. Commit domain
// ---------------------------------------------------------------------------

export interface CommitAuthorization {
  user_authorization: string;
  authorized_at: IsoTimestamp;
}

// git.prepareCommitReceipt() return
export interface CommitPreparationEvidence {
  prepared_head: GitCommitSha;
  prepared_tree: GitTreeSha;
  expected_paths: ExactRepoPath[];
}

export interface CommitPreparation extends CommitPreparationEvidence {
  attempt_id: CommitAttemptId;
  review_receipt_digest: StateDigest;
  prepared_at: IsoTimestamp;
}

export type CommitResult =
  | { outcome: "committed"; commit_hash: GitCommitSha; failure_summary: null }
  | { outcome: "not_committed"; commit_hash: null; failure_summary: string }
  | { outcome: "mismatch"; mismatch_category: CommitMismatchCategory };
