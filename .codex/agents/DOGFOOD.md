# Provider live dogfood guide

This is optional provider-maintainer guidance for checking live provider, model, and host behavior.
It is provider-side only: it is not Workflow MCP state, an agent contract, a generated definition, or
a downstream installer artifact. There is no repository-wide results ledger; put issue-specific
observations with the relevant issue or change instead.

Use a fresh host session and a disposable target when appropriate. These checks complement, rather
than replace, the authoritative contracts, architecture documentation, and executable tests.

Provider/model/host dogfood is provider-side evidence complementary to authoritative contracts and
executable tests. A live check such as launching or restarting an installed integration in a fresh
host session and manually verifying its behavior is not an Implementer acceptance criterion or a
parent inspection unless it fits an existing authoritative mechanism. Do not silently rewrite later-
lifecycle, external, or unavailable observations as Workflow MCP results. There is no repository-wide
results ledger; report available observations with the relevant issue or change after the normal
workflow, without making them a Workflow MCP gate.

## Provider/model semantic judgment

Use an actually configured provider and model to assess bounded summaries, natural-language decisions,
fail-closed behavior, and whether user-facing results follow the intended semantic boundary rather
than merely matching prompt text.

## Actual Codex/OpenCode host behavior

In the real host, verify effective permissions, tool exposure, agent loading, MCP startup and
discoverability, and the distinction between OpenCode Plan, Orchestrator, Build, and worker surfaces.
This is host/provider behavior, not a deterministic installer checklist.

## Native Plan/planner/Orchestrator routing

From fresh host sessions, exercise change planning, bounded planner handoff, exact plan
presentation/approval, and subsequent exact approved-plan execution. Include the
standalone-investigation versus change-planning boundary and confirm Orchestrator does not become a
second planner.

## Authoritative-source transport

With a complete authoritative source containing boundary-sensitive text, exercise the real
Plan-to-planner path and inspect source placement/preservation and host reminders. See
[`docs/opencode-orchestration-flow.md`](../../docs/opencode-orchestration-flow.md) for current
compatibility limitations. Prompt conventions are not typed transport, collision-proof parsing, or
a semantic sandbox.

## Real Git hook/staging behavior

With an actual live committer flow, exercise hook failure or hook mutation, unrelated staged changes,
exact-scope staging, and the resulting user-facing stop/report behavior. Do not duplicate receipt or
Workflow MCP unit/integration cases.

## Reload/bootstrap behavior not mechanically proven by tests

After relevant provider configuration, contract, or runtime changes, use the real host
restart/reload/bootstrap path and verify that the live host observes the intended committed/provider
runtime boundary. Keep self-hosting and installed-target boundaries distinct; ordinary target
documentation changes do not become a reload requirement.

## Use automated assurance instead

Deterministic server, schema, receipt, validation-policy, installer, generated-definition, and
host-adapter behavior belongs in the authoritative contracts, current architecture documentation,
and executable tests. Do not turn this guide into a checklist or record historical results here.
