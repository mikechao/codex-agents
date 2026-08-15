# codex-agents

Reusable Codex `implementer`, `code_reviewer`, and `committer` definitions with a local durable
workflow-state MCP server.

## Set up this project

```sh
pnpm install
pnpm test
```

The project requires Node 22 or newer. Its own `.codex/config.toml` runs the server against this
repository. Runtime SQLite state is stored outside the repository under the user's Codex state
directory.

## Install into another repository

After `pnpm install`, run:

```sh
./install-into.sh /absolute/path/to/target-repository
```

The installer requires a Git repository, refuses to replace an existing `.codex/agents`
directory or `workflow_state` MCP registration, copies the agent definitions, and registers this
project's server by absolute path. Restart or reload Codex afterward, then verify it with:

```sh
codex mcp get workflow_state
```

The target repository should also incorporate the custom-subagent policy from
`.codex/agents/WORKFLOW.md` into its root `AGENTS.md`. The installer deliberately does not rewrite
repository policy automatically.
