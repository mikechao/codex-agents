# Issue 1 — Phase I spec: migrate tests to TypeScript, finalize the suite

Detailed planning for Phase I of `issue-1-plan.md`. Converts all seven remaining workflow-MCP
test files (`.codex/workflow-mcp/tests/*.node.mjs`) to `.node.ts` on the v2 client packages,
compiles them to `dist/tests/*.node.js`, deletes the five remaining `.mjs` shims, and makes the
full `pnpm test` green for the first time since Phase A. Behavioral coverage is unchanged.

## 0. Current state and prerequisites

- Phases A–H landed and committed. `pnpm typecheck` green; `pnpm test:agents` 19/19; workflow
  oracle subset 98/98. Phase H spec archived.
- Remaining `.mjs` files: the five shims (`errors/git/store/transitions/validation.mjs`) and six
  test files. Three test files load today (`git/lifecycle/workflow.node.mjs`); three cannot load
  until converted — `migration.node.mjs`, `protocol.node.mjs`, `protocol-v2.node.mjs` import the
  removed v1 `@modelcontextprotocol/sdk` (`ERR_MODULE_NOT_FOUND`).
- `change-receipt.node.ts` (agents) already converted in Phase H.
- The three unloadable files are the final regression gate: full STDIO protocol, migration
  reopen/rollback, and stdout/stderr-cleanliness coverage that has not run since Phase A. Any
  latent SDK v2 wire difference (tool-schema serialization, argument handling) surfaces here.

## 1. Per-file conversion map

All six files move to `.codex/workflow-mcp/tests/*.node.ts` and compile to
`.codex/workflow-mcp/dist/tests/*.node.js` (tsconfig.workflow-mcp.json already includes them).

| File | Imports to update | Paths to update |
|---|---|---|
| `git.node.mjs` | `../errors.mjs` -> `../errors.js`; `../git.mjs` -> `../git.js` | receipt copy/spawn -> `dist/change-receipt.js` (done in H — keep) |
| `lifecycle.node.mjs` | `../store.mjs` -> `../store.js`; `../validation.mjs` -> `../validation.js` | receipt paths (done in H) |
| `workflow.node.mjs` | `../errors.mjs` -> `../errors.js`; `../store.mjs` -> `../store.js`; `../transitions.mjs` -> `../transitions.js`; `../validation.mjs` -> `../validation.js` | receipt paths (done in H) |
| `migration.node.mjs` | `@modelcontextprotocol/sdk/client/index.js` -> `@modelcontextprotocol/client`; `/client/stdio.js` -> `@modelcontextprotocol/client/stdio`; `../errors.mjs`/`../store.mjs`/`../validation.mjs` -> `../*.js` | server spawn path -> `dist/server.js`; receipt copy/spawn -> `dist/change-receipt.js` |
| `protocol.node.mjs` | same SDK swaps; `../store.mjs` -> `../store.js`; `../server.mjs` -> `../server.js` (`tools` import) | server spawn path (x7) -> `dist/server.js`; receipt paths -> `dist/change-receipt.js`; doc-consistency list line 1011 `.codex/workflow-mcp/server.mjs` -> `.codex/workflow-mcp/dist/server.js` |
| `protocol-v2.node.mjs` | same SDK swaps; `../store.mjs` -> `../store.js` | `SERVER` const -> `dist/server.js`; receipt paths -> `dist/change-receipt.js` |

The `tools` import in `protocol.node.mjs` becomes `import { tools } from "../server.js"` (compiled
module — `dist/tools` shape identical).

## 2. SDK v2 client adaptation (the three unloadable files)

- `import { Client } from "@modelcontextprotocol/client";`
  `import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";`
- `new Client({ name, version }, { capabilities: {} })`,
  `new StdioClientTransport({ command, args, cwd, env, stderr })`,
  `await client.connect(transport)`, `await client.close()`, `await transport.close()` — unchanged.
- `client.callTool({ name, arguments })` — unchanged (v2 dropped only the result-schema argument).
- `client.listTools()` — unchanged; `listed.tools` is `Tool[]`.
- **Content block cast**: `result.content[0].text` -> `(result.content[0] as { text: string }).text`
  (the `ContentBlock` union has no shared `.text`). Apply at every
  `JSON.parse((await client.callTool(...)).content[0].text)` site.
- **Annotations optional chain**: `createTool.annotations.readOnlyHint` ->
  `createTool.annotations?.readOnlyHint` (v2 fields are optional; runtime value is present).
- Error assertions are unaffected: our server still resolves tool failures as
  `{ isError: true, content: [...] }` with the `ERROR_*` category inside; tests assert categories,
  not SDK error text.

## 3. Strict-mode typing rules for the converted tests

- Helpers get annotations: `const git = (...args: string[]) => execFileSync(...)`,
  `run(root: string, paths: string[])`, `receipt(root: string, paths: string[])`, fixture
  functions, and `target(...)` builders — mechanical.
- `JSON.parse(...)` results stay `any` (most test code is untouched).
- `assert.equal/throws/deepEqual` argument types follow the `any`/`string` patterns — no behavior
  changes; no weakening of any case.
- `import type` where only types are imported (none expected beyond node:test's `TestContext`
  if used).
- The workflow-node test helper closures and the lifecycle table-driven scenarios convert without
  structural change.

## 4. Final deletions

Delete the five shims — no `.mjs` importer remains once the tests are converted:

- `.codex/workflow-mcp/errors.mjs`, `validation.mjs`, `git.mjs`, `transitions.mjs`, `store.mjs`.

After this, `.codex/workflow-mcp/` contains only `.ts` sources, `dist/`, `tests/*.node.ts`, and
`README.md` — no `.mjs` anywhere in the project (`.codex/agents/change-receipt.ts` also `.ts`).

## 5. Verification

1. `pnpm typecheck` passes (both tsconfigs, now covering all tests).
2. `pnpm build` emits `dist/tests/*.node.js` for all six files; committed.
3. **Full suite green**: `pnpm test` (`pnpm build && node --test
   .codex/workflow-mcp/dist/tests/*.node.js .codex/agents/dist/tests/*.node.js`) — every case,
   including the previously-unloadable migration/protocol/protocol-v2 suites, passes.
4. `pnpm test:workflow-mcp` and `pnpm test:agents` green (acceptance criteria).
5. STDIO cleanliness re-verified by protocol-v2's own assertions (stdout = transport frames only;
   stderr contains no capability/objective/auth/finding/receipt/SQL/stack).
6. Greps must be empty:
   - `rg -n '\.mjs' .codex` (no `.mjs` files or references in sources/tests/config).
   - `rg -n '@modelcontextprotocol/sdk' .` (no v1 SDK references; `pnpm-lock.yaml`/`node_modules`
     may retain none — verify `package.json` has none).
   - `rg -n 'server\.mjs|change-receipt\.mjs' .codex install-into.sh .codex/config.toml` — only
     `docs/archive/` and historical plan text may match.
7. `git diff --check` clean; worktree clean after `pnpm test` (deterministic `tsc` output);
   single commit: six converted test files, the five shim deletions, `dist/` (sources + tests),
   and any final `package.json`/script adjustments if needed.

## 6. Decision points (with recommendation)

1. **Convert all six test files in one phase** — RECOMMENDED: `pnpm test` cannot go green
   partially (it globs the whole `dist/tests/`), and the shims cannot be deleted before all six
   are converted.
2. **Pragmatic casts at SDK/JSON boundaries** (`content[0] as { text: string }`,
   `annotations?.`) — the only strict-mode friction; test logic is untouched.
3. **Delete shims now** — the transition mechanics' end-state: no `.mjs` consumers remain.
4. **Keep the per-test case count unchanged** — no test added/removed/weakened; `pnpm test`
   totals stay identical to the pre-migration suite.

## 7. Done criteria for Phase I

- All six `.node.ts` test files compile and pass; `dist/tests/*.node.js` committed.
- Five shims deleted; zero `.mjs` files remain under `.codex/`.
- `pnpm typecheck`, `pnpm test:workflow-mcp`, `pnpm test:agents`, and full `pnpm test` all pass.
- The three previously-unloadable suites (migration, protocol, protocol-v2) pass fully — this is
  the definitive SDK-v2 wire-compatibility gate.
- Greps from section 6 clean; `git diff --check` clean; single commit.