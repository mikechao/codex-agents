# Workflow State and Orchestration Semantics Investigation

## Executive conclusion

The current architecture should mostly remain intact. The durable workflow model is not primarily suffering from too many phases; most phases preserve meaningful safety distinctions around independent review, validation, repair authority, external commit side effects, and provenance. The larger problem is the protocol between Workflow MCP and the OpenCode Orchestrator.

Workflow MCP owns the authoritative transition rules, but `workflow_operator_decision_get` usually returns only a semantic recommendation. The Orchestrator must then recover the exact tool, argument shape, authorization representation, sequencing constraints, and post-success route from its prompt and sometimes from a second raw parent read. That creates a second, model-executed version of parts of the state machine. The recent #136 and #139 failures are direct consequences. The #112-shaped validation failure is a related evidence-classification problem: the server correctly protects terminal evidence from replacement, but the parent protocol does not mechanically prevent “evidence unavailable” from being recorded as a real failure.

The smallest redesign with material impact is therefore not a state-machine rewrite. It is to evolve the operator projection into a semantic **and executable** next-action contract:

- retain the current persisted state, role-specific views, typed transition tools, version checks, and worker fail-closed checks;
- make action legality exact rather than approximate;
- return a bounded server-derived action descriptor identifying the legal operation, fixed arguments, required semantic inputs, authorization placement, and success route;
- return a refreshed descriptor from successful parent mutations so dispatch is a server-derived consequence of the mutation;
- make waiting, evidence collection, terminal outcomes, and unsupported recovery explicit results rather than generic prose;
- keep user authorization semantically uniform in the descriptor, while allowing domain tools to retain their appropriate, tool-specific persisted fields.

This would meet the target criterion much more closely without weakening exact identity, optimistic concurrency, scope integrity, receipts, independent review, validation, repair and commit authorization, commit verification, lineage, or stale-state rejection.

## Evidence baseline and scope

This report inspected the repository and live GitHub issues on September 11, 2026 PDT (September 12 UTC). At inspection time:

- local `main`, `origin/main`, and GitHub `main` all resolved to `78fd6587ad4e28dee512798a62b7e351da3066bb`, titled `Fix repair authorization dispatch ordering`;
- the worktree was clean;
- [issue #140](https://github.com/mikechao/codex-agents/issues/140) was open and had no comments;
- [issue #136](https://github.com/mikechao/codex-agents/issues/136) was closed by the current head change;
- [issue #139](https://github.com/mikechao/codex-agents/issues/139) was open;
- [issue #112](https://github.com/mikechao/codex-agents/issues/112) was closed, with its repository fix present;
- [issue #132](https://github.com/mikechao/codex-agents/issues/132) and [issue #137](https://github.com/mikechao/codex-agents/issues/137) were open and provide additional current evidence.

The principal repository sources are:

- [domain values](.codex/workflow-mcp/values.ts)
- [persisted and projected types](.codex/workflow-mcp/types.ts)
- [phase/action queries](.codex/workflow-mcp/transitions/queries.ts)
- [operator projection](.codex/workflow-mcp/operator-decision.ts)
- [tool schemas](.codex/workflow-mcp/server.ts)
- [review and validation transitions](.codex/workflow-mcp/transitions/review.ts)
- [commit transitions](.codex/workflow-mcp/transitions/commit.ts)
- [store, role views, mutation boundary, and commit reconciliation](.codex/workflow-mcp/store.ts)
- [OpenCode Orchestrator](.opencode/agents/orchestrator.md)
- [implementer contract](.codex/agents/contracts/implementer.md)
- [reviewer contract](.codex/agents/contracts/code_reviewer.md)
- [committer contract](.codex/agents/contracts/committer.md)
- [explanatory workflow documentation](.codex/agents/WORKFLOW.md)

This was a read-only architecture investigation. No implementation or test run was needed to establish the static protocol structure, and no repository files were changed except creation of this requested report.

## 1. Current-state control-plane map

### Durable workflow domains

The current domain declares four roles: `parent`, `implementer`, `reviewer`, and `committer`. It supports `change` and `review_only` workflows; review-only supports `working_tree` and `commit_range` modes.

There are 16 phases:

1. `IMPLEMENTING`
2. `REVIEWING`
3. `REPAIR_REQUIRED`
4. `REPAIRING`
5. `STOPPED_APPROVED`
6. `STOPPED_INCONCLUSIVE`
7. `STOPPED_CONCERNS`
8. `STOPPED_NEEDS_CONTEXT`
9. `STOPPED_IMPLEMENTATION_BLOCKED`
10. `STOPPED_REPAIR_EXHAUSTED`
11. `COMMIT_AUTHORIZED`
12. `COMMIT_PREPARED`
13. `STOPPED_COMMIT_PREPARATION`
14. `STOPPED_NOT_COMMITTED`
15. `STOPPED_COMMIT_MISMATCH`
16. `COMMITTED`

These phases are supplemented by durable status domains rather than represented by phase alone:

- implementation: `DONE`, `DONE_WITH_CONCERNS`, `INCOMPLETE`, `NEEDS_CONTEXT`, `BLOCKED`;
- review: `APPROVED`, `CHANGES_REQUESTED`, `INCONCLUSIVE`;
- validation: `passed`, `failed`, `not_run`, with `command` and `inspection` kinds;
- commit submission: `committed` or `not_committed`;
- verified commit result: `committed`, `not_committed`, or `mismatch`;
- mismatch category: `HEAD_CHANGED`, `PARENT_MISMATCH`, `TREE_MISMATCH`, or `PATH_MISMATCH`;
- finding severity and resolution, acceptance status, finding adjudication, Git path modes, and receipt path states.

The flat version-10 `WorkflowState` also persists data that materially affects orchestration: workflow and runtime identity; optimistic version; objective; immutable plan and work items; plan provenance; workflow type/review mode; base reference; approved scope and append-only expansions; path baselines; acceptance and validation requirements; implementation and review receipts; repair-cycle count and maximum; predecessor/child lineage and supersession; implementation evidence; current and historical findings and adjudications; stop and recovery contexts; exact repair authority; accepted concerns; commit authorization, preparation, and result; and append-only audit history.

### Workflow actions and public tools

The domain declares 27 `WorkflowAction` values:

1. `workflow_create`
2. `workflow_adopt_dirty_scope`
3. `workflow_expand_scope`
4. `workflow_parent_get`
5. `workflow_implementer_get`
6. `workflow_reviewer_get`
7. `workflow_committer_get`
8. `workflow_get_audit`
9. `workflow_submit_implementation`
10. `workflow_record_manual_validation`
11. `workflow_resume_implementation`
12. `workflow_accept_concerns`
13. `workflow_begin_review`
14. `workflow_submit_review`
15. `workflow_authorize_repair`
16. `workflow_adjudicate_findings`
17. `workflow_resume_review`
18. `workflow_finalize_repair_exhausted`
19. `workflow_create_linked_followup`
20. `workflow_create_linked_followup_from_plan`
21. `workflow_authorize_commit`
22. `workflow_prepare_commit`
23. `workflow_submit_commit_result`
24. `workflow_reconcile_commit_result`
25. `workflow_retry_commit_preparation`
26. `workflow_return_commit_to_review`
27. `workflow_retry_commit`

The server exposes 29 workflow tools. The extra protocol surfaces are `workflow_create_from_plan` and `workflow_operator_decision_get`, which deliberately are not `WorkflowAction` values. Five `plan_*` tools are also exposed but belong to the separate planning authority, not workflow execution.

### Operator decisions and recovery choices

The semantic projection has eight decision kinds:

- `no_user_action`
- `inspection_required`
- `approve_exact_repairs`
- `finalize_repair_exhausted`
- `approve_bounded_continuation`
- `approve_recovery`
- `approve_commit`
- `operator_intervention`

Its six normalized recovery choices are:

- `accept_concerns`
- `resume_implementation`
- `resume_review`
- `retry_commit`
- `retry_commit_preparation`
- `return_commit_to_review`

Automatic routes are `implement`, `review`, `re_review`, and `commit`. The projection intentionally omits raw phases, workflow identity, receipts, capabilities, and audit details. This reduces ordinary UX exposure, but it also means an executable mutation usually requires another `workflow_parent_get` plus prompt-owned mapping from semantic decision to tool schema.

### Authority boundaries

**User authority.** The user authorizes semantic choices with durable consequences: exact repair, finding adjudication, concern acceptance, bounded continuation after exhausted repair, recovery/resumption, scope expansion where needed, and commit. Denial or ambiguity must not mutate state or dispatch a worker.

**Parent authority.** Only the parent performs control-plane mutations: scope adoption/expansion, manual inspection evidence, implementation/review recovery, concern acceptance, repair authorization and adjudication, repair exhaustion, linked continuation creation, commit authorization and recovery, and bookkeeping reconciliation. Parent mutation tools require exact workflow identity and expected version. Runtime affinity and optimistic version checks are enforced at the store boundary.

**Implementer authority.** The implementer may inspect its role view, modify only approved paths, and submit implementation status/evidence. In repair mode it must find current persisted repair authority and fail closed when the directive is absent, stale, or does not cover the requested work. It cannot authorize its own repair, expand scope, submit review, or commit.

**Reviewer authority.** The reviewer is read-only. It begins a review to bind the target, independently inspects the exact target, executes only authorized validation commands, and submits approval, blockers, or an inconclusive result. It reports inspection requirements as `not_run`; only the parent may record terminal manual inspection evidence.

**Committer authority.** The committer requires persisted commit authorization and a valid reviewed receipt. It stages the exact authorized set, asks Workflow MCP to verify and persist commit preparation, performs the external commit, and submits the outcome. It must stop immediately on preparation failure and cannot repair, review, or broaden scope.

**Workflow MCP authority.** Persisted state and transition implementations are authoritative. The mutation boundary verifies runtime ownership, identity, expected version, immutable fields, scope and adjudication monotonicity, repository receipts, and append-only audit. Worker checks are defense in depth, not substitutes for this authority.

### Principal lifecycle paths

The sequences below use `D` for the semantic decision read, `P` for exact parent read, `U` for user decision, `M` for parent mutation, and `W` for worker dispatch.

#### Normal implementation → review → approval → commit

`D(implement)` → `W(implementer get + submit DONE)` → `D(review)` → `W(reviewer get + begin + submit APPROVED)` → `D(approve_commit)` → `U` → `P` → `M(authorize_commit)` → refreshed `D(commit)` → `W(committer get + prepare + external commit + submit result)` → refreshed terminal projection.

The server owns each transition, but the Orchestrator owns the procedural stitching: which worker to call, when to reread, how to construct commit authorization, and when successful authorization permits dispatch.

#### Blocking review → repair → re-review

`W(reviewer submit CHANGES_REQUESTED)` → `D(approve_exact_repairs)` → `P(resolve exact current blocker IDs and proposal)` → `U` → fresh `P` → `M(authorize_repair with finding IDs and repair directive)` → refreshed `D(implement)` → `W(implementer executes directive)` → refreshed `D(re_review)` → `W(fresh reviewer with repair-conformance evidence)`.

The durable separation between `REPAIR_REQUIRED` and `REPAIRING` is valuable: it proves that worker repair did not begin before explicit authorization. The accidental complexity is that the Orchestrator must translate an affirmative semantic decision into the nested `repair_directive.user_authorization` shape and must enforce the mutation-before-dispatch order itself.

#### Failed or stale repair authorization

`U(approve proposal)` → fresh `P` discovers changed version/findings/scope, or `M(authorize_repair)` rejects stale version/runtime/directive → no implementer dispatch → refresh `D` and present any changed decision.

The server correctly rejects stale state. The gap exposed by #136 was that dispatch safety depended on prompt sequencing rather than the mutation result mechanically returning the newly legal route.

#### Inconclusive review with pending inspection evidence

`W(reviewer submit INCONCLUSIVE with inspection not_run)` → `D(inspection_required)` → parent obtains actual evidence → fresh `P` → `M(record_manual_validation passed|failed)` → refreshed `D`; when no evidence remains pending, `D(approve recovery: resume_review)` → `U` → fresh `P` → `M(resume_review with resume_context)` → refreshed `D(re_review)` → `W(reviewer)`.

If inspection cannot be performed, the correct action is to wait or seek intervention while leaving it `not_run`; “unavailable” is not evidence of failure. Current server semantics support that distinction, but the projection does not return an executable “wait; do not mutate” constraint.

#### Implementation `NEEDS_CONTEXT` / `BLOCKED` recovery

`W(implementer submit NEEDS_CONTEXT or BLOCKED)` → `D(approve_recovery)` → `U` → fresh `P` → optional separately authorized scope expansion → `M(resume_implementation with resume_context)` → refreshed `D(implement)` → `W(implementer)`.

Scope expansion and resumption are distinct durable decisions. Expansion does not itself resume work. That is defensible, but the Orchestrator must know which tool carries `resume_context` and whether a separate scope mutation is required.

#### Commit preparation failure

`W(committer prepare fails)` → persisted `STOPPED_COMMIT_PREPARATION` → `D(approve one recovery)` → `U` → fresh `P` → either `M(retry_commit_preparation with retry_context)` → refreshed `D(commit)`, or `M(return_commit_to_review with review_context)` → refreshed `D(review)`.

Current classification maps stale receipt failures back to review and staged scope/content failures to retry preparation. Issue #137 demonstrates that `ERROR_STAGED_SCOPE` can also mean the approved/reviewed move or rename source set was incomplete, for which blind retry is ineffective. This is an incomplete error/recovery classification, not evidence that commit preparation should be collapsed away.

#### Not-committed retry

`W(external commit does not complete; submit not_committed)` → `D(approve retry_commit)` → `U` → fresh `P` → `M(retry_commit with retry_context)` → refreshed `D(commit)` → new committer attempt.

`COMMIT_PREPARED` and `STOPPED_NOT_COMMITTED` preserve the boundary around an external side effect and should remain distinct.

#### Commit mismatch

Repository verification detects changed HEAD, parent, tree, or paths → persist `STOPPED_COMMIT_MISMATCH` with category → `D(operator_intervention)`.

Mismatch is deliberately terminal because the system cannot safely infer whether an unexpected commit is acceptable. The generic intervention result could be more explicit, but automatic recovery would weaken safety.

There is a separate cross-runtime bookkeeping route: a parent role view may expose `workflow_reconcile_commit_result` while `COMMIT_PREPARED`; the server then verifies the existing commit and records committed or mismatch. The ordinary operator projection recomputes static phase actions and does not include this store-injected capability, so the Orchestrator cannot discover this route from its normal read.

#### Repair exhaustion and linked continuation

At the maximum repair cycle, `D(finalize_repair_exhausted)` → `P` → `M(finalize)` → refreshed `D(approve_bounded_continuation)` → `U` → fresh `P` → `M(create linked follow-up, optionally from plan)` → child implementation and remediation review → combined/fresh review of the relevant lineage → ordinary approval and commit.

The lineage, supersession, and combined-review semantics are essential. The accidental burden is the amount of exact child construction data the parent must assemble after a high-level continuation decision.

#### Review-only workflows

Review-only starts in `REVIEWING` and never dispatches an implementer unless an approved blocker creates repair work. A `working_tree` review binds and reviews the current target and may proceed to commit. A `commit_range` review evaluates an existing range and does not create another commit. Blocking findings use the same explicit repair authority path.

Two edge cases expose projection gaps rather than a need for new phases:

- #132: a no-change working-tree review can reach approval and then ask for meaningless commit authorization;
- an approved commit-range workflow has no commit action and falls through to generic operator intervention instead of a clear successful terminal result.

## 2. Responsibility and duplication map

| Concern | Persisted state / transitions | `permittedNextActions` | Operator projection | Orchestrator | Workers |
|---|---|---|---|---|---|
| Phase legality | Authoritative transition guards | Phase matrix plus dynamic filters | Reinterprets phases/actions into decisions | Reconstructs route and sequence | Role getter and submission reject invalid states |
| Identity/runtime/version | Store enforces exact identity, runtime affinity, and optimistic version | Exposed in role views, not normal decision | Intentionally omitted | Must perform parent read and copy exact values | Getters fail closed |
| Scope/path integrity | State, baselines, expansions, receipts, and transition validation | Some actions dynamically filtered | Semantic summaries only | Must compare proposal/current scope before mutation | Implementer and committer enforce approved paths |
| Repair cycle | State and repair transition enforce maximum | Matrix advertises both authorize and finalize in `REPAIR_REQUIRED` | Chooses one by cycle count | Must trust projection but invoke correct tool | Implementer requires exact directive |
| Repair proposal | Exact findings and directive persisted | Only action name | Generic proposal; required/forbidden path arrays may be empty | Reads raw state and constructs IDs/directive/nested authorization | Enforces directive and conformance |
| User authorization | Tool-specific fields and audit | Not represented structurally | `authorization_required` semantic flag | Must know whether authorization is absent, top-level, or nested | Requires resulting persisted authority, not conversation approval |
| Recovery | Stop/recovery contexts and tool-specific transitions | Raw action names | Normalizes six choices | Maps choice back to exact tool and context field | Resumes only after state changes |
| Inspection evidence | Validation state; terminal results immutable | Pending evidence gates review/approval | Names required inspection | Must classify observed failure vs unavailable evidence and construct write | Reviewer reports `not_run`/`INCONCLUSIVE` |
| Review freshness | Receipt binding and resume/reset transitions | Review/re-review routes | Supplies semantic route | Must dispatch fresh reviewer at correct point | Reviewer independently reads and binds target |
| Commit authorization | Persisted authorization and reviewed receipt | Commit tool availability | Asks semantic approval | Constructs authorization mutation and sequences committer | Committer verifies persisted authority |
| Commit recovery | Preparation/result states and repository verification | Retry/return actions | Normalized recovery | Maps to `retry_context` or `review_context` | Committer stops on preparation failure |
| Reconciliation | Store injects parent-only capability and verifies Git | Static calculation misses injected action | Does not expose route | Prompt must know exceptional path | Not a normal committer action |
| Lineage/continuation | State, linked creation, supersession, combined review | Linked actions | Bounded continuation decision | Constructs selected linked-workflow mutation | Workers consume child role views |

The most important concrete duplication is in `REPAIR_REQUIRED`. The action matrix includes both `workflow_authorize_repair` and `workflow_finalize_repair_exhausted`. The authorize transition rejects at the cycle maximum; finalize rejects before it. The operator projection independently inspects the cycle and chooses the correct action. Thus `permitted_next_actions` is an over-approximation despite its name, and exact legality is split between transition guards and projection logic.

The most consequential leakage into the Orchestrator is mutation-shape knowledge:

- `resume_implementation` takes `resume_context`;
- `resume_review` also takes `resume_context`;
- `retry_commit` and `retry_commit_preparation` take `retry_context`;
- `return_commit_to_review` takes `review_context`;
- `accept_concerns`, finding adjudication, and commit authorization take top-level `user_authorization`;
- repair authorization carries user authorization inside `repair_directive`;
- repair exhaustion takes no authorization field even though the semantic flow can require a user-owned decision.

These schemas can each be reasonable domain APIs. Requiring the model to infer them from a generic `authorization_required: true` flag is not reasonable protocol design.

Workers intentionally duplicate some checks. Their fail-closed role contracts defend against stale handoffs, unauthorized paths, missing repair directives, non-independent review, and unprepared commits. That duplication is valuable defense in depth because a model may receive a bad dispatch. It is different from asking the parent model to reproduce the exact transition protocol merely to invoke the authoritative server.

## 3. Dogfood failure analysis

### #136: approval before persisted repair authorization

Observed shape: the user approved repair, but the Orchestrator dispatched the implementer before `workflow_authorize_repair` had successfully persisted repair authority. The implementer then correctly failed closed because the authoritative state did not permit repair.

The current head fixes the prompt ordering: affirmative user decision → fresh parent read → repair authorization mutation → refreshed operator decision → implementer dispatch, with no dispatch after stale state, mutation failure, or MCP outage.

Classification:

- **Primary:** duplicated authority representation and sequencing knowledge.
- **Also:** incomplete projection—the semantic decision did not carry an executable mutation-and-success-route contract.
- **Not primary:** necessary domain complexity. Explicit persisted repair authorization is a valuable safety property.
- **Not a worker failure:** the implementer behaved correctly by rejecting conversational authorization that was not in state.

The prompt fix is appropriate containment, but it leaves the same class of sequencing error possible elsewhere.

### #139: `authorization_required` misread as a mutation field

Observed shape: the Orchestrator interpreted semantic `authorization_required: true` as meaning that the selected recovery tool accepted a `user_authorization` argument. The recovery schema did not accept that field.

Classification:

- **Primary:** mutation-shape knowledge leaking into the Orchestrator.
- **Also:** incomplete projection and prompt ambiguity.
- **Not:** an internally inconsistent tool schema. Recovery tools use domain-specific context fields; the projection simply does not describe the invocation contract.
- **Not solved by:** adding `user_authorization` indiscriminately to every tool. That would conflate semantic user consent, persisted domain authority, and audit metadata.

The server should mechanically say whether authorization is required for presentation, whether it is represented in the mutation payload, and where any payload value belongs.

### #112-shaped validation failure

Original shape: an inspection that had not actually run was recorded as terminal `failed`. Later real evidence could not replace it because terminal validation results are immutable, leaving the workflow effectively unrecoverable.

The current repository has meaningful fixes: reviewer contracts distinguish unavailable inspection from observed failure, inspection requirements remain `not_run`, manual evidence may be recorded from relevant stopped states, and review resumption is blocked while inspection evidence is pending.

The residual architectural risk remains. `workflow_record_manual_validation` accepts only `passed` or `failed`, and the semantic projection tells the Orchestrator that inspection is required but does not mechanically state: invoke this mutation only after observation; if evidence is unavailable, do not mutate and remain pending.

Classification:

- **Primary:** incomplete projection of evidence-authoring preconditions.
- **Also:** evidence semantics left partly to prompt interpretation.
- **Not primary:** terminal immutability. Preventing later replacement of signed-off evidence is a useful audit and safety property.
- **Recommended response:** make “pending/unavailable means wait, not failed” executable protocol metadata; do not generally make failed evidence mutable.

### Additional current-repository evidence

**#137—commit preparation recovery.** `ERROR_STAGED_SCOPE` is mapped to retry preparation, but a reviewed rename/move can expose an incomplete authorized source-path set that retrying cannot repair. This is an incomplete error taxonomy and recovery projection. The durable preparation phase is still necessary.

**#132—no-change review-only.** A no-change working-tree review can produce approval but still prompt for commit authorization. This is a missing derived semantic outcome: “approved, no commit needed.” It does not justify another state or broad workflow rewrite.

**Cross-runtime reconciliation blind spot.** `workflow_parent_get` can expose `workflow_reconcile_commit_result` through a store-injected runtime capability, while `workflow_operator_decision_get` recomputes static phase actions and misses it. This is direct current evidence that the normal projection is not a complete description of the next legal action.

**Generic terminal projection.** `STOPPED_COMMIT_MISMATCH`, completed workflows, approved commit ranges, and some approved states without a commit route become generic `operator_intervention`. The server knows materially different outcomes but projects them through one catch-all.

## 4. Essential versus accidental complexity

### Essential safety/domain complexity to preserve

- exact workflow, plan, runtime, and attempt identity;
- optimistic version checks and stale-state rejection;
- immutable approved plan/work items and append-only scope expansion;
- path baselines, approved scope, receipts, and repository-state verification;
- role separation and independent code review;
- explicit `not_run` versus observed validation failure;
- terminal validation evidence and reset only through legitimate new implementation/review cycles;
- exact blocker IDs, repair directive, cycle count, and repair-conformance review;
- explicit persisted repair authorization;
- fail-closed workers;
- explicit commit authorization;
- distinct commit authorization, preparation, external side effect, result, and mismatch verification;
- terminal mismatch rather than guessed reconciliation;
- lineage, supersession, linked continuation, and combined review;
- append-only audit and provenance.

### Accidental orchestration/protocol complexity

- semantic decision → tool-name mapping in the Orchestrator;
- tool-name → context-field mapping (`resume_context`, `retry_context`, `review_context`);
- guessing whether and where user authorization belongs in a payload;
- reconstructing exact finding IDs, repair paths, and directive structure from raw state;
- prompt-owned mutation-before-dispatch sequencing;
- requiring a full projection reread after every successful mutation when the mutation response could return the derived next route;
- `permitted_next_actions` that over-approximates actual transition legality;
- operator projection blindness to dynamically injected reconciliation capability;
- generic intervention for known terminal/success conditions;
- prompt-only prohibition on recording unavailable inspection as failure;
- coarse commit-preparation error-to-recovery mapping;
- no-change and commit-range completion ambiguity.

The number of phases and tools is therefore a poor optimization target. Collapsing meaningful states could shorten the inventory while increasing ambiguity and weakening auditability.

## 5. Candidate architectures

### Direction 1: minimal-change, complete the projection and contracts

Keep the state model and all typed tools. Extend `workflow_operator_decision_get` with exact operation metadata and tighten existing projections:

```json
{
  "decision": "approve_recovery",
  "choice": "resume_review",
  "invocation_requirements": {
    "tool": "workflow_resume_review",
    "required_fields": ["workflow_id", "expected_version", "resume_context"],
    "authorization_required": true,
    "authorization_payload_location": null
  }
}
```

Also make `permitted_next_actions` exact, include runtime-derived reconciliation, add explicit terminal outcomes, state inspection evidence preconditions, and resolve #132/#137 classifications.

Advantages:

- no persisted-state migration;
- no generic mutation endpoint;
- preserves typed schemas and existing audit records;
- low implementation and rollout risk;
- directly fixes the field-guessing problem behind #139.

Disadvantages:

- the Orchestrator still copies identifiers and constructs payloads;
- mutation and subsequent dispatch remain separate prompt-owned steps;
- repair proposals may still require a raw parent read and model assembly;
- projection metadata can drift from schemas unless generated or derived mechanically.

Expected reasoning reduction: moderate. It makes the prompt more reliable but does not fully remove its role as protocol interpreter.

### Direction 2: server-owned executable next action — recommended

Return a bounded semantic next action plus a server-derived action envelope. The descriptor is not a bearer token and does not bypass transition validation; every mutation still rechecks identity, version, runtime, scope, and current state.

```json
{
  "primary": {
    "kind": "approve_recovery",
    "summary": "Resume review after required inspection evidence is complete"
  },
  "next_action": {
    "mode": "parent_mutation",
    "operation": "workflow_resume_review",
    "fixed_arguments": {
      "workflow_id": "wf_...",
      "expected_version": 17
    },
    "required_inputs": [
      {
        "name": "resume_context",
        "type": "bounded_string",
        "source": "approved_recovery_context"
      }
    ],
    "authorization": {
      "required": true,
      "payload_location": null
    },
    "on_success": {
      "mode": "dispatch",
      "role": "reviewer"
    }
  }
}
```

For repair, the descriptor would contain the exact current blocker IDs, a server-derived directive template, scope constraints, and the fact that authorization belongs inside the directive. For inspection it would state `invoke_only_after_observation` and return `wait` when evidence is unavailable. For automatic routes it would return the worker role directly. Successful parent mutations should return the refreshed descriptor derived from the committed new state.

The Orchestrator’s remaining responsibilities become appropriately semantic:

1. read one fresh authoritative descriptor;
2. present the exact bounded proposal when user consent is required;
3. collect only the declared semantic input slots;
4. invoke the declared operation with fixed and supplied inputs;
5. dispatch only the route returned by the successful mutation.

Advantages:

- removes tool and field guessing;
- makes mutation-before-dispatch structural, addressing #136;
- separates semantic authorization from payload representation, addressing #139;
- makes unavailable inspection a wait state rather than a tempting `failed` write, addressing #112-shaped failures;
- captures runtime-derived routes such as reconciliation;
- retains typed tools, narrow authority, server validation, audit, and fail-closed behavior;
- materially approaches the stated one-read criterion.

Disadvantages:

- requires a versioned descriptor schema and consistency tests;
- mutation responses and projection logic need a shared derivation path;
- user-entered strings still need bounds and exact proposal binding;
- existing orchestrator/runtime versions need a compatibility transition at the self-hosting boundary.

Expected reasoning reduction: high. The model chooses and explains semantic input but stops reconstructing legal protocol mechanics.

### Direction 3: deeper semantic consolidation

Possible consolidations include representing `STOPPED_NEEDS_CONTEXT` and `STOPPED_IMPLEMENTATION_BLOCKED` as one implementation stop with a durable reason, unifying recovery mutations under a typed recovery family, or making repair exhaustion transition directly into a continuation decision.

Advantages:

- can remove some repeated phase/action mapping;
- may simplify reporting and stop/recovery code;
- could provide a common recovery envelope.

Disadvantages:

- requires persisted-state migration and compatibility handling;
- risks hiding distinctions useful for audit, UX, and policy;
- does not by itself solve payload guessing or sequencing;
- broadens the change surface across transitions, schemas, contracts, tests, and installed runtimes;
- commit phases, concern acceptance, repair authority, and mismatch should not be merged because they represent genuinely different safety facts.

Expected reasoning reduction: low to moderate unless combined with Direction 2. It is not justified as the first move.

### Comparative failure and safety evaluation

| Scenario | Direction 1 | Direction 2 | Direction 3 |
|---|---|---|---|
| Stale version/runtime | Existing server rejection preserved; model still copies values | Fixed version/runtime in descriptor; server rechecks on use | Preserved if carefully migrated; no inherent improvement |
| Changed scope/proposal | Fresh parent read and prompt comparison | Version-bound exact proposal; changed state invalidates action | Same need remains |
| User denial/ambiguity | Prompt must avoid mutation | Descriptor remains non-executable until affirmative input is bound | Same as chosen interface |
| MCP/tool failure | Prompt must suspend | No success route returned, therefore no dispatch | Same underlying need |
| Pending inspection | Better prose/metadata | Explicit collect/wait mode; no failed mutation offered | State consolidation does not solve classification |
| Observed failed validation | Existing immutable evidence retained | Exact evidence mutation offered only after observation | Must preserve immutable evidence semantics |
| Repair authorization | Invocation requirements clarify shape | Exact blockers/directive/auth location; dispatch returned only after success | Fewer states would not remove authority need |
| Worker dispatch | Still prompt-sequenced | Server-returned successful route | Still prompt-sequenced unless paired with envelope |
| Fresh re-review | Existing route retained | Explicit reviewer dispatch after repair submission/resume | Risk of obscuring freshness if over-consolidated |
| Commit recovery | Fields documented | Exact retry/return/reconcile action returned | Commit state collapse would weaken side-effect accounting |
| Commit mismatch | Can project explicit terminal outcome | Explicit terminal descriptor, no mutation | Must remain distinct |
| Auditability | Unchanged | Unchanged or improved by recording descriptor/action identity | Migration risk |
| Fail-closed behavior | Improved somewhat | Strongest: no route on failed mutation or missing evidence | Depends on redesign quality |

### Uniform authorization representation

User semantic authorization should have a uniform **protocol description**, not necessarily a universal mutation field.

The projection should consistently report:

- whether affirmative user consent is required;
- the exact proposal being authorized;
- which parts of that proposal are version/scope bound;
- whether authorization is persisted as a domain field, included in audit metadata only, nested in another domain object, or represented solely by invoking a user-gated transition;
- what operation becomes legal after consent.

Tool-specific mutations remain preferable where their persisted meanings differ. A repair directive, concern acceptance, commit authorization, and recovery rationale are not the same domain object. Forcing all tools to accept `user_authorization` would make surface syntax uniform while muddying semantics. If consistent decision auditing is desired, add common server-owned audit metadata rather than requiring the Orchestrator to put an identically named field into every state mutation.

## 6. Recommendation

Adopt Direction 2 as a focused protocol evolution, using Direction 1 as its compatibility stepping stone. Do not begin by reducing the 16 phases or replacing the typed tools with a generic “advance workflow” mutation.

Specifically:

1. Establish one server-owned computation of the exact next legal action. It must incorporate transition guards, dynamic role capabilities, repair-cycle limits, validation gates, workflow type/mode, and runtime reconciliation.
2. Have `workflow_operator_decision_get` return both the human-facing semantic decision and a bounded executable descriptor derived from that computation.
3. Bind descriptors to exact workflow identity and version. Continue revalidating every invariant in transition implementations; the descriptor is guidance, not authority by itself.
4. Represent user authorization uniformly in descriptor metadata while retaining tool-specific mutation schemas and persisted domain fields.
5. Return the refreshed next-action descriptor from successful parent mutations. Worker dispatch then follows only from a committed state transition.
6. Add explicit projection modes for `dispatch`, `parent_mutation`, `collect_evidence`, `wait`, and `terminal`. Avoid routing known outcomes through generic operator intervention.
7. Keep worker fail-closed checks as defense in depth.

How close is the current system to the target criterion?

- **Automatic implementation/review routes:** relatively close; the projection already supplies role routes.
- **Ordinary commit:** workable but still depends on parent payload and sequencing knowledge.
- **Repair:** not close; exact proposal construction, nested authorization shape, version refresh, mutation ordering, and dispatch sequencing are prompt-owned.
- **Recovery:** not close; normalized choices do not describe exact tool schemas.
- **Inspection:** not close enough; pending evidence is visible, but safe evidence-authoring preconditions are not executable.
- **Cross-runtime reconciliation:** fails the criterion because the normal projection omits a legal dynamic action.

The minimum change that gets materially closer is an exact invocation descriptor for all parent decisions plus refreshed action/route data in mutation responses. That removes the need to grep source, guess fields, probe writes, or reconstruct transition rules from prose while leaving the proven durable safety model intact.

## 7. Suggested follow-up work

These should be small dependency-ordered issues, not one state-machine rewrite:

1. **Make next-action legality single-source and exact.** Remove the repair-cycle over-approximation, incorporate dynamic reconciliation, and define explicit successful/terminal outcomes for commit-range, no-change, committed, and mismatch cases.
2. **Define and version the executable next-action descriptor.** Specify modes, operation identity, fixed arguments, semantic input slots, authorization representation, proposal binding, and success route. Keep it non-authoritative and version-bound.
3. **Cover recovery and inspection first.** Generate exact context-field requirements for every recovery tool and encode observed/pending/unavailable inspection semantics. Add regression scenarios for #139 and #112.
4. **Add exact repair envelopes.** Include blocker IDs, directive template, scope constraints, authorization location, cycle state, and the post-success implementer route. Add #136 ordering and stale-state regressions.
5. **Return refreshed descriptors from parent mutations.** Ensure failed/stale mutations return no dispatch route; successful mutations derive their route from committed state.
6. **Teach the Orchestrator to consume descriptors.** Remove prompt-owned tool/payload maps and mutation-before-dispatch branches once coverage exists; retain user presentation, semantic input collection, and failure suspension.
7. **Resolve current semantic gaps.** Address #132 no-change completion, #137 move/rename preparation classification, approved commit-range completion, and cross-runtime reconciliation visibility.
8. **Reassess phase consolidation only after protocol simplification.** Measure remaining duplication. If implementation stop phases still provide no distinct policy or audit value, consider a narrow migration; do not combine commit, repair-authority, concern, or mismatch states.

## Final assessment

The system has accumulated real control-plane complexity, but most of its durable state is carrying safety meaning. The strongest evidence does not support deleting phases wholesale. It supports relocating executable orchestration knowledge from the model prompt into the authoritative server projection.

The desired boundary is:

> Workflow MCP decides what is legal and mechanically describes how to invoke it; the user decides the bounded semantic question; the Orchestrator presents, binds declared inputs, invokes, and dispatches; workers independently fail closed against authoritative state.

That is a comparatively small architectural shift with a large reduction in model-owned workflow reasoning.
