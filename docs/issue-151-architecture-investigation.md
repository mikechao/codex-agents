# Issue #151 read-only architecture investigation report

Baseline verified before analysis:

- Checkout is clean on `main`.
- Local `HEAD`, local `main`, and GitHub's current `main` all resolve to
  `f9747f99e334b575ba79358f4c544cf18bb93c80` — `Make Blocked Implementation Recovery Plan-Aware`.
- [Issue #151](https://github.com/mikechao/codex-agents/issues/151) is open; its current body matches
  this investigation.
- [Issue #155](https://github.com/mikechao/codex-agents/issues/155) is closed with successful
  deterministic validation and dogfood evidence.
- No files, refs, issues, branches, worktrees, schemas, or runtime state were modified during the
  read-only investigation.

## 1. Executive conclusion

Recommendation: **B. Bounded simplification**.

The current phase model should largely remain. Most of the 16 phases preserve independent authority,
review, recovery, or external-side-effect facts. Broad phase consolidation would create more
migration and proof burden than maintenance leverage.

The highest-leverage findings are:

1. **Authority replacement is the main state-maintenance seam.** Plan-backed creation and #155
   rebind independently enumerate the same PlanArtifact-derived contract fields. A typed
   authoritative implementation-contract boundary would reduce omissions without changing
   persistence.

2. **Evidence invalidation is only partly centralized.** Existing helpers distinguish review
   receipts and commit evidence, but #155 still needed bespoke clearing of implementation,
   review-result, repair, linked-review, and concern state. Narrow typed invalidation operations are
   justified; a generic reset helper is not.

3. **Action/protocol metadata has too many independently maintained registries.** #155 touched 21
   files and added 1,180 lines. The new policy was concentrated in four production modules; many
   other changes registered, projected, exposed, permitted, tested, or documented the same
   operation.

4. **Plan snapshots should remain self-contained for now.** Plan fields could technically be derived
   from exact immutable revision provenance, but removing them would require a schema break and
   couple historical workflow reads to planning rows. Centralized materialization plus exact
   consistency checking is safer and cheaper.

5. **Only the implementation-stop family is plausibly phase-redundant.**
   `STOPPED_NEEDS_CONTEXT` and `STOPPED_IMPLEMENTATION_BLOCKED` duplicate `stop_context.status`;
   their legal actions can be derived. However, blocked recovery has unique plan-rebind authority,
   and consolidation has low leverage compared with its schema/audit blast radius.

This does not justify a broader architecture correction. The observed duplication has two bounded
causes—authority/evidence reconciliation and operation-registration plumbing—not one defect
requiring replacement of the state machine.

## 2. Current authority model

### Persisted authority

The schema-v10 `WorkflowState` is a flat durable snapshot containing lifecycle phase,
implementation contract, receipts, evidence, repair authority, commit authority, lineage, and
runtime affinity in [`types.ts`, `WorkflowState`](../.codex/workflow-mcp/types.ts#L891).

The store adds four independent mechanical boundaries:

- Runtime ownership and attestation.
- Optimistic `expected_version` checks.
- State digest and runtime shape validation before persistence.
- Append-only audit events with before/after phase and state digests.

These are enforced by
[`WorkflowStore.#mutate`](../.codex/workflow-mcp/store.ts#L2315),
[`#persistExistingTransition`](../.codex/workflow-mcp/store.ts#L1090), and
[`validateWorkflowStateV10`](../.codex/workflow-mcp/state-validation.ts#L708).

### Authoritative artifacts

Plan revisions are append-only rows addressed by exact `(plan_id, revision)` and protected by a
stored digest. Only the current approved revision can seed or rebind a workflow; see
[`PlanStore.#approvedPlan`](../.codex/workflow-mcp/plan-store.ts#L224).

`createStateFromPlan()` freezes the approved artifact into the workflow rather than retaining only a
pointer: [`state.ts`](../.codex/workflow-mcp/transitions/state.ts#L299).

Scope expansions, authorization-time baselines, findings, adjudications, receipts, commit attempts,
and linked-continuation topology are workflow-owned durable authority, not PlanArtifact content.

### Derived projections

The following are projections, not authority:

- Role-specific views and permitted actions:
  [`roleView()` and `ACTION_MATRIX`](../.codex/workflow-mcp/transitions/queries.ts#L240).
- Exact next-step legality:
  [`workflowLegality()`](../.codex/workflow-mcp/transitions/queries.ts#L856).
- Semantic operator decision:
  [`deriveOperatorDecision()`](../.codex/workflow-mcp/operator-decision.ts#L397).
- Executable descriptor:
  [`descriptorForLegality()`](../.codex/workflow-mcp/operator-action-descriptor.ts#L1023).

The post-#140 architecture correctly keeps all four subordinate to persisted state and transition
validation.

## 3. Phase/recovery classification matrix

| Phase | Durable meaning and classification | Derivable meaning | Consolidation verdict | Decisive invariant |
|---|---|---|---|---|
| `IMPLEMENTING` | Active initial implementation authority; durable safety | Operator status and implementer route | Keep | Submission does not carry repair finding authority |
| `REPAIRING` | Active, explicitly authorized repair with exact finding IDs/directive; durable safety | Implementer route | **Must remain separate from `IMPLEMENTING`** | `repair_authorized_ids`, `repair_directive`, repair cycle, and reviewer conformance requirement |
| `REVIEWING` | Fresh independent review/evidence collection boundary; durable safety | Review vs re-review route is derived | Keep | Only reviewer operations and parent-owned inspections are legal |
| `REPAIR_REQUIRED` | Current independent review produced effective blockers; parent decision required | Repair/finalize readiness is derived from findings and cycle | **Must remain separate from `REPAIRING`** | User has not yet authorized exact repair |
| `STOPPED_CONCERNS` | Implementation completed with bounded concerns awaiting explicit acceptance; durable authorization stop | Status is duplicated in `stop_context` | Keep for now | Concern acceptance is a distinct user authorization, not context-only resume |
| `STOPPED_NEEDS_CONTEXT` | Implementation/repair paused for context; recovery state | Phase is derivable from `stop_context.status` | Plausible consolidation only | Resume returns to exact `stopped_from`; no plan replacement authority |
| `STOPPED_IMPLEMENTATION_BLOCKED` | Implementation/repair blocked; may expose revised-plan recovery; recovery plus plan authority | Phase is derivable from `stop_context.status` | Plausible with preceding phase, but defer | Only this status may rebind a newer exact approved plan |
| `STOPPED_INCONCLUSIVE` | Review stopped without a conclusive result; review recovery/inspection authority | Duplicates `stop_context.status=INCONCLUSIVE` | Keep for now | Dirty-scope adoption and parent inspection recovery differ from implementation stops |
| `STOPPED_APPROVED` | Independent review approval is complete, but commit is not authorized; durable safety | No-commit completion may be derived from workflow type/receipt | **Must remain separate from commit states** | Review approval must never imply commit authorization |
| `STOPPED_REPAIR_EXHAUSTED` | Parent finalized the bounded repair limit; terminal/audit meaning plus follow-up authority | Exhaustion condition derives from cycle and blockers | Keep | Finalization is an explicit durable event; no further repair is legal |
| `COMMIT_AUTHORIZED` | Exact user commit authorization exists; no prepared attempt yet | Commit route | **Must remain separate** | Authorization exists, but staged tree/attempt identity does not |
| `COMMIT_PREPARED` | Exact prepared tree/path set and attempt ID exist; external `git commit` result may be uncertain | Committer vs reconciliation route depends on runtime readiness | **Must remain separate** | External-side-effect uncertainty begins here |
| `STOPPED_COMMIT_PREPARATION` | No commit exists; preparation failed with typed retry/review/choice recovery | Exact recovery derives from `stop_context` and live Git state | **Must remain separate** | Failure occurred before external commit, unlike result uncertainty |
| `STOPPED_NOT_COMMITTED` | Attempt was authoritatively verified not to have changed HEAD; retryable | Retry route | **Must remain separate** | A prepared attempt existed, but external result is known to be no commit |
| `STOPPED_COMMIT_MISMATCH` | Repository state cannot be reconciled to the prepared attempt; terminal safety stop | Terminal failure projection | **Must remain separate** | Retrying could duplicate or misattribute an external side effect |
| `COMMITTED` | Verified commit SHA/tree/parent/path result; terminal authority | Terminal completion projection | **Must remain separate** | Positive externally verified result |

The implementation-stop phases could be represented as a discriminated stopped substate because
[`implementationRecoveryStateReady()`](../.codex/workflow-mcp/transitions/queries.ts#L459) already
maps phase back to `stop_context.status`. To preserve equivalent meaning, consolidation would still
need:

- exact status and `stopped_from`;
- distinct rebind legality for `BLOCKED`;
- explicit concern authorization;
- equivalent audit outcome/status;
- unchanged parent/worker operations;
- unchanged version/runtime checks.

That is technically possible but does not remove the hard logic. It mostly moves the discriminator
from `phase` to `stop_context`, while requiring schema reset and broad test/documentation changes.

## 4. Authority materialization map

| Source authority | Workflow materialization | Overlay or downstream dependency | Classification and obligation |
|---|---|---|---|
| `PlanRevisionArtifact.workflow_type` | `workflow_type` | Rebind currently requires it to remain `change` | A: freeze; workflow semantics depend on it |
| `full_plan` | `approved_plan` | Parent/implementer execution intent | A now; B technically from exact immutable artifact |
| `execution_brief` | `execution_brief` | Implementer projection | A now; B technically derivable |
| `objective` | `objective` | Role/operator intent projections | A now; B technically derivable |
| `approved_paths` | `approved_paths`, working-tree `review_target.approved_paths`, initial receipt scope | C: append-only scope expansions and linked combined-review scope may diverge intentionally | A current snapshot plus C overlays |
| Acceptance criteria | `acceptance_criteria` | `acceptance_results` keyed by criterion ID | A; replacement must invalidate results |
| Validation requirements | `validation_requirements` | Ordered `validation_results`, manual-inspection authority, reviewer execution policy | A; replacement must invalidate results and recheck policy |
| Approval/provenance | `plan_provenance` with ID, revision, digest, approved timestamp | Rebind audit retains prior and replacement provenance | A; must never resolve via mutable current-plan state |
| Workflow creation HEAD | `base_head`, `initial_receipt`, `dirty_baseline_paths` | Scope-change computation and review/commit receipts | A; repository-specific workflow authority |
| Scope authorization | `scope_expansions`, `approved_path_baselines` | Effective scope and append-only audit | C: workflow-local overlay |
| Linked topology | parent/source/supersession plus `linked_continuation` | Combined review target and reciprocal lineage validation | C: workflow-local authority |
| Work-item metadata | `work_items` | Display/provenance only; immutable after creation | A: independent provenance |
| Lifecycle evidence | implementation/review/repair/commit fields | Keyed to the materialized contract and repository state | C: workflow-local, invalidated selectively |

The authoritative plan field set is repeated in:

- [`PlanRevisionContent`](../.codex/workflow-mcp/plan-store.ts#L52)
- [`createStateFromPlan()`](../.codex/workflow-mcp/transitions/state.ts#L299)
- [`assertApprovedPlanUnchanged()`](../.codex/workflow-mcp/store.ts#L415)
- [`rebindImplementationPlan()`](../.codex/workflow-mcp/transitions/implementation.ts#L483)

A typed `AuthoritativeImplementationContract` materialization/replacement boundary would therefore
be safer than manually assigning individual fields. It should include source provenance and produce
an explicit reconciliation result such as added paths and invalidation requirements.

Important nuance: after #155, a revised artifact must retain every already-authorized path.
Therefore a revised PlanArtifact can absorb paths previously represented as workflow-local
expansions, while the original expansion history remains append-only. Any abstraction must
distinguish:

- current effective scope;
- artifact-declared scope;
- historical workflow expansion provenance.

They are not interchangeable.

Removing plan snapshots is not recommended now. Exact derivation would have to use the historical
`(plan_id, revision, artifact_digest)`, never `plans.current_revision`. It would also make every
historical workflow read depend on the continued availability and validation of planning rows.

## 5. Evidence invalidation matrix

“Review evidence” below distinguishes review receipts from findings/result authority because the
current code treats them differently.

| Authority-changing operation | Implementation evidence | Review/repair evidence | Validation | Commit evidence | Lineage/provenance | Current owner |
|---|---|---|---|---|---|---|
| Scope expansion | Clears summary/status, touched/changed paths, acceptance, receipt, failures, finding resolutions | Clears review start/final receipts; current findings and repair directive survive | Cleared | All cleared | Appends expansion and baselines | [`scopeExpansion()`](../.codex/workflow-mcp/transitions/implementation.ts#L49), `clearStaleImplementationEvidence` |
| Dirty-scope adoption | Survives | Only review receipts cleared; findings/repair survive | Survives | Normally absent | Expansion stays immutable; audit records authorization-time commitment | [`adoptDirtyScope()`](../.codex/workflow-mcp/transitions/implementation.ts#L408) and store audit handling |
| Staged-scope reconciliation | Survives | Review receipts cleared; findings/result/repair fields survive pending fresh review | Survives | All cleared | Appends expansion/baseline and recovery context | [`reconcileStagedScope()`](../.codex/workflow-mcp/transitions/implementation.ts#L317) |
| Revised-plan rebind | All cleared | Receipts, findings, classifications, review version, concern and repair authority cleared; repair cycle reset; linked remediation receipt reset | Cleared | All cleared | Workflow ID, base, initial receipt, scope history, work items, adjudication history, and lineage survive; provenance replaced with audit record | [`rebindImplementationPlan()`](../.codex/workflow-mcp/transitions/implementation.ts#L483) |
| Repair authorization | Prior implementation handoff survives until replaced | Findings survive as repair authority; cycle increments; exact IDs/directive installed | Survives | Absent | Existing audit/history survives | [`authorizeRepair()`](../.codex/workflow-mcp/transitions/review.ts#L374) |
| Repair implementation completion | Replaces implementation result, touched paths, acceptance, validation, receipt, failures, resolution map | Prior findings survive for re-review; directive survives until a conclusive review clears it | Replaced by implementation submission, then command slots replaced by reviewer evidence | Absent | History survives | [`submitImplementation()`](../.codex/workflow-mcp/transitions/implementation.ts#L159), [`submitReview()`](../.codex/workflow-mcp/transitions/review.ts#L112) |
| Finding adjudication | Survives | Appends immutable adjudication snapshots; if no effective blockers remain, clears repair IDs/directive and returns to review | Survives | Absent | Adjudication history append-only | [`adjudicateFindings()`](../.codex/workflow-mcp/transitions/review.ts#L308) |
| Return commit to review | Survives | Review receipts cleared; findings and prior result remain until replaced by fresh review | Survives | All cleared | May rebase `base_head`, initial receipt, dirty baseline, and linked combined-review base together | [`returnCommitToReview()`](../.codex/workflow-mcp/transitions/commit.ts#L162), store wrapper at [`store.ts`](../.codex/workflow-mcp/store.ts#L2793) |
| Retry commit preparation | Survives | Survives | Survives | Authorization survives; preparation/result cleared | Recovery context appended in state/audit | [`retryCommitPreparation()`](../.codex/workflow-mcp/transitions/commit.ts#L129) |
| Retry known-not-committed attempt | Survives | Survives | Survives | Authorization survives; prior preparation/result cleared | Recovery context and audit survive | [`retryCommit()`](../.codex/workflow-mcp/transitions/commit.ts#L245) |
| Commit reconciliation/result | Survives | Survives | Survives | Preparation retained; verified result added, or mismatch recorded | Runtime affinity unchanged; audit identifies actor/result | [store reconciliation](../.codex/workflow-mcp/store.ts#L2859) |
| Linked follow-up/supersession | Source evidence survives unchanged but becomes non-actionable | Child starts with copied findings/remediation context and empty lifecycle evidence | Child gets its own contract; no results | Source cannot authorize commit after supersession; child starts empty | Explicit reciprocal parent/source/successor and ordered lineage created atomically | [`#createLinkedFollowupSuccessor()`](../.codex/workflow-mcp/store.ts#L2914) |

Repeated patterns justify these narrow concepts:

- `invalidateImplementationSubmissionEvidence`
- `invalidateReviewReceipts`
- `invalidateCurrentReviewResultAndRepairAuthority`
- `invalidateCommitAuthority`
- `replaceApprovedImplementationContract`

The first, second, and fourth largely exist today, though `clearStaleReviewEvidence()` only clears
receipts and its name overstates its scope:
[`shared.ts`](../.codex/workflow-mcp/transitions/shared.ts#L33).

A single `resetWorkflow()` would be unsafe. Scope expansion, staged reconciliation, plan rebind, and
commit-review return intentionally have different survival rules.

### #159 follow-through

The bounded centralization was completed with typed internal operations named
`invalidateImplementationSubmissionEvidence`, `invalidateReviewReceipts`,
`invalidateRepairAuthorization`, `invalidateCurrentReviewResultAndRepairAuthority`,
`invalidateFullCommitAuthorityAndEvidence`, and `invalidateLinkedReviewProgress`. Commit retry
handling keeps the narrower commit-local `invalidateRetryablePreparedCommitAttemptEvidence`, which
deliberately preserves commit authorization. Revised-plan rebind continues to compose the narrow
operations explicitly alongside its concern-acceptance and repair-cycle resets; no generic reset
profile was introduced.

The evidence-survival matrix above is unchanged. These names centralize the already-established
semantics without changing schemas, phases, legality, protocol surfaces, or persisted behavior. The
#155 case study below remains the historical account of the helpers and call sites that existed at
that time.

## 6. #155 maintenance-surface case study

Conceptual change:

```text
STOPPED_IMPLEMENTATION_BLOCKED
→ exact newer current approved revision of same PlanArtifact
→ validate compatibility and unchanged partial implementation
→ replace authoritative implementation contract
→ invalidate stale evidence
→ fresh IMPLEMENTING authority
```

### Genuine new policy

The genuinely new policy was:

- Rebind only from a valid blocked implementation stop.
- Require the same `plan_id`, a strictly newer current approved revision, and
  `workflow_type=change`.
- Reject scope contraction, superseded workflows, incompatible limits, and invalid validation
  policy.
- Preserve the exact partial repository state by matching it against the blocked implementation
  receipt.
- Permit only clean/absent added paths and record authorization-time baselines.
- Suppress ordinary resume and expansion when a compatible approved replacement exists.
- Fail closed when the newer approved revision is incompatible.
- Replace contract authority and invalidate all evidence keyed to the old contract.
- Preserve workflow identity, base, initial receipt, append-only histories, runtime ownership, and
  lineage.
- Bind the descriptor and stale-state reference to exact replacement plan identity.

### Existing abstractions reused successfully

#155 reused:

- `PlanStore.resolveApprovedPlan()` and immutable artifact digests.
- Optimistic workflow version and runtime ownership.
- `implementationRecoveryStateReady()`.
- Scope expansion/baseline history.
- `clearStaleImplementationEvidence`, `clearStaleReviewEvidence`, and
  `clearFullCommitEvidence`.
- Descriptor `plan_binding`, stale bindings, and refresh-required semantics.
- Generic audit envelopes and state digests.
- Append-only finding adjudication checks.

### Bespoke reconciliation

Bespoke logic remained necessary for:

- Replacing seven PlanArtifact/provenance fields.
- Reconciling artifact scope with previous expansions.
- Updating working-tree and linked combined-review targets.
- Resetting linked remediation review state.
- Clearing current findings, classifications, concern acceptance, repair authority, and review
  version.
- Resetting the repair cycle.
- Recording rebind-specific prior/replacement provenance and user authorization.

### Quantified surface

The #155 commit changed **21 files**, adding **1,180** and deleting **71** lines:

- Four core semantic implementation modules—`plan-store.ts`, `transitions/implementation.ts`,
  `transitions/queries.ts`, and `store.ts`—accounted for 409 additions. These contain most genuine
  policy and repository preflight logic.
- Six operation/type/protocol modules—`values.ts`, `types.ts`, `transitions.ts`,
  `operator-decision.ts`, `operator-action-descriptor.ts`, and `server.ts`—accounted for 89
  additions. These were mixed: exact descriptor/schema boundaries were necessary, but action
  membership, operation unions, recovery mapping, re-export, tool-name registration, and dispatch
  were mirrored plumbing.
- Seven test modules accounted for 633 additions. `planning.test.ts` and
  `lifecycle-domain.test.ts` primarily prove genuine behavior; protocol, host-contract, and
  exact-list updates largely prove duplicated registries remain synchronized.
- Four documentation/host files accounted for 49 additions.

The schema stayed at v10; `state-validation.ts` did not change. This demonstrates that #155 was a
lifecycle-policy addition, not a persisted-schema addition.

## 7. Transition/protocol duplication map

Representative ordinary operation: `workflow_expand_scope`. Case-study operation:
`workflow_rebind_implementation_plan`.

| Representation | Exact location | Classification | Derivation opportunity |
|---|---|---|---|
| Action membership | [`WORKFLOW_ACTION_VALUES`](../.codex/workflow-mcp/values.ts#L59) | 4: mirrored registry | Derive from typed action definitions |
| Operation unions | [`OperatorParentMutationOperation`](../.codex/workflow-mcp/types.ts#L158) | 4 | Derive from registry mode/actor |
| Legality | [`ACTION_MATRIX`, `actionsForRole`](../.codex/workflow-mcp/transitions/queries.ts#L240) | 1: domain policy | Keep explicit and independently tested |
| Dynamic readiness | `scopeMutationReadiness`, `implementationPlanRebindStateReadiness` | 1 | Keep domain-specific |
| Semantic recovery mapping | [`recoveryDecision()`](../.codex/workflow-mcp/operator-decision.ts#L103) | 4 | Registry can carry recovery semantic ID |
| Transition implementation | `scopeExpansion()`, `rebindImplementationPlan()` | 2: concrete policy implementation | Keep explicit typed functions |
| Store transaction/preflight | `expandScope()`, `rebindImplementationPlan()` | 2 and 3 | Keep Git/PlanStore/runtime checks explicit |
| Descriptor mode/auth/input metadata | [`ACTION_DESCRIPTOR_METADATA`](../.codex/workflow-mcp/operator-action-descriptor.ts#L121) | 3 and 4 | Natural registry nucleus |
| Fixed arguments/bindings | `fixedArguments()`, `referencesFor()`, `invocation()` | 1/3 for plan/finding bindings; 4 for generic identity/version | Derive generic pieces; retain typed action-specific binding factories |
| Expected post-success routes | [`expectedAfter()`](../.codex/workflow-mcp/operator-action-descriptor.ts#L515) | 4 with semantic assertions | Registry field, still verified against committed legality |
| Server tool name | [`SERVER_TOOL_NAMES`](../.codex/workflow-mcp/server.ts#L297) | 4 | Derive workflow action subset |
| Server schema | `toolDefinitions` | 3: independent boundary validation | Keep explicit typed schema, referenced from registry |
| Server dispatch | [`dispatchFor()`](../.codex/workflow-mcp/server.ts#L1163) | 4 | Derive from typed handler key where signatures permit |
| Audit event | [`AuditEventType`](../.codex/workflow-mcp/types.ts#L689) and store call | 1/3 | Keep independent; actions and events are not one-to-one |
| Host permission | [`orchestrator.md`](../.opencode/agents/orchestrator.md#L36) | 3 and 4 | Generate or exactly assert parent allowlist from registry |
| Installer assertion | [`self-host-opencode.test.ts`](../.codex/installer/tests/self-host-opencode.test.ts#L203) | 5 | Derive expected list |
| Protocol/exhaustiveness tests | [`protocol-contract.test.ts`](../.codex/workflow-mcp/tests/protocol-contract.test.ts#L17) | 3 and 5 | Retain schema/permission checks; remove hand-maintained duplicate name lists |
| Documentation | `WORKFLOW.md`, MCP README, host prose | 1 for behavioral explanation; 5 for repeated tool-name existence | Keep semantic docs; avoid mechanically enumerating registries |

A smaller typed action definition registry is justified if it derives only structural metadata:

- action membership;
- parent/worker/query classification;
- descriptor mode;
- operation types;
- server registration linkage;
- generic identity/version arguments;
- parent host-permission expectations;
- exhaustiveness expectations.

It must not generate or replace:

- legality predicates;
- state transitions;
- PlanStore/Git/runtime preflights;
- action-specific stale bindings;
- audit semantics;
- JSON-schema validation;
- mutation-time revalidation.

### State-validation coupling

Useful independent checks include:

- Runtime ID and runtime revision are both present or both absent.
- Receipt path arrays exactly match receipt scope.
- Every scope expansion has exactly corresponding authorization-time baselines.
- Initial paths plus expansion history exactly equal effective `approved_paths`.
- Linked review target equals either remediation scope or combined scope.
- Linked base, predecessor, root, and lineage endpoints agree.
- Validation results are an ordered subset of current requirements.
- Repair authorization IDs and directive presence agree.
- Adjudication snapshots and versions remain append-only and internally consistent.

These checks in
[`state-validation.ts`](../.codex/workflow-mcp/state-validation.ts#L708) should remain.

Duplicated materializations that create synchronization obligations include:

- `approved_paths` versus initial receipt plus expansions;
- working-tree `review_target.approved_paths` versus effective or combined scope;
- `base_head` versus review target and linked original base;
- parent/source workflow IDs versus continuation predecessor;
- implementation stop phase versus `stop_context.status`;
- PlanArtifact snapshot fields versus exact `plan_provenance`.

Notably, validation currently checks that provenance implies non-null plan/brief, but it does not
compare the workflow snapshot with the exact immutable artifact. It also does not generally enforce
phase-to-stop-context or phase-to-commit-field consistency. Those relationships fail closed later
through guards, but they are not full corruption cross-checks.

Removing independently checked receipts, baselines, lineage links, or commit digests would weaken
corruption detection. Centralizing how they are updated is preferable to deleting them.

## 8. Recommended architecture changes

These are architecture concepts, not an implementation plan or child-issue decomposition.

1. **Introduce one typed authoritative implementation-contract mapping.**

   It should own the mapping from exact approved artifact/provenance to workflow fields and expose
   explicit effective-scope reconciliation. Creation and rebind should use the same mapping. Direct
   workflows remain a separate typed source.

2. **Centralize narrow evidence invalidation semantics.**

   Keep explicitly different operations for implementation evidence, review receipts, current
   review/repair authority, and commit authority. Plan rebind should compose those named operations
   through a plan-rebind-specific boundary. Preserve append-only provenance and adjudications by
   construction.

3. **Use a typed action-definition registry for mechanical metadata.**

   Start from the existing exhaustive `ACTION_DESCRIPTOR_METADATA`, but remove historical
   issue-number classifications such as `descriptorized_in_155`. Derive operation unions, action
   membership, generic descriptor shape, tool linkage, and parent-permission expectations. Keep
   legality and transition code independent.

4. **Add exact PlanArtifact snapshot consistency verification before considering derivation.**

   For plan-backed workflows, compare the frozen implementation contract against the exact
   historical artifact/digest, not the current revision. This strengthens corruption detection and
   validates the proposed centralized mapping without a schema change.

### Explicit non-recommendations

- Do not broadly merge phases.
- Do not merge `IMPLEMENTING` and `REPAIRING`.
- Do not merge review approval with commit authorization.
- Do not merge commit preparation, result uncertainty, mismatch, and completion.
- Do not remove receipts, authorization-time baselines, or reciprocal lineage checks.
- Do not replace typed tools with a generic transition endpoint.
- Do not make executable descriptors authoritative mutation capabilities.
- Do not move legality or payload interpretation into Orchestrator prose.
- Do not make the OpenCode-only orchestrator a shared generated worker adapter.
- Do not persist worker attempts or orchestration retries.
- Do not derive historical meaning from a mutable current PlanArtifact.
- Do not remove PlanArtifact snapshots before exact-artifact consistency and persistence-lifetime
  assumptions are proven.

## 9. Risk and migration assessment

| Concept | Maintenance leverage | Blast radius | Schema/migration | Compatibility risk | Test/host impact | Primary invariants at risk |
|---|---|---|---|---|---|---|
| Typed contract mapping/replacement | High | Medium | None if representation remains unchanged | Low–medium | Transition/store tests; rebind dogfood; no host protocol change | Scope provenance, baselines, validation IDs, linked review target |
| Narrow invalidation operations | High | Medium | None | Medium because survival rules differ | Matrix-style lifecycle regressions; rebind, scope, repair, commit-recovery dogfood | Reviewed vs unreviewed scope, retained findings, commit authorization |
| Typed action registry | High for future operations | Medium–high initial refactor | None | Low if protocol names/schemas stay byte-equivalent | Protocol, descriptor, agent, installer tests; one representative host dogfood | Least-authority permissions, schema/descriptor mismatch, dispatch classification |
| Exact artifact/snapshot verification | Medium assurance, medium maintenance benefit | Medium | None | Medium for previously tolerated inconsistent rows | Planning/store corruption tests; no descriptor change | Historical availability, exact digest/revision binding |
| Remove copied PlanArtifact fields | Medium at best | Very high | Schema bump/reset required under [`migration.ts`](../.codex/workflow-mcp/migration.ts#L3) | High | Nearly every role view, transition, store, test, and descriptor | Historical self-containment and planning-row availability |
| Consolidate stopped phases | Low | High | Schema bump/reset and audit compatibility work | High | Broad lifecycle/protocol/docs tests and dogfood | Exact recovery routing and equivalent audit meaning |
| Phase-discriminated persisted state rewrite | Unproven | Very high | Schema break | Very high | Whole Workflow MCP | Every lifecycle invariant |

The first three bounded changes offer the strongest maintenance leverage without a persisted schema
change. The latter three should not be pursued from current evidence.

## 10. Suggested next step

Issue #151 has enough evidence to move to a later planning/decomposition phase.

The architecture decision should be:

- retain the current durable phase and authority model;
- pursue bounded centralization of contract replacement and evidence invalidation;
- consolidate mechanical action metadata through a typed registry;
- separately strengthen exact PlanArtifact snapshot consistency;
- defer phase consolidation and snapshot removal.

No additional read-only investigation is required before making that decision. A future planning
pass should keep contract replacement/invalidation separate from action-registry plumbing because
they protect different invariants and have independent rollback/test surfaces.

No tests were run because this was a no-change, read-only investigation. The worktree was clean at
the conclusion of that investigation.
