# codex-agents

Reusable `implementer`, `code_reviewer`, and `committer` agent definitions with a local durable
workflow-state MCP server, shared between Codex and OpenCode.

The three role contracts live as host-neutral prose in `.codex/agents/contracts/`. Codex TOML
definitions (`.codex/agents/*.toml`) and OpenCode Markdown definitions (`.opencode/agents/*.md`)
are generated from those fragments by `bun run generate:agents`, so the two hosts cannot silently
drift apart; `bun run test:agents` fails when the checked-in definitions diverge from the
generator output. Host-specific permission syntax and model choices differ, but the workflow
meaning, role responsibilities, MCP calls, stop conditions, review semantics, and commit gates are
identical.

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
bun run generate:agents   # regenerate host definitions from .codex/agents/contracts/
bun run typecheck         # strict tsc checks without emitting
bun run test              # full suite: agents + workflow-MCP + installer tests
bun run test:agents       # focused change-receipt and contract-consistency tests
bun run test:installer    # focused installer tests
bun run test:workflow-mcp # focused workflow-state MCP server tests
bun run test:coverage     # full suite with Bun coverage reporting
bun run test:stress       # full suite, randomized order, each file run twice
```

## Install into another repository

After `bun install`, run:

```sh
./install-into.ts /absolute/path/to/target-repository
```

The installer requires Bun 1.3 or newer and a Git repository and installs both host adapters in
one all-or-nothing step:

- Codex: copies the agent definitions into `.codex/agents/` and registers this project's server
  by absolute path in `.codex/config.toml`.
- OpenCode: copies the agent definitions into `.opencode/agents/` and registers the same server
  as a local MCP (`mcp.workflow_state`) in the project's `opencode.json` (or extends an existing
  `opencode.json`/`opencode.jsonc` without touching unrelated settings).

It refuses to replace existing Codex agent definitions or any existing `implementer.md`,
`code_reviewer.md`, or `committer.md` under `.opencode/agents/`, while preserving unrelated
existing OpenCode agents; it refuses existing `workflow_state` registrations in either host,
refuses malformed existing configuration, and rolls the whole installation back if any commit
step fails, so a failed run never leaves only one host installed. If the automatic rollback
itself fails, it is reported alongside the original failure: the original OpenCode agents stay
preserved in a backup directory named in the error, and the original content of a config file
that could not be restored is preserved next to it as `<config>.recover`. OpenCode registers the
server as a `type: "local"` STDIO process that OpenCode starts itself; no separate manual server
launch is required.

Restart or reload Codex, then verify it with:

```sh
codex mcp get workflow_state
```

Restart or reload OpenCode, then verify that the `workflow_state` tools are visible in a session
(e.g. `opencode run "list your available workflow_state tools"`). Both hosts share the same
durable workflow state for the repository, so a workflow started in one host is visible in the
other. The generated OpenCode definitions pin the `opencode-go/deepseek-v4-flash` model, so the
OpenCode Go provider must be connected (`/connect`) or the per-agent model overridden for the
subagent models to resolve.

OpenCode permissions are host-level defense in depth, not a filesystem sandbox: the reviewer
gets `edit: deny` plus a narrow bash allowlist; the committer gets `edit: deny` and a fail-closed
bash allowlist for the documented commit flow (status/diff/log/show/rev-parse/ls-files
inspection, approved `git add`/`git commit`, and the receipt command) that denies
push/amend/rebase/reset/checkout/switch and filesystem mutation; the implementer keeps broad bash
for validation with explicit denies for staging, committing, and history-rewriting commands; and
each agent only exposes its own role's workflow tools. The server-side capability and version
checks remain authoritative for both hosts.

The target repository should also incorporate the custom-subagent policy from
`.codex/agents/WORKFLOW.md` into its root `AGENTS.md`. The installer deliberately does not rewrite
repository policy automatically.
