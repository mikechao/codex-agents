# AGENTS.md

This is a Bun ESM project. Bun is required to run the local MCP server, the test suite, and the
package manager (`bun install`/`bun run`); TypeScript/tsc handles static typechecking via
`tsc --noEmit`. The reusable Codex `implementer`, `code_reviewer`, and `committer` definitions
live under `.codex/agents/`; the project-scoped configuration in `.codex/config.toml` registers
the local workflow-state server. The historical v2 implementation spec and the TypeScript/SDK-v2
migration records live under `docs/archive/`.

Read `.codex/agents/WORKFLOW.md` before changing an agent contract or the workflow-state MCP
server. Keep the TOML contracts, workflow documentation, MCP tool schemas and transitions, and
their tests consistent. After changing an agent contract, use `.codex/agents/EVALS.md` as the
manual evaluation checklist, and add to `EVAL_RESULTS.md` only for scenarios actually executed.

The local STDIO server under `.codex/workflow-mcp/` is developer tooling. It must remain
repository-local, emit no non-protocol output on stdout, preserve append-only workflow audit
history, and keep role capabilities and optimistic version checks intact. Runtime SQLite state
belongs outside the repository by default; tests may override its location explicitly.

Use `bun run test:agents` for focused receipt/agent checks and `bun run test:workflow-mcp` for
focused server checks. Run the full `bun run test` suite before declaring any change complete.

The workflow-state server and its tests are TypeScript under `.codex/workflow-mcp/` and run
directly from source with Bun; there is no compiled `dist/` mirror. Run `bun run typecheck`
before declaring changes complete.

Subprocess execution keeps Node-compatible `node:child_process` (`execFileSync`/`spawnSync`)
semantics: Bun's `spawnSync` does not throw on `maxBuffer` overflow (it SIGTERMs with no error),
so the binary-blob protections and `ERROR_GIT`/`ERROR_RECEIPT_UNAVAILABLE` categorization rely on
the Node APIs and must not be swapped out. TOML contracts and project config are parsed with
`Bun.TOML.parse`, not a custom parser.
