# Workflow MCP source architecture

This document is an implementation-oriented map of source ownership and dependency direction
in `.codex/workflow-mcp/`. It is not a workflow state-machine specification, runtime contract,
persistence authority, or role contract. For those boundaries, see the authoritative
[workflow documentation](../agents/WORKFLOW.md) and the server README.

## Layers and ownership

The low-level/common layer provides reusable domain primitives:

- `types.ts` declares domain types, branded data shapes, and type-only dependencies on finite
  values.
- `values.ts` owns runtime finite-domain constants, sets, and predicates.
- `errors.ts` defines typed workflow errors and converts unknown errors to safe public errors.
- `validation.ts` provides shared bounded and exact input, contract, path, digest, and shape
  validation helpers.
- `migration.ts` defines the supported persisted schema-version boundary and its fail-closed
  check.

The shared/support layer contains helpers used by multiple transition domains:

- `transitions/shared.ts` owns cloning, phase guards, recovery, and stale-evidence cleanup.
- `transitions/receipts.ts` compares receipt paths and calculates scope changes.
- `state-validation.ts` validates current-schema persisted state keys and shapes.
- `transitions/queries.ts` derives role views, permitted actions, validation and finding queries,
  and related projections.
- `transitions/state.ts` constructs initial state and normalizes workflow and review targets.

Mutation-domain modules own the transition operations for their areas:

- `transitions/implementation.ts` handles implementation submission, scope expansion and adoption,
  implementation recovery and concern handling, and implementation-evidence cleanup.
- `transitions/review.ts` handles the review lifecycle, findings, adjudication, repair
  authorization and recovery, and review evidence.
- `transitions/commit.ts` handles commit authorization, preparation and result validation,
  mismatch and failure handling, and commit recovery.
- `transitions/linked-followup.ts` validates linked-follow-up inputs and constructs child state,
  including plan-backed follow-ups.

## Facade and dependency direction

`transitions.ts` is a thin compatibility and re-export facade. It assembles the public transition
exports and constants for existing consumers; it is not an implementation owner. The specialized
transition modules (`transitions/implementation.ts`, `transitions/review.ts`, `transitions/commit.ts`,
and `transitions/linked-followup.ts`) must not import `transitions.ts`. They import common and
support modules directly. Facade consumers such as `store.ts`, `index.ts`, and tests intentionally
remain separate from specialized transition implementation.

The current graph follows this bounded direction:

```text
common primitives -> shared/support -> domain transitions -> compatibility-facade consumers
```

This is a boundary guide, not a strict total ordering: some common and support modules depend on
other common/support modules, and not every source file belongs to the transition implementation
layer. Orchestration and persistence adapters (`store.ts`, `server.ts`, `operator-decision.ts`,
and related adapters) sit outside that implementation layer. They may coordinate persistence,
protocol handling, Git/runtime integration, or projections through the public/module-level APIs;
they do not move domain ownership into the facade.

`store.ts` owns persistence and runtime-ownership enforcement plus adapter orchestration.
`operator-decision.ts` derives a semantic operator projection from state and query helpers. These
source boundaries do not replace or reproduce the runtime and workflow authority described by the
authoritative documentation.

When changing this directory, preserve these ownership and downward-dependency boundaries unless
an architecture change is explicitly in scope.
