# OpenCode primary-agent orchestration

OpenCode-specific instructions for the primary Build agent, loaded through `instructions` in the
root `opencode.json`. This file coordinates the project's `implementer`, `code_reviewer`, and
`committer` subagents around the authoritative `workflow_state` MCP workflow. It does not replace
the role contracts (`.opencode/agents/*.md`) or `.codex/agents/WORKFLOW.md`; keep detailed role
behavior in those files and keep this file OpenCode-only so Codex behavior is unchanged.

## Build orchestrator boundary

Build is the orchestrator, not the implementer. This boundary applies to every non-trivial
implementation request, whether the request enters directly in Build or follows a completed
Plan-mode plan. Build must delegate the implementation to `implementer`; delegation is a required
responsibility boundary, not an optional strategy.

For a direct Build request such as `Implement <issue>`, Build performs only bounded, read-only
preflight, creates or reuses the authoritative workflow, and promptly delegates to `implementer`.
For Plan-mode work, planning, refinement, review, and discarding a plan are pre-workflow activities
and do not create an implementation workflow. An explicit execution approval such as `implement the
plan`, `execute the plan`, or `go ahead` ends planning and switches Build to this orchestration
boundary. The approved plan is handoff context for `implementer`; Build must not re-derive it.

Bounded pre-delegation preflight may include only the minimum read-only context needed to establish
the workflow contract: inspect `git status` and current `HEAD`, confirm the expected working-tree
baseline, extract the objective, approved paths, acceptance criteria, and validation requirements,
and optionally run one baseline validation command when useful. Preflight must not become a second
implementation-planning pass. Before delegation, Build must not redesign APIs, draft implementation
signatures, repeatedly grep or read implementation details, reason through refactor mechanics, or
otherwise solve the implementation.

For non-trivial work, Build must not edit source, configuration, or test files, apply patches, enter
source-level implementation TODOs, or execute source-level implementation work before delegation.
After bounded preflight, Build must create or reuse the authoritative `workflow_state` workflow
before any implementation mutation, capture the exact returned `workflow_id`, and delegate with the
exact `workflow_id`, `implementer` capability, and current `expected_version`. The implementer's
first authoritative action remains `workflow_get` for that workflow. Build-side TODOs, if used, track
only orchestration progress such as preflight, workflow creation/reuse, delegation, review,
authorization, and commit handoff; they do not describe source changes Build intends to perform.

This boundary preserves the existing trivial-edit exemption: a clearly trivial edit may follow the
ordinary lightweight path, but Build must use the workflow-backed implementer lifecycle for
non-trivial implementation work.

## Workflow identity

- After bounded preflight and before delegating non-trivial work, create the authoritative workflow
  through `workflow_state` (or reuse the existing authoritative workflow when one is already in
  progress).
- Capture the exact `workflow_id` returned by workflow creation.
- Include that exact `workflow_id` in every delegated subagent invocation, together with each role's
  own `capability` and the current `expected_version` from the parent view.
- Preserve the same `workflow_id` across the implementer -> reviewer -> remediation-if-needed ->
  committer handoffs for one workflow. Never mint a new workflow for a later phase of the same
  change.
- Treat the `workflow_state` MCP server as the authoritative state/transition mechanism across
  roles: every subagent begins by reading its own view with `workflow_get` for the supplied
  `workflow_id` and never reconstructs state from prompts or local persistence.

## Delegation flow

- Delegate non-trivial implementation work to `implementer`.
- After implementation, delegate independent review to `code_reviewer`.
- When review returns blocking findings, authorize repair on exactly those finding IDs and send the
  findings back to `implementer` for remediation; re-review after repair.
- Delegate commit preparation and execution to `committer` only after review approval and explicit
  workflow commit authorization.
- Review-only workflows skip the implementer and are dispatched directly to the reviewer.

## Required orchestration context

Subagents treat the parent-supplied `workflow_id` as required context:

- Never guess or synthesize a missing workflow ID.
- Never inspect `~/.codex/state/workflow-mcp`, SQLite files, or other MCP implementation storage to
  recover a workflow ID.
- If the required `workflow_id` is absent, fail the handoff clearly and report the missing
  orchestration context to the parent instead of reconstructing orchestration state from
  implementation details.

## Override and debug

Manually mentioning `@implementer`, `@code_reviewer`, or `@committer` remains a valid override and
debug path. Pass the exact `workflow_id` in those invocations too; a missing ID still fails closed.
