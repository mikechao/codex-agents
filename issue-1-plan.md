# Issue 1 Plan: Migrate workflow-state MCP to TypeScript + MCP SDK v2

Behavior-preserving infrastructure migration of the local workflow-state MCP server from
JavaScript (`.mjs`) to TypeScript and from `@modelcontextprotocol/sdk` v1 to the MCP TypeScript
SDK v2 server package. No redesign of workflow semantics, agent contracts, state transitions,
repair policy, commit gating, or persisted workflow behavior, except the minimal compatibility
adaptation required by the SDK migration.

## Decisions locked in

- **Layout:** source `.ts` stays where the `.mjs` files are; `tsc` mirrors into `dist/` per component.
- **change-receipt:** also migrated to TS.
- **Tests:** migrated to TS and compiled.
- **`dist/` committed** so Codex/`install-into.sh` run compiled artifacts with no build prerequisite.

## Target layout

```
.codex/workflow-mcp/
  errors.ts  types.ts(new)  validation.ts  git.ts  store.ts  transitions.ts  server.ts  index.ts
  tests/*.node.ts                # TS test sources
  dist/                          # committed compiled ESM (sources + tests)
    *.js
    tests/*.node.js              # committed compiled tests
  README.md
.codex/agents/
  change-receipt.ts
  tests/change-receipt.node.ts
  dist/                          # committed compiled ESM (sources + tests)
    change-receipt.js            # committed; copied by install-into.sh
    tests/change-receipt.node.js
  *.toml  WORKFLOW.md  EVALS.md  EVAL_RESULTS.md
tsconfig.json  tsconfig.workflow-mcp.json  tsconfig.agents.json
```

- Tests emit into `dist/tests/*.node.js` (tsconfig `rootDir` mirror), NOT `tests/dist/`.
- Entry point: `.codex/workflow-mcp/dist/server.js` (config, `pnpm start`, tests).
- Server's `createReceipt` spawns `<root>/.codex/agents/dist/change-receipt.js`; workflow tests
  copy that compiled file into temp repos at the same relative location.

## Phase A — Tooling & build infra  [DONE]

1. **Capture the green baseline FIRST**, before any edit: run `pnpm install && pnpm test` against the
   current `.mjs` sources and v1 SDK. The existing `.mjs` tests import `@modelcontextprotocol/sdk` and
   cannot run once the dependency is removed in step 2, so the baseline must be recorded before the
   swap.
2. **`package.json`**
   - Replace dep `@modelcontextprotocol/sdk@^1.30.0` -> `@modelcontextprotocol/server@^2.0.0`.
   - devDependencies: `@modelcontextprotocol/client@^2.0.0` (tests only), `typescript` (latest
     stable, currently 7.x; fall back to 6.x if the Go-based compiler has gaps),
     `@types/node@^22` (matches `engines.node >= 22`).
   - Scripts:
     - `start`: `node --no-warnings .codex/workflow-mcp/dist/server.js`
     - `build`: `tsc -p tsconfig.workflow-mcp.json && tsc -p tsconfig.agents.json`
     - `typecheck`: same with `--noEmit`
     - `test`: `pnpm build && node --test .codex/workflow-mcp/dist/tests/*.node.js .codex/agents/dist/tests/*.node.js`
     - `test:workflow-mcp` / `test:agents`: `pnpm build && node --test ...` on the matching dist tests
3. **tsconfigs** — strict, ESM NodeNext:
   - `tsconfig.json` is a shared base only: `"files": []` plus the shared `compilerOptions`
     (solution-style), so a bare `tsc` at the repo root is a no-op rather than "No inputs were
     found"; all real builds use `tsc -p tsconfig.workflow-mcp.json` / `tsconfig.agents.json`.
   - `compilerOptions` (base): `target es2023`, `module`/`moduleResolution nodenext`,
     `strict: true`, `verbatimModuleSyntax`, `isolatedModules`, `noEmitOnError`, `skipLibCheck`,
     `forceConsistentCasingInFileNames`, `types: ["node"]` (required for TS >=6 and the v2
     `.d.mts` which references `Buffer`).
   - `tsconfig.workflow-mcp.json`: `rootDir .codex/workflow-mcp`, `outDir .codex/workflow-mcp/dist`,
     include `.codex/workflow-mcp/**/*.ts` (sources + tests -> `dist/*.js`, `dist/tests/*.node.js`).
   - `tsconfig.agents.json`: `rootDir .codex/agents`, `outDir .codex/agents/dist`, include
     `change-receipt.ts` + `tests/**/*.ts` -> `dist/change-receipt.js`, `dist/tests/change-receipt.node.js`.
   - Start with `strict` only (not `noUncheckedIndexedAccess`) to keep the mechanical migration
     faithful; revisit as a follow-up.
4. `pnpm install` to update the lockfile (drops the v1 SDK, adds the v2 packages).

### Done Report — Phase A

**Baseline (captured before edits):** `pnpm install && pnpm test` → 154 tests, 0 fail on `.mjs` +
v1 SDK.

**Changes:**
- `package.json` — swapped `@modelcontextprotocol/sdk@^1.30.0` → `@modelcontextprotocol/server@^2.0.0`;
  added devDeps `@modelcontextprotocol/client@^2.0.0`, `typescript@^7.0.2`, `@types/node@^22`;
  scripts now `start` → `dist/server.js`, plus `build`, `typecheck`, and `test`/`test:agents`/
  `test:workflow-mcp` all rebuild `dist/` first and run compiled `*.node.js`.
- `tsconfig.json` — solution-style base (`files: []`, es2023/nodenext/strict/verbatimModuleSyntax/
  isolatedModules/noEmitOnError/skipLibCheck/`types:["node"]`).
- `tsconfig.workflow-mcp.json` — `rootDir .codex/workflow-mcp`, `outDir` `dist`, includes `**/*.ts`.
- `tsconfig.agents.json` — `rootDir .codex/agents`, `outDir` `dist`, includes `change-receipt.ts` +
  `tests/**/*.ts`.
- `pnpm-lock.yaml` — lockfile refreshed (drops v1 SDK + 81 packages, adds the 4 new ones).

**Verified:** `pnpm ls` shows the 4 expected packages; no `@modelcontextprotocol/sdk` in
lockfile/package.json; both `tsc -p` configs parse with exit 0; bare `tsc` is a benign empty-files
no-op (TS 7 reports TS18002, matching the plan's intent). Note `git status` also shows pre-existing
untracked `issue-1-phase-b.md`/`issue-1-plan.md` — untouched.

## Phase B — Domain types (new `.codex/workflow-mcp/types.ts`)  [DONE]

Pure types; validation functions (Phase C) are the only producers of branded values. Enumerated
from the actual runtime code:

- **Branded identity/value types** (selective, `string & {__brand}` / `number & {__brand}`):
  `WorkflowId`, `GitCommitSha`, `GitTreeSha`, `GitBlobSha`, `ExactRepoPath`, `FindingId`,
  `StateDigest`, `ContentDigest`, `CapabilityToken`, `CapabilityHash`, `IsoTimestamp`,
  `WorkflowVersion`, `CommitAttemptId`.
- **Unions:** `Role`, `WorkflowPhase` (15 phases), `WorkflowType`, `ImplementationStatus`,
  `ReviewStatus`, `FindingSeverity`, `FindingResolution`, `AcceptanceStatus`, `ValidationStatus`,
  `RangePathKind`, `GitFileMode` (`"100644"|"100755"|"120000"`), `CommitOutcome`,
  `CommitMismatchCategory`, `WorkflowAction` (all tool names), `ErrorCategory` (all `ERROR_*`
  literals), `AuditEventType`, `ActorRole`.
- **`ReviewTarget`** as the spec's discriminated union (`WorkingTreeReviewTarget` /
  `CommitRangeReviewTarget`).
- **Findings:** `Finding`, `BlockingFinding`, `OptionalFinding`, `ReviewFinding`,
  `FindingResolutionMap`, `RemediationContext`
  (`{policy:"explicitly_authorized",authorized_finding_ids,repair_cycle,user_authorization}`).
- **Contracts/results:** `AcceptanceCriterion/Result`, `ValidationRequirement/Result`,
  `StopContext`, `RecoveryContext` (kind-discriminated), `ConcernAcceptance`.
- **Receipt/Git:** `ReceiptPathState`, `ReceiptPath` (discriminated so `absent` has no mode/digest),
  `ChangeReceipt`, `GitTreeEntry`, `ReviewRangePath`, `ReviewRange`.
- **`WorkflowState`** — flat interface, all 34 v2 keys + the migration-only keys
  (`legacy_evidence`, temporary compat aliases) as optional. Not phase-discriminated this sprint.
- **Role views:** `ParentView`, `ImplementerView`, `ReviewerView`, `CommitterView`, union
  `RoleView`, `RoleCapabilities`.
- **Persistence:** `WorkflowRow`, `AuditEventRow` (SQLite shapes) distinct from `WorkflowState` /
  `AuditEvent` (parsed). `AuditEnvelope`, `AuditEvent`.
- **Commit domain:** `CommitAuthorization`, `CommitPreparation`, `CommitResult` (discriminated on
  `outcome`), and `CommitVerification` as the spec's `{ok:true,...}|{ok:false,mismatch}`.

### Done Report — Phase B

**Changes:**
- Added `.codex/workflow-mcp/types.ts` — type-only module (`export type` only plus the `Brand`
  helper), fully erasable and safe under `verbatimModuleSyntax`. Implements every type in the
  `issue-1-phase-b.md` spec: `Brand` + 13 branded identity/value types (section 2), all core unions
  including `WorkflowAction` (16 tool names) and `AuditEventType` (section 3), the `ReviewTarget`
  discriminated union (section 4), findings/remediation (section 5), acceptance/validation
  contracts and results (section 6), receipts and Git metadata (section 7), `WorkflowState` +
  `StopContext`/`RecoveryContext`/`ConcernAcceptance` (section 8), the four concrete role views +
  `RoleView`/`RoleCapabilities` (section 9), `WorkflowRow`/`AuditEventRow` persistence rows
  (section 10), `AuditEnvelope`/`AuditEvent`/`LegacyAuditSummary` (section 11), and the commit
  domain incl. `CommitPreparation`/`CommitResult`/`CommitVerification` (section 12).
- **Deviation from the spec working set:** grep of the actual `ERROR_*` literals in
  `.codex/workflow-mcp/*.mjs` + `.codex/agents/*.mjs` found two categories missing from the spec's
  section 3 list, so `ErrorCategory` additionally includes `ERROR_STAGED_CONTENT` and
  `ERROR_STAGED_SCOPE` (both flagged in-file). No runtime code imports `types.ts` yet, so the union
  is not yet compile-enforced against `fail(...)` — that lands in Phase C.

**Verified:**
- `pnpm typecheck` passes for `types.ts` in isolation (empty other-module inputs under both
  `tsconfig.workflow-mcp.json` and `tsconfig.agents.json`).
- `git diff --check` clean.
- No runtime behavior change: module added, nothing imports it (Phase C lands the producers,
  D–F the consumers).

## Phase C — Runtime boundary typing (`errors.ts`, `validation.ts`)  [DONE]

- `WorkflowError(category: ErrorCategory, detail?)`; `fail`, `safeError`, `isWorkflowError` typed.
- Validation helpers become the trusted untrusted->typed boundary, taking `unknown` and returning
  branded/typed values: `revision(): GitCommitSha`, `capability(): CapabilityToken`,
  `exactPaths(): ExactRepoPath[]`, `expectedVersion(): WorkflowVersion`, `objectDigest(): StateDigest`,
  `issueCapability(): CapabilityToken`, `hashCapability(): CapabilityHash`, `findings(): ReviewFinding[]`,
  `contractList`/`evidenceResults`, `exactKeys(): Record<string, unknown>`.
- **No behavioral change**: all existing `ERROR_*` paths, limits, and ordering preserved.

### Done Report — Phase C

**Changes:**
- Added `.codex/workflow-mcp/errors.ts` — `WorkflowError`, `SafeError`, `fail(...): never`,
  `safeError`, `isWorkflowError`, exactly per `issue-1-phase-c.md` §2; `ErrorCategory` is `import
  type` from `types.ts` (verbatim-module-safe), so every `fail(...)` literal is compile-enforced
  against the union.
- Added `.codex/workflow-mcp/validation.ts` — same names/values/detail strings/bounds as the
  `.mjs` original (byte-identical `canonicalJson`/`objectDigest`); helpers take `unknown` and
  return branded/typed values, with producer-side casts only (Phase B rule). New exports:
  `workflowId(): WorkflowId` (throws `ERROR_NOT_FOUND` "workflow is not found" — matches
  `store.#row`), `isoNow(): IsoTimestamp`, `findingIdList(value, name, errorCategory): FindingId[]`.
  Overloads give `contractList`/`evidenceResults`/`finding(s)` concrete return types
  (`AcceptanceCriterion[]`/`ValidationRequirement[]`, `AcceptanceResult[]`/`ValidationResult[]`,
  `BlockingFinding[]`/`OptionalFinding[]`). `fail(): never` enables definite-assignment narrowing.
- `errors.mjs`/`validation.mjs` replaced with temporary re-export shims
  (`export * from "./dist/errors.js"` resp. `"./dist/validation.js"`); no consumer or test file
  changed — imports resolve through the shims to the single compiled modules, preserving
  `instanceof WorkflowError` identity. Shims are removed at Phase I (tests) / Phase G (server entry).
- Committed `.codex/workflow-mcp/dist/{types,errors,validation}.js` per the committed-`dist/` policy.

**Verified:**
- `pnpm typecheck` passes under both tsconfigs.
- Oracle `pnpm build && node --test .codex/workflow-mcp/tests/*.node.mjs`: **98/101 pass**. The 3
  failures (`migration.node.mjs`, `protocol.node.mjs`, `protocol-v2.node.mjs`) are pre-existing on
  committed Phase B — they import `@modelcontextprotocol/sdk`, which Phase A's dep swap left
  unlinked; re-run with the Phase C changes stashed reproduces the identical 3 failures. This
  resolves at Phase I when the tests migrate to `@modelcontextprotocol/client`.
- No shim bypass: the only files referencing `dist/errors.js`/`dist/validation.js` are the two
  shims; all `.mjs` consumers/tests still import the `.mjs` specifiers (per §1.2). Note: the §8
  grep wording "matches only the shims" conflicts with §1.2's keep-the-`.mjs`-specifiers rule, so
  the enforced check is the no-bypass one above.
- `git diff --check` clean; committed `dist/` is deterministic (identical hashes across rebuilds).

## Phase D — `git.ts`

- Typed helpers (`currentHead(): GitCommitSha`, `writeTree(): GitTreeSha`, `treeEntry`,
  `reviewRange(): ReviewRange`, `createReceipt(): ChangeReceipt`, `prepareCommitReceipt`,
  `verifyCommit` -> `CommitVerification`, `verifyPreparedCommit`/`verifyCommitResult` ->
  `CommitMismatchCategory | null`).
- Spawn path for the receipt CLI -> `join(root, ".codex", "agents", "dist", "change-receipt.js")`.
- `verifyCommit` refactored internally to the `ok`-discriminated `CommitVerification`; consumers
  (`store.recordCommit`) adapt (internal only — persisted `commit_result` wire shape unchanged).

## Phase E — `transitions.ts`

- Transition functions typed `(state: WorkflowState, input: unknown, ...) => WorkflowState`,
  keeping all in-function runtime validation.
- Typed constants (`PHASES`, `MISMATCH_CATEGORIES`, `IMPLEMENTATION_STOP_PHASES`),
  `permittedNextActions(): WorkflowAction[]`, `ACTION_MATRIX` typed.
- `roleView` with role-literal overloads returning the concrete
  `ParentView/ImplementerView/ReviewerView/CommitterView` plus a `Role`->`RoleView` fallback.
- `migrateV1State` returns `WorkflowState` (legacy keys set); input validated via a
  `V1WorkflowState`-ish shape check as today.

## Phase F — `store.ts`

- `WorkflowStore` methods typed; `#row(): WorkflowRow` (cast from `node:sqlite` results after
  digest/auth checks), `parseState(): WorkflowState` (JSON parse + digest verification —
  **unchanged** boundary; no new read-time structural validation, which would risk new
  `ERROR_STATE_CORRUPT` for previously-accepted rows).
- Common mutation args validated via typed helpers into branded values before `#mutate`.
- `audit()` returns `AuditEvent[]`; `#audit`/`auditEnvelope` typed; old/legacy audit summaries kept
  as-is (loosely typed), only new events are `AuditEnvelope`.
- Preserve the `export { exactPaths }` re-export currently at `store.mjs:685` (kept for library
  compatibility alongside the `index.ts` barrel).

## Phase G — `server.ts` (SDK v2)

```ts
import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { Tool } from "@modelcontextprotocol/server";
```

- `setRequestHandler("tools/list", ...)` and `setRequestHandler("tools/call", ...)` (method
  strings replace `*RequestSchema`); handler still reads `request.params.arguments`.
- `export const tools: Tool[]` — the `Tool[]` annotation resolves the `type: "object"`
  literal-widening; `schema()` helper typed to return the JSON-Schema `inputSchema` shape (plain
  JSON Schema passes through verbatim on the low-level path — `additionalProperties: false`,
  `oneOf`, `const` all preserved).
- `new Server({name:"workflow-state",version:"1.0.0"}, {capabilities:{tools:{}}, instructions})` —
  unchanged constructor; keep `createServer(store)`, `main()`/STDIO wiring, shutdown handling,
  `StdioServerTransport()` (v2 defaults to `process.stdin/stdout`), and the
  `if (import.meta.url === \`file://${process.argv[1]}\`)` entry guard. Default v2 stdio serves the
  2025-era `initialize` handshake — no 2026-07-28 opt-in needed.
- Error results stay `{ isError: true, content: [{type:"text",text:JSON.stringify(safeError(err))}] }`
  (still resolves normally; our handler never throws out).
- `index.ts` keeps the public re-exports.

## Phase H — `change-receipt.ts`

- Port `change-receipt.mjs` -> TS 1:1, keeping byte-compatible receipts, CLI behavior,
  `safePaths`/`createReceipt` exports, and stdout/stderr contract. Compile to
  `.codex/agents/dist/change-receipt.js`.

## Phase I — Tests

- **Workflow-MCP tests -> `.node.ts`** (7 files, ~7k lines). Mechanical edits:
  - SDK imports -> `@modelcontextprotocol/client` and `@modelcontextprotocol/client/stdio`.
  - Module imports `../*.mjs` -> `../*.js`.
  - Server spawn path -> `join(process.cwd(), ".codex", "workflow-mcp", "dist", "server.js")`.
  - Receipt copy/spawn paths -> `.codex/agents/dist/change-receipt.js`.
  - Doc-consistency list (protocol.node.mjs:1011) -> `.codex/workflow-mcp/dist/server.js`.
  - `Client`/`callTool`/`listTools` stay compatible (`callTool({name, arguments})`; unknown-tool
    rejection is the only client-side change and tests only call known tools). Pragmatic `as` casts
    at `JSON.parse`/`ContentBlock` boundaries.
- **Agents receipt test -> `.node.ts`**: import compiled module, spawn compiled CLI path.
- No test logic weakened; full suite is the regression oracle.

## Phase J — Config / installer / docs

- `.codex/config.toml` args -> `[--no-warnings, ".codex/workflow-mcp/dist/server.js"]`.
- `install-into.sh`:
  - Server path -> `$project_root/.codex/workflow-mcp/dist/server.js`, plus a guard that errors
    with "run `pnpm build`" if `dist/server.js` is missing.
  - **Scope the `.codex/agents` copy to runtime needs** instead of copying the whole directory:
    copy `dist/change-receipt.js`, the TOML contracts, `WORKFLOW.md`, `EVALS.md`, and
    `EVAL_RESULTS.md`. Do NOT copy `.ts` sources or `tests/` into target repos. The target must end
    up with `.codex/agents/dist/change-receipt.js` (the server spawns that exact path).
- `WORKFLOW.md` + `implementer.toml` receipt commands -> `node .codex/agents/dist/change-receipt.js -- ...`.
- `.codex/workflow-mcp/README.md` + root `README.md` + `AGENTS.md`: note TS/build (`pnpm build`,
  `pnpm typecheck`) and the compiled `dist/` layout; no `.mjs` entry references remain.
- **EVALS / agent-contract note:** the `implementer.toml`/`WORKFLOW.md` receipt-command change is
  prompt-text-only (`.mjs` -> `dist/change-receipt.js`); receipt behavior is byte-identical, so no
  new EVALS scenarios are required. Optionally re-run the degraded-mode receipt EVALS scenario as a
  spot check. Do not update `EVAL_RESULTS.md` unless a scenario is actually executed.
- **`mcp-plan.md`:** the optional migration-task append must explicitly note that it supersedes the
  v2 global rule "Keep ... the existing MCP SDK; add no runtime dependency" — this issue mandates
  the SDK v2 swap and a new runtime dependency by design.

## Phase K — Verification

Run in order:

1. `pnpm typecheck` passes (acceptance criterion: strict TS).
2. `pnpm test:workflow-mcp`, `pnpm test:agents`, then full `pnpm test` (all pass).
3. **Committed-dist determinism:** after `pnpm test` (which rebuilds `dist/`), `git status --short`
   must show no changes to committed `dist/` files — proving the committed artifacts match fresh
   `tsc` output byte-for-byte and builds leave the worktree clean.
4. STDIO smoke test: `pnpm start` -> `codex mcp get workflow_state` / tool list; assert stdout
   protocol-clean and phases/views/commit-gating unchanged.
5. `rg` sweep (each must find nothing):
   - `@modelcontextprotocol/sdk` anywhere in sources/tests/`package.json`.
   - `change-receipt\.mjs` in agent docs/TOMLs/installer (`WORKFLOW.md`, `implementer.toml`,
     `install-into.sh`, `.codex/agents/**`).
   - `.mjs` entry-point references in `.codex/config.toml`, `install-into.sh`, `package.json`
     scripts, and docs.
6. `git diff --check`; `git status --short` review; commit sources + `dist/` together.

## Acceptance-criteria mapping

| Acceptance criterion | Where addressed / verified |
|---|---|
| Server source is TypeScript | Phases B-G, H |
| Uses MCP SDK v2 server package | Phase A.2, G |
| `pnpm typecheck` succeeds (strict) | Phase A.3, K.1 |
| Project config starts the compiled server | Phase J (config.toml -> `dist/server.js`), K.4 |
| Phases/transition semantics unchanged | Phases E, G; full test suite (K.2) |
| Persisted workflow/state compatibility | Phase F (digest-only read boundary, schema v2 unchanged); migration tests |
| Tool names/request semantics/roles/version checks/receipts/repair limits/commit gating intact | Phases E-G; protocol/lifecycle tests (K.2) |
| Runtime validation retained for MCP args, persisted state, untrusted boundaries | Phases C, F; validation unchanged |
| `ReviewTarget` invariants typed without weakening runtime validation | Phase B (discriminated union), C |
| Finding severity/blocking invariants typed | Phase B (`BlockingFinding`/`OptionalFinding`) |
| Persistence rows distinct from parsed domain types | Phase B (`WorkflowRow`/`AuditEventRow` vs `WorkflowState`/`AuditEvent`), F |
| Commit verification/mismatch uses explicit typed result | Phase B (`CommitVerification`), D |
| Role-view typing preserves least-authority projections | Phase B (concrete views), E (overloads) |
| STDIO protocol cleanliness | Phase G (unchanged wiring); protocol-v2 test (K.2, K.4) |
| `pnpm test:workflow-mcp`, `pnpm test:agents`, `pnpm test` pass | Phase A scripts, K.2 |
| Docs/installer/config no longer reference `.mjs` entry points | Phase J, K.5 |

## Risks / watchpoints

- **SDK-level validation**: v2 low-level `Server` does not validate `tools/call` args server-side
  (unlike `registerTool`), so our `ERROR_*` categories are preserved — confirmed by the migration
  guide; the test suite is the oracle.
- **`Tool` typing**: requires `tools: Tool[]` annotation / `type: "object" as const`;
  `annotations` fields unchanged in v2.
- **TS 7 (Go compiler)**: pin current `typescript`; fall back to 6.x if ecosystem gaps appear;
  `types: ["node"]` is mandatory.
- **Committed `dist/`**: keep in sync; `pnpm build` runs in every test script so drift is caught,
  and the committed-artifact determinism check (K.3) fails the worktree-clean requirement on any
  source/artifact mismatch.
- **Behavior preservation**: no phase-discriminated state unions, no new read-time state
  validation, no persisted-schema changes; only the SDK-required `tools/list`/`tools/call`
  registration change touches the protocol surface.