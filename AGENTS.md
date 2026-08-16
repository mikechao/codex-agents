# AGENTS.md

This is a Bun-runtime ESM project managed with pnpm. Bun is required to run the local MCP server
and the test suite; pnpm remains the package manager, and TypeScript/tsc handles typechecking and
building. The reusable Codex `implementer`, `code_reviewer`, and `committer` definitions live
under `.codex/agents/`; the project-scoped configuration in `.codex/config.toml` registers the
local workflow-state server. The historical v2 implementation spec and the TypeScript/SDK-v2
migration records live under `docs/archive/`.

Read `.codex/agents/WORKFLOW.md` before changing an agent contract or the workflow-state MCP
server. Keep the TOML contracts, workflow documentation, MCP tool schemas and transitions, and
their tests consistent. After changing an agent contract, use `.codex/agents/EVALS.md` as the
manual evaluation checklist, and add to `EVAL_RESULTS.md` only for scenarios actually executed.

The local STDIO server under `.codex/workflow-mcp/` is developer tooling. It must remain
repository-local, emit no non-protocol output on stdout, preserve append-only workflow audit
history, and keep role capabilities and optimistic version checks intact. Runtime SQLite state
belongs outside the repository by default; tests may override its location explicitly.

Use `pnpm test:agents` for focused receipt/agent checks and `pnpm test:workflow-mcp` for focused
server checks. Run the full `pnpm test` suite before declaring any change complete.

The workflow-state server and its tests are TypeScript under `.codex/workflow-mcp/`; `pnpm build`
emits the committed `dist/` artifacts that Codex, `install-into.sh`, and the tests run. Run
`pnpm typecheck` before declaring changes complete.
