# Issue 1 — Phase E spec: `transitions.ts`

Detailed planning for Phase E of `issue-1-plan.md`. Converts `.codex/workflow-mcp/transitions.mjs`
to TypeScript: typed transitions over `WorkflowState`, typed `roleView` overloads returning the
concrete least-authority views, typed `permittedNextActions` (`WorkflowAction[]`), and the
`migrateV1State` port. All runtime behavior, error categories, detail strings, and check ordering
are preserved.

## 0. Current state and prerequisites

- Phases A–D landed and committed (`types.ts`, `errors.ts`, `validation.ts`, `git.ts`, shims,
  committed `dist/`). `pnpm typecheck` passes; oracle subset (git/lifecycle/workflow `.mjs` tests)
  is 98/98 green.
- `transitions.mjs` is unchanged by prior phases (verified: same exports, 1182 lines).
- Oracle for this phase (same SDK-free subset as Phases C/D):
  `pnpm build && node --test .codex/workflow-mcp/tests/git.node.mjs
  .codex/workflow-mcp/tests/lifecycle.node.mjs .codex/workflow-mcp/tests/workflow.node.mjs`
- **Coverage gap (important):** `migration.node.mjs` (the `migrateV1State` regression tests)
  imports the removed v1 SDK and cannot load until Phase I. The `migrateV1State` port is therefore
  NOT oracle-covered this phase — port it as a strict 1:1 line-for-line rewrite and flag it for
  Phase I verification.

## 1. Transition mechanics

Same as C/D: `transitions.mjs` -> `transitions.ts`, replace `transitions.mjs` with the shim
`export * from "./dist/transitions.js";`, commit `dist/transitions.js`. No consumer edits:
`store.mjs` and the `.mjs` tests keep importing `./transitions.mjs` / `../transitions.mjs`
(workflow.node.mjs imports `permittedNextActions`, `roleView`). The shim is deleted at Phase F
when `store.mjs` is converted.

## 2. Imports

```ts
import { randomUUID } from "node:crypto";
import { fail } from "./errors.js";
import {
  ACCEPTANCE_STATUSES, VALIDATION_STATUSES, boundedString, canonicalJson, contractList,
  evidenceResults, exactKeys, exactPaths, findings, findingIdList, isoNow, objectDigest,
  optionalText, repairCycle, resolutionMap, revision, role, stringList, userAuthorization,
} from "./validation.js";
import type {
  AcceptanceCriterion, AcceptanceResult, BlockingFinding, ChangeReceipt, CommitAttemptId,
  CommitAuthorization, CommitMismatchCategory, CommitPreparation, CommitPreparationEvidence,
  CommitResult, CommitVerification, ExactRepoPath, FindingId, FindingResolutionMap,
  FindingSeverity, GitCommitSha, ImplementationStatus, IsoTimestamp, OptionalFinding,
  ParentView, ImplementerView, ReviewerView, CommitterView, RemediationContext, ReviewFinding,
  ReviewRange, ReviewTarget, Role, RoleView, StopContext, ValidationRequirement,
  ValidationResult, WorkflowAction, WorkflowId, WorkflowPhase, WorkflowState, WorkflowType,
  WorkflowVersion,
} from "./types.js";
```

## 3. Constants and typed unions

```ts
export const SCHEMA_VERSION = 2;

export const IMPLEMENTATION_STOP_PHASES: Record<
  "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED",
  WorkflowPhase
> = {
  DONE_WITH_CONCERNS: "STOPPED_CONCERNS",
  NEEDS_CONTEXT: "STOPPED_NEEDS_CONTEXT",
  BLOCKED: "STOPPED_IMPLEMENTATION_BLOCKED",
};

export const PHASES: readonly WorkflowPhase[] = [ /* all 15 phases, same order */ ];
export const MISMATCH_CATEGORIES: ReadonlySet<CommitMismatchCategory> = new Set([...]);

const V1_PHASES: readonly string[] = [ /* 11 v1 phases incl. "STOPPED_BLOCKED" */ ];
const V1_STATE_KEYS: readonly string[] = [ /* 26 keys, unchanged */ ];
```

`IMPLEMENTATION_STOP_PHASES` indexed only in the `input.status !== "DONE"` branch (narrowed to the
three stop statuses), so the `Record` value is never `undefined`.

View/action tables (unchanged content, tightened element types):

```ts
const ROLE_VIEW_COMMON: readonly string[] = [ /* same 10 keys */ ];
const TEMPORARY_COMPATIBILITY_KEYS: readonly string[] = [ /* same 5 keys */ ];
const REVIEWER_IMPLEMENTER_HANDOFF: readonly string[] = [ /* same 9 keys */ ];
const ROLE_VIEW_EXTRA: Record<"implementer" | "reviewer" | "committer", readonly string[]> = { /* same */ };
const ACTION_MATRIX: Partial<Record<Role, Partial<Record<WorkflowPhase, readonly WorkflowAction[]>>>> = { /* same */ };
```

## 4. Core patterns

- **Capture `exactKeys`:** every transition reads `const args = exactKeys(input, [...], name,
  [...optional])` and reads all fields from `args: Record<string, unknown>` — `input: unknown`
  itself is never indexed. Field reads go through validation helpers or literal-comparison
  narrowing (`if (args.workflow_type !== "change" && args.workflow_type !== "review_only") fail(...)`
  narrows to `WorkflowType` afterwards).
- **`fail(): never` narrowing:** `corrupt(): never` (wraps `fail("ERROR_STATE_CORRUPT", ...)`)
  so `if (!isObject(state)) corrupt();` narrows the remainder of `migrateV1State`.
- **`clone`:** `function clone<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }`.
- **Type guards** (internal):

  ```ts
  function isObject(value: unknown): value is Record<string, unknown> { ... }
  function isStringArray(value: unknown): value is string[] { ... }
  ```

## 5. Exported function signatures

```ts
export function permittedNextActions(state: WorkflowState, actorRole: Role): WorkflowAction[];

export function roleView(state: WorkflowState, actorRole: "parent"): ParentView;
export function roleView(state: WorkflowState, actorRole: "implementer"): ImplementerView;
export function roleView(state: WorkflowState, actorRole: "reviewer"): ReviewerView;
export function roleView(state: WorkflowState, actorRole: "committer"): CommitterView;
export function roleView(state: WorkflowState, actorRole: Role): RoleView;

export function createState(
  input: unknown,
  repositoryRoot: string,
  currentHead: GitCommitSha,
  options: { internal?: boolean } = {},
): WorkflowState;

export function submitImplementation(
  state: WorkflowState, input: unknown, repositoryRoot: string, freshReceipt: ChangeReceipt,
): WorkflowState;
export function resumeImplementation(state: WorkflowState, input: unknown): WorkflowState;
export function acceptConcerns(state: WorkflowState, input: unknown): WorkflowState;
export function submitReview(state: WorkflowState, input: unknown): WorkflowState;
export function authorizeRepair(state: WorkflowState, input: unknown): WorkflowState;
export function resumeReview(state: WorkflowState, input: unknown): WorkflowState;
export function finalizeRepairExhausted(state: WorkflowState, input: unknown): WorkflowState;
export function authorizeCommit(state: WorkflowState, authorization: unknown): WorkflowState;
export function recordCommit(state: WorkflowState, evidence: CommitVerification, input: unknown): WorkflowState;
export function commitMismatch(state: WorkflowState, category: CommitMismatchCategory): WorkflowState;
export function prepareCommit(state: WorkflowState, input: unknown, evidence: CommitPreparationEvidence): WorkflowState;
export function submitCommitResult(state: WorkflowState, input: unknown): WorkflowState;
export function retryCommit(state: WorkflowState, input: unknown): WorkflowState;

export interface LinkedFollowupPlan {          // NEW, exported for store (Phase F)
  objective: string;
  approved_paths: ExactRepoPath[];
  acceptance_criteria: string[];               // raw caller order; contractList runs in child
  validation_requirements: string[];
  base_head: GitCommitSha;
  max_repair_cycles: number;
  parent_workflow_id: WorkflowId | null;
  source_workflow_id: WorkflowId | null;
  authorized_finding_ids: FindingId[];
  linked_findings: ReviewFinding[];
  user_authorization: string;
}
export function linkedFollowupInput(
  state: WorkflowState, input: unknown, repositoryRoot: string, currentHead: GitCommitSha,
): LinkedFollowupPlan;
export function linkedFollowupChildState(followup: LinkedFollowupPlan): WorkflowState;

export function changedReceiptPaths(receipt: ChangeReceipt | null | undefined): ExactRepoPath[];
export function dirtyBaselinePaths(receipt: ChangeReceipt | null | undefined): ExactRepoPath[];
export function rangeDirtyBaselinePaths(range: ReviewRange | null | undefined): ExactRepoPath[];
export function scopeChangedPaths(
  initialReceipt: ChangeReceipt | null, finalReceipt: ChangeReceipt | null,
): ExactRepoPath[];

export function migrateV1State(state: unknown): WorkflowState;
```

## 6. Function-by-function notes

### `permittedNextActions` / `roleView`

- `permittedNextActions` keeps the two filters (parent `STOPPED_APPROVED` non-working-tree removes
  `workflow_authorize_commit`; committer `COMMIT_AUTHORIZED` non-legacy removes
  `workflow_record_commit`) and returns `actions.sort()` (`WorkflowAction[]`).
- `roleView` builds `const view: Record<string, unknown> = {};` exactly as today (common keys
  present in state, then the parent full-projection minus `legacy_evidence` and the five
  temporary-compat keys, or the role extra lists with the review-only handoff filter), then
  `return view as RoleView;` (producer-side cast). The overloads give Phase F concrete view types
  per role literal; `#mutate`'s dynamic `Role` argument resolves to `RoleView`.

### `createState` / `baseState` / `reviewTarget`

- `baseState(options)` internal:
  ```ts
  interface BaseStateOptions {
    objective: string;
    approvedPaths: ExactRepoPath[];
    baseHead: GitCommitSha;
    maxRepairCycles: number;
    parentWorkflowId?: WorkflowId | null;
    workflowType?: WorkflowType;
    sourceWorkflowId?: WorkflowId | null;
    linkedFindings?: ReviewFinding[];
    remediationContext?: RemediationContext | null;
  }
  ```
  `version: 0 as WorkflowVersion` (producer cast; `WorkflowVersion` is branded), `workflow_id: null`.
- `reviewTarget(value: unknown, approvedPaths: ReadonlyArray<ExactRepoPath>, repositoryRoot: string,
  currentHead: GitCommitSha, workflowType: WorkflowType): ReviewTarget` — keeps the
  `JSON.stringify` path comparison (NOT `canonicalJson` — preserve the existing comparison), the
  working-tree/commit-range branches with literal include-flag returns, and the final
  `ERROR_UNSUPPORTED_WORKFLOW_TYPE` fallback. Discriminated-union construction is literal-typed.
- `createState`: **keep the `options.internal === true` MCP-2.1-era path** (dead today; store calls
  without options) — behavior-preserving. Its `parentWorkflowId` read is
  `optionalText(...) as WorkflowId | null` (brand cast; documented).

### `submitImplementation`

- `const args = exactKeys(input, [...same 11 keys], "implementation submission")`.
- `const receipt = args.implementation_receipt;` then the existing object check
  (`!receipt || typeof !== "object" || Array.isArray`) narrows to `object`;
  `next.implementation_receipt = JSON.parse(JSON.stringify(freshReceipt ?? receipt)) as ChangeReceipt`
  — the cast is justified because the store verified canonical equality with the fresh receipt
  before calling (documented producer cast).
- `touchedPaths` via `exactPaths(args.agent_touched_paths, repositoryRoot, true)`; approved-subset
  check unchanged.
- Evidence via `evidenceResults(...)` (overloads resolve to `AcceptanceResult[]` /
  `ValidationResult[]`); `knownFailures = stringList(...)`; `resolutionMap(args.finding_resolution_map, priorIds, ...)`.
- Stop branch:
  ```ts
  next.stop_context = {
    status: input.status,                       // narrowed to non-DONE ImplementationStatus
    summary: boundedString(args.summary, "summary", 4000),
    stopped_from: state.phase as "IMPLEMENTING" | "REPAIRING",  // ensured by ensurePhase; cast
  };
  ```
  `ensurePhase(state, "IMPLEMENTING", "REPAIRING")` guarantees the phase at runtime; the
  `stopped_from` cast is the safe producer-side narrowing for the `StopContext` discriminant.
- DONE gates (satisfied criteria / passed validations / no known failures) unchanged.

### `submitReview`

- `findings(args.blocking_findings ?? [], "blocking_findings", true)` ->
  `BlockingFinding[]`; `(..., false)` -> `OptionalFinding[]` (overloads).
- `priorIds` from both buckets; `resolutionMap(...)`; the still-present classification loop
  (`item.finding_id === id` string-vs-brand comparisons are legal); bucket/severity checks
  unchanged; INCONCLUSIVE `stop_context` literal matches the second `StopContext` variant.
- `next.review_receipt = args.review_receipt ? JSON.parse(JSON.stringify(args.review_receipt)) as ChangeReceipt : null` — the store validates receipts canonically before calling (documented cast).

### `authorizeRepair` / `linkedFollowupInput` — use `findingIdList`

- `const ids = findingIdList(args.finding_ids, "finding_ids", "ERROR_INVALID_REPAIR");` then keep
  the `ids.length > state.blocking_findings.length` check and the existing-ID / cycle-limit checks.
  (Category+detail identical to today; the Phase C spec already documented the empty-string-id
  edge — both paths fail "finding IDs are invalid".)
- `linkedFollowupInput`: `findingIdList(args.finding_ids, "finding_ids", "ERROR_INVALID_FOLLOWUP")`,
  then the one-bucket check and the `LinkedFollowupPlan` return.
- `authorizeRepair`: `next.repair_cycle += 1` stays `number` (decision 5 of Phase B).

### Commit transitions

- `recordCommit(state, evidence: CommitVerification, input)`: adopt `if (!evidence.ok)` narrowing;
  keep the `MISMATCH_CATEGORIES.has(evidence.mismatch)` defensive check inside the failure branch.
  Success branch builds the committed `CommitResult` from `evidence.commit_hash`.
- `commitMismatch(state, category: CommitMismatchCategory)` — keep the membership check
  (`has(category)` type-checks on the branded union).
- `prepareCommit(state, input, evidence: CommitPreparationEvidence)`:
  ```ts
  next.commit_preparation = {
    attempt_id: randomUUID() as CommitAttemptId,          // documented brand cast
    prepared_head: evidence.prepared_head,
    prepared_tree: evidence.prepared_tree,
    expected_paths: evidence.expected_paths,
    review_receipt_digest: objectDigest(state.review_receipt),
    prepared_at: isoNow(),
  };
  ```
  (`isoNow()` replaces `new Date().toISOString()` — identical output.)
- `submitCommitResult`: attempt-ID match (`state.commit_preparation?.attempt_id !== args.attempt_id`
  -> `ERROR_COMMIT_MISMATCH`), outcome checks, `commit_hash` regex -> `as GitCommitSha` producer
  cast, `boundedString(args.failure_summary, "failure_summary", 2000)`.
- `retryCommit`: clears preparation/result, `recovery_context` kind `"commit"`, `isoNow()`.
- `resumeImplementation` / `resumeReview` / `acceptConcerns` / `authorizeCommit`: same pattern,
  `isoNow()` for `recovered_at` / `accepted_at` / `authorized_at`.

### Receipt-derived helpers

- `changedReceiptPaths` / `dirtyBaselinePaths` / `rangeDirtyBaselinePaths` / `scopeChangedPaths`:
  defensive `null | undefined` params, identical filters and sorts, `includes(entry.state)` on the
  `ReceiptPathState` / `RangePathKind` unions type-check.

### `migrateV1State` (the blind port — highest care)

- Keep `V1_STATE_KEYS` exact-key check, `corrupt(): never` narrowing, and EVERY field check
  verbatim (objective length, repair cycle bounds, phase membership in `V1_PHASES`, null-or-string
  fields, `isStringArray`, `isObject`).
- After the key/isObject checks, cast once:
  ```ts
  const v1 = state as unknown as V1WorkflowState;
  ```
  with an internal interface documenting the v1 shape (all fields raw: `string[]`,
  `Record<string, unknown>`, `unknown` for receipt/finding/commit payloads). Checks then read `v1.*`
  (identical semantics; `Number.isSafeInteger`, `typeof`, `isStringArray` checks preserved).
- Return-object casts (boundary casts on legacy data after the existing shape checks — documented):
  `workflow_id` -> `WorkflowId`; `parent_workflow_id` -> `WorkflowId | null`;
  `implementation_receipt` / `review_receipt` -> `ChangeReceipt | null`;
  `finding_resolution_map` / `prior_finding_classifications` -> `FindingResolutionMap`;
  `blocking_findings` / `optional_findings` -> `BlockingFinding[]` / `OptionalFinding[]`;
  `commit_authorization` -> `CommitAuthorization | null`; `commit_result` -> `CommitResult | null`.
- Phase mapping (`STOPPED_BLOCKED` -> `STOPPED_IMPLEMENTATION_BLOCKED` when
  `implementation_status === "BLOCKED"`, else `STOPPED_REPAIR_EXHAUSTED`) and the full keyed
  return object unchanged (legacy keys + `legacy_evidence` included).

## 7. Decision points (with recommendation)

1. **`args = exactKeys(...)` capture pattern** — required; `input: unknown` is never indexed.
2. **Keep `options.internal` createState path** — RECOMMENDED (dead but behavior-preserving);
   brand cast on `parentWorkflowId`.
3. **`corrupt(): never` + `isObject` type guard** — gives clean narrowing in `migrateV1State`.
4. **`recordCommit` adopts `!evidence.ok`** — typed now; `.mjs` consumers already worked with the
   additive shape (Phase D analysis).
5. **Keep defensive `MISMATCH_CATEGORIES.has` checks** in `recordCommit`/`commitMismatch`.
6. **`stopped_from` cast after `ensurePhase`** — safe producer-side narrowing for `StopContext`.
7. **`LinkedFollowupPlan` exported interface** — consumed by Phase F `store.ts`.
8. **Blind `migrateV1State` port** — strict 1:1; flagged for Phase I verification (migration tests
   unloadable until then).
9. **Keep `changedReceiptPaths` export** (unused today; preserve the public surface).

## 8. Done criteria for Phase E

- `transitions.ts` exists with every signature above; `transitions.mjs` is the shim
  `export * from "./dist/transitions.js";`. No `.mjs` consumer or test file edited.
- `pnpm typecheck` passes; `pnpm build` emits `dist/transitions.js`; committed.
- Oracle passes (SDK-free subset, section 0): 98 tests, 0 fail — including the role-view
  projection tests (exact per-role keys), permitted-actions tests, contract/creation tests,
  repair/commit transition tests, and lifecycle restart tests (all exercise `transitions.ts`
  through the shim + `.mjs` store).
- `migrateV1State`: no oracle coverage this phase (documented risk) — line-for-line port review
  required; Phase I will run `migration.node.mjs`.
- Grep: `rg -n 'transitions\.mjs' .codex` matches only the shim, `store.mjs`, and `.mjs` tests
  (expected until Phase F).
- `git diff --check` clean; commit `transitions.ts`, the shim, and `dist/` together; worktree clean
  after the oracle build.