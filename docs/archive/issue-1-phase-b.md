# Issue 1 — Phase B spec: domain types (`.codex/workflow-mcp/types.ts`)

Detailed planning for Phase B of `issue-1-plan.md`. Produces a new type-only module
`.codex/workflow-mcp/types.ts`. No runtime code here; validation functions (Phase C) are the only
producers of branded values. This spec is the contract the compiler will enforce — the store,
transitions, and git modules (Phases D–F) must conform to it.

## 1. Brand helper

```ts
declare const __brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [__brand]: B };
```

Fully erasable; safe under `verbatimModuleSyntax`. All branded types below use it.

## 2. Identity / value types (selective branding)

| Type | Underlying | Runtime producer (Phase C) / source |
|---|---|---|
| `WorkflowId` | `Brand<string, "WorkflowId">` | NEW `workflowId(value: unknown)` (regex `^[0-9a-f-]{36}$`, currently inline in `store.#row`); call sites currently call `randomUUID()` -> brand at site |
| `WorkflowVersion` | `Brand<number, "WorkflowVersion">` | `expectedVersion()` |
| `GitCommitSha` | `Brand<string, "GitCommitSha">` | `revision()`, `currentHead()`, `verifyRevision()`, `verifyRange()` |
| `GitTreeSha` | `Brand<string, "GitTreeSha">` | `writeTree()`; `verifyPreparedCommit` `^{tree}` parse |
| `GitBlobSha` | `Brand<string, "GitBlobSha">` | git `ls-tree`/`ls-files` object fields (`treeEntry`, `treeEntries`, `stagedEntries`); consumed by `blobDigest` |
| `ExactRepoPath` | `Brand<string, "ExactRepoPath">` | `exactPaths()` |
| `FindingId` | `Brand<string, "FindingId">` | `finding()` (finding_id, `boundedString` max 80); NEW `findingIdList()` for repair/linked-followup id arrays (currently inline) |
| `StateDigest` | `Brand<string, "StateDigest">` | `objectDigest()`; the `state_digest` column and `review_receipt_digest` |
| `ContentDigest` | `Brand<string, "ContentDigest">` | receipt `digest()` (sha256 of blob content), `blobDigest()`, receipt `overall_scope_hash` and per-path `digest` |
| `CapabilityToken` | `Brand<string, "CapabilityToken">` | `issueCapability()` |
| `CapabilityHash` | `Brand<string, "CapabilityHash">` | `hashCapability()` |
| `IsoTimestamp` | `Brand<string, "IsoTimestamp">` | NEW `isoNow()` (wraps `new Date().toISOString()`) |
| `CommitAttemptId` | `Brand<string, "CommitAttemptId">` | `randomUUID()` in `prepareCommit` -> brand at site |

Notes
- `StateDigest` vs `ContentDigest` are both 64-hex but have distinct meanings — keep them separate.
- `repositoryRoot()` returns an **absolute** filesystem path, NOT an `ExactRepoPath` (which is
  repo-relative); type it `string`.
- Do NOT brand: `objective`, `summary`, evidence strings, `criterion_id`/`validation_id` (internally
  generated, order/ID matching is validated), audit `changed_fields` entries.

## 3. Core unions

```ts
export type Role = "parent" | "implementer" | "reviewer" | "committer";      // = validation ROLES
export type WorkflowPhase =
  | "IMPLEMENTING" | "REVIEWING" | "REPAIR_REQUIRED" | "REPAIRING"
  | "STOPPED_APPROVED" | "STOPPED_INCONCLUSIVE" | "STOPPED_CONCERNS"
  | "STOPPED_NEEDS_CONTEXT" | "STOPPED_IMPLEMENTATION_BLOCKED"
  | "STOPPED_REPAIR_EXHAUSTED" | "COMMIT_AUTHORIZED" | "COMMIT_PREPARED"
  | "STOPPED_NOT_COMMITTED" | "STOPPED_COMMIT_MISMATCH" | "COMMITTED";
export type WorkflowType = "change" | "review_only";
export type ImplementationStatus = "DONE" | "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED";
export type ReviewStatus = "APPROVED" | "CHANGES_REQUESTED" | "INCONCLUSIVE";
export type FindingSeverity = "P0" | "P1" | "P2" | "P3";
export type FindingResolution = "resolved" | "still_present" | "superseded";
export type AcceptanceStatus = "satisfied" | "not_satisfied";
export type ValidationStatus = "passed" | "failed" | "not_run";
export type RangePathKind = "added" | "modified" | "deleted" | "unchanged";
export type GitFileMode = "100644" | "100755" | "120000";                     // normalizeMode accepted set
export type CommitOutcome = "committed" | "not_committed" | "mismatch";
export type CommitMismatchCategory =
  | "HEAD_CHANGED" | "PARENT_MISMATCH" | "TREE_MISMATCH" | "PATH_MISMATCH";
```

- `WorkflowAction` — all 16 tool names (from `server.ts` `tools`): `workflow_create`,
  `workflow_get`, `workflow_get_audit`, `workflow_submit_implementation`,
  `workflow_resume_implementation`, `workflow_accept_concerns`, `workflow_submit_review`,
  `workflow_authorize_repair`, `workflow_resume_review`, `workflow_finalize_repair_exhausted`,
  `workflow_create_linked_followup`, `workflow_authorize_commit`, `workflow_prepare_commit`,
  `workflow_submit_commit_result`, `workflow_retry_commit`, `workflow_record_commit`.
- `ErrorCategory` — union of every `ERROR_*` literal used by `fail(...)` in the server PLUS the
  child change-receipt CLI categories that `git.createReceipt` can re-throw (`/^ERROR_[A-Z_]+$/`
  from child stderr). Working set (grep-verify during Phase C; the union forces completeness):
  `ERROR_INTERNAL`, `ERROR_UNKNOWN_TOOL`, `ERROR_INJECTED_FAILURE`,
  `ERROR_INVALID_SHAPE`, `ERROR_INVALID_PATHS`, `ERROR_INVALID_ROLE`, `ERROR_CAPABILITY_DENIED`,
  `ERROR_INVALID_VERSION`, `ERROR_INVALID_FINDING`, `ERROR_INVALID_IMPLEMENTATION`,
  `ERROR_STATE_CORRUPT`, `ERROR_MIGRATION_REQUIRED`, `ERROR_NOT_FOUND`, `ERROR_STORE_CLOSED`,
  `ERROR_VERSION_CONFLICT`, `ERROR_STALE_BASE`, `ERROR_STALE_RECEIPT`, `ERROR_INVALID_REVIEW`,
  `ERROR_COMMIT_NOT_ALLOWED`, `ERROR_LEGACY_WORKFLOW`, `ERROR_INVALID_TRANSITION`,
  `ERROR_UNSUPPORTED_WORKFLOW_TYPE`, `ERROR_INVALID_REPAIR`, `ERROR_REPAIR_LIMIT`,
  `ERROR_INVALID_FOLLOWUP`, `ERROR_COMMIT_MISMATCH`, `ERROR_GIT`, `ERROR_NO_HEAD`,
  `ERROR_INVALID_REVISION`, `ERROR_NON_ANCESTOR`, `ERROR_INVALID_REVIEW_PATH`,
  `ERROR_UNSUPPORTED_MODE`, `ERROR_RECEIPT_UNAVAILABLE`, `ERROR_EMPTY_PATH`, `ERROR_UNSAFE_PATH`,
  `ERROR_DUPLICATE_PATH`, `ERROR_EMPTY_PATHS`, `ERROR_PATH_ACCESS`, `ERROR_UNTRACKED_PATH`,
  `ERROR_GIT_SIZE`, `ERROR_NOT_REPOSITORY`, `ERROR_DIRECTORY_PATH`,
  `ERROR_UNSUPPORTED_FILE_TYPE`, `ERROR_INVALID_ARGUMENTS`.
- `AuditEventType` — `WORKFLOW_CREATED`, `WORKFLOW_MIGRATED`, `IMPLEMENTATION_SUBMITTED`,
  `IMPLEMENTATION_STOPPED`, `IMPLEMENTATION_RESUMED`, `CONCERNS_ACCEPTED`, `REVIEW_SUBMITTED`,
  `REPAIR_AUTHORIZED`, `REVIEW_RESUMED`, `REPAIR_EXHAUSTED`, `COMMIT_AUTHORIZED`,
  `COMMIT_PREPARED`, `COMMIT_RESULT_SUBMITTED`, `COMMIT_RETRY_AUTHORIZED`, `COMMIT_RECORDED`,
  `LINKED_FOLLOWUP_CREATED`.
- `ActorRole = Role`.
- `AuditOutcome = WorkflowPhase | ReviewStatus | "retry" | CommitOutcome | null` (values actually
  written to audit `outcome`).

## 4. Review target (discriminated union — exact objective shape)

```ts
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
```

Runtime validation (`transitions.reviewTarget`) must still reject malformed external inputs before
anything becomes one of these; the type is not a validator.

## 5. Findings and remediation

```ts
export interface Finding {
  finding_id: FindingId;
  severity: FindingSeverity;
  blocking: boolean;
  file_and_line: string;              // max 300
  failure_scenario: string;           // max 2000
  impact: string;                     // max 2000
  violated_requirement: string;       // max 2000
  remediation: string;                // max 2000
  missing_or_inadequate_test: string; // max 2000
}
export type BlockingFinding = Finding & { severity: "P0" | "P1" | "P2"; blocking: true };
export type OptionalFinding = Finding & { severity: "P3"; blocking: false };
export type ReviewFinding = BlockingFinding | OptionalFinding;
export type FindingResolutionMap = Record<FindingId, FindingResolution>;
export interface RemediationContext {
  policy: "explicitly_authorized";      // only value the runtime produces
  authorized_finding_ids: FindingId[];
  repair_cycle: number;                 // always 0 at creation
  user_authorization: string;
}
```

`finding()` in Phase C returns `ReviewFinding[]`; `blocking_findings`/`optional_findings` are
`BlockingFinding[]`/`OptionalFinding[]` respectively.

## 6. Acceptance / validation contracts and results

```ts
export interface AcceptanceCriterion { criterion_id: string; description: string; }   // "AC-001".."AC-999"
export interface ValidationRequirement { validation_id: string; description: string; } // "VAL-001"..
export interface AcceptanceResult { criterion_id: string; status: AcceptanceStatus; evidence: string; }
export interface ValidationResult { validation_id: string; status: ValidationStatus; evidence: string; }
```

`contractList()` produces the criterion/requirement arrays; `evidenceResults()` produces the result
arrays (exact IDs in contract order enforced at runtime).

## 7. Receipts and Git metadata

```ts
export type ReceiptPathState = "added" | "modified" | "deleted" | "unchanged" | "absent";

export type ReceiptPath =
  | { path: ExactRepoPath; state: "absent"; kind: "missing" }                 // no mode/digest
  | { path: ExactRepoPath; state: "deleted"; kind: "missing"; mode: GitFileMode } // no digest
  | { path: ExactRepoPath; state: "added" | "modified" | "unchanged";
      kind: "file" | "symlink"; mode: GitFileMode; digest: ContentDigest };

export interface ChangeReceipt {
  schema_version: 1;                    // receipt schema stays version 1
  base_head: GitCommitSha;
  approved_paths: ExactRepoPath[];
  paths: ReceiptPath[];
  overall_scope_hash: ContentDigest;
}

export interface GitTreeEntry {          // normalized blob entry (supported modes only)
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
```

Note: the raw unvalidated `git ls-tree` record returned by `git.ts treeEntry()` (`{ mode: string;
type: string; object: string }`) is an internal detail — model it as a private `GitLsTreeRecord` in
`git.ts`, not in `types.ts`. Receipts from MCP input are validated by canonical comparison against a
server-computed fresh receipt at runtime; the type documents the expected shape only.

## 8. WorkflowState (flat; NOT phase-discriminated this sprint)

```ts
export interface WorkflowState {
  schema_version: 2;
  version: WorkflowVersion;
  workflow_id: WorkflowId | null;   // null only during construction; always set when persisted
  workflow_type: WorkflowType;
  legacy_v1: boolean;
  phase: WorkflowPhase;
  objective: string;
  base_head: GitCommitSha;
  approved_paths: ExactRepoPath[];
  acceptance_criteria: AcceptanceCriterion[];
  validation_requirements: ValidationRequirement[];
  review_target: ReviewTarget;
  initial_receipt: ChangeReceipt | null;
  dirty_baseline_paths: ExactRepoPath[];
  repair_cycle: number;             // runtime-validated 0..2
  max_repair_cycles: number;        // runtime-validated 0..2
  parent_workflow_id: WorkflowId | null;
  source_workflow_id: WorkflowId | null;
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
  review_receipt: ChangeReceipt | null;
  stop_context: StopContext | null;
  recovery_context: RecoveryContext | null;
  repair_authorized_ids: FindingId[];
  concern_acceptance: ConcernAcceptance | null;
  commit_authorization: CommitAuthorization | null;
  commit_preparation: CommitPreparation | null;
  commit_result: CommitResult | null;
  // Migration-only keys (present on legacy rows; absent on new v2 workflows):
  legacy_evidence?: { acceptance_evidence: string[]; validation_evidence: string[] };
  implementation_changed_paths?: ExactRepoPath[];
  implementation_acceptance_evidence?: string[];
  implementation_validation_evidence?: string[];
  authorized_optional_ids?: FindingId[];
  user_authorization_summary?: string | null;
}
```

Context types:

```ts
export type StopContext =
  | { status: ImplementationStatus; summary: string; stopped_from: "IMPLEMENTING" | "REPAIRING" }
  | { status: "INCONCLUSIVE"; summary: string; stopped_from: "REVIEWING" };

export type RecoveryContext =
  | { kind: "implementation"; context: string; recovered_at: IsoTimestamp }
  | { kind: "review"; context: string; recovered_at: IsoTimestamp }
  | { kind: "commit"; context: string; recovered_at: IsoTimestamp };

export interface ConcernAcceptance { user_authorization: string; accepted_at: IsoTimestamp; }
```

## 9. Role views (concrete projections, least-authority preserved)

Common view base:

```ts
export interface RoleViewCommon {
  workflow_id: WorkflowId | null;
  schema_version: 2;
  version: WorkflowVersion;
  workflow_type: WorkflowType;
  phase: WorkflowPhase;
  objective: string;
  approved_paths: ExactRepoPath[];
  repair_cycle: number;
  max_repair_cycles: number;
  review_target: ReviewTarget;
  permitted_next_actions: WorkflowAction[];
}
```

```ts
export type ParentView = RoleViewCommon &
  Omit<WorkflowState, "legacy_evidence" | "implementation_changed_paths"
    | "implementation_acceptance_evidence" | "implementation_validation_evidence"
    | "authorized_optional_ids" | "user_authorization_summary">;
// Note: the Omit intentionally still excludes the migration-only keys from the parent projection,
// matching `roleView` runtime behavior; base_head + all non-common fields are included.

export interface ImplementerView extends RoleViewCommon {
  acceptance_criteria: AcceptanceCriterion[];
  validation_requirements: ValidationRequirement[];
  initial_receipt: ChangeReceipt | null;
  dirty_baseline_paths: ExactRepoPath[];
  linked_findings: ReviewFinding[];
  remediation_context: RemediationContext | null;
  implementation_summary: string | null;
  implementation_status: ImplementationStatus | null;
  implementation_receipt: ChangeReceipt | null;
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
  implementation_receipt: ChangeReceipt | null;
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
  blocking_findings: BlockingFinding[];
  optional_findings: OptionalFinding[];
  prior_finding_classifications: FindingResolutionMap;
  concern_acceptance: ConcernAcceptance | null;
  review_receipt: ChangeReceipt | null;
  stop_context: StopContext | null;
  recovery_context: RecoveryContext | null;
}
export type ReviewerView = Omit<ReviewerViewBase, "workflow_type"> &
  (({ workflow_type: "change" } & ImplementerHandoffView) | { workflow_type: "review_only" });

export interface CommitterView extends RoleViewCommon {
  acceptance_criteria: AcceptanceCriterion[];
  validation_requirements: ValidationRequirement[];
  dirty_baseline_paths: ExactRepoPath[];
  agent_touched_paths: ExactRepoPath[];
  scope_changed_paths: ExactRepoPath[];
  implementation_summary: string | null;
  implementation_status: ImplementationStatus | null;
  implementation_receipt: ChangeReceipt | null;
  implementation_known_failures: string[];
  acceptance_results: AcceptanceResult[];
  validation_results: ValidationResult[];
  blocking_findings: BlockingFinding[];
  optional_findings: OptionalFinding[];
  prior_finding_classifications: FindingResolutionMap;
  concern_acceptance: ConcernAcceptance | null;
  review_receipt: ChangeReceipt | null;
  commit_authorization: CommitAuthorization | null;
  commit_preparation: CommitPreparation | null;
  commit_result: CommitResult | null;
  stop_context: StopContext | null;
  recovery_context: RecoveryContext | null;
}

export type RoleView = ParentView | ImplementerView | ReviewerView | CommitterView;
export type RoleCapabilities = Record<Role, CapabilityToken>;
```

The store's `roleView` gets role-literal overloads (Phase E) returning the concrete view type.
The `ReviewerView` review_only variant is the faithful least-authority model; if it fights the
store's runtime filtering during Phase E, fall back to marking `ImplementerHandoffView` fields
optional on `ReviewerView` and note the deviation.

## 10. Persistence rows (distinct from parsed domain types)

```ts
export interface WorkflowRow {
  workflow_id: string;                       // raw DB values; branded only after parse boundary
  version: number;
  state_json: string;
  state_digest: string | null;
  parent_capability_hash: string;
  implementer_capability_hash: string;
  reviewer_capability_hash: string;
  committer_capability_hash: string;
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
```

`parseState()` (Phase F) converts a verified `state_json` into `WorkflowState` after JSON parse +
digest verification; rows stay raw strings. SQLite `node:sqlite` results are cast to these at the
`#row`/audit read sites.

## 11. Audit domain

```ts
export interface AuditEnvelope {
  schema_version: 2;
  phase_before: WorkflowPhase | null;
  phase_after: WorkflowPhase;
  state_digest_before: StateDigest | null;
  state_digest_after: StateDigest;
  changed_fields: string[];            // sorted top-level keys excluding "version"
  linked_workflow_id: WorkflowId | null;
  outcome: AuditOutcome;
}
export interface AuditEvent {
  version: number;
  event_type: AuditEventType;          // legacy rows may fall outside the union; cast at read
  actor_role: ActorRole;
  summary: AuditEnvelope | LegacyAuditSummary;
  created_at: IsoTimestamp;
}
export interface LegacyAuditSummary { [key: string]: unknown; } // old rows returned unsynthesized
```

Write-side (`#audit`, `auditEnvelope`) params are the typed unions; read-side `audit()` keeps old
rows byte-for-byte and casts their summary/event_type to the loose legacy types.

## 12. Commit domain

```ts
export interface CommitAuthorization { user_authorization: string; authorized_at: IsoTimestamp; }

export interface CommitPreparationEvidence {   // git.prepareCommitReceipt() return
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

export type CommitVerification =
  | { ok: true; commit_hash: GitCommitSha; changed_paths: ExactRepoPath[] }
  | { ok: false; mismatch: CommitMismatchCategory };
```

`git.verifyPreparedCommit` / `verifyCommitResult` keep `CommitMismatchCategory | null` (internal
shape change only; persisted `commit_result` wire shape unchanged).

## 13. Producers summary (Phase C contract)

- `revision(): GitCommitSha`, `currentHead(): GitCommitSha`, `verifyRevision(): GitCommitSha`,
  `verifyRange(): { base_revision: GitCommitSha; head_revision: GitCommitSha }`
- `exactPaths(): ExactRepoPath[]`, `expectedVersion(): WorkflowVersion`,
  `workflowId(): WorkflowId` (NEW), `isoNow(): IsoTimestamp` (NEW),
  `findingIdList(): FindingId[]` (NEW)
- `objectDigest(): StateDigest`, `blobDigest(): ContentDigest`
- `issueCapability(): CapabilityToken`, `hashCapability(): CapabilityHash`
- `finding(): ReviewFinding`, `findings(): ReviewFinding[]`,
  `contractList(): AcceptanceCriterion[] | ValidationRequirement[]`, `evidenceResults()`
- `exactKeys(): Record<string, unknown>` (validated object, untyped values by design)

## 14. Decision points (with recommendation)

1. **`workflow_id: WorkflowId | null` on `WorkflowState`** — RECOMMENDED: `createState` starts null,
   the store assigns a `WorkflowId`; `WorkflowId | null` flows without new asserts. Alternative
   (`WorkflowId`, builder returns `Omit<...>`) adds store-side friction; not worth it.
2. **`ReviewerView` review_only variant** — model it as the discriminated variant (section 9);
   fall back to optional handoff fields if it fights Phase E.
3. **Audit read-side strictness** — keep `AuditEventType`/`ActorRole` on the write path; legacy rows
   read as loose types. Do not widen the write-side unions.
4. **`ErrorCategory` completeness** — union forces compile errors on any `fail(...)` literal that is
   not enumerated; grep the working set (section 3) during Phase C and extend only with real values.
5. **No `RepairCycle` literal union** — keep `repair_cycle: number` (runtime-validated 0..2) to
   avoid churn from `next.repair_cycle += 1`. Revisit as a follow-up.
6. **Tool JSON-Schema types** stay in `server.ts` (Phase G), not `types.ts`; `types.ts` is pure
   domain.
7. **`types.ts` is `export type`-only** (plus the `Brand` helper type). No runtime exports, so
   `verbatimModuleSyntax` consumers import via `import type`.

## 15. Done criteria for Phase B

- `.codex/workflow-mcp/types.ts` exists with every type above, `pnpm typecheck` passes for it in
  isolation (a temporary empty stub for the other modules, or deferred until Phases C–F compile).
- Every brand is produced by a Phase C helper (mapping in section 13); no branded value is created
  by a bare `as` cast except the two documented `randomUUID()` brand-at-site call sites
  (`WorkflowId` in store, `CommitAttemptId` in prepareCommit) and git-object parses
  (`GitBlobSha`/`GitTreeSha`).
- `ReviewTarget`/`CommitVerification`/`CommitResult` are discriminated unions; role views are
  concrete projections with exactly the runtime field sets; persistence rows are distinct from
  parsed types.
- No runtime behavior change: this phase only adds a module; nothing imports it yet (Phase C lands
  the producers, D–F the consumers).
- `git diff --check` clean.