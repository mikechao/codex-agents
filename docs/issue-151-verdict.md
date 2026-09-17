# Issue #151 post-implementation effectiveness verdict

This document is the post-implementation retrospective for issue #151 after completion of the
bounded simplification children #157, #158, #159, and #160. It evaluates whether those changes
materially improved Workflow MCP architecture rather than merely moving code. It records the
completed investigation; it is not a proposal, implementation plan, or source of new follow-up
work.

Evaluation points:

- Original investigation baseline: `f9747f99e334b575ba79358f4c544cf18bb93c80`.
- Evaluated current `main`: `390881fb4cc6a6d7dda21ab7a509e8e7288f8a61`.
- Compared implementation children: #157 through #160.

## Verdict

The bounded #157-#160 program was worth doing, with qualifications.

- #157 materially improved integrity by adding an independent, fail-closed read-side check of
  frozen plan-backed workflow authority.
- #158 materially reduced omission risk when PlanArtifact authority is created or replaced.
- #159 improved invariant locality and reviewability, although most of its implementation cost was
  additional regression coverage rather than production-code reduction.
- #160 substantially reduced structural action-registration omissions, at the cost of a large
  registry and some remaining server and permission duplication.
- The evidence still supports retaining the existing 16-phase model. Broad phase consolidation
  would mostly relocate discriminators while creating persisted-schema and audit churn.

No architectural regression was found that outweighs those gains. The principal residual hazards
are the size and centrality of the action registry, remaining schema/dispatch/permission
registration seams, manually maintained evidence-family inventories, and the stronger availability
dependency on retained historical PlanArtifact rows.

## 1. Plan-backed authority integrity (#157)

### Measured before/after facts

At the baseline, a persisted workflow was checked by its own state digest and
`validateWorkflowStateV10()`, but its frozen PlanArtifact-derived fields were not compared with the
approved artifact named by `plan_provenance`. Baseline `parseState()` and startup validation could
therefore accept a structurally valid row whose digest had been recomputed after changing values
such as `objective`, `approved_plan`, or acceptance criteria, even though its provenance still
claimed authority from a different approved artifact. Ordinary workflow reads also did not resolve
the historical approval to detect missing or inconsistent authority.

Current code adds two separate checks:

1. [`PlanStore.resolveHistoricalApprovedPlan()`](../.codex/workflow-mcp/plan-store.ts) resolves the
   exact historical `(plan_id, revision)`, requires an approval, verifies stored artifact and
   approval digests through the PlanStore resolution path, and compares complete provenance,
   including `approved_at`.
2. [`assertHistoricalPlanSnapshot()`](../.codex/workflow-mcp/store.ts) compares `workflow_type`,
   `objective`, `approved_plan`/`full_plan`, `execution_brief`, acceptance criteria, validation
   requirements, and artifact-declared paths directly against that artifact.

The verifier treats scope deliberately: every artifact-declared path must remain authorized, while
effective workflow scope may be a legitimate superset after append-only expansion. It does not
reinterpret linked combined-review scope as artifact scope. Direct workflows return before this
check.

Verification runs during store startup through `validatePersistedRows()` and on authoritative row
lookup through `WorkflowStore.#row()`. Focused coverage in
[`planning.test.ts`](../.codex/workflow-mcp/tests/planning.test.ts) exercises frozen-field mismatch,
provenance mismatch, missing revision or approval rows, artifact and approval digest mismatch,
startup rejection, historical revision stability after newer revisions, legitimate overlays, and
direct-workflow bypass.

The implementation added 34 lines to `plan-store.ts`, 33 lines to `store.ts`, and extensive focused
corruption tests in the #157 commit. It did not change the persisted schema, phase model, protocol,
descriptor, or host permissions.

### Architectural assessment

The verifier is genuinely independent from the #158 materialization path. It compares workflow
state directly with `artifact.*`; it does not use
`authoritativeImplementationContract()`, `writeAuthoritativeImplementationContract()`, or
`replaceAuthoritativeImplementationContract()`. A writer that omits or miscopies a field will
therefore produce a state rejected by the read-side boundary.

There is limited incidental coupling: `resolveHistoricalApprovedPlan()` now also constructs an
`implementation_contract`, although `assertHistoricalPlanSnapshot()` deliberately ignores it. More
substantively, plan-backed workflow readability now depends on retention and validity of the exact
historical PlanStore rows. That is an availability-for-integrity tradeoff. Given the repository's
immutable historical PlanArtifact authority model, it is an appropriate tradeoff rather than
accidental complexity.

This was a strong safety improvement: a previously possible internally self-consistent but
externally unauthorized snapshot now fails closed as `ERROR_STATE_CORRUPT`.

## 2. Contract materialization and replacement (#158)

### Inventory measurement

For this count, an inventory is a logical production location that enumerates the complete
PlanArtifact-derived implementation contract or its persisted-name equivalents. A multi-step
linked-follow-up conversion within one module counts as one logical mapping.

At the original baseline there were five independent inventories:

1. `PlanRevisionContent` plus `planRevisionContent()` in `plan-store.ts`.
2. `createStateFromPlan()` in `transitions/state.ts`.
3. `assertApprovedPlanUnchanged()` in `store.ts`.
4. `rebindImplementationPlan()` in `transitions/implementation.ts`.
5. `linkedFollowupInputFromPlan()`, `LinkedFollowupContract`, and child-state copying in
   `transitions/linked-followup.ts`.

#157 intentionally added a sixth independent inventory: the read-side verifier. That inventory was
required to remain independent during #158.

Current code has three conceptual authorities, implemented by four explicit mapping functions:

1. The shared write representation
   [`AuthoritativeImplementationContract`](../.codex/workflow-mcp/types.ts), projected by
   [`authoritativeImplementationContract()`](../.codex/workflow-mcp/implementation-contract.ts)
   and written to state by `writeAuthoritativeImplementationContract()` in
   [`transitions/state.ts`](../.codex/workflow-mcp/transitions/state.ts).
2. The persisted non-scope projection used by the immutability guard,
   `authoritativeImplementationAuthorityFromState()`.
3. The intentionally independent #157 artifact-to-snapshot verifier.

The four literal current enumerators are `authoritativeImplementationContract()`,
`writeAuthoritativeImplementationContract()`,
`authoritativeImplementationAuthorityFromState()`, and `assertHistoricalPlanSnapshot()`. The
canonical `PlanRevisionContent` shape is now derived rather than maintained as an explicit field
list.

### Shared materialization and overlay separation

All three plan-backed write paths now consume `AuthoritativeImplementationContract`:

- `createStateFromPlan()` uses it for initial workflow construction.
- [`replaceAuthoritativeImplementationContract()`](../.codex/workflow-mcp/transitions/state.ts)
  uses it for revised-plan rebind.
- `linkedFollowupInputFromPlan()` carries it unchanged and `linkedFollowupChildState()` delegates
  plan-backed child creation to `createStateFromPlan()` in
  [`transitions/linked-followup.ts`](../.codex/workflow-mcp/transitions/linked-followup.ts).

Scope and history were not hidden inside that abstraction. Contract replacement returns:

- `prior_effective_paths`;
- `artifact_declared_paths`;
- `added_paths`.

[`rebindImplementationPlan()`](../.codex/workflow-mcp/transitions/implementation.ts) still
explicitly appends `scope_expansions` and `approved_path_baselines`, updates the working-tree review
target, and separately extends linked combined-review scope. Existing expansion and baseline
history remains append-only even when a revised artifact absorbs paths that were previously
workflow-local expansions. The focused replacement test in
[`lifecycle-domain.test.ts`](../.codex/workflow-mcp/tests/lifecycle-domain.test.ts) asserts the exact
contract fields changed and confirms unrelated overlays remain untouched.

### Maintenance assessment

At baseline, adding or renaming one authoritative field required coordinated edits to three write
paths, the immutable guard, and the plan-content inventory: five production inventories, or six
after including the intentionally independent #157 verifier. Current code requires the central
artifact-to-contract projection and contract-to-state writer, plus deliberate updates to the
independent guard, verifier, and their test oracles. Creation, rebind, and linked-follow-up call
sites do not change.

This approximately halves the production synchronization burden and, more importantly, removes
the risk that only one of the three write paths omits a field. The derived contract type makes some
omissions compile-time failures. The guarantee is not completely compile-time exhaustive:
forgetting to write a newly introduced contract field from
`writeAuthoritativeImplementationContract()` is primarily caught by focused tests and the
independent verifier.

#158 therefore produced both a real write-side source of truth and a deliberately separate
read-side check. It did not merely move the three old mappings behind a generic facade.

## 3. Evidence invalidation (#159)

### Measured before/after facts

Before #159, four partial clearing concepts already existed:

- `clearStaleImplementationEvidence()` knew nine implementation, acceptance, validation, and
  receipt fields.
- `clearStaleReviewEvidence()` cleared only two review-receipt fields despite its broad name.
- `clearFullCommitEvidence()` cleared three commit fields.
- `clearRetryablePreparedAttempt()` cleared two fields while intentionally preserving commit
  authorization.

Four transition sites still needed direct knowledge of individual evidence fields: revised-plan
rebind, conclusive review, finding adjudication, and repair-authorization replacement.

Current [`transitions/shared.ts`](../.codex/workflow-mcp/transitions/shared.ts) defines six narrow
shared operations:

- `invalidateImplementationSubmissionEvidence`;
- `invalidateReviewReceipts`;
- `invalidateRepairAuthorization`;
- `invalidateCurrentReviewResultAndRepairAuthority`;
- `invalidateFullCommitAuthorityAndEvidence`;
- `invalidateLinkedReviewProgress`.

Commit retry retains the local
`invalidateRetryablePreparedCommitAttemptEvidence()` operation because those paths intentionally
preserve `commit_authorization`.

Eleven transition functions now call named invalidators: four implementation/scope functions,
three review functions, and four commit/recovery functions. The four previously direct transition
sites no longer enumerate individual clearing fields.

The survival differences remain explicit at each caller:

- Scope expansion composes implementation, receipt, and full-commit invalidation.
- Dirty-scope adoption invalidates only review receipts.
- Staged-scope reconciliation invalidates review receipts and full commit authority.
- Revised-plan rebind composes five helpers and separately clears concern acceptance and resets the
  repair cycle.
- Commit retry uses the narrow commit-local helper and preserves authorization.

The evidence matrix in
[`lifecycle-domain.test.ts`](../.codex/workflow-mcp/tests/lifecycle-domain.test.ts) projects contract,
scope history, implementation, review receipts, current review results, adjudications, repair
authority, concern acceptance, commit authority, lineage, and linked-continuation families. Its
table-driven cases assert both changed families and evidence that must survive.

### Architectural assessment

No helper became a generic reset profile. The call-site composition still communicates the
important differences between scope expansion, adoption, rebind, review completion, and commit
retry.

Two helpers have limited present reuse:
`invalidateCurrentReviewResultAndRepairAuthority()` and `invalidateLinkedReviewProgress()` are
primarily rebind operations. Their value is invariant naming and locality more than code reuse.
That is defensible, but it means part of #159 is abstraction-for-reviewability rather than a large
maintenance reduction.

The remaining weakness is that these field families are manual. Adding a new evidence-bearing
WorkflowState field does not automatically force every invalidator or the test `evidenceProjection()`
to classify it. #159 centralized existing knowledge; it did not make evidence classification
type-exhaustive.

This was a moderate maintenance improvement. Its production change was small, while the added
survival tests were intentionally much larger and accounted for most of its cost.

## 4. Action and protocol registry (#160)

### Baseline representations

For `workflow_rebind_implementation_plan`, structural facts were independently repeated in the
baseline across:

- the workflow action tuple;
- the parent-operation union;
- the recovery union;
- the recovery action-to-ID map;
- the query-layer recovery-action list;
- `ACTION_DESCRIPTOR_METADATA`;
- `expectedAfter()`;
- separate semantic-choice ID and label/summary maps;
- `SERVER_TOOL_NAMES`;
- the tool definition;
- the server dispatch map;
- the OpenCode parent permission;
- agent and installer permission expectations;
- protocol and type exhaustiveness fixtures.

Baseline examples include `WORKFLOW_ACTION_VALUES` in `values.ts`,
`OperatorRecovery`/`OperatorParentMutationOperation` in `types.ts`,
`ACTION_DESCRIPTOR_METADATA`, `expectedAfter()`, and `semanticChoice()` in
`operator-action-descriptor.ts`, `recoveryDecision()` in `operator-decision.ts`, and
`SERVER_TOOL_NAMES` plus `dispatchFor()` in `server.ts`.

### Current structural authority

[`WORKFLOW_ACTION_REGISTRY`](../.codex/workflow-mcp/workflow-action-registry.ts) is now the single
structural declaration for action identity, actor ownership, durable classification, server-handler
linkage, descriptor mode, recovery ID, static authorization/input metadata, semantic choice, and
expected post-success routes. The `workflow_rebind_implementation_plan` entry contains all of those
facts together.

The following are derived from registry keys or metadata:

- `WorkflowAction`;
- parent-mutation, worker-dispatch, query, and non-projectable operation subsets;
- actor partitions;
- recovery action and recovery ID types/lists;
- `ACTION_DESCRIPTOR_METADATA`;
- worker host-permission inputs;
- parent permission expectations used by agent and installer tests.

Server coverage is more strongly linked but remains intentionally split. Tool definitions retain
their explicit JSON schemas in [`server.ts`](../.codex/workflow-mcp/server.ts), server names derive
from those definitions and are checked against `WorkflowAction`, and
`WORKFLOW_ACTION_STORE_ADAPTERS` provides an exhaustive typed action-to-store adapter map. Adapter
builders encode whether the complete validated input or only `workflow_id` is forwarded.

### Policy that remains independent

The registry does not own or derive:

- phase legality in `ACTION_MATRIX`;
- dynamic readiness, including `implementationPlanRebindStateReadiness()`;
- JSON schemas;
- transition implementations;
- PlanStore, Git, runtime, and receipt preflight;
- action-specific fixed arguments, plan bindings, and stale references in
  [`operator-action-descriptor.ts`](../.codex/workflow-mcp/operator-action-descriptor.ts);
- audit event types or event-specific detail semantics;
- mutation-time revalidation and optimistic version checks.

This is an important positive result. Registering an action structurally does not authorize it:
legality and the mutation boundary remain separate and fail closed.

### Before/after maintenance comparison

| Surface | Baseline | Current |
|---|---|---|
| Action membership | Explicit tuple | Registry key |
| Operation subsets | Manual parent and worker unions | Derived conditional types for four partitions |
| Recovery identity | Union, decision map, and query list | One registry field plus derived type/list/predicate |
| Static descriptor metadata | Metadata entry plus separate outcome and semantic-choice maps | One registry entry and derived metadata |
| Server names | Independent tuple | Derived from tool definitions and checked against registry actions |
| Dispatch | Independent dispatch map | Exhaustive typed adapters tied to registered handlers and argument mode |
| Worker permissions | Manual tool lists and emitted permission lines | Derived from actor partitions by `generate-host-definitions.ts` |
| Parent permission assertions | Actual allowlist plus two hand-maintained expected lists | Actual allowlist plus assertions derived from parent actions |
| Exhaustiveness tests | Multiple duplicate name lists | Independent protocol, partition, and handler oracles remain |

The reduction is real but incomplete. Adding an action still requires an explicit schema/tool
definition, a typed dispatch adapter, and—when parent-owned—an actual orchestrator permission. The
registry's `server.handler` is checked against, rather than used to generate, executable dispatch.
`workflow-action-registry.test.ts` also retains a complete expected linkage map as an independent
test oracle. These are now mechanically checked synchronization points rather than silent duplicate
registries.

#160 materially reduced the likelihood of forgetting action membership, an operation union,
recovery classification, descriptor metadata, a worker permission, or a parent-permission
assertion. It did not remove the need to make explicit policy decisions.

## 5. Cost of the bounded refactor

### Measured repository changes

Across the baseline-to-current comparison:

- 28 files changed.
- 3,361 lines were added and 1,104 deleted.
- Two production modules were added:
  - `implementation-contract.ts`: 39 lines;
  - `workflow-action-registry.ts`: 715 lines.
- One test module was added:
  - `workflow-action-registry.test.ts`: 167 lines.
- Test files added 1,515 lines and removed 114.
- Architecture and investigation documentation added 497 lines and removed 5.
- Remaining production code added approximately 1,349 lines and removed 985, for net production
  growth of approximately 364 lines.

The new action registry replaced substantial code in `operator-action-descriptor.ts`, `types.ts`,
and `values.ts`; its full 715 lines are therefore not pure net runtime growth. Most total growth came
from regression tests and the recorded architecture investigation, not additional lifecycle state
or transition behavior.

The refactor introduced one authoritative contract type family, six shared evidence invalidators,
one narrow local commit-attempt invalidator, and a typed registry with derived action partitions and
protocol metadata. The persisted schema remained version 10.

### Qualitative cost and indirection

Understanding one action now requires distinguishing:

- structural metadata in `workflow-action-registry.ts`;
- dynamic descriptor bindings in `operator-action-descriptor.ts`;
- schema in `server.ts`;
- legality/readiness in `transitions/queries.ts`;
- transition semantics and store preflight in their domain modules.

That separation is architecturally correct, but the 715-line registry is a substantial navigation
and review surface. `ACTION_DESCRIPTOR_METADATA` is projected with an
`as unknown as Record<...>` cast, which weakens type assurance at that boundary. Server-handler
linkage is represented in registry metadata, explicit adapters, and an independent expected-linkage
test.

No circular dependency exists today: the action registry has no imports, and `types.ts` uses
type-only imports from it. There is, however, future pressure to keep the registry a low-level leaf.
Introducing domain-rich metadata that imports WorkflowState or branded domain values could create a
cycle. The agent generator also now imports the workflow registry, which is safe while that module
remains dependency-light.

The evidence-invalidating helpers are simpler than a duplicated field assignment at their call
sites, but the two primarily single-use helpers provide naming and ownership benefits rather than
large code savings. They should be judged by omission prevention and reviewability, not line count.

## 6. Counterfactual maintenance test: a new parent recovery action

This counterfactual assumes a new parent recovery action structurally similar to
`workflow_rebind_implementation_plan`. It does not specify or propose such an action.

### Baseline mechanical registration

A baseline implementation would have required separate edits to:

1. `WORKFLOW_ACTION_VALUES`.
2. `OperatorParentMutationOperation`.
3. `OperatorRecovery`.
4. `ACTION_DESCRIPTOR_METADATA`.
5. `expectedAfter()`.
6. The semantic-choice ID map.
7. The semantic-choice label/summary map.
8. `recoveryDecision()`'s action-to-recovery map.
9. The query-layer recovery-action list.
10. `SERVER_TOOL_NAMES`.
11. The server dispatch map.
12. The actual OpenCode parent permission.
13. Hand-maintained agent and installer expected permission lists.
14. Protocol, type, and operator-decision exhaustiveness fixtures.
15. The transition facade export where applicable.

The server tool definition was another required surface, combining mechanical name registration
with the genuine policy of exact boundary schema design.

Several omissions could remain locally type-correct: for example, adding the server operation but
forgetting a recovery map, descriptor outcome entry, or host assertion.

### Current mechanical registration

The current architecture requires approximately:

1. One complete action-registry entry containing actor, classification, server linkage, descriptor
   mode, recovery ID, authorization/input metadata, semantic choice, and expected outcomes.
2. One typed server adapter.
3. One actual parent permission line.
4. One tool definition, including the independently authored schema.
5. Explicit acknowledgment in independent partition, protocol-name, and handler-linkage test
   oracles.

The action type, operation subsets, recovery type/list/mapping, static descriptor metadata, worker
permission exclusion, parent permission expectations, and server/action exactness checks follow
automatically. For a worker action, the actor declaration also drives generated worker permissions;
for a parent action, the manually installed primary-agent permission remains an intentional host
boundary.

Production plumbing therefore falls from roughly 12-14 independent registration edits to about
three mechanical registrations, plus schema and independent test oracles. The exact file-edit count
depends on whether the action needs specialized bindings, but forgotten registry, permission,
union, and recovery defects are much more likely to fail compilation or exact tests.

### Genuine policy changes in either architecture

Neither design removes the substantive work:

- decide legal source state and competing actions;
- define dynamic readiness, precedence, and failure behavior;
- define the exact input schema;
- define fixed arguments and stale authority bindings;
- implement transition guards and state transformation;
- implement PlanStore/Git/runtime/receipt preflight and the optimistic transaction;
- decide evidence survival;
- define audit event and detail semantics;
- add behavior, corruption, stale-state, and authorization tests;
- update semantic documentation.

This counterfactual supports #160's effectiveness claim. Structural registration is materially
cheaper and omissions are more visible, while genuine policy remains explicit.

## 7. Reassessment of broad phase consolidation

The evidence still supports leaving the phase model mostly intact.

`STOPPED_NEEDS_CONTEXT` and `STOPPED_IMPLEMENTATION_BLOCKED` remain the only plausible pair for
consolidation. Both carry `stop_context`, both can resume to the exact `stopped_from` phase, and
`implementationRecoveryStateReady()` already checks the correspondence between phase and stop
status.

The distinction still carries behavior, however. Only blocked implementation may expose revised
PlanArtifact replacement. Its legality row includes `workflow_rebind_implementation_plan`, and
`actionsForRole()` applies plan-recovery-specific precedence by suppressing ordinary resume and
scope expansion when an exact compatible replacement is available, or failing closed when the
replacement is incompatible.

Merging the phases would therefore:

- move the effective discriminator to `stop_context.status`;
- replace two `ACTION_MATRIX` rows with status-sensitive legality branches;
- retain the same rebind readiness and mutation checks;
- change persisted phase and audit meaning;
- require a clean-break schema reset under `migration.ts`;
- churn lifecycle fixtures, protocol projections, documentation, and historical audit
  interpretation.

None of #157-#160 creates new leverage for that migration. #160 deliberately leaves legality out of
the structural action registry, while #158 and #159 centralize contract and evidence concerns that
are orthogonal to phase identity. Consolidation would remove one phase literal but not the hard
recovery policy.

A potentially higher-value consistency boundary would be stronger independent validation of
phase-to-`stop_context` and phase-to-commit-field relationships. That observation does not change
the conclusion that broad phase consolidation remains low-leverage and high-churn.

## 8. Residual hazards and remaining duplication

The completed refactor leaves these maintenance hazards:

- Historical PlanStore rows are now required for plan-backed workflow reads, increasing integrity
  at the cost of availability coupling.
- `workflow-action-registry.ts` is large and central, and its descriptor projection uses a broad
  cast.
- Evidence invalidators and the evidence test projection do not automatically become exhaustive
  when WorkflowState gains a field.
- Parent permissions remain manually installed even though derived assertions now detect
  omissions.
- Server handler linkage remains split between registry metadata and typed adapters.
- Tool schemas remain intentionally independent, and descriptor/schema consistency tests still
  contain action-specific fixed-field knowledge.
- State validation does not generally establish every phase-to-stop-context or phase-to-commit-field
  relationship; some contradictions fail closed only in later transition/readiness guards.

The highest-value remaining duplication is therefore not broad phase identity. It is:

- registry server linkage versus executable dispatch adapters;
- manual evidence-family inventories;
- missing general cross-validation between phase and authority-bearing substates;
- action-specific fixed-argument knowledge repeated between descriptor and schema tests.

These are residual observations from the effectiveness review, not new implementation
recommendations.

## Final assessment

### What became materially safer

- Frozen plan-backed workflow snapshots are checked against their exact historical approved
  authority and fail closed on mismatch.
- All plan-backed write paths use one contract representation, backed by an independent verifier.
- Evidence invalidation vocabulary makes stale-evidence omission easier to see and review.
- Action membership, operation partitions, recovery identity, static descriptor metadata, and
  worker permissions are mechanically linked.
- Parent permission and server/dispatch omissions are covered by exact derived assertions.

### What became materially cheaper to evolve

- A new PlanArtifact contract field no longer requires separate creation, rebind, and linked-child
  mappings.
- A structurally similar new action needs far fewer production registration edits.
- Mechanical omissions that were previously locally valid now tend to become compile-time or exact
  test failures.
- Reviewers can inspect named evidence-family invalidations instead of reconstructing field lists at
  every transition.

### What complexity moved rather than disappeared

- Descriptor, type, and action duplication became a large structural registry.
- Evidence field knowledge moved into shared helpers and a comprehensive manual test projection.
- Server schemas, dynamic bindings, legality, adapters, permissions, transitions, and audit meaning
  remain separate by design.
- Historical workflow integrity now depends on historical planning-row availability.

Overall, the program delivered enough omission-risk reduction, independent fail-closed assurance,
and future-change leverage to justify its implementation and review cost. #157 and #158 provide the
clearest immediate return. #159 is primarily a reviewability and regression-assurance investment.
#160 has the largest upfront complexity cost, but it successfully converts the multi-registry
failure mode demonstrated by the original plan-rebind work into a smaller and mechanically checked
registration surface. Broad phase consolidation would still cost more than it saves.
