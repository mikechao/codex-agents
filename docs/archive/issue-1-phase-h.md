# Issue 1 — Phase H spec: `change-receipt.ts` (the atomic receipt-CLI flip)

Detailed planning for Phase H of `issue-1-plan.md`. Converts `.codex/agents/change-receipt.mjs` to
TypeScript, compiles it to `.codex/agents/dist/change-receipt.js`, converts its test, and — in one
atomic change (as promised in the Phase D spec, section 7) — flips every receipt path to the
compiled artifact: `git.ts` spawn path, the loadable workflow `.mjs` test fixtures, and the
`WORKFLOW.md`/`implementer.toml` commands. Receipt output stays byte-identical.

## 0. Current state and prerequisites

- Phases A–G landed and committed. `pnpm typecheck` passes; oracle subset 98/98; the compiled
  STDIO entry smoke-tested. Phase G spec archived.
- `change-receipt.mjs` (309 lines) is untouched since MCP-1.x. It is a self-contained Node CLI
  (node builtins only) that exports `createReceipt`/`safePaths` and runs `main()` under the
  `import.meta.url` guard. It is spawned by `git.ts` `createReceipt` and copied into temp repos by
  the workflow tests; `install-into.sh` copies the whole `.codex/agents/` tree (so the compiled
  artifact under `.codex/agents/dist/` is deployed automatically).
- `tsconfig.agents.json` already targets `change-receipt.ts` + `tests/**/*.ts` ->
  `dist/change-receipt.js` + `dist/tests/change-receipt.node.js`; `pnpm test:agents` already runs
  `pnpm build && node --test .codex/agents/dist/tests/*.node.js` (green for the first time once
  this phase lands).
- `change-receipt.mjs` references outside itself: `git.ts` (spawn), three loadable workflow tests
  (`git/lifecycle/workflow.node.mjs` — copy + spawn), the unloadable SDK tests (Phase I), and
  `WORKFLOW.md:311` + `implementer.toml:54` (commands).

## 1. Why no shim for this module

A re-export shim (`export * from "./dist/change-receipt.js"`) would NOT work for the receipt CLI:
it is spawned by path, and the CLI guard (`import.meta.url === file://${process.argv[1]}`) only
fires when the compiled file itself is `argv[1]`. So the `.mjs` file is deleted outright and the
compiled file becomes the CLI. Consequence: the receipt's own test must move to TypeScript in this
phase (it is part of the same compile unit), and the three loadable workflow tests get mechanical
path edits. This is the documented exception to "no test edits" (Phase D spec, section 7).

## 2. `.codex/agents/change-receipt.ts` (1:1 port, local types)

The module stays **self-contained**: `tsconfig.agents.json` has `rootDir .codex/agents`, so it must
NOT import from `../workflow-mcp/types.ts` (rootDir violation). Define local structural types that
mirror the receipt contract v1 (the Phase B `ChangeReceipt` family describes the same wire shape;
no cross-module dependency):

```ts
type GitMode = "100644" | "100755" | "120000";

interface HeadEntry {
  mode: GitMode;
  kind: "symlink" | "file";
  digest: string;
}

interface ReceiptEntry {
  path: string;
  state: "added" | "modified" | "deleted" | "unchanged" | "absent";
  kind: "file" | "symlink" | "missing";
  mode?: GitMode;        // present except for absent/deleted-absent entries
  digest?: string;
}

interface Receipt {
  schema_version: 1;
  base_head: string;
  approved_paths: string[];
  paths: ReceiptEntry[];
  overall_scope_hash: string;
}
```

Signatures (all internal except `safePaths`/`createReceipt`; error categories are thrown as
`new Error("ERROR_...")` exactly as today — the CLI's `fail()` is the only non-throwing path and
returns `2`):

```ts
const SCHEMA_VERSION = 1;

function fail(category: string): number;                 // stderr write + return 2 (CLI only)
function runGit(repositoryRoot: string, args: readonly string[]): string;      // ERROR_GIT
function readGitBlob(repositoryRoot: string, objectId: string): Buffer;        // ERROR_GIT_SIZE / ERROR_GIT
function repositoryRoot(cwd = process.cwd()): string;                          // ERROR_NOT_REPOSITORY
function requireHead(root: string): string;                                    // ERROR_NO_HEAD
function normalizePath(root: string, input: string): string;                   // ERROR_EMPTY_PATH / ERROR_UNSAFE_PATH
function assertSafeParent(root: string, path: string): void;                   // ERROR_UNSAFE_PATH / ERROR_PATH_ACCESS
export function safePaths(root: string, inputs: string[]): string[];           // ERROR_EMPTY_PATHS / ERROR_DUPLICATE_PATH
function headEntry(root: string, path: string): HeadEntry | null;              // ERROR_GIT / ERROR_UNSUPPORTED_MODE
function normalizeMode(mode: string): GitMode;                                 // ERROR_UNSUPPORTED_MODE
function digest(value: Buffer): string;
function currentMetadata(root: string, path: string, head: HeadEntry | null): ReceiptEntry;
function canonicalReceipt(receipt: Receipt): string;      // JSON.stringify of the 4 fields, byte-identical
function validateOptions(options: unknown): { allowAbsent: boolean };          // ERROR_INVALID_ARGUMENTS
export function createReceipt(
  inputs: string[],
  cwd = process.cwd(),
  options: Record<string, unknown> = {},
): Receipt;                                                                     // ERROR_EMPTY_PATHS
function createReceiptAtRoot(inputs: string[], root: string, options: { allowAbsent: boolean }): Receipt;
function main(): number;
```

Port rules (strict 1:1):
- Every `ERROR_*` category, detail-less stderr line, exit code, and stdout JSON line is identical.
- `currentMetadata` branches (ENOENT + head -> `deleted`; absent opt-in; symlink/file modes;
  directory/other -> `ERROR_DIRECTORY_PATH`/`ERROR_UNSUPPORTED_FILE_TYPE`) verbatim.
- The `catch` narrowing uses `error instanceof Error && error.message === "..."` (Node 22 typed
  `catch` is `unknown`).
- `canonicalReceipt` stays plain `JSON.stringify` (NOT canonicalJson — this module has no
  dependency and the byte output must not change).
- Entry guard unchanged:
  ```ts
  if (import.meta.url === `file://${process.argv[1]}`) {
    process.exitCode = main();
  }
  ```
- tsc does not emit the `#!/usr/bin/env node` shebang — irrelevant (spawned via `process.execPath`).

## 3. `.codex/agents/tests/change-receipt.node.mjs` -> `.node.ts`

Converted with mechanical typing (assert/node:test/child_process/fs imports unchanged; helper
params annotated: `git(root: string, ...args: string[])`, `run(root: string, paths: string[])`,
`runWithFlags(root: string, flags: string[], paths: string[])`, `receipt(root: string, paths:
string[])`). Two changes:

- `import { createReceipt, safePaths } from "../change-receipt.mjs"` ->
  `from "../change-receipt.js"` (compiles to `dist/change-receipt.js`; the compiled test lives at
  `dist/tests/` so `../change-receipt.js` resolves to `dist/change-receipt.js`).
- `const utility = resolve(import.meta.dirname, "..", "change-receipt.mjs")` ->
  `resolve(import.meta.dirname, "..", "change-receipt.js")`.

All 19+ existing cases keep their assertions (byte-compatible receipts, CLI stdout/stderr contract,
option validation, symlink safety). No behavioral weakening.

## 4. `git.ts` spawn path

```ts
// before
const script = join(root, ".codex", "agents", "change-receipt.mjs");
// after
const script = join(root, ".codex", "agents", "dist", "change-receipt.js");
```

Everything else in `createReceipt` (spawn flags, stderr category parsing, `ERROR_RECEIPT_UNAVAILABLE`
fallback) unchanged. Rebuild commits `dist/git.js`.

## 5. Loadable workflow `.mjs` tests — mechanical path edits (documented exception)

For `git.node.mjs`, `lifecycle.node.mjs`, `workflow.node.mjs` (the three oracle files):

- Copy source: `join(process.cwd(), ".codex", "agents", "change-receipt.mjs")` ->
  `join(process.cwd(), ".codex", "agents", "dist", "change-receipt.js")`.
- Copy destination: `join(root, ".codex", "agents", "change-receipt.mjs")` ->
  `join(root, ".codex", "agents", "dist", "change-receipt.js")`.
- Fixture mkdir: the existing `mkdirSync(join(root, ".codex", "agents"), { recursive: true })`
  becomes `mkdirSync(join(root, ".codex", "agents", "dist"), { recursive: true })`.
- Spawn path: `realpathSync(join(root, ".codex", "agents", "change-receipt.mjs"))` ->
  `...join(root, ".codex", "agents", "dist", "change-receipt.js")`.

(workflow.node.mjs has ~10 such sites; git/lifecycle ~3 each. The unloadable protocol tests are
updated at Phase I.)

## 6. Documentation commands

- `WORKFLOW.md:311` and `implementer.toml:54`:
  `node .codex/agents/change-receipt.mjs -- path/a path/b` ->
  `node .codex/agents/dist/change-receipt.js -- path/a path/b`.
- `install-into.sh` needs NO change this phase: `cp -R .codex/agents/.` already carries
  `dist/change-receipt.js` into target repos (the copy-scoping refinement stays in Phase J).

## 7. Verification

1. `pnpm typecheck` passes (both tsconfigs — the agents config now compiles real files).
2. `pnpm build` emits `dist/change-receipt.js`, `dist/tests/change-receipt.node.js`, and updated
   `dist/git.js`; all committed.
3. **New oracle: `pnpm test:agents`** — `pnpm build && node --test
   .codex/agents/dist/tests/*.node.js` — all receipt cases pass (the suite itself asserts
   byte-compatibility).
4. Existing oracle: `pnpm build && node --test .codex/workflow-mcp/tests/git.node.mjs
   .codex/workflow-mcp/tests/lifecycle.node.mjs .codex/workflow-mcp/tests/workflow.node.mjs` —
   98/98 (the server now spawns the compiled receipt from the temp-repo fixtures).
5. CLI spot check against a temp git repo: `node .codex/agents/dist/change-receipt.js -- note.txt`
   returns the same JSON as the old `.mjs` (verified by the suite; optional manual check).
6. Grep: `rg -n 'change-receipt\.mjs' .codex .codex/agents` matches nothing except `docs/archive/`
   and historical `issue-1-plan.md` text.
7. `git diff --check` clean; worktree clean after builds; single commit: `change-receipt.ts`, the
   converted test, `git.ts` edit, the three test edits, docs, and `dist/`.

## 8. Decision points (with recommendation)

1. **No shim; delete `change-receipt.mjs`; test converts in this phase** — RECOMMENDED (the CLI
   entry guard is path-sensitive; atomic flip per Phase D spec section 7).
2. **Local structural types in `change-receipt.ts`** — no cross-rootDir import from
   `workflow-mcp/types.ts`; the receipt contract types are mirrored locally (single leaf module,
   standalone artifact for `install-into.sh`).
3. **Plain `JSON.stringify` for `canonicalReceipt`** — must stay byte-identical to today.
4. **Mechanical edits to the three loadable `.mjs` tests** — required and documented; Phase I
   replaces these files with the TS suite.
5. **Docs commands flipped now** — part of the atomic change; `install-into.sh` untouched until
   Phase J's copy-scoping.

## 9. Done criteria for Phase H

- `change-receipt.ts` + converted `change-receipt.node.ts` compile; `change-receipt.mjs` deleted;
  `dist/change-receipt.js` and `dist/tests/change-receipt.node.js` committed.
- `git.ts` spawns `dist/change-receipt.js`; the three loadable workflow tests use the compiled
  path; docs commands updated.
- `pnpm typecheck`, `pnpm test:agents`, and the workflow oracle subset (98/98) all pass.
- No `change-receipt.mjs` references remain in runnable code, tests, config, or docs.
- `git diff --check` clean; worktree clean after the oracle builds.