# Issue 1 — Phase J spec: installer scoping, docs, and plan notes

Detailed planning for Phase J of `issue-1-plan.md` — the final implementation phase. Scopes the
`install-into.sh` `.codex/agents` copy to runtime needs, adds compiled-artifact guards, documents
the TypeScript/build layout, and records the mcp-plan.md rule supersession. No server code changes;
`pnpm test` stays 154/154.

## 0. Current state

- Phases A–I landed and committed: `pnpm typecheck` green, full `pnpm test` 154/154, no `.mjs`
  files anywhere, compiled `dist/` committed, STDIO entry smoke-tested. Phase I spec archived.
- Already done by prior phases (verified — no action here):
  - `.codex/config.toml` and `install-into.sh` server path -> `dist/server.js` (Phase G).
  - `WORKFLOW.md:311` and `implementer.toml:54` receipt commands -> `dist/change-receipt.js`
    (Phase H).
  - `package.json` scripts (`build`, `typecheck`, `start`, `test*`) (Phase A).

## 1. `install-into.sh` — artifact guards + scoped copy

Add two guards at the top (after the existing repo/agents/config checks):

```sh
if [ ! -f "$project_root/.codex/workflow-mcp/dist/server.js" ]; then
  echo "Compiled server artifact missing: $project_root/.codex/workflow-mcp/dist/server.js" >&2
  echo "Run 'pnpm build' in $project_root first." >&2
  exit 1
fi
if [ ! -f "$project_root/.codex/agents/dist/change-receipt.js" ]; then
  echo "Compiled receipt artifact missing: $project_root/.codex/agents/dist/change-receipt.js" >&2
  echo "Run 'pnpm build' in $project_root first." >&2
  exit 1
fi
```

Replace the blanket copy `cp -R -- "$project_root/.codex/agents/." "$agents_staging/"` with a
scoped copy (runtime needs only — NO `.ts` sources, NO `tests/`):

```sh
mkdir -p -- "$agents_staging/dist"
for file in code_reviewer.toml committer.toml implementer.toml WORKFLOW.md EVALS.md EVAL_RESULTS.md; do
  if [ -f "$project_root/.codex/agents/$file" ]; then
    cp -- "$project_root/.codex/agents/$file" "$agents_staging/"
  fi
done
cp -- "$project_root/.codex/agents/dist/change-receipt.js" "$agents_staging/dist/"
```

Target repos end up with exactly: the three TOML contracts, `WORKFLOW.md`, `EVALS.md`,
`EVAL_RESULTS.md`, and `dist/change-receipt.js` (the path `git.ts` spawns).

## 2. Documentation

### `AGENTS.md` (project policy)
Add a short build note to the tooling paragraph (keep the existing `pnpm test:agents` /
`pnpm test:workflow-mcp` / full-`pnpm test` guidance): the workflow-state server and its tests are
TypeScript under `.codex/workflow-mcp/`; `pnpm build` emits the committed `dist/` artifacts that
Codex, `install-into.sh`, and the tests run; run `pnpm typecheck` before declaring changes
complete.

### `.codex/workflow-mcp/README.md`
Add a "Build and typecheck" paragraph: sources are TypeScript; `pnpm build` compiles to the
committed `dist/` mirror (entry `dist/server.js`); `pnpm typecheck` runs strict checks; tests are
TS under `tests/` compiled to `dist/tests/`. Keep the existing `pnpm start` and state-location
content unchanged.

### Root `README.md`
In the setup block, note that `pnpm build` must have run (it is part of `pnpm test`) so the
committed `dist/` artifacts are fresh before `./install-into.sh`.

## 3. `mcp-plan.md` — supersession note

The v2 global rule "Keep Node 22+, ESM, node:sqlite, and the existing MCP SDK; add no runtime
dependency" is now superseded. Append a short note at the top of the "Global rules" section (or as
a labeled block after the plan title):

> Superseded: the TypeScript/SDK-v2 migration (issue 1) replaced `@modelcontextprotocol/sdk` v1
> with `@modelcontextprotocol/server` v2 (plus `@modelcontextprotocol/client` for tests and
> TypeScript tooling) by design. See `docs/archive/issue-1-phase-*.md` for the per-phase records.

## 4. EVALS note (no action)

The agent-contract text changes across the migration are path-only (`.mjs` -> `dist/*.js`); receipt
behavior is byte-identical, so no new EVALS scenarios are required and `EVAL_RESULTS.md` is not
updated unless a scenario is actually run (existing rule preserved).

## 5. Verification

1. `pnpm typecheck` and `pnpm test` (154/154) still pass — no code touched.
2. **Installer end-to-end:** run `./install-into.sh /tmp/<target-repo>` against a scratch git
   repo; assert: install succeeds; the target contains exactly the scoped files (no `.ts`, no
   `tests/`); `$target/.codex/agents/dist/change-receipt.js` exists; the generated
   `$target/.codex/config.toml` points at `$project_root/.codex/workflow-mcp/dist/server.js`.
3. Greps:
   - `rg -n '\.mjs' AGENTS.md README.md .codex/workflow-mcp/README.md .codex/agents/WORKFLOW.md
     .codex/agents/*.toml .codex/config.toml install-into.sh mcp-plan.md` — no matches (historical
     `docs/archive/` may match).
   - `rg -n 'pnpm build|pnpm typecheck' AGENTS.md .codex/workflow-mcp/README.md README.md` —
     present.
4. `git diff --check` clean; commit `install-into.sh`, `AGENTS.md`, root `README.md`,
   `.codex/workflow-mcp/README.md`, and `mcp-plan.md` together.

## 6. Decision points (with recommendation)

1. **Scoped installer copy (explicit file list)** — RECOMMENDED per issue-1-plan.md Phase J: target
   repos receive runtime files only; `.ts` sources and `tests/` are excluded. `EVAL_RESULTS.md` is
   copied only when present (loop guard).
2. **Two artifact guards** — server and receipt compiled files; error message directs to
   `pnpm build`.
3. **Docs mention `pnpm build`/`pnpm typecheck` but do not restructure content** — minimal churn.
4. **mcp-plan.md supersession as a labeled note**, not a rewrite — the historical task list stays
   intact (AGENTS.md: treat it as the ordered v2 plan; the note prevents the "add no runtime
   dependency" rule from being misapplied going forward).

## 7. Done criteria for Phase J

- `install-into.sh` scopes the copy and guards on both compiled artifacts; end-to-end install
  verified against a scratch target repo.
- `AGENTS.md`, root `README.md`, `.codex/workflow-mcp/README.md` document the TS/build layout;
  no `.mjs` references remain in runnable docs/config.
- `mcp-plan.md` carries the supersession note.
- `pnpm typecheck` + `pnpm test` still 154/154; `git diff --check` clean; single commit.