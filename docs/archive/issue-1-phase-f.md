# Issue 1 — Phase F spec: `store.ts`

Detailed planning for Phase F of `issue-1-plan.md`. Converts `.codex/workflow-mcp/store.mjs` to
TypeScript: the `WorkflowStore` class, SQLite row typing, digest verification, audit envelopes, the
transactional `#mutate` core, and `createLinkedFollowup`. All runtime behavior, validation order,
error categories, and audit output are preserved; the compiled module emits no non-protocol output.

## 0. Current state and prerequisites

- Phases A–E landed and committed (`types.ts`, `errors.ts`, `validation.ts`, `git.ts`,
  `transitions.ts`, shims, committed `dist/`). `pnpm typecheck` passes; oracle subset
  (git/lifecycle/workflow `.mjs` tests) is 98/98 green. Phase E spec archived.
- `store.mjs` is unchanged by prior phases (verified: 685 lines, imports via `git.mjs`/`transitions.mjs`/`validation.mjs`/`errors.mjs` shims).
- Consumers: `server.mjs` (`openStore`), `index.mjs` (`openStore`, `resolveStatePath`,
  `WorkflowStore`), and the `.mjs` tests (`WorkflowStore`, `resolveStatePath`) — all resolve
  through the new shim, no edits.
- Oracle for this phase: `pnpm build && node --test .codex/workflow-mcp/tests/git.node.mjs
  .codex/workflow-mcp/tests/lifecycle.node.mjs .codex/workflow-mcp/tests/workflow.node.mjs`
  (SDK-free subset; the migration/protocol test files still unload until Phase I).
- Coverage note: the store's migration path (`#migrateLegacyRows`) has no oracle coverage this
  phase (migration tests unloadable); port it as a strict 1:1 rewrite and flag for Phase I.

## 1. Transition mechanics

Same as C–E: `store.mjs` -> `store.ts`, replace `store.mjs` with the shim
`export * from "./dist/store.js";`, commit `dist/store.js`. No consumer edits. The `store.mjs` shim
is deleted at Phase G (server entry conversion).

## 2. Imports

```ts
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fail } from "./errors.js";
import {
  createReceipt, currentHead, prepareCommitReceipt, repositoryRoot, reviewRange,
  verifyCommit, verifyCommitResult, verifyReviewReceipt,
} from "./git.js";
import {
  acceptConcerns, authorizeCommit, authorizeRepair, commitMismatch, createState,
  dirtyBaselinePaths, finalizeRepairExhausted, IMPLEMENTATION_STOP_PHASES,
  linkedFollowupChildState, linkedFollowupInput, migrateV1State, prepareCommit,
  rangeDirtyBaselinePaths, recordCommit, resumeImplementation, resumeReview, retryCommit,
  roleView, submitCommitResult, submitImplementation, submitReview,
} from "./transitions.js";
import {
  canonicalJson, compareCapability, exactKeys, exactPaths, expectedVersion, hashCapability,
  issueCapability, isoNow, objectDigest, role, workflowId,
} from "./validation.js";
import type {
  AuditEnvelope, AuditEvent, AuditEventType, AuditOutcome, CapabilityHash, CapabilityToken,
  ChangeReceipt, CommitMismatchCategory, CommitPreparationEvidence, CommitVerification,
  ExactRepoPath, GitCommitSha, IsoTimestamp, LegacyAuditSummary, ParentView, Role,
  RoleCapabilities, RoleView, StateDigest, WorkflowId, WorkflowRow, WorkflowState,
  WorkflowVersion,
} from "./types.js";
```

`mutationInput`, `changedFields`, `auditEnvelope`, `parseState` stay module-level (not exported).

## 3. Module-level helpers

```ts
export function resolveStatePath(root: string): string;   // unchanged hash-derived path

export interface WorkflowStoreOptions {                   // NEW
  repositoryRoot?: string;
  databasePath?: string;
  faultAfterLinkedChildInsert?: boolean;
  faultAfterMigrationUpdate?: boolean;
}

function mutationInput(value: unknown): Record<string, unknown>;   // returns the validated object

function changedFields(
  before: WorkflowState | null,
  after: WorkflowState,
): string[];   // sorted top-level keys minus "version", canonicalJson comparison

function auditEnvelope(
  before: WorkflowState | null,
  after: WorkflowState,
  digestBefore: StateDigest | null,
  options: { linked_workflow_id?: WorkflowId | null; outcome?: AuditOutcome | null } = {},
): AuditEnvelope;

function parseState(row: WorkflowRow): WorkflowState;   // JSON.parse + ERROR_STATE_CORRUPT; cast
```

Implementation details:
- `mutationInput` returns `value` (same reference) typed `Record<string, unknown>` after the
  `ERROR_INVALID_SHAPE` check — callers read `args.xxx` as `unknown`.
- `changedFields`/`auditEnvelope` index state keys via `as Record<string, unknown>` casts (interfaces
  lack index signatures); `objectDigest(after)` for `state_digest_after`; `fail(): never` keeps the
  `parseState` catch type-safe.
- `resolveStatePath` uses `isoNow()`-independent logic (unchanged `createHash` path).

## 4. Class skeleton and constructor

```ts
export class WorkflowStore {
  readonly root: string;
  readonly path: string;
  readonly faultAfterLinkedChildInsert: boolean;
  readonly faultAfterMigrationUpdate: boolean;
  private db: DatabaseSync;
  private closed = false;

  constructor(options: WorkflowStoreOptions = {}) {
    this.root = realpathSync(options.repositoryRoot ?? repositoryRoot(process.cwd()));
    this.path = options.databasePath ?? (process.env.WORKFLOW_MCP_DB_PATH || resolveStatePath(this.root));
    this.faultAfterLinkedChildInsert = options.faultAfterLinkedChildInsert === true;
    this.faultAfterMigrationUpdate = options.faultAfterMigrationUpdate === true;
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON;");
    this.db.exec(`/* unchanged CREATE TABLE / index SQL */`);
    const workflowColumns = this.db
      .prepare("PRAGMA table_info(workflows)")
      .all()
      .map((column) => (column as { name: string }).name);
    if (!workflowColumns.includes("state_digest")) {
      this.db.exec("ALTER TABLE workflows ADD COLUMN state_digest TEXT");
    }
    try {
      this.#migrateLegacyRows();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { if (this.closed) return; this.closed = true; this.db.close(); }
}
```

## 5. Private methods

```ts
private #ensureOpen(): void;                     // ERROR_STORE_CLOSED

private #capabilityHashes(
  capabilities: RoleCapabilities,
): Record<Role, CapabilityHash>;                 // hashCapability per role

private #assertAuth(row: WorkflowRow, actorRole: unknown, token: unknown): Role;
// role(actorRole) -> hash lookup -> compareCapability -> ERROR_CAPABILITY_DENIED;
// RETURNS the validated Role (needed for roleView typing; checks/order unchanged)

private #verifyDigest(row: WorkflowRow): void;   // null digest -> ERROR_MIGRATION_REQUIRED;
                                                 // mismatch -> ERROR_STATE_CORRUPT

private #row(workflowId: WorkflowId): WorkflowRow;
// SELECT * WHERE workflow_id = ?; undefined -> ERROR_NOT_FOUND; then #verifyDigest.
// The format regex stays inside as defense-in-depth (callers brand first, so it never fires).

private #audit(
  workflowId: WorkflowId,
  version: number,                 // audit_events.version is INTEGER
  eventType: AuditEventType,
  actorRole: ActorRole,
  summary: AuditEnvelope,
): void;
// INSERT unchanged; created_at = isoNow()

private #migrateLegacyRows(): void;              // section 6

private #mutate(
  workflowId: unknown,
  actorRole: Role,
  token: unknown,
  expected: unknown,
  eventType: AuditEventType,
  action: (state: WorkflowState) => WorkflowState,
  outcome: AuditOutcome | null | ((next: WorkflowState) => AuditOutcome | null) = null,
): RoleView;                                     // section 7
```

## 6. `#migrateLegacyRows` (blind port — 1:1)

```ts
private #migrateLegacyRows(): void {
  const rows = this.db.prepare("SELECT workflow_id, version, state_json FROM workflows").all() as
    Array<Pick<WorkflowRow, "workflow_id" | "version" | "state_json">>;
  if (rows.length === 0) return;
  this.db.exec("BEGIN IMMEDIATE");
  try {
    let migrated = false;
    for (const row of rows) {
      let parsed: unknown;
      try { parsed = JSON.parse(row.state_json); } catch {
        fail("ERROR_STATE_CORRUPT", "workflow state is invalid");
      }
      const schema = (parsed as { schema_version?: unknown }).schema_version;
      const state = parsed as WorkflowState;      // envelope/before view; migrateV1State revalidates
      if (schema === 1) {
        if (row.version !== (parsed as { version: number }).version) {
          fail("ERROR_STATE_CORRUPT", "workflow state is invalid");
        }
        const next = migrateV1State(parsed);
        next.version = ((parsed as { version: number }).version + 1) as WorkflowVersion;
        const now = isoNow();
        const result = this.db.prepare(
          "UPDATE workflows SET version = ?, state_json = ?, state_digest = ?, updated_at = ? WHERE workflow_id = ? AND version = ?",
        ).run(next.version, JSON.stringify(next), objectDigest(next), now, row.workflow_id, row.version);
        if (result.changes !== 1) fail("ERROR_STATE_CORRUPT", "workflow state is invalid");
        if (this.faultAfterMigrationUpdate) fail("ERROR_INJECTED_FAILURE", "injected migration failure");
        this.#audit(row.workflow_id as WorkflowId, next.version, "WORKFLOW_MIGRATED", "parent",
          auditEnvelope(state, next, null, { outcome: next.phase }));
        migrated = true;
      } else if (schema !== 2) {
        fail("ERROR_STATE_CORRUPT", "workflow state is invalid");
      }
    }
    if (migrated) this.db.exec("COMMIT");
    else this.db.exec("ROLLBACK");
  } catch (error) {
    this.db.exec("ROLLBACK");
    throw error;
  }
}
```

Key points:
- A single raw `JSON.parse` per row: `schema_version` is read from the untyped parse (the literal-2
  `WorkflowState` type makes `state.schema_version === 1` a compile error — hence the raw parse).
- `migrateV1State(parsed)` takes `unknown` and performs the full v1 validation exactly as before.
- `row.workflow_id as WorkflowId` / `+1 as WorkflowVersion` are documented boundary casts (row is
  DB-trusted; version arithmetic crosses the brand).

## 7. `#mutate` (the transactional core)

```ts
private #mutate(
  workflowId: unknown, actorRole: Role, token: unknown, expected: unknown,
  eventType: AuditEventType,
  action: (state: WorkflowState) => WorkflowState,
  outcome: AuditOutcome | null | ((next: WorkflowState) => AuditOutcome | null) = null,
): RoleView {
  this.#ensureOpen();
  const expectedVersionNumber = expectedVersion(expected);
  const id = workflowId(workflowId);                 // brand at boundary; regex also inside #row
  this.db.exec("BEGIN IMMEDIATE");
  try {
    const row = this.#row(id);
    const selectedRole = this.#assertAuth(row, actorRole, token);
    if (row.version !== expectedVersionNumber) fail("ERROR_VERSION_CONFLICT", "workflow version is stale");
    const current = parseState(row);
    const next = action(current);
    const nextVersion = (expectedVersionNumber + 1) as WorkflowVersion;
    next.version = nextVersion;
    const now = isoNow();
    const result = this.db.prepare(
      "UPDATE workflows SET version = ?, state_json = ?, state_digest = ?, updated_at = ? WHERE workflow_id = ? AND version = ?",
    ).run(nextVersion, JSON.stringify(next), objectDigest(next), now, id, expectedVersionNumber);
    if (result.changes !== 1) fail("ERROR_VERSION_CONFLICT", "workflow version is stale");
    const resolvedOutcome = typeof outcome === "function" ? outcome(next) : outcome;
    this.#audit(id, nextVersion, eventType, selectedRole,
      auditEnvelope(current, next, row.state_digest as StateDigest | null, { outcome: resolvedOutcome }));
    this.db.exec("COMMIT");
    return roleView(next, selectedRole);
  } catch (error) {
    this.db.exec("ROLLBACK");
    throw error;
  }
}
```

## 8. Validation-order preservation (CRITICAL)

The current runtime order must be unchanged; eager common-args validation in the public methods
would silently reorder error categories:

| Step | Current order | Phase F placement |
|---|---|---|
| 1 | `mutationInput` (ERROR_INVALID_SHAPE) | `const args = mutationInput(input)` in each public method |
| 2 | `expectedVersion` (ERROR_INVALID_VERSION) | top of `#mutate` / explicit in `createLinkedFollowup` |
| 3 | workflow_id format (ERROR_NOT_FOUND) | `workflowId(...)` immediately after step 2 (before `BEGIN`) |
| 4 | capability (ERROR_CAPABILITY_DENIED) | inside `#assertAuth` (after `BEGIN`, as today) |
| 5 | version conflict | unchanged inside `#mutate` |

`get`/`audit`: `#ensureOpen` -> `workflowId(...)` -> `#row` -> `#assertAuth` (returns Role) ->
view/audit rows. `createLinkedFollowup`: `#ensureOpen` -> `mutationInput` -> `expectedVersion` ->
`workflowId(...)` -> `BEGIN` -> `#row` -> `#assertAuth` -> version conflict -> transition logic.

## 9. Public methods

```ts
create(input: unknown): { workflow: ParentView; capabilities: RoleCapabilities };
get(workflowId: unknown, actorRole: unknown, token: unknown): RoleView;
audit(workflowId: unknown, actorRole: unknown, token: unknown): AuditEvent[];

submitImplementation(input: unknown): RoleView;
resumeImplementation(input: unknown): RoleView;
acceptConcerns(input: unknown): RoleView;
submitReview(input: unknown): RoleView;
authorizeRepair(input: unknown): RoleView;
resumeReview(input: unknown): RoleView;
finalizeRepairExhausted(input: unknown): RoleView;
authorizeCommit(input: unknown): RoleView;
recordCommit(input: unknown): RoleView;
prepareCommit(input: unknown): RoleView;
submitCommitResult(input: unknown): RoleView;
retryCommit(input: unknown): RoleView;

createLinkedFollowup(input: unknown): { workflow: ParentView; capabilities: RoleCapabilities };
```

Per-method notes (each starts `const args = mutationInput(input);`):

- **`create`** — unchanged order: `currentHead` -> `createState` -> working-tree
  `createReceipt(..., true)` / range `reviewRange` (the `review_mode === "working_tree"` narrowing
  makes the else-branch `CommitRangeReviewTarget`, satisfying `reviewRange`'s param type) ->
  `state.workflow_id = randomUUID() as WorkflowId` -> capabilities (`issueCapability()` x4,
  `#capabilityHashes`) -> BEGIN/INSERT (`objectDigest(state)`) -> `#audit(id, 0,
  "WORKFLOW_CREATED", "parent", auditEnvelope(null, state, null))` -> COMMIT ->
  `{ workflow: roleView(state, "parent"), capabilities }` (overload -> `ParentView`).
- **`submitImplementation`** — `eventType`/`outcome` from `args.status === "DONE"` ternary;
  `IMPLEMENTATION_STOP_PHASES[args.status as "DONE_WITH_CONCERNS" | "NEEDS_CONTEXT" | "BLOCKED"]`
  (key cast; the branch guarantees non-DONE). Action: fresh receipt + base check + canonical
  receipt equality (`canonicalJson(args.implementation_receipt)`), then
  `submitImplementation(state, args, this.root, currentReceipt)`.
- **`submitReview`** — action: `exactKeys(args.review_target, [...7 keys], "review_target")`;
  normalized target built from `args.review_target as Record<string, unknown>` with
  `approved_paths: exactPaths(...)`; canonical equality vs `state.review_target`; `submitReview`
  transition; APPROVED working-tree requires receipt and `verifyReviewReceipt(this.root,
  args.review_receipt as ChangeReceipt, state.approved_paths, state.base_head)` (cast documented:
  canonical receipt equality is enforced at the store/transition boundary). Outcome =
  `args.review_status as ReviewStatus` (only consumed after the action validates it).
- **`authorizeCommit`** — action: working-tree check (discriminated narrowing), missing-receipt
  check, `verifyReviewReceipt(this.root, state.review_receipt, ...)` (narrowed non-null), then
  `authorizeCommit(state, args)`.
- **`recordCommit`** — `exactKeys(args, [4 keys], "commit record")`; action: legacy check, phase
  check, `verifyCommit(this.root, state, args.commit_hash)` -> `recordCommit(state, evidence, args)`;
  outcome `(next) => next.commit_result!.outcome` (non-null assertion — `recordCommit` always sets
  it; preserves today's semantics).
- **`prepareCommit`** — action: `prepareCommitReceipt(this.root, state)` ->
  `prepareCommit(state, args, evidence)` (`CommitPreparationEvidence`).
- **`submitCommitResult`** — `exactKeys(args, [7 keys], "commit result")`; action: transition then
  `verifyCommitResult(this.root, state, args)` -> `commitMismatch` on non-null; outcome
  `(next) => next.commit_result!.outcome`.
- **`retryCommit`** — `exactKeys(args, [4 keys], "commit retry")`; outcome literal `"retry"`.
- **`finalizeRepairExhausted`** — outcome literal `"STOPPED_REPAIR_EXHAUSTED"` (in `AuditOutcome`).
- **`resumeImplementation` / `acceptConcerns` / `authorizeRepair` / `resumeReview`** — no store-side
  `exactKeys` (the transitions validate); event types unchanged.
- **`createLinkedFollowup`** — `expectedVersion(args.expected_version)` and
  `workflowId(args.workflow_id)` before `BEGIN`; `#row(id)`; `#assertAuth(row, "parent",
  args.capability)`; version-conflict check against `expectedVersionNumber`; `linkedFollowupInput`
  -> `linkedFollowupChildState` -> child receipt/baseline -> `randomUUID() as WorkflowId` child id ->
  child INSERT -> `#audit(childId, 0, "WORKFLOW_CREATED", "parent", { linked_workflow_id:
  state.workflow_id })` -> parent `next = { ...state, version: (expectedVersionNumber + 1) as
  WorkflowVersion }` -> UPDATE -> `#audit(row.workflow_id as WorkflowId, next.version,
  "LINKED_FOLLOWUP_CREATED", "parent", { linked_workflow_id: childId })` -> fault injection check ->
  COMMIT -> child parent-view + capabilities.
- **`audit()` read** — `SELECT version, event_type, actor_role, summary_json, created_at ... ORDER
  BY event_id`; map with boundary casts: `event_type as AuditEventType`, `actor_role as ActorRole`,
  `summary: JSON.parse(...) as AuditEnvelope | LegacyAuditSummary`, `created_at as IsoTimestamp`
  (legacy rows may fall outside the unions — documented).

## 10. SQLite typing notes

- `.get()` / `.all()` results cast to `WorkflowRow` / partial picks / audit-row shape at the read
  sites (`as` after the DB call); `PRAGMA table_info` columns via `(column as { name: string }).name`.
- `.run(...)` params accept `SQLInputValue`; branded strings/numbers pass directly; raw `unknown`
  values are always branded (`workflowId`, `expectedVersion`) before reaching `.run`.

## 11. Decision points (with recommendation)

1. **No eager common-args validation** — public methods pass raw unknowns into `#mutate`;
   branding happens in the existing validation order (section 8). RECOMMENDED (behavior-critical).
2. **`#assertAuth` returns the validated `Role`** — enables `roleView(next, selectedRole)` and the
   `get`/`audit` returns; checks and order unchanged.
3. **Raw-parse `#migrateLegacyRows`** — single `JSON.parse`, branch on untyped `schema_version`
   (avoids the literal-2 comparison compile error); `migrateV1State(parsed)` revalidates fully.
4. **`next.commit_result!.outcome`** — non-null assertion in outcome callbacks (preserves current
   semantics; `recordCommit`/`submitCommitResult` always set `commit_result`).
5. **`as StateDigest | null` on `row.state_digest`** after `#verifyDigest` — producer cast.
6. **`version: number` on `#audit`** — the column is INTEGER; brand casts stay at `#mutate`/migration
   call sites.
7. **Preserve `export { exactPaths }`** re-export (library compatibility; Phase B plan note).
8. **`WorkflowStoreOptions` interface** replaces the inline `options = {}` shape (repositoryRoot,
   databasePath, two fault-injection flags).
9. **Blind migration port** — flagged for Phase I verification (migration tests unloadable now).

## 12. Done criteria for Phase F

- `store.ts` exists with every signature above; `store.mjs` is the shim
  `export * from "./dist/store.js";`. No `.mjs` consumer or test file edited.
- `pnpm typecheck` passes; `pnpm build` emits `dist/store.js`; committed.
- Oracle passes (SDK-free subset): 98 tests, 0 fail — lifecycle restart tests, store-level
  transition/audit/digest tests, and the `exactPaths` re-export remain intact.
- Spot checks held: exact digest continuity, changed-fields sets, append-only audit order,
  fault-injection rollbacks, capability-denial categories, version-conflict categories, stale-base
  receipts, and linked-followup atomicity (through the `.mjs` tests).
- Grep: `rg -n 'store\.mjs' .codex` matches only the shim, `server.mjs`, `index.mjs`, and `.mjs`
  tests (expected until Phase G).
- `git diff --check` clean; commit `store.ts`, the shim, and `dist/` together; worktree clean after
  the oracle build.