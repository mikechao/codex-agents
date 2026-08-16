# OpenCode primary-agent orchestration

OpenCode-specific instructions for the primary Build agent, loaded through `instructions` in the
root `opencode.json`. This file coordinates the project's `implementer`, `code_reviewer`, and
`committer` subagents around the authoritative `workflow_state` MCP workflow. It does not replace
the role contracts (`.opencode/agents/*.md`) or `.codex/agents/WORKFLOW.md`; keep detailed role
behavior in those files and keep this file OpenCode-only so Codex behavior is unchanged.

## Workflow identity

- Before delegating non-trivial work, create the authoritative workflow through `workflow_state`
  (or reuse the existing authoritative workflow when one is already in progress).
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