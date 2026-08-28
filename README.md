# codex-agents

Reusable `implementer`, `code_reviewer`, and `committer` agent definitions with a local durable
workflow-state MCP server, shared between Codex and OpenCode. OpenCode also includes a dedicated
`orchestrator` primary, the native built-in Plan mediator override, and generated `planner` and
hidden read-only `explorer` subagents.

The execution role contracts live as host-neutral prose in `.codex/agents/contracts/`; planner and
explorer contracts are OpenCode-only. Codex TOML
definitions (`.codex/agents/*.toml`) and OpenCode Markdown definitions (`.opencode/agents/*.md`)
are generated from those fragments by `bun run generate:agents`, so the two hosts cannot silently
drift apart; `bun run test:agents` fails when the checked-in definitions diverge from the
generator output. Host-specific permission syntax and model choices differ, but the workflow
meaning, role responsibilities, MCP calls, stop conditions, review semantics, and commit gates are
identical.

Managed worker model and reasoning assignments are centralized in
`.codex/agents/model-policy.yaml`, the only supported policy edit point. The policy supports
host-specific role assignments; structural permissions, sandboxing, tools, and behavioral contracts
remain owned by the typed generator and contract fragments. Installation materializes fresh
definitions in memory rather than depending on checked-in worker artifacts or mutating this provider
checkout. Policy changes take effect on generation or installation, not through hot reload; restart
running host sessions to load changed definitions. Policy is host metadata and is not carried in
delegation prompts or Workflow MCP state.

## Set up this project

```sh
bun install
bun run test
```

The project requires Bun 1.3 or newer for install, the MCP server, and the tests. Bun executes
the TypeScript sources directly; TypeScript/tsc remains responsible for static typechecking via
`tsc --noEmit`, and Biome owns formatting and linting for the TypeScript/JSON sources listed in
the root `biome.json`. There is no compiled `dist/` artifact step. Its own `.codex/config.toml` and
root `opencode.json` register the server against this repository with Bun, so opening `codex-agents`
directly in either host loads the local agent definitions and auto-starts the
`workflow_state` MCP server from the project config itself — no manual server launch is required.
Runtime SQLite state is stored outside the repository under the user's Codex state directory.

Plan execution records the exact approved artifact text as immutable `approved_plan` state through
`workflow_create_from_plan`. Direct or non-plan workflows explicitly pass `null`; structured objective,
paths, acceptance criteria, and validation requirements remain the enforceable workflow contract. The
plan is visible to the parent and implementer only. Legacy linked follow-ups retain their explicit
direct contract; plan-native linked follow-ups pass only the exact child plan identity and let the
server resolve the approved artifact rather than retranscribing or inheriting the source plan.
Approved paths are an append-only narrow mutation scope. Linked follow-ups retain that remediation
allowlist, then require a fresh independent combined review over the inherited logical-change paths
before commit eligibility; the source is superseded so only the active leaf can commit. In an active
working-tree change workflow, the
parent may use `workflow_expand_scope` only with fresh user authorization naming exact new paths;
Workflow MCP records clean/absent baselines, rejects dirty paths, and requires fresh implementation
and review evidence after expansion. If an inconclusive review needs to recover an already-expanded
path that is now dirty, the parent may explicitly use `workflow_adopt_dirty_scope`; Workflow MCP
commits an authorization-time content commitment and verifies it before resume and review snapshot
creation.

Workflow creation also accepts optional generic work-item provenance. Records preserve provider-neutral
metadata (`provider`, `id`, `display_ref`, and nullable HTTP(S) `url`) immutably in schema v8, survive
restart, and flow automatically through linked follow-ups. Only parent and committer views expose this
metadata; it is not authorization, scope, review evidence, or tracker mutation. Committers render
authoritative items as neutral `Refs <display_ref>` lines and never infer IDs or emit completion keywords.

The Workflow MCP runtime can be materialized independently from a committed revision with
`resolveRuntimeArtifact` from `.codex/workflow-mcp/index.ts`. It returns a deterministic `runtime_id`
and absolute Bun `runtimePath` from an external, content-addressed cache. The `runtime_id` hashes the
trusted runtime closure and committed package metadata while excluding the revision selector, so
selector-only differences that resolve to the same trusted inputs and unrelated repository changes
do not change the ID. Dirty checkout edits do not affect the committed runtime. Issue #17 can persist
that ID and launch the returned path, while runtime packaging remains separate from workflow
persistence, affinity, promotion, hot swapping, and cache GC.

## Commands

```sh
bun run start             # launch the workflow_state MCP server on STDIO
bun run generate:agents   # regenerate checked-in host definitions from policy and contracts
bun run typecheck         # strict tsc checks without emitting
bun run test              # full suite: agents + workflow-MCP + installer tests
bun run test:agents       # focused change-receipt and contract-consistency tests
bun run test:installer    # focused installer tests
bun run test:workflow-mcp # focused workflow-state MCP server tests
bun run test:coverage     # full suite with Bun coverage reporting
bun run test:stress       # full suite, randomized order, each file run twice
bun run format            # apply Biome formatting to supported sources
bun run format:check      # check Biome formatting without modifying files
bun run lint              # run Biome linting without modifying files
bun run check             # complete Biome check (format + lint + import hygiene)
bun run validate          # pre-completion gate: check + typecheck + full test suite
```

TOML files (`.codex/agents/*.toml`, `.codex/config.toml`) stay outside Biome and
continue to be validated through `Bun.TOML.parse` and the existing semantic assertions.

## Use this repository directly

Opening `codex-agents` itself in Codex loads the three shared agents from `.codex/agents/` and registers
the local `workflow_state` bootstrap supervisor via `.codex/config.toml`. Opening it in OpenCode loads the
the execution subagents plus generated `planner`/`explorer` and the `orchestrator` primary agent from `.opencode/agents/`, applies the native built-in `agent.plan` mediator override, and registers the same server as a local MCP
(`mcp.workflow_state`) via the root `opencode.json`, using the same Bun entrypoint
  (a temporary copy materialized from `git show HEAD:.codex/workflow-mcp/bootstrap.ts`) and the same `enabled`/`timeout` semantics as
installer-generated registrations. The self-host OpenCode registration is checked into the
repository and a test keeps it from silently diverging from the installer's registration shape.

OpenCode defaults new sessions in this repository to the `orchestrator` primary agent through
`default_agent`. See the [OpenCode orchestration flow](docs/opencode-orchestration-flow.md) for the
current architecture and handoff sequence. Use the normal primary-agent switcher (Tab by default)
to select the built-in Plan mediator or Build for deliberate ordinary direct coding. For a persisted
non-trivial plan, Plan delegates to generated `planner`, retrieves and renders the exact authoritative
`full_plan` verbatim, and explicitly approves only after user confirmation; it never creates a
workflow. Then switch to Orchestrator and name the exact `plan_id` and revision with `implement the
plan`. Orchestrator performs bounded read-only preflight, parent-verifies the current approved plan,
calls `workflow_create_from_plan`, and automatically dispatches `implementer`, `code_reviewer`, and—after
explicit user commit authorization—`committer`. Worker handoffs contain only the `workflow_id`; each
role reads authoritative state and its `expected_version` through its dedicated getter. The single
capability remains parent-only for privileged transitions, with separation enforced by role-specific
tool exposure and Workflow MCP workflow, phase, version, and invariant checks. Orchestrator cannot
edit, stage, or commit itself. Build remains an
independent direct-coding option rather than the workflow control plane.

Planning is a separate pre-workflow path: built-in Plan delegates substantial planning and every
material refinement only to `planner`, which may launch zero through four disposable read-only
explorers. Explorer context is bounded and never persisted in Workflow MCP or plan artifacts. The
planner uses only the three planner-side operations, reconciles every executable validation argv
against the target's exact reviewer policy, and returns a bounded `PlannerHandoff`; Plan performs
exact parent retrieval, verbatim presentation, and explicit approval, while Orchestrator performs
exact approved execution only.
The optional target-owned `.codex/planner-policy.json` supplies advisory repository guidance and is
not copied by the installer. Only the current approved revision can execute; stale or historical
revisions stop without workflow creation. Direct Orchestrator implementation remains a deliberate
fallback and uses `workflow_create` with `approved_plan: null`. Build remains independent.
After an external Git commit succeeds, Workflow MCP itself observes and persists the verified commit
SHA, without requiring the committer to submit it.

## Install into another repository

After `bun install`, run:

```sh
./install-into.ts /absolute/path/to/target-repository
```

The installer requires Bun 1.3 or newer and a Git repository and installs both host adapters in
one all-or-nothing step:

- Codex: materializes fresh policy-resolved agent definitions into `.codex/agents/` and registers
  this project's committed `.codex/workflow-mcp/server.ts` by absolute path in `.codex/config.toml`.
- OpenCode: materializes fresh policy-resolved agent definitions (including planner and explorer) into `.opencode/agents/` and registers that same absolute
  provider server directly as a local MCP (`mcp.workflow_state`) in the project's
  `opencode.json` (or extends an existing `opencode.json`/`opencode.jsonc` without touching
  unrelated settings).
- The reviewer validation runner is installed at `.codex/agents/reviewer-validation.ts`, and a
  project-owned `.codex/reviewer-validation.json` policy is scaffolded only when absent. The policy
  contains exact argv arrays, timeout limits, and output limits (not workflow validation IDs);
  customize it in the target project without regenerating agent definitions. Workflow-local
  `VAL-*` IDs correlate evidence only. Reviewer validation is executed directly without a shell, and
  unauthorized argv, malformed policy, shell syntax, timeouts, unavailable commands, and working-tree
  mutations fail closed. Manual validation requirements are represented with `argv: null` and are
  never executed.

Installed repositories do not receive the Workflow MCP bootstrap, supervisor, or runtime-artifact
sources. Their direct provider-server registration has no runtime-artifact affinity lifecycle; the
server uses the target repository's Git and durable state normally.

For OpenCode, a new config or an existing config without `default_agent` defaults to
`orchestrator`, and a new or depth-absent config gets `subagent_depth: 2`. Installation adds the
canonical native `agent.plan` override only when `agent.plan` is absent. Existing explicit
`default_agent`, `subagent_depth`, `agent.plan`, unrelated agent/config settings, comments, and
trailing commas are preserved; malformed `agent` or `agent.plan` shapes fail closed before partial
installation. The orchestrator is still installed and can be selected with the primary-agent
switcher.

It refuses to replace existing Codex agent definitions or any existing `implementer.md`,
`code_reviewer.md`, `committer.md`, `planner.md`, `explorer.md`, or `orchestrator.md` under `.opencode/agents/`, while preserving unrelated
existing OpenCode agents; it refuses existing `workflow_state` registrations in either host,
refuses malformed existing configuration, and rolls the whole installation back if any commit
step fails, so a failed run never leaves only one host installed. If the automatic rollback
itself fails, it is reported alongside the original failure: the original OpenCode agents stay
preserved in a backup directory named in the error, and the original content of a config file
that could not be restored is preserved next to it as `<config>.recover`. OpenCode registers the
absolute provider server as a `type: "local"` STDIO process that OpenCode starts itself; no
separate manual server launch is required.

Restart or reload Codex, then verify it with:

```sh
codex mcp get workflow_state
```

Restart or reload OpenCode, then verify that the `workflow_state` tools are visible in a session
(e.g. `opencode run "list your available workflow_state tools"`). Both hosts share the same
durable workflow state for the repository, so a workflow started in one host is visible in the
other. The generated OpenCode definitions pin the provider/model IDs and reasoning declared by
`.codex/agents/model-policy.yaml`, so the configured provider must be connected (`/connect`) or the
per-agent models overridden for the subagent models to resolve.

OpenCode permissions are host-level defense in depth, not a filesystem sandbox: the built-in Plan
override denies edit, bash, planner-side Workflow MCP operations, workflow creation, and direct
planner dispatch while allowing only parent plan retrieval/approval; the orchestrator has
`edit: deny`, read-only repository inspection, parent-only workflow tools, and Task access only
to the three workflow subagents; the reviewer
  gets `edit: deny` plus a narrow bash allowlist containing only Git inspection (including `git grep`),
  receipt inspection, and the project-owned reviewer validation runner. Reviewer semantic searches
  cover tracked content plus exact approved untracked paths, not ambient untracked or ignored files;
  the committer gets `edit: deny` and a fail-closed
bash allowlist for the documented commit flow (status/diff/log/show/rev-parse/ls-files
inspection, approved `git add`/`git commit`, and the receipt command) that denies
push/amend/rebase/reset/checkout/switch and filesystem mutation; the implementer keeps broad bash
for validation with explicit denies for staging, committing, and history-rewriting commands; and
each agent only exposes its own role's workflow tools. The server-side capability and version
checks remain authoritative for both hosts.

The target repository should also incorporate the custom-subagent policy from
`.codex/agents/WORKFLOW.md` into its root `AGENTS.md`. The installer deliberately does not rewrite
repository policy automatically.
