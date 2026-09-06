# Codex-agents simplification investigation

## Scope and provenance

This was a read-only investigation of the current checkout. Four focused explorer passes covered:

- domain/state transitions;
- persistence/store responsibilities;
- protocol/projections/contracts;
- tests and historical layering.

I also inspected `.codex/agents/WORKFLOW.md`, `operator-decision.ts`, and `server.ts` directly. No repository marker for issue #97 was found, so conclusions are based on the current repository state rather than a reconstructed issue diff.

---

## Executive assessment

The largest complexity concentrations are:

1. **`store.ts` is both persistence kernel and application-service layer.**
2. **`transitions.ts` combines state evolution, validation, role projection, action authority, and receipt handling.**
3. **Operator decisions re-derive semantics through role views and multiple phase/action representations.**
4. **Lineage and repair concepts are intentionally safe but represented in many overlapping forms.**
5. **Tests and documentation retain migration-era boundaries that no longer match current responsibilities.**

The safest simplifications are internal responsibility separations and test restructuring. The riskiest are schema/protocol changes involving lineage, role views, direct linked follow-ups, or operator-decision output shape.

---

# Findings and recommendations

## 1. Name state invalidation boundaries and consolidate repeated recovery mechanics

**Observed complexity**

`transitions.ts` repeats state cloning, phase changes, stop-context clearing, recovery-context construction, and evidence invalidation across:

- `resumeImplementation`
- `resumeReview`
- `retryCommitPreparation`
- `returnCommitToReview`
- `retryCommit`
- `scopeExpansion`

Scope expansion manually clears a large overlapping set of implementation, review, and commit fields. Similar clearing logic appears independently in commit and recovery transitions.

**Relevant files/symbols**

- `.codex/workflow-mcp/transitions.ts`
  - `scopeExpansion`
  - `resumeImplementation`
  - `resumeReview`
  - `retryCommitPreparation`
  - `returnCommitToReview`
  - `retryCommit`
- `.codex/workflow-mcp/types.ts`
  - `StopContext`
  - `RecoveryContext`

**Simpler shape**

Introduce named internal operations for distinct invalidation boundaries, such as:

- stale implementation evidence;
- stale review evidence;
- stale commit attempt;
- common recovery-stop reset.

The domain-specific clearing rules should remain explicit, but the repeated mechanical reset and timestamp construction should be centralized.

**Invariant that must remain**

- Scope expansion invalidates all stale implementation, review, and commit evidence.
- Returning to review invalidates review and commit evidence but not unrelated implementation history.
- Commit retries remain tied to the correct prepared attempt.
- Recovery transitions preserve repair-cycle and authority semantics.

**Delete or relocate?**

Mostly **deletion of duplicated reset mechanics**, not relocation of authority. The invalidation policy becomes more explicit rather than hidden in a generic reset helper.

**Risk**

Low to medium.

**Own bounded refactor?**

Yes. This should be a small, independently testable refactor.

---

## 2. Reduce phase-semantic duplication without making transitions table-driven

**Observed complexity**

Phase meaning is repeated across:

- `WORKFLOW_PHASE_VALUES`;
- `ACTION_MATRIX`;
- transition guards and assignments;
- `operator-decision.ts`’s `stateStatus`;
- repeated phase groupings for recovery, review, and commit routes.

`permittedNextActions` is already a second layer over `ACTION_MATRIX`, adding validation, recovery, review-mode, supersession, and authority conditions.

**Relevant files/symbols**

- `.codex/workflow-mcp/values.ts`
  - `WORKFLOW_PHASE_VALUES`
- `.codex/workflow-mcp/transitions.ts`
  - `ACTION_MATRIX`
  - `permittedNextActions`
- `.codex/workflow-mcp/operator-decision.ts`
  - `stateStatus`
  - `primaryDecision`
  - `recoveryDecision`
  - `boundaryDecision`

**Simpler shape**

Create a small declarative metadata source for static phase properties only:

- broad semantic status;
- whether the phase is active, stopped, terminal, review-related, or commit-related.

Use it to remove repeated switches and grouping arrays, while retaining procedural transition guards and `permittedNextActions`.

**Invariant that must remain**

`permittedNextActions` remains the authoritative action calculation. The operator projection must remain read-only and must not become a second state machine.

**Delete or relocate?**

Deletes repeated phase classification. It should not relocate transition authority into a table.

**Risk**

Medium.

**Own bounded refactor?**

Yes. It should be separate from any persisted-schema or protocol change.

---

## 3. Extract a narrow transactional persistence kernel from `WorkflowStore`

**Observed complexity**

`.codex/workflow-mcp/store.ts` is approximately 2,600 lines and combines:

- SQLite lifecycle and schema verification;
- persisted-state parsing;
- plan storage;
- workflow orchestration;
- runtime ownership and attestation;
- Git evidence;
- request routing;
- transitions;
- role projections;
- audit construction;
- optimistic persistence.

The generic `#mutate` path centralizes important compare-and-swap behavior, but several specialized paths repeat portions of row loading, version checks, digest handling, updates, and audit insertion:

- `adoptRuntime`
- `adoptDirtyScopeCrossRuntime`
- `beginReviewCrossRuntime`
- linked-follow-up creation

**Relevant files/symbols**

- `.codex/workflow-mcp/store.ts`
  - `#mutate`
  - runtime adoption methods;
  - dirty-scope adoption;
  - review-start paths;
  - linked-follow-up creation
- `.codex/workflow-mcp/transitions.ts`
- `.codex/workflow-mcp/validation.ts`

**Simpler shape**

Extract only a workflow persistence kernel responsible for:

- transactional row loading;
- digest-verified state loading;
- compare-and-swap writes;
- version assignment;
- atomic audit append;
- rollback behavior.

Do **not** create a generic repository abstraction that hides SQLite semantics.

**Invariant that must remain**

- State and audit writes remain atomic.
- Optimistic version checks remain exact.
- Persisted state is digest-verified before use.
- Cross-runtime and linked-child operations retain one transaction where currently required.
- Audit remains a correctness input for reconciliation, not merely logging.

**Delete or relocate?**

This should delete duplicated persistence protocol code while relocating the low-level transaction mechanics into a deliberately narrow boundary.

**Risk**

Medium to high.

**Own bounded refactor?**

Yes. This is one of the most valuable but highest-prerequisite efforts.

---

## 4. Separate persistence integrity and plan-aggregate concerns from orchestration

**Observed complexity**

Schema creation, schema-signature verification, startup integrity scanning, workflow parsing, and plan-row parsing form a coherent persistence-integrity responsibility. Plan persistence is also a separate aggregate with:

- dedicated tables;
- revision parsing;
- optimistic revision updates;
- approval resolution;
- parent/planner views.

Its coupling to workflows is primarily exact approved-plan provenance and atomic workflow creation.

**Relevant files/symbols**

- `.codex/workflow-mcp/store.ts`
- `.codex/workflow-mcp/migration.ts`
- `.codex/workflow-mcp/tests/migration.test.ts`
- `.codex/workflow-mcp/tests/planning.test.ts`

**Simpler shape**

Consider two narrow boundaries:

1. persisted-record/schema integrity;
2. plan aggregate/repository operations with transaction-aware approved-revision resolution.

The plan boundary must still support atomic workflow creation and linked-follow-up authorization.

**Invariant that must remain**

- Schema v9 remains fail-closed.
- Incompatible databases are rejected rather than silently migrated.
- Exact plan revision and approval identity remain authoritative.
- Workflow creation from an approved plan remains atomic.

**Delete or relocate?**

Primarily relocation, with some duplicated parsing and integrity scaffolding removed.

**Risk**

Medium.

**Own bounded refactor?**

Yes, but it should follow or coordinate with the transactional-kernel work.

---

## 5. Stop deriving operator decisions through complete role views

**Observed complexity**

`operatorDecisionGet` constructs all four role views to obtain their permitted actions, then `operator-decision.ts` interprets those actions again. This creates:

> persisted state → role projections → action extraction → semantic projection

The operator projection also independently represents related semantics in:

- `primary.kind`;
- `outcome.status`;
- `commit.eligible`;
- `commit.authorization`;
- `authority_boundaries`;
- `reconciliation.status`.

**Relevant files/symbols**

- `.codex/workflow-mcp/store.ts`
  - `operatorDecisionGet`
- `.codex/workflow-mcp/transitions.ts`
  - `roleView`
  - `permittedNextActions`
- `.codex/workflow-mcp/operator-decision.ts`
  - `actionsFor`
  - `primaryDecision`
  - `stateStatus`
  - `boundaryDecision`
  - `deriveOperatorDecision`

**Simpler shape**

First, remove the unnecessary construction of complete role views when only action arrays are needed. Derive role actions directly from the state.

A later, riskier option is to reduce overlapping operator fields, but that should not be done without consumer evidence.

**Invariant that must remain**

- Role views continue enforcing secrecy and role boundaries.
- Operator decisions remain non-authoritative.
- Exact mutation inputs still come from parent reads.
- Optimistic version checks remain mandatory.

**Delete or relocate?**

The first step deletes redundant projection work. A future envelope redesign would delete protocol representation, but is not yet justified.

**Risk**

Low to medium for the internal action derivation; high for changing the public operator-decision shape.

**Own bounded refactor?**

Yes. Treat internal derivation and public schema reduction as separate efforts.

---

## 6. Review compatibility residue before deleting it

**Observed complexity**

The repository documents schema v9 as a clean break, but current code still contains historical-looking surfaces:

- `V8_STATE_KEYS`;
- `validateWorkflowStateV3` through `validateWorkflowStateV8`;
- `operatorDecision` aliasing;
- worktree result aliases;
- tests whose names and fixtures imply older protocol generations.

Direct linked follow-up creation is also documented as a “legacy direct-contract” route alongside the plan-bound route.

**Relevant files/symbols**

- `.codex/workflow-mcp/transitions.ts`
- `.codex/workflow-mcp/types.ts`
- `.codex/workflow-mcp/operator-decision.ts`
- `.codex/workflow-mcp/tests/type-contract.test.ts`
- `.codex/agents/WORKFLOW.md`
- `.codex/workflow-mcp/README.md`

**Simpler shape**

Perform a consumer and contract audit, then remove or rename only demonstrably internal residue. At minimum, stale names should not imply that schema-v8 compatibility is supported.

Do not remove direct non-plan workflow creation merely because plan-backed creation is preferred.

**Invariant that must remain**

- Schema-v9 rejection and clean-reset behavior remain unchanged.
- Closed request shapes continue rejecting obsolete fields.
- Public installed-target compatibility is not broken accidentally.

**Delete or relocate?**

Potentially deletes obsolete aliases and historical names. This is not merely code motion.

**Risk**

Medium to high because repository-local search cannot establish external consumers.

**Own bounded refactor?**

Yes, but only after the compatibility audit.

---

## 7. Restructure tests around invariant boundaries

**Observed complexity**

`lifecycle.test.ts` is approximately 2,200 lines and mixes:

- lifecycle routing;
- role views;
- persistence/reopen;
- audit chains;
- planning;
- linked follow-ups;
- commit recovery;
- dirty-scope adoption.

`protocol.test.ts` and `protocol-v2.test.ts` duplicate MCP client setup and request builders. `protocol-v2.test.ts` is no longer solely a v2 compatibility test; it contains broad workflow semantics.

Planning assertions also overlap between protocol and `planning.test.ts`.

**Relevant files**

- `.codex/workflow-mcp/tests/lifecycle.test.ts`
- `.codex/workflow-mcp/tests/protocol.test.ts`
- `.codex/workflow-mcp/tests/protocol-v2.test.ts`
- `.codex/workflow-mcp/tests/planning.test.ts`
- `.codex/workflow-mcp/tests/protocol-contract.test.ts`
- `.codex/workflow-mcp/tests/type-contract.test.ts`
- `.codex/workflow-mcp/tests/test-fixtures.ts`

**Simpler shape**

- Split lifecycle coverage by invariant while retaining the shared reopen/snapshot harness.
- Add protocol-specific fixtures for MCP client startup, request parsing, and cleanup.
- Keep raw JSON-RPC cleanliness tests distinct.
- Reduce protocol tests to representative serialization/dispatch/error cases where store tests already cover exhaustive semantics.
- Rename or clarify `protocol-v2.test.ts` if its current responsibility is transport cleanliness rather than SDK-version compatibility.

**Invariant that must remain**

- Reopen-after-each-step coverage remains where persistence is being tested.
- Audit ordering and digest-chain assertions remain.
- Store tests retain exhaustive semantic/error matrices.
- Protocol tests retain wire shape, dispatch, and stdout cleanliness coverage.
- Closed tool registries remain covered at both runtime and type levels where those assertions are genuinely distinct.

**Delete or relocate?**

Deletes duplicated setup and redundant cross-layer scenarios; relocates tests to clearer ownership boundaries.

**Risk**

Low to medium.

**Own bounded refactor?**

Yes. This is a good early simplification effort.

---

# Complexity that should probably remain

## Runtime affinity and attestation

The apparent duplication between runtime identity, artifact discovery, HMAC verification, launch attestation, and ownership checks protects a real invariant: an affined workflow must not be served or mutated by an unauthorized runtime.

Relevant files:

- `.codex/workflow-mcp/store.ts`
- `.codex/workflow-mcp/runtime-supervisor.ts`
- `.codex/workflow-mcp/runtime-artifact.ts`

This may eventually deserve a named policy module, but it should not be simplified by weakening or bypassing persisted-owner verification.

## Audit construction and audit evidence

Audit is used for:

- append-only history;
- digest chaining;
- dirty-scope adoption;
- cross-runtime reconciliation;
- authorization evidence.

Treating it as generic logging would destroy correctness. Any extraction must preserve its transactional and evidentiary roles.

## Lineage redundancy

`parent_workflow_id`, `source_workflow_id`, `superseded_by_workflow_id`, and `linked_continuation` are undeniably complex. However, the extensive validation in `validateLineage` protects reciprocal links, ordered ancestry, acyclicity, and combined-review semantics.

Removing fields would be a schema/protocol redesign, not simplification-by-cleanup. Centralize lineage access and validation first; leave persisted representation alone for now.

## Role-specific tools and views

Four role getters and many phase-specific tools create surface area, but they also enforce host-level and server-side authority boundaries. Collapsing them into generic role/action tools could make authorization less mechanically visible.

## Manual validation ownership

The distinction between parent-owned manual evidence, implementer-produced change validation, and reviewer-produced review-only validation is complicated but substantive. It should not be normalized into one generic validation result path.

## Schema-v9 fail-closed startup

The migration checks, digest checks, exact schema validation, and refusal to backfill are repetitive by design. They protect against silently interpreting incompatible or corrupted state.

---

# Recommended sequence

1. **Test-boundary and fixture simplification**  
   Lowest risk; clarifies which invariants each suite owns and provides safer regression coverage for later changes.

2. **State invalidation/recovery helpers plus limited phase metadata deduplication**  
   Reduce repeated transition mechanics without changing persisted shape or authority.

3. **Direct action derivation for operator decisions**  
   Remove redundant role-view construction while preserving the existing public projection and authority rules.

4. **Transactional persistence-kernel extraction**  
   Highest-value structural simplification, after tests clearly protect atomicity, audit, runtime, and cross-runtime behavior.

5. **Separate compatibility-residue audit**  
   Only then decide whether historical validators, aliases, names, or the legacy direct linked-follow-up route can actually be removed.

These are bounded simplification efforts, not implementation plans.

---

