# Issue 1 — Phase C spec: runtime boundary typing (`errors.ts`, `validation.ts`)

Detailed planning for Phase C of `issue-1-plan.md`. Converts the two runtime-validation modules to
TypeScript and makes them the only producers of the branded domain values declared in `types.ts`
(Phase B). Behavior is preserved exactly: every `ERROR_*` category, detail string, bound, and
normalization rule stays byte-identical; the compiled modules emit no non-protocol output.

## 0. Current state and prerequisites

Landed and committed: Phase A tooling (tsconfigs, `package.json` scripts, deps
`@modelcontextprotocol/server@^2`, `@modelcontextprotocol/client@^2`, `typescript@^7`,
`@types/node@^22`) and Phase B `types.ts`. `pnpm typecheck` passes. `pnpm build` has NOT been run
yet (no `dist/`), and the package `test` scripts point at `dist/tests/*.node.js`, which only exist
after Phase I.

Consequence for Phases C–G: the regression oracle is the existing `.mjs` tests run directly, not
`pnpm test`:

```sh
pnpm build && node --test .codex/workflow-mcp/tests/*.node.mjs
```

(Full `pnpm test` becomes green again at Phase I when the tests are compiled into `dist/tests/`.)

## 1. Transition mechanics (governs Phases C–G)

The remaining server modules (`git.mjs`, `transitions.mjs`, `store.mjs`, `server.mjs`, `index.mjs`)
and the `.mjs` tests import `./errors.mjs` / `./validation.mjs` (or `../errors.mjs`,
`../validation.mjs`). To keep every consumer and test green during the incremental conversion:

1. Convert a module `X.mjs` -> `X.ts`; `tsc` emits `dist/X.js`.
2. Replace `X.mjs` with a temporary re-export shim (same filename, tiny):

   ```js
   // errors.mjs / validation.mjs — temporary shim while consumers are still .mjs
   export * from "./dist/errors.js";   // resp. "./dist/validation.js"
   ```

   Consumers and tests keep their existing import specifiers (`./errors.mjs`,
   `../validation.mjs`), which resolve through the shim to the single compiled module — so
   `instanceof WorkflowError` and identity across modules are preserved.
3. Delete each shim only when no `.mjs` file imports it any more (`rg -n 'errors\.mjs|validation\.mjs' .codex` must only match the shim itself). Last shims go away at Phase I (tests) / Phase G (server entry).

Phase C therefore touches exactly: `errors.ts` (new), `validation.ts` (new), `errors.mjs` ->
shim, `validation.mjs` -> shim, plus committed `dist/` output. No edits to consumers or tests.

## 2. `errors.ts`

```ts
import type { ErrorCategory } from "./types.js";

export interface SafeError {
  category: ErrorCategory;
  detail: string;
}

export class WorkflowError extends Error {
  category: ErrorCategory;
  detail: string;
  constructor(category: ErrorCategory, detail = "") {
    super(category);
    this.name = "WorkflowError";
    this.category = category;
    this.detail = detail;
  }
}

export function fail(category: ErrorCategory, detail = ""): never {
  throw new WorkflowError(category, detail);
}

export function safeError(error: unknown): SafeError {
  if (error instanceof WorkflowError) {
    return { category: error.category, detail: error.detail };
  }
  return { category: "ERROR_INTERNAL", detail: "operation failed" };
}

export function isWorkflowError(error: unknown, category: ErrorCategory): boolean {
  return error instanceof WorkflowError && error.category === category;
}
```

Notes
- `fail` returns `never` (it always throws) — behavior-preserving, and it enables definite-assignment
  narrowing at call sites (e.g. `const x = value ?? fail(...)` becomes `string`).
- `safeError`/`isWorkflowError` take `unknown`; `SafeError` exported for the server's error result.
- `ErrorCategory` is `import type` from `./types.js` (verbatim-module-safe).

## 3. `validation.ts` — constants

Keep the same names and values; tighten the element types only:

```ts
export const MAX_PATHS = 200;
export const MAX_FINDINGS = 200;
export const MAX_CONTRACTS = 999;
export const MAX_TEXT = 4000;
export const MAX_DETAIL = 2000;

const FINDING_SEVERITIES: ReadonlySet<FindingSeverity> = new Set(["P0", "P1", "P2", "P3"]);
const FINDING_KEYS = [
  "finding_id", "severity", "blocking", "file_and_line", "failure_scenario",
  "impact", "violated_requirement", "remediation", "missing_or_inadequate_test",
] as const satisfies readonly (keyof Finding)[];

export const RESOLUTION_STATUSES: ReadonlySet<FindingResolution> = new Set(["resolved", "still_present", "superseded"]);
export const ACCEPTANCE_STATUSES: ReadonlySet<AcceptanceStatus> = new Set(["satisfied", "not_satisfied"]);
export const VALIDATION_STATUSES: ReadonlySet<ValidationStatus> = new Set(["passed", "failed", "not_run"]);

export const ROLES: readonly Role[] = ["parent", "implementer", "reviewer", "committer"];
```

Set-membership rule: since helper parameters are `unknown`, calls like
`statuses.has(item.status)` / `FINDING_SEVERITIES.has(severity)` / `ROLES.includes(role)` need an
element cast (`statuses.has(item.status as AcceptanceStatus | ValidationStatus)`); this is the
validated-boundary cast, never a behavioral change.

## 4. `validation.ts` — helper signatures (the Phase B producer contract)

Imports: `import { fail } from "./errors.js";` and
`import type { AcceptanceCriterion, ... } from "./types.js";` (every type used in return/param
positions).

### 4.1 Strings and simple scalars

```ts
export function boundedString(value: unknown, name: string, max = MAX_TEXT): string;
export function optionalString(value: unknown, name: string, max = MAX_DETAIL): string | null; // internal
export function optionalText(value: unknown, name: string, max = MAX_DETAIL): string | null;
export function userAuthorization(value: unknown): string;             // boundedString(MAX_DETAIL)
export function stringList(value: unknown, name: string, maxItems = 50, maxLength = 2000): string[];
export function repairCycle(value: unknown): number;                   // safe int 0..2, ERROR_INVALID_SHAPE
export function safeObject(value: unknown, name: string, maxKeys = 30): Record<string, unknown>;
export function safeValidation(value: unknown): unknown;               // keep export + exact sanitize semantics (unused today; grep before removing)
```

### 4.2 IDs, roles, revisions, versions, paths

```ts
export function workflowId(value: unknown): WorkflowId;      // NEW; regex ^[0-9a-f-]{36}$, throws ERROR_NOT_FOUND
export function revision(value: unknown, name = "revision"): GitCommitSha; // ^[0-9a-f]{40}$, ERROR_INVALID_SHAPE
export function role(value: unknown): Role;                  // ERROR_INVALID_ROLE
export function capability(value: unknown): CapabilityToken; // ^[0-9a-f]{64}$, ERROR_CAPABILITY_DENIED
export function expectedVersion(value: unknown): WorkflowVersion; // safe int >= 0, ERROR_INVALID_VERSION
export function exactPaths(value: unknown, repositoryRoot: string, allowEmpty = false): ExactRepoPath[];
export function exactKeys(
  value: unknown,
  keys: readonly string[],
  name: string,
  optional: readonly string[] = [],
): Record<string, unknown>;
export function findingIdList(value: unknown, name: string, errorCategory: ErrorCategory): FindingId[]; // NEW
```

`workflowId()` throws `ERROR_NOT_FOUND` ("workflow is not found") on purpose: that is exactly what
`store.#row` does today for a malformed id, and the extracted helper must preserve it (Phase F will
call `workflowId()` at the store boundary).

`findingIdList` validates: array, non-empty, unique, each a string with `1 <= length <= 80`; throws
the supplied `errorCategory` with detail "finding IDs are invalid" (matches today's
`ERROR_INVALID_REPAIR` / `ERROR_INVALID_FOLLOWUP` call sites; the caller keeps its bucket/subset
checks).

### 4.3 Capabilities and digests

```ts
export function issueCapability(): CapabilityToken;                  // randomBytes(32).toString("hex")
export function hashCapability(value: CapabilityToken): CapabilityHash;
export function compareCapability(storedHash: string, value: unknown): boolean;
export function canonicalJson(value: unknown): string;               // byte-identical algorithm
export function objectDigest(value: unknown): StateDigest;           // sha256(canonicalJson) hex
export function isoNow(): IsoTimestamp;                              // NEW: new Date().toISOString() branded
```

`compareCapability` internally does `capability(value)` (branding the token), then
`hashCapability`, then the existing length + `timingSafeEqual` check. `isoNow()`/`objectDigest()`
casts are the legitimate producer-side casts (Phase B rule: no bare casts at arbitrary call sites).

### 4.4 Contracts, evidence, findings, resolution maps

```ts
export function contractList(
  value: unknown, name: string, idPrefix: "AC", idField: "criterion_id", allowEmpty?: boolean,
): AcceptanceCriterion[];
export function contractList(
  value: unknown, name: string, idPrefix: "VAL", idField: "validation_id", allowEmpty?: boolean,
): ValidationRequirement[];
export function contractList(
  value: unknown, name: string, idPrefix: string, idField: "criterion_id" | "validation_id",
  allowEmpty = false,
): AcceptanceCriterion[] | ValidationRequirement[]; // implementation

export function evidenceResults(
  value: unknown, name: string,
  contracts: ReadonlyArray<AcceptanceCriterion>, idField: "criterion_id",
  statuses: ReadonlySet<AcceptanceStatus>,
): AcceptanceResult[];
export function evidenceResults(
  value: unknown, name: string,
  contracts: ReadonlyArray<ValidationRequirement>, idField: "validation_id",
  statuses: ReadonlySet<ValidationStatus>,
): ValidationResult[];
export function evidenceResults(
  value: unknown, name: string,
  contracts: ReadonlyArray<AcceptanceCriterion | ValidationRequirement>,
  idField: "criterion_id" | "validation_id",
  statuses: ReadonlySet<AcceptanceStatus | ValidationStatus>,
): AcceptanceResult[] | ValidationResult[]; // implementation

export function resolutionMap(
  value: unknown,
  expectedIds: ReadonlyArray<FindingId>,
  name: string,
): FindingResolutionMap; // exact key set + RESOLUTION_STATUSES membership, ERROR_INVALID_FINDING

export function finding(value: unknown, index: number, expectedBlocking: true): BlockingFinding;
export function finding(value: unknown, index: number, expectedBlocking: false): OptionalFinding;
export function finding(value: unknown, index: number, expectedBlocking?: boolean): ReviewFinding; // impl
export function findings(value: unknown, name: string, expectedBlocking: true): BlockingFinding[];
export function findings(value: unknown, name: string, expectedBlocking: false): OptionalFinding[];
export function findings(value: unknown, name: string, expectedBlocking?: boolean): ReviewFinding[]; // impl
```

Call-site resolution (already how `transitions.mjs` calls them):
- `contractList(input.acceptance_criteria, "acceptance_criteria", "AC", "criterion_id")` ->
  `AcceptanceCriterion[]` (assignable to `state.acceptance_criteria`).
- `contractList(input.validation_requirements, "validation_requirements", "VAL", "validation_id", allowEmpty)` ->
  `ValidationRequirement[]`.
- `evidenceResults(input.acceptance_results, "acceptance", state.acceptance_criteria, "criterion_id", ACCEPTANCE_STATUSES)` ->
  `AcceptanceResult[]`; the validation twin -> `ValidationResult[]`.
- `findings(input.blocking_findings ?? [], "blocking_findings", true)` -> `BlockingFinding[]`;
  `(..., false)` -> `OptionalFinding[]`; these feed `state.blocking_findings` /
  `state.optional_findings`.

Overload bodies keep the exact runtime checks (order/ID equality, `statuses.has`, error categories
`ERROR_INVALID_IMPLEMENTATION` / `ERROR_INVALID_FINDING` / `ERROR_INVALID_SHAPE`), including the
existing detail strings.

## 5. Consumer impact (Phases C–F handoff)

- `errors.ts` exports: `WorkflowError`, `SafeError`, `fail`, `safeError`, `isWorkflowError`
  (unchanged names).
- `validation.ts` exports every current name with the same signature shape and the new
  `workflowId`, `isoNow`, `findingIdList`. Nothing imports `types.ts` yet from `.mjs` — it is
  consumed by `errors.ts`/`validation.ts` (types) and, from Phase D onward, `git.ts`/`store.ts`/
  `transitions.ts` (runtime values).
- Later phases consume the branded producers here (e.g. `store.ts` calls `workflowId`,
  `expectedVersion`, `capability`, `role`, `issueCapability`, `hashCapability`, `objectDigest`,
  `compareCapability`, `canonicalJson`, `exactKeys`, `exactPaths`; `transitions.ts` calls the
  contract/evidence/finding/resolution helpers; `git.ts` calls `canonicalJson`, `exactPaths`).
- `.mjs` consumers and tests are untouched this phase (they resolve through the shims).

## 6. Behavioral-preservation notes (must hold)

- `canonicalJson` and `objectDigest` must be byte-identical — tests assert exact digest/hash values
  (state digests, capability hashes, receipts).
- Every `fail(...)` detail string and category is preserved verbatim; `ErrorCategory` (types.ts) is
  compile-enforced, so a missed literal is a compile error, not a silent change. (The Phase B
  session already added `ERROR_STAGED_CONTENT` / `ERROR_STAGED_SCOPE` to the union — keep them.)
- Limits and ordering are unchanged: `exactPaths` normalization/sort, `exactKeys` sorted-key
  comparison, `contractList` zero-padded 3-digit IDs, `evidenceResults` exact ID order, resolution
  maps with sorted exact key sets.
- `safeError`'s non-`WorkflowError` fallback stays `{ category: "ERROR_INTERNAL", detail: "operation failed" }`.
- No stdout output anywhere (STDIO cleanliness).

## 7. Decision points (with recommendation)

1. **`fail(): never`** — RECOMMENDED (always throws; improves narrowing; zero behavioral change).
2. **Transition shims** — RECOMMENDED (`export * from "./dist/X.js"`), so Phase C touches only the
   two modules + shims; no importer/test edits.
3. **Overloads for `contractList` / `evidenceResults` / `finding(s)`** — RECOMMENDED; gives concrete
   return types at call sites with zero casts in Phases E/F.
4. **`workflowId()` throws `ERROR_NOT_FOUND`** — required for behavior parity with `store.#row`.
5. **`hashCapability(value: CapabilityToken)`** and **`compareCapability(storedHash: string, value: unknown)`**
   — keeps the token branding on the hash path.
6. **`findingIdList(value, name, errorCategory)`** — caller-supplied category preserves
   `ERROR_INVALID_REPAIR` / `ERROR_INVALID_FOLLOWUP`; callers keep bucket/subset checks.
7. **Keep `safeValidation` and `optionalText` exports** even if unused; grep for usage before any
   removal (removal is out of scope this phase).
8. **No `RepairCycle` literal union** — `repairCycle(): number` stays (per Phase B decision 5).
9. **`tsc` stale-output note** — `tsc` does not clean `dist/`; if a stale file ever shadows a
   deleted source, add `rm -rf dist` to the build script (out of scope unless needed).

## 8. Done criteria for Phase C

- `errors.ts` and `validation.ts` exist with all signatures above; `errors.mjs`/`validation.mjs`
  are the two shims; no other `.mjs` or test file changed.
- `pnpm typecheck` passes (both tsconfigs).
- `pnpm build` emits `dist/types.js`, `dist/errors.js`, `dist/validation.js` and they are committed.
- Oracle passes: `pnpm build && node --test .codex/workflow-mcp/tests/*.node.mjs` — full suite,
  with exact digest/hash/error-category assertions intact.
- Grep checks: `rg -n 'from "\./errors\.mjs"|from "\./validation\.mjs"|from "\.\./errors\.mjs"|from "\.\./validation\.mjs"' .codex`
  matches only the shims; every `fail("ERROR_...` literal in the two new files is in
  `ErrorCategory`.
- `git diff --check` clean; commit `errors.ts`, `validation.ts`, the two shims, and `dist/`
  together. Worktree clean after the oracle build (deterministic `tsc` output).