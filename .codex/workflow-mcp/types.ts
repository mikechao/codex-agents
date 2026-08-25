// Domain types for the workflow-state MCP server. Type-only module: no runtime exports, so
// `verbatimModuleSyntax` consumers import via `import type`. Branded values are produced only by
// the Phase C validation helpers; see `.codex/workflow-mcp/validation.ts` (planned).

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
export type GitCommitSha = Brand<string, "GitCommitSha">;
export type GitTreeSha = Brand<string, "GitTreeSha">;
export type GitBlobSha = Brand<string, "GitBlobSha">;
export type ExactRepoPath = Brand<string, "ExactRepoPath">;
export type FindingId = Brand<string, "FindingId">;
export type StateDigest = Brand<string, "StateDigest">;
export type ContentDigest = Brand<string, "ContentDigest">;
export type CapabilityToken = Brand<string, "CapabilityToken">;
export type CapabilityHash = Brand<string, "CapabilityHash">;
export type IsoTimestamp = Brand<string, "IsoTimestamp">;
export type CommitAttemptId = Brand<string, "CommitAttemptId">;

export interface WorkItemReference {
  provider: string;
  id: string;
  display_ref: string;
  url: string | null;
}

// ---------------------------------------------------------------------------
// 3. Core unions
// ---------------------------------------------------------------------------

export type Role = "parent" | "implementer" | "reviewer" | "committer"; // = validation ROLES

export type WorkflowPhase =
  | "IMPLEMENTING"
  | "REVIEWING"
  | "REPAIR_REQUIRED"
  | "REPAIRING"
  | "STOPPED_APPROVED"
  | "STOPPED_INCONCLUSIVE"
  | "STOPPED_CONCERNS"
  | "STOPPED_NEEDS_CONTEXT"
  | "STOPPED_IMPLEMENTATION_BLOCKED"
  | "STOPPED_REPAIR_EXHAUSTED"
  | "COMMIT_AUTHORIZED"
  | "COMMIT_PREPARED"
  | "STOPPED_COMMIT_PREPARATION"
  | "STOPPED_NOT_COMMITTED"
  | "STOPPED_COMMIT_MISMATCH"
  | "COMMITTED";

export type WorkflowType = "change" | "review_only";
export type ImplementationStatus =
  | "DONE"
  | "DONE_WITH_CONCERNS"
  | "INCOMPLETE"
  | "NEEDS_CONTEXT"
  | "BLOCKED";
export type StoppingImplementationStatus = Exclude<ImplementationStatus, "DONE" | "INCOMPLETE">;
export type ReviewStatus = "APPROVED" | "CHANGES_REQUESTED" | "INCONCLUSIVE";
export type FindingSeverity = "P0" | "P1" | "P2" | "P3";
export type FindingResolution = "resolved" | "still_present" | "superseded";
export type FindingAdjudicationDisposition = "CONTRACT_INCONSISTENT" | "OUTSIDE_APPROVED_SCOPE";
export type AcceptanceStatus = "satisfied" | "not_satisfied";
export type ValidationStatus = "passed" | "failed" | "not_run";
export type RangePathKind = "added" | "modified" | "deleted" | "unchanged";
export type GitFileMode = "100644" | "100755" | "120000"; // normalizeMode accepted set
export type CommitOutcome = "committed" | "not_committed" | "mismatch";
export type CommitMismatchCategory =
  | "HEAD_CHANGED"
  | "PARENT_MISMATCH"
  | "TREE_MISMATCH"
  | "PATH_MISMATCH";

// All Workflow MCP tool names (from `server.ts` `tools`).
export type WorkflowAction =
  | "workflow_create"
  | "workflow_adopt_dirty_scope"
  | "workflow_expand_scope"
  | "workflow_parent_get"
  | "workflow_implementer_get"
  | "workflow_reviewer_get"
  | "workflow_committer_get"
  | "workflow_get_audit"
  | "workflow_submit_implementation"
  | "workflow_resume_implementation"
  | "workflow_accept_concerns"
  | "workflow_begin_review"
  | "workflow_submit_review"
  | "workflow_authorize_repair"
  | "workflow_adjudicate_findings"
  | "workflow_resume_review"
  | "workflow_finalize_repair_exhausted"
  | "workflow_create_linked_followup"
  | "workflow_authorize_commit"
  | "workflow_prepare_commit"
  | "workflow_submit_commit_result"
  | "workflow_reconcile_commit_result"
  | "workflow_retry_commit_preparation"
  | "workflow_return_commit_to_review"
  | "workflow_retry_commit";

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
  | "ERROR_CAPABILITY_DENIED"
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
  | "ERROR_SCOPE_EXPANSION_DIRTY";

export type CommitPreparationFailureCategory =
  | "ERROR_STAGED_SCOPE"
  | "ERROR_STAGED_CONTENT"
  | "ERROR_STALE_RECEIPT";

export type AuditEventType =
  | "WORKFLOW_CREATED"
  | "SCOPE_EXPANDED"
  | "WORKFLOW_RUNTIME_ADOPTED"
  | "IMPLEMENTATION_SUBMITTED"
  | "IMPLEMENTATION_INCOMPLETE"
  | "IMPLEMENTATION_STOPPED"
  | "IMPLEMENTATION_RESUMED"
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

// ---------------------------------------------------------------------------
// 6. Acceptance / validation contracts and results
// ---------------------------------------------------------------------------

export interface AcceptanceCriterion {
  criterion_id: string; // "AC-001".."AC-999"
  description: string;
}

export interface ValidationRequirement {
  /** Workflow-local result correlation ID; never a repository command selector. */
  validation_id: string; // "VAL-001"..
  description: string;
  /** Exact executable argv, or null for a manual validation requirement. */
  argv: string[] | null;
}

export interface AcceptanceResult {
  criterion_id: string;
  status: AcceptanceStatus;
  evidence: string;
}

export interface ValidationResult {
  validation_id: string;
  status: ValidationStatus;
  evidence: string;
}

// ---------------------------------------------------------------------------
// 7. Receipts and Git metadata
// ---------------------------------------------------------------------------

export type ReceiptPathState = "added" | "modified" | "deleted" | "unchanged" | "absent";

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

export interface ReviewRangePath {
  path: ExactRepoPath;
  kind: RangePathKind;
  base: GitTreeEntry | null;
  head: GitTreeEntry | null;
}

export interface ReviewRange {
  base_revision: GitCommitSha;
  head_revision: GitCommitSha;
  paths: ReviewRangePath[];
}

// ---------------------------------------------------------------------------
// 8. WorkflowState (flat; NOT phase-discriminated this sprint)
// ---------------------------------------------------------------------------

export interface WorkflowState {
  schema_version: 7;
  version: WorkflowVersion;
  workflow_id: WorkflowId | null; // null only during construction; always set when persisted
  workflow_type: WorkflowType;
  /** Immutable runtime that owns this workflow. */
  runtime_id: string | null;
  runtime_revision: GitCommitSha | null;
  phase: WorkflowPhase;
  objective: string;
  approved_plan: string | null;
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
  concern_acceptance: ConcernAcceptance | null;
  commit_authorization: CommitAuthorization | null;
  commit_preparation: CommitPreparation | null;
  commit_result: CommitResult | null;
}

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
      recovery: "retry" | "review";
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
  schema_version: 7;
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
  validation_results: ValidationResult[];
  finding_resolution_map: FindingResolutionMap;
};

export interface ReviewerViewBase extends RoleViewCommon {
  acceptance_criteria: AcceptanceCriterion[];
  validation_requirements: ValidationRequirement[];
  dirty_baseline_paths: ExactRepoPath[];
  linked_findings: ReviewFinding[];
  blocking_findings: BlockingFinding[];
  optional_findings: OptionalFinding[];
  prior_finding_classifications: FindingResolutionMap;
  finding_adjudications: FindingAdjudication[];
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
export type ParentCapability = CapabilityToken;

// ---------------------------------------------------------------------------
// 10. Persistence rows (distinct from parsed domain types)
// ---------------------------------------------------------------------------

export interface WorkflowRow {
  workflow_id: string; // raw DB values; branded only after parse boundary
  version: number;
  state_json: string;
  state_digest: string | null;
  parent_capability_hash: string;
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
}

export interface AuditEvent {
  version: number;
  event_type: AuditEventType;
  actor_role: ActorRole;
  summary: AuditEnvelope;
  scope_expansion?: ScopeExpansionAudit;
  dirty_scope_adoption?: DirtyScopeAdoptionAudit;
  finding_adjudications?: FindingAdjudication[];
  created_at: IsoTimestamp;
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
  runtime_id: string | null;
  runtime_revision: GitCommitSha | null;
  executing_runtime_id: string | null;
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
