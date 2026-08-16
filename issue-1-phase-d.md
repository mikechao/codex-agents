# Issue 1 — Phase D spec: `git.ts`

Detailed planning for Phase D of `issue-1-plan.md`. Converts `.codex/workflow-mcp/git.mjs` to
TypeScript, types every git helper with the domain/branded values from `types.ts`, and refactors
`verifyCommit` to the `ok`-discriminated `CommitVerification`. All runtime behavior, error
categories, and check ordering are preserved; the compiled module emits no non-protocol output.

## 0. Current state and prerequisites

- Phases A/B/C landed and committed: tooling, `types.ts`, `errors.ts`, `validation.ts` (exact
  producer signatures verified), shims `errors.mjs`/`validation.mjs`, committed `dist/`.
- `pnpm typecheck` passes; `pnpm build` emits `dist/types.js`, `dist/errors.js`,
  `dist/validation.js`.
- **Oracle correction** (learned during Phase C verification): the `.mjs` suite cannot load in
  full — `migration.node.mjs`, `protocol.node.mjs`, and `protocol-v2.node.mjs` import the removed
  v1 `@modelcontextprotocol/sdk` (`ERR_MODULE_NOT_FOUND`). That is a pre-existing Phase A
  consequence, fixed only at Phase I (tests). The per-phase oracle for Phases C–G is the
  SDK-free subset:

  ```sh
  pnpm build && node --test .codex/workflow-mcp/tests/git.node.mjs \
    .codex/workflow-mcp/tests/lifecycle.node.mjs .codex/workflow-mcp/tests/workflow.node.mjs
  ```

  Verified green before this phase: 98 tests, 0 fail.

## 1. Transition mechanics

Same as Phase C: convert `git.mjs` -> `git.ts`, replace `git.mjs` with the shim
`export * from "./dist/git.js";`, and commit `dist/git.js`. No consumer edits: `store.mjs`,
`transitions.mjs`, and `git.node.mjs` keep importing `./git.mjs` / `../git.mjs`, resolving through
the shim to the single compiled module. The `git.mjs` shim is deleted at Phase F (when
`store.mjs`/`transitions.mjs` are converted).

## 2. Imports and internal helpers

```ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fail } from "./errors.js";
import { canonicalJson, exactPaths } from "./validation.js";
import type {
  ChangeReceipt, CommitMismatchCategory, CommitPreparationEvidence, CommitVerification,
  ContentDigest, ExactRepoPath, GitBlobSha, GitCommitSha, GitFileMode, GitTreeEntry,
  GitTreeSha, ReviewRange, WorkflowState,
} from "./types.js";
```

Internal (not exported):

```ts
function git(root: string, args: readonly string[], maxBuffer = 4 * 1024 * 1024): string;
function gitStatus(root: string, args: readonly string[]): { status: number; output: string };

// Raw, unvalidated `git ls-tree` record (Phase B note: private to git.ts, not in types.ts).
interface GitLsTreeRecord { mode: string; type: string; object: string; }

function treeEntry(root: string, revision: GitCommitSha, path: ExactRepoPath): GitLsTreeRecord | null;
function treeEntries(root: string, revision: GitCommitSha): Map<ExactRepoPath, GitTreeEntry>;
function normalizeMode(mode: string): GitFileMode;                    // ERROR_UNSUPPORTED_MODE
function digest(value: Buffer): ContentDigest;                        // sha256 hex
function commitChangedPaths(root: string, fromRevision: GitCommitSha, toRevision: GitCommitSha): ExactRepoPath[];
```

`commitChangedPaths` keeps its `ERROR_COMMIT_MISMATCH` checks; rename/copy status handling
(`R`/`C` + destination) unchanged.

## 3. Exported signatures

```ts
export function currentHead(root: string): GitCommitSha;              // ERROR_NO_HEAD
export function repositoryRoot(cwd: string): string;                  // absolute path — NOT ExactRepoPath
export function verifyRevision(root: string, revision: string): GitCommitSha;      // ERROR_INVALID_REVISION
export function verifyRange(
  root: string, baseRevision: GitCommitSha, headRevision: GitCommitSha,
): { base_revision: GitCommitSha; head_revision: GitCommitSha };      // ERROR_INVALID_REVISION / ERROR_NON_ANCESTOR
export function reviewRange(root: string, target: CommitRangeReviewTarget): ReviewRange; // ERROR_INVALID_REVIEW_PATH
export function verifyReviewReceipt(
  root: string, receipt: ChangeReceipt,
  expectedPaths: ReadonlyArray<ExactRepoPath>, baseHead: GitCommitSha,
): ChangeReceipt;                                                     // ERROR_STALE_RECEIPT
export function createReceipt(
  root: string, expectedPaths: ReadonlyArray<ExactRepoPath>, allowAbsent = false,
): ChangeReceipt;                                                     // child ERROR_* / ERROR_RECEIPT_UNAVAILABLE
export function verifyCommit(root: string, state: WorkflowState, commitHash: unknown): CommitVerification;
export function stagedPaths(root: string): ExactRepoPath[];
export function stagedEntries(root: string): Map<ExactRepoPath, GitTreeEntry>;
export function approvedResidue(
  root: string, approvedPaths: ReadonlyArray<ExactRepoPath>, staged: ReadonlyArray<ExactRepoPath>,
): ExactRepoPath[];
export function writeTree(root: string): GitTreeSha;                  // ERROR_GIT
export function prepareCommitReceipt(root: string, state: WorkflowState): CommitPreparationEvidence;
export function verifyPreparedCommit(root: string, state: WorkflowState, commitHash: unknown): CommitMismatchCategory | null;
export function verifyCommitResult(root: string, state: WorkflowState, input: Record<string, unknown>): CommitMismatchCategory | null;
```

Notes on parameter choices:

- `verifyCommit` / `verifyPreparedCommit` take `commitHash: unknown` — the value comes from
  untrusted MCP input; the function's existing `typeof`/regex check is the boundary and returns
  `{ ok: false, mismatch: "HEAD_CHANGED" }` / `"HEAD_CHANGED"` for malformed values. No Phase F
  cast needed.
- `verifyCommitResult(root, state, input: Record<string, unknown>)` reads `input.outcome` /
  `input.commit_hash` as `unknown` and keeps its `ERROR_INVALID_SHAPE` fallback for other outcomes.
- `reviewRange(root, target: CommitRangeReviewTarget)` — the only caller (`store.create`'s
  else-branch after `review_mode === "working_tree"` narrowing) already has the narrowed type;
  `verifyRange(root, target.base_revision, target.head_revision)` then type-checks.
- `verifyRevision(root, revision: string)` — the regex check brands the return; callers may pass
  plain strings (tests do).
- `repositoryRoot` stays `string`: it returns an absolute filesystem path, not a repo-relative
  `ExactRepoPath` (Phase B note).

## 4. `verifyCommit` -> `CommitVerification` (the one shape refactor)

```ts
export function verifyCommit(root: string, state: WorkflowState, commitHash: unknown): CommitVerification {
  if (typeof commitHash !== "string" || !/^[0-9a-f]{40}$/u.test(commitHash)) {
    return { ok: false, mismatch: "HEAD_CHANGED" };
  }
  const head = currentHead(root);
  if (head !== commitHash) return { ok: false, mismatch: "HEAD_CHANGED" };
  const parent = git(root, ["rev-list", "--parents", "-n", "1", commitHash]).trim().split(" ");
  if (parent.length !== 2) return { ok: false, mismatch: "PARENT_MISMATCH" };
  if (parent[1] !== state.base_head) return { ok: false, mismatch: "PARENT_MISMATCH" };
  const entries = treeEntries(root, commitHash as GitCommitSha);
  for (const entry of state.review_receipt?.paths ?? []) {
    const tree = entries.get(entry.path);
    if (entry.state === "deleted") {
      if (tree) return { ok: false, mismatch: "TREE_MISMATCH" };
      continue;
    }
    // Absent entries have no mode/digest; JS read them as undefined (always TREE_MISMATCH if a
    // tree entry exists). Map to undefined explicitly to preserve that exact semantics.
    const mode = entry.state === "absent" ? undefined : entry.mode;
    const entryDigest = entry.state === "absent" ? undefined : entry.digest;
    if (!tree || tree.mode !== mode || blobDigest(root, tree.object) !== entryDigest) {
      return { ok: false, mismatch: "TREE_MISMATCH" };
    }
  }
  const expectedChanged = (state.review_receipt?.paths ?? [])
    .filter((entry) => entry.state !== "unchanged")
    .map((entry) => entry.path)
    .sort();
  const actualChanged = commitChangedPaths(root, state.base_head, commitHash as GitCommitSha);
  if (
    actualChanged.length !== expectedChanged.length ||
    actualChanged.some((path, index) => path !== expectedChanged[index])
  ) {
    return { ok: false, mismatch: "PATH_MISMATCH" };
  }
  return { ok: true, commit_hash: commitHash as GitCommitSha, changed_paths: actualChanged };
}
```

**Consumer compatibility (verified by analysis):** the still-`.mjs` consumers
(`store.recordCommit` -> `transitions.recordCommit`) discriminate on `evidence.mismatch` /
`evidence.commit_hash` *presence*, not on `ok`:
- failure: `{ ok: false, mismatch: category }` — `evidence.mismatch` present -> mismatch branch
  (and `MISMATCH_CATEGORIES.has(category)` passes);
- success: `{ ok: true, commit_hash, changed_paths }` — `evidence.mismatch` undefined -> success
  branch with a defined `commit_hash`.

The `ok` discriminator is additive, so no `.mjs` consumer edit is needed in this phase. When
`transitions.ts`/`store.ts` land (Phases E/F), they adopt `if (!evidence.ok)` narrowing.

`prepareCommitReceipt` and `verifyPreparedCommit`/`verifyCommitResult` keep their current shapes
(`CommitPreparationEvidence`, `CommitMismatchCategory | null`) — no change beyond typing.

## 5. Receipt-path union narrowing (other sites)

- `prepareCommitReceipt`: the existing order already narrows cleanly — `entry.state === "deleted"`
  branch, then `if (entry.state !== "added" && entry.state !== "modified") continue;` leaves the
  `added | modified` members where `entry.mode`/`entry.digest` exist. No behavior change.
- `expected_paths` filter: `["added", "modified", "deleted"].includes(entry.state)` — type-safe
  against `ReceiptPathState`.
- `verifyReviewReceipt`: unchanged comparisons against `receipt.base_head`, canonical
  `approved_paths`, and a fresh `createReceipt` — keep byte-identical (`allowAbsent` stays
  default `false` here).

## 6. Producer-side casts (documented, per Phase B rule)

Branded values derived from git output are cast inside `git.ts` only:

- `treeEntries` / `stagedEntries` map values: `{ mode: normalizeMode(fields[0]), object: fields[2] as GitBlobSha }`
  and keys `record.slice(separator + 1) as ExactRepoPath`.
- `reviewRange` base/head: `{ mode: base.mode as GitFileMode, object: base.object as GitBlobSha }`
  — after the existing `type !== "blob"` rejection; do NOT call `normalizeMode` here (the current
  code does not validate mode on this path — casting preserves behavior).
- `stagedPaths` / `approvedResidue` / `commitChangedPaths` paths: `as ExactRepoPath`.
- `currentHead` / `writeTree` / `verifyPreparedCommit` tree parse: `as GitCommitSha` /
  `as GitTreeSha`.
- `blobDigest(root, object: GitBlobSha): ContentDigest` and `digest(...): ContentDigest` casts.

## 7. Deferred item — receipt CLI spawn path (deviation from issue-1-plan.md)

`issue-1-plan.md` Phase D says to flip `createReceipt`'s spawn path to
`join(root, ".codex", "agents", "dist", "change-receipt.js")`. **Deferred to Phase H.** Reason:
the compiled receipt does not exist until Phase H converts `change-receipt.mjs` (no
`dist/change-receipt.js` yet), and the oracle tests copy the receipt into temp repos at the current
path — flipping early would break every receipt operation and the oracle. Phase H flips the path in
one atomic change: `git.ts` spawn path + compiled `change-receipt.js` artifact + test copy/spawn
paths + `WORKFLOW.md`/`implementer.toml` commands + `install-into.sh` copy. Phase D keeps:

```ts
const script = join(root, ".codex", "agents", "change-receipt.mjs");
```

## 8. Decision points (with recommendation)

1. **`CommitVerification` now** — RECOMMENDED. Additive `ok` discriminator keeps `.mjs` consumers
   working unchanged (analysis in section 4); oracle (legacy `recordCommit` paths through the
   `.mjs` store) confirms.
2. **`commitHash: unknown`** on `verifyCommit`/`verifyPreparedCommit` — RECOMMENDED (honest
   untrusted boundary; the internal regex check stays authoritative).
3. **`reviewRange(target: CommitRangeReviewTarget)`** — RECOMMENDED (caller already narrows;
   no runtime change).
4. **`verifyRevision(revision: string)`** — keep `string` param (brands on return).
5. **No `normalizeMode` addition to `reviewRange`** — casting preserves current mode-passthrough
   behavior.
6. **Defer receipt spawn-path flip to Phase H** — deviation from the umbrella plan, documented in
   section 7.
7. **No changes to `verifyPreparedCommit`/`verifyCommitResult` shapes** — keep
   `CommitMismatchCategory | null` (persisted `commit_result` wire shape untouched).

## 9. Done criteria for Phase D

- `git.ts` exists with every signature in sections 2–3; `git.mjs` is the shim
  `export * from "./dist/git.js";`. No `.mjs` consumer or test file edited.
- `pnpm typecheck` passes.
- `pnpm build` emits `dist/git.js` (plus existing dist files); committed.
- Oracle passes (SDK-free subset, section 0): `pnpm build && node --test
  .codex/workflow-mcp/tests/git.node.mjs .codex/workflow-mcp/tests/lifecycle.node.mjs
  .codex/workflow-mcp/tests/workflow.node.mjs` — 98 tests, 0 fail. The three SDK-importing test
  files remain unloadable until Phase I (pre-existing, not a regression).
- Spot behavior checks held: `verifyRange`/`reviewRange` deep-equal assertions,
  `stagedPaths`/`stagedEntries` mode/content assertions, `prepareCommitReceipt` staging
  checks, and the legacy `recordCommit` commit/mismatch paths via the `.mjs` store.
- Grep: `rg -n 'git\.mjs' .codex` matches only the shim and its still-`.mjs` consumers
  (`store.mjs`, `transitions.mjs`) and the `.mjs` tests — expected until Phases E/F.
- `git diff --check` clean; commit `git.ts`, the shim, and `dist/` together. Worktree clean after
  the oracle build.