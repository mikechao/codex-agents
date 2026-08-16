# codex-agents

Reusable Codex `implementer`, `code_reviewer`, and `committer` definitions with a local durable
workflow-state MCP server.

## Set up this project

```sh
bun install
bun run test
```

The project requires Bun 1.3 or newer for install, the MCP server, and the tests. Bun executes
the TypeScript sources directly; TypeScript/tsc remains responsible for static typechecking via
`tsc --noEmit`. There is no compiled `dist/` artifact step. Its own `.codex/config.toml` runs the
server against this repository with Bun. Runtime SQLite state is stored outside the repository
under the user's Codex state directory.

## Commands

```sh
bun run start             # launch the workflow_state MCP server on STDIO
bun run typecheck         # strict tsc checks without emitting
bun run test              # full suite: agents + workflow-MCP tests
bun run test:agents       # focused change-receipt tests
bun run test:workflow-mcp # focused workflow-state MCP server tests
bun run test:coverage     # full suite with Bun coverage reporting
bun run test:stress       # full suite, randomized order, each file run twice
```

## Install into another repository

After `bun install`, run:

```sh
./install-into.ts /absolute/path/to/target-repository
```

The installer requires Bun 1.3 or newer and a Git repository, refuses to replace an existing
`.codex/agents` directory or `workflow_state` MCP registration, copies the agent definitions, and
registers this project's server by absolute path. Restart or reload Codex afterward, then verify it
with:

```sh
codex mcp get workflow_state
```

The target repository should also incorporate the custom-subagent policy from
`.codex/agents/WORKFLOW.md` into its root `AGENTS.md`. The installer deliberately does not rewrite
repository policy automatically.
