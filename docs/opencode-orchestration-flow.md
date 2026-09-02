# OpenCode orchestration flow

This guide describes the current OpenCode architecture in this repository. The custom
`orchestrator` is the workflow control plane: it coordinates the authoritative `workflow_state`
MCP workflow and delegates repository work to the shared worker roles. It is not a replacement for
the normal OpenCode agents, and it does not edit, stage, or commit files.

OpenCode planning is a separate pre-workflow topology. The native built-in `agent.plan` override is
the user-facing mediator and presenter: it delegates substantial planning and every material
refinement to the generated `planner`, which may fan out zero to four hidden, read-only `explorer`
agents. Explorer context is disposable and is never persisted in Workflow MCP or plan artifacts.
Planner is the sole complete plan writer/refiner and returns one bounded `PlannerHandoff`; Plan uses
the parent surface to retrieve and render exact `full_plan` text verbatim, then explicitly approves.
Orchestrator only parent-reads the exact current approved plan and executes it through
`workflow_create_from_plan`.

The complete workflow-state contract, including every transition and stop condition, is in
[`.codex/agents/WORKFLOW.md`](../.codex/agents/WORKFLOW.md). This guide explains how the OpenCode
primary routes a normal implementation without reproducing that state machine.

## Semantic operator refresh

After creation or reuse, each worker handoff, and each parent mutation, Orchestrator reads the
read-only `workflow_operator_decision_get` projection. It is the normal routing surface: when the
projection proves `no_user_action`, Orchestrator automatically dispatches implementation, review,
re-review, or the already-authorized commit preparation route. The projection is bounded to the
requested workflow and reciprocal explicit linked lineage, and normal text contains semantic
outcomes rather than raw workflow/plan IDs, phases, actions, audits, capabilities, or receipts.

The operator question is decision-first and asks for a semantic choice. The projection is read-only and not authorization; before
asking for a mutation, Orchestrator combines it with an exact `workflow_parent_get` read to resolve
one concrete safe proposal. It presents the consequence and exact repository-relative visible paths
when deterministic, or bounded semantic alternatives when the paths/objective/recovery choice
differs. It asks for only the user's genuine choice, never for known IDs, versions, capabilities,
finding IDs, lineage, contracts, internal action/phase names, or an exact payload. Internal Workflow
MCP names and phases are not ordinary labels, while existing semantic values such as
`approve_recovery`, `retry_commit`, `approve_bounded_continuation`, `no_user_action`, `route: review`,
and `route: re_review` remain valid.

An unambiguous contextual natural-language answer is sufficient: `yes`, `continue`, `go ahead`, and
`commit it` are examples, not a required incantation, `Reply ...` incantation, or magic phrase.
Negative, ambiguous, unrelated, changed, or
stale responses fail closed without mutation. After affirmative input, Orchestrator re-reads
authoritative state and verifies proposal, scope, findings, lineage, plan binding, permitted action,
runtime authority, and version before encoding exactly the existing mutation. Conversation memory is never
a proposal or authority, and no durable proposal state or parser is added. No durable proposal state is
created by the operator exchange.

Exact repair, concern/context/review recovery, bounded linked continuation, scope expansion and
changed-intent classification, final reconciliation, and commit authorization remain explicit.
Orchestrator compares a newly supplied objective, outcome, criteria, and logical-change scope at its
input boundary; an ID-only projection never makes that classification. Full parent reads are used
only for exact current mutation inputs or explicit debug/status requests.

Explicit linked chains can report their existing combined-review requirement. Separately created
workflows are not joined through matching work items, paths, branches, or conversation history. If
authoritative logical-change topology is absent or contradictory, Orchestrator fails closed and
requires the repository-owned relationship prerequisite described by #22 rather than synthesizing
a reconciliation workflow.

## Entry paths

There are two supported ways to begin implementation:

1. **Direct Orchestrator.** A user makes a non-trivial implementation request while using the
   `orchestrator` primary. Orchestrator performs bounded, read-only preflight (the current Git
   status and `HEAD`, plus the exact objective, approved paths, acceptance criteria, and validation
   requirements), then creates or reuses the authoritative workflow. It does not investigate the
   implementation in depth or solve it in the primary session.
2. **Plan -> Orchestrator.** A user runs `/plan <request>` in the built-in Plan primary. Plan
   delegates to `planner`, retrieves the exact plan artifact, renders its `full_plan` verbatim, and
   waits for explicit approval of the exact plan ID/revision. Plan does not create an implementation
   workflow. The user then switches to Orchestrator and says `implement the approved plan` (or
   equivalent). Orchestrator consumes the one exact identity from the immediately preceding approved
   Native Plan handoff without redundant identity reconfirmation, parent-verifies current approval,
   performs policy preflight, calls `workflow_create_from_plan`, and dispatches the plan-derived
   workflow to the implementer. If no single exact identity is bound, Orchestrator asks which
   semantic plan is intended and never selects historical, stale, or unrelated plan state.

In both paths, the custom Orchestrator primary is the workflow control plane rather than Build.
OpenCode's built-in Build agent remains available for deliberate ordinary direct coding and receives
no project-global orchestration instructions. Select it explicitly when workflow-backed delegation
is not wanted.

The generated planner is the sole author of persisted plan revisions. The host-native Plan agent is
the user-facing mediator, not a second planner implementation: it delegates only to `planner` and
accepts its bounded handoff before parent retrieval and approval. Orchestrator is not a planning
entry point and has no plan approval or planner dispatch authority.

For planning requests, delegate only to `planner`, never directly to `explorer`. The planner may use
the optional target-owned `.codex/planner-policy.json` as advisory guidance, but malformed or
authority-bearing content becomes bounded `needs_input` risk and cannot grant capabilities, approval,
scope, or validation authority. Before `ready_for_approval`, each executable validation argv must
match `.codex/reviewer-validation.json` by exact array equality. A missing or mismatched policy stops
planning rather than guessing.

Material plan refinement uses the existing `plan_revise` operation with exactly the plan ID, exact
optimistic base revision, and a required non-empty bounded `replacements` object. The server copies
omitted fields only from the exact verified base artifact, replaces each supplied array wholesale,
and validates/normalizes a complete candidate before inserting one immutable revision. Invalid,
unknown, null, or empty replacements fail closed; no second complete-replacement operation exists.

For Plan -> Orchestrator execution, `workflow_create_from_plan` receives only the exact approved
plan ID/revision and supported creation options; the server copies immutable `approved_plan` and
provenance from the authoritative artifact. Orchestrator must not summarize or reconstruct it.
Direct requests pass `approved_plan: null`. The parent view and implementer view expose this execution intent, while
reviewer and committer views retain least-context projections. Objective, paths, acceptance criteria,
validation requirements, and authorized remediation/findings remain structured enforcement fields.

For a plan-native linked follow-up, parent-read the exact child plan identity and approval, optionally
read the artifact for reviewer-policy preflight, then call `workflow_create_linked_followup_from_plan`
with only source authority/version, plan ID/revision, exact finding IDs, and explicit authorization.
The server resolves and binds the current approved artifact inside the source/child transaction;
artifact prose and contracts are never retranscribed. The legacy
`workflow_create_linked_followup` remains the direct-contract compatibility route.

The orchestrator passes only explicit user-approved work-item metadata to `workflow_create` or
`workflow_create_from_plan`; absent tracker metadata is represented as `work_items: []`. These generic
immutable references are schema v8 state, shown only to parent and committer, and inherited automatically
by linked follow-ups. Linked creation never accepts retranscribed replacements or externally discovered identifiers. The committer
renders exact authoritative display references as neutral `Refs <display_ref>` lines, with no tracker
API calls and no `Fixes`/`Closes`/`Resolves` completion semantics.

## Identity and handoffs

The authoritative server is the source of truth. Every worker handoff carries exactly the workflow ID;
workers obtain their role view and current version from a dedicated getter:

- `workflow_id`: the exact workflow identifier created or reused by Orchestrator;
- workers call `workflow_implementer_get`, `workflow_reviewer_get`, or `workflow_committer_get`;
- parent control-plane mutations carry only semantic inputs and expected version; runtime authority is
  supplied by the executing host and launch attestation.

For this repository's self-host registration, the MCP command first materializes the bootstrap
supervisor from the provider repository's committed `HEAD`, rather than executing the mutable
checkout copy. Bootstrap fails closed unless the supervised and provider paths resolve to the same
canonical Git root. The supervisor then materializes the provider's committed runtime through the
runtime-artifact API, launches that immutable path, and records runtime affinity with each workflow.
A restart promotes the current committed runtime for new workflows; requests for unfinished workflows
are routed to their persisted owning artifact. Editing or committing the provider checkout never
hot-swaps a running artifact.

Installed repositories have a deliberately simpler boundary: Codex and OpenCode invoke the
provider's absolute `.codex/workflow-mcp/server.ts` directly. The installer does not copy the
bootstrap, supervisor, or runtime-artifact sources, and installed mode has no runtime-affinity
lifecycle; its direct server uses the target repository's Git and durable state.

Runtime authority is never guessed, regenerated, or replaced. Before dispatching
the next role, Orchestrator refreshes the operator projection and uses its semantic decision. It
reads the parent view only when exact mutation inputs/version are needed. Each worker's first authoritative action is its dedicated capability-free getter. The
returned role view supplies that worker's objective, scope, criteria, evidence, receipts,
repair context, and next actions; receipt data and digests remain internal to Workflow MCP, and the
prompt does not duplicate them.

The approved plan is immutable, but the effective approved path scope may be expanded append-only by
the parent with `workflow_expand_scope` in the explicitly permitted implementation and repair stops.
The parent must have fresh user authorization naming exact paths; Workflow MCP captures clean or
absent baselines and records the amendment parent-only. After expansion, refresh the operator
projection and implementer views before dispatch: stale implementation/review evidence is cleared and fresh
implementation and review are required without consuming a repair cycle.

Workers perform their role and submit a terminal MCP result through their role-specific submission
tool. After a successful terminal submission, the OpenCode adapter also requires a non-empty normal
text report to the parent. Orchestrator refreshes the operator projection immediately after each
terminal worker handoff before deciding what happens next.

The refresh is semantic-decision-first. After every terminal implementation handoff—including an
authorized repair completion—Orchestrator calls `workflow_operator_decision_get` before summarizing
or routing. If it reports `no_user_action/review` or `no_user_action/re_review`, it directly dispatches
a fresh `code_reviewer`, even when the projection retains an earlier blocker summary. Retained
blockers are history/remediation context only and do not cause a duplicate repair-authorization
prompt. Full parent reads remain an exact-mutation-input or explicit debug/status escape hatch.

## Normal implementation, review, and commit flow

Orchestrator's preflight is deliberately bounded. The implementer owns detailed implementation
investigation, edits, and required validation. The code reviewer independently inspects the declared
working-tree target and is read-only; it does not fix findings or authorize a commit. The committer
prepares and executes only the exact approved scope after the required gates, and it reports the
external Git result back to the workflow server.

### Validation-policy preflight

Before creating a managed workflow, Orchestrator reads the target repository's
`.codex/reviewer-validation.json` policy and checks every proposed executable validation. Authorization
is exact structured `argv` equality: length, argument ordering, and every individual argument must
match a policy command. Workflow-local validation IDs, descriptions, prefixes, and approximate matches
do not authorize execution. A requirement with `argv: null` is an explicit manual check and is never
executed.

This preflight addresses the #34 regression in which a workflow could be created with a required
executable validation that the reviewer policy did not authorize, leaving review to fail later with
an unavailable check. When a proposed command is not authorized, Orchestrator does not edit the
policy, run the reviewer validation, silently drop the requirement, or claim that it passed manually.
It may use an already-authorized exact argv only when that command is genuinely sufficient for the
same check, or represent a genuinely manual check with `argv: null`; otherwise it reports the policy
mismatch and stops before `workflow_create` or `workflow_create_from_plan`. Policy reading and comparison stay bounded and
read-only, with no helper execution or reviewer enforcement changes.

The illustrative happy path is:

```text
IMPLEMENTING (v0) -> REVIEWING (v1) -> STOPPED_APPROVED (v2) -> COMMIT_AUTHORIZED (v3) -> COMMIT_PREPARED (v4) -> COMMITTED (v5)
```

The version numbers in this illustrative sequence are examples only and are **not normative**; the
server's returned `expected_version` is always authoritative. Review approval stops at
`STOPPED_APPROVED` until the user explicitly authorizes the commit. Review approval by itself is not
commit authorization, and optional findings do not authorize extra remediation.

After explicit user authorization, Orchestrator authorizes the commit in the workflow, refreshes the
operator projection, and dispatches the committer. Working-tree reviewers first call `workflow_begin_review`;
Workflow MCP owns receipt capture and comparison. The committer stages complete approved paths
(never partial hunks), calls `workflow_prepare_commit`, runs the external Git commit,
and submits the commit result whether Git succeeds or fails. Orchestrator performs the final parent
refresh after that terminal handoff.

### Intent classification and final-tree reconciliation

Before mutation or dispatch, classify the request into one of three routes:

1. **Unchanged approved intent:** a P0-P2 defect is ordinary repair. Use the latest refreshed review's
   exact blocking IDs, explicit authorization, `workflow_authorize_repair`, implementer, and a fresh
   independent review.
2. **Changed intent:** a material change to the objective, desired outcome, acceptance criteria, or
   logical change stops the current route. It requires explicit authorization naming a new bounded
   objective and exact scope, then a new bounded `change` workflow with its own criteria, validations, and
   approved plan where applicable. Repair, adjudication, `workflow_expand_scope`, and generic linked
   follow-ups are not substitutes.
3. **Final-tree reconciliation:** an already-dirty logical change requires explicit authorization for
   a `review_only` workflow with `review_mode: working_tree`, current HEAD as `base_revision`,
   `head_revision: null`, and `include_staged`, `include_unstaged`, and `include_untracked` all
   `true`. Its exact complete
   repository-relative path allowlist covers the whole logical change, including approved-untracked
   content, while excluding unrelated and ignored state. Dispatch `code_reviewer` directly, never
   implementer first. Only a fresh reconciliation review reports blocking findings; ordinary exact-ID
   repair authorization is then required before permitting implementer. Optional findings never
   trigger remediation.

Approval is separate from commit authorization. Once freshly approved and explicitly authorized,
the committer stages the complete exact logical-change scope and makes one coherent commit. Supported
finding-linked follow-ups remain narrow: a supported active source, exact current finding IDs,
narrow remediation context and scope, and a fresh combined review. They cannot serve as changed intent
or reconciliation shortcuts. After every terminal worker handoff and parent mutation, refresh the
read-only `workflow_operator_decision_get` projection, summarize only its bounded semantic result,
and route from its fresh decision; stale prose and dirty-path inference grant no authority. Use the
full parent view only for exact mutation inputs/version or explicit debug/status detail.

```mermaid
sequenceDiagram
    actor User
    participant Plan
    participant Orchestrator
    participant workflow_state
    participant implementer
    participant code_reviewer
    participant committer
    participant GitWorkingTree as Git/working tree

    alt Direct implementation request
        User->>Orchestrator: Implement request
    else Approved Plan execution
        User->>Plan: /plan non-trivial request
        Plan->>planner: Delegate planning/refinement
        planner-->>Plan: Bounded PlannerHandoff
        Plan->>workflow_state: Parent-read exact plan revision
        workflow_state-->>Plan: Authoritative full_plan
        Plan-->>User: Render full_plan verbatim; await explicit approval
        User->>Plan: Approve exact plan ID/revision
        Plan->>workflow_state: Parent-read and approve exact revision
        Plan-->>User: Exact approved plan ID/revision
        User->>Orchestrator: implement the approved plan
        Note over Plan,Orchestrator: The immediately preceding exact approved handoff supplies identity; Orchestrator still parent-verifies it and does not re-plan or approve.
    end
    Orchestrator->>GitWorkingTree: Read-only preflight: status and HEAD
    Orchestrator->>workflow_state: Parent-read exact approved plan and policy preflight
    Orchestrator->>workflow_state: workflow_create_from_plan (identity/options/work items only)
    workflow_state-->>Orchestrator: Exact workflow_id + parent view
    Orchestrator->>workflow_state: workflow_operator_decision_get refresh
    workflow_state-->>Orchestrator: Semantic implementation decision
    Orchestrator->>implementer: Exact workflow_id
    implementer->>workflow_state: Initial workflow_implementer_get
    workflow_state-->>implementer: Authoritative implementer view
    implementer->>GitWorkingTree: Implement approved scope and validate
    implementer->>workflow_state: Terminal implementation submission
    implementer-->>Orchestrator: Final textual implementation report
    Orchestrator->>workflow_state: workflow_operator_decision_get refresh
    workflow_state-->>Orchestrator: Semantic no_user_action/review decision
    Orchestrator->>code_reviewer: Exact workflow_id
    code_reviewer->>workflow_state: Initial workflow_reviewer_get
    workflow_state-->>code_reviewer: Authoritative reviewer view
    code_reviewer->>workflow_state: workflow_begin_review (working tree)
    code_reviewer->>GitWorkingTree: Independent read-only review
    code_reviewer->>workflow_state: Terminal review submission
    code_reviewer-->>Orchestrator: Final textual review report
    Orchestrator->>workflow_state: workflow_operator_decision_get refresh
    workflow_state-->>Orchestrator: Explicit commit-authorization boundary
    User->>Orchestrator: Explicit commit authorization
    Orchestrator->>workflow_state: Authorize commit
    Orchestrator->>workflow_state: workflow_operator_decision_get refresh
    workflow_state-->>Orchestrator: Semantic no_user_action/commit decision
    Orchestrator->>committer: Exact workflow_id
    committer->>workflow_state: Initial workflow_committer_get
    workflow_state-->>committer: Authoritative committer view
    committer->>GitWorkingTree: Stage exact approved paths
    committer->>workflow_state: workflow_prepare_commit
    workflow_state-->>committer: COMMIT_PREPARED
    committer->>GitWorkingTree: External git commit
    committer->>workflow_state: Terminal commit-result submission
    committer-->>Orchestrator: Final textual commit report
    Orchestrator->>workflow_state: Final workflow_operator_decision_get refresh
    workflow_state-->>Orchestrator: Semantic committed outcome (or documented stop)
```

## Findings and stop paths

When review identifies blocking findings, the parent authorizes a bounded repair loop using the exact
finding IDs, then sends the implementer back to `REPAIRING` and re-runs independent review. The
complete repair-cycle limit and transition semantics are defined in
[`.codex/agents/WORKFLOW.md`](../.codex/agents/WORKFLOW.md); this guide does not duplicate them.

Only a fresh reviewer result whose projection reports `approve_exact_repairs` with its authority
boundary available can request repair authorization. The parent then reads the full view for the
current exact blocker IDs, version, and permitted mutation action. The prompt uses only
those current exact blocker IDs and bounded reasons. A fresh review that reconfirms the same ID may
request that ID again; if the old ID is resolved and a different blocker is current, only the
different current ID is requested. A retained non-empty blocker list alone never prompts for repair,
and an absent permitted action fails closed.

For reconciliation, the reviewer-only start is mandatory even when implementation files are already
dirty. A blocking result can enter ordinary exact-ID repair only after explicit authorization, then
requires combined fresh review; an approval stops for separate commit authorization. Optional findings
stop without remediation. A changed-intent request instead starts a newly authorized bounded change
workflow, not a repair or follow-up.

The workflow also stops rather than guessing when it encounters concerns (`STOPPED_CONCERNS`), an
inconclusive review (`STOPPED_INCONCLUSIVE`), missing implementation context or an implementation
blocker, an unchanged-HEAD commit retry (`STOPPED_NOT_COMMITTED`), or a receipt/scope mismatch
(`STOPPED_COMMIT_MISMATCH`). A linked follow-up is a separate, explicitly authorized cycle for work
that is not part of the approved implementation; it is not an excuse to continue after approval.
These paths preserve the same authoritative identity and require the corresponding parent
transition. For `STOPPED_INCONCLUSIVE`, a parent may explicitly adopt exact dirty paths from an
earlier scope expansion. Adoption is content-committed at authorization time and guarded both
before review resume and when the expanded review-start receipt is established; historical-runtime
recovery allows only those narrow guards and the adoption itself.

For self-hosting, the regression scenario is A -> edit approved runtime paths -> test/review -> commit
B -> restart -> create a new workflow under B -> resume the unfinished workflow under A. Missing or
mismatched artifacts stop with dedicated runtime isolation/recovery errors. Installed hosts do not
promote runtime artifacts or resume runtime affinity; they execute the provider server directly for
the target repository.

## Boundary summary

- **Orchestrator:** primary execution control plane; exact approved-plan parent read, bounded
  policy/Git preflight, workflow creation, and routing only; no plan approval or planner dispatch.
- **Plan:** native user-facing pre-workflow mediator/presenter; delegates to the generated planner,
  renders exact `full_plan` verbatim, and explicitly approves; never creates an implementation workflow.
- **Implementer:** detailed investigation, edits, validation, and implementation evidence.
- **Code reviewer:** independent read-only review and semantic findings; receipt capture and
  comparison remain inside Workflow MCP.
- **Committer:** exact-scope staging, commit preparation, external Git commit, and commit-result
  submission after explicit authorization.
- **Build:** optional direct coding agent, not workflow orchestration, with no project-global
  orchestration instructions.
