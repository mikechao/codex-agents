# OpenCode orchestration flow

This guide describes the current OpenCode architecture in this repository. The custom
`orchestrator` is the workflow control plane: it coordinates the authoritative `workflow_state`
MCP workflow and delegates repository work to the shared worker roles. It is not a replacement for
the normal OpenCode agents, and it does not edit, stage, or commit files.

The complete workflow-state contract, including every transition and stop condition, is in
[`.codex/agents/WORKFLOW.md`](../.codex/agents/WORKFLOW.md). This guide explains how the OpenCode
primary routes a normal implementation without reproducing that state machine.

## Entry paths

There are two supported ways to begin implementation:

1. **Direct Orchestrator.** A user makes a non-trivial implementation request while using the
   `orchestrator` primary. Orchestrator performs bounded, read-only preflight (the current Git
   status and `HEAD`, plus the exact objective, approved paths, acceptance criteria, and validation
   requirements), then creates or reuses the authoritative workflow. It does not investigate the
   implementation in depth or solve it in the primary session.
2. **Plan -> Orchestrator.** A user runs `/plan <request>` in Plan, allows the plan to finish, then
   switches to Orchestrator and says `implement the plan` (or equivalent). Planning is pre-workflow:
   Plan does not create an implementation workflow. Once the approved plan is handed to Orchestrator,
   it is execution context; Orchestrator does not re-plan an approved plan. It performs the same
   bounded preflight, then creates or reuses the workflow and dispatches the plan to the implementer.

In both paths, the custom Orchestrator primary is the workflow control plane rather than Build.
OpenCode's built-in Build agent remains available for deliberate ordinary direct coding and receives
no project-global orchestration instructions. Select it explicitly when workflow-backed delegation
is not wanted.

For Plan -> Orchestrator execution, `workflow_create` receives the exact approved Plan-mode text in
immutable `approved_plan`; Orchestrator must not summarize or reconstruct it. Direct requests pass
`approved_plan: null`. The parent view and implementer view expose this execution intent, while
reviewer and committer views retain least-context projections. Objective, paths, acceptance criteria,
validation requirements, and authorized remediation/findings remain structured enforcement fields.

The orchestrator passes only explicit user-approved work-item metadata to `workflow_create`; absent
tracker metadata is represented as `work_items: []`. These generic immutable references are schema v6
state, shown only to parent and committer, and inherited automatically by linked follow-ups. Linked
creation never accepts retranscribed replacements or externally discovered identifiers. The committer
renders exact authoritative display references as neutral `Refs <display_ref>` lines, with no tracker
API calls and no `Fixes`/`Closes`/`Resolves` completion semantics.

## Identity and handoffs

The authoritative server is the source of truth. Every worker handoff carries exactly the workflow ID;
workers obtain their role view and current version from a dedicated getter:

- `workflow_id`: the exact workflow identifier created or reused by Orchestrator;
- workers call `workflow_implementer_get`, `workflow_reviewer_get`, or `workflow_committer_get`;
- only parent control-plane mutations carry the single parent capability.

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

The parent capability is never guessed, regenerated, or replaced. Before dispatching
the next role, Orchestrator refreshes the parent view and uses its returned version and permitted
actions. Each worker's first authoritative action is its dedicated capability-free getter. The
returned role view supplies that worker's objective, scope, criteria, evidence, receipts,
repair context, and next actions; receipt data and digests remain internal to Workflow MCP, and the
prompt does not duplicate them.

The approved plan is immutable, but the effective approved path scope may be expanded append-only by
the parent with `workflow_expand_scope` in the explicitly permitted implementation and repair stops.
The parent must have fresh user authorization naming exact paths; Workflow MCP captures clean or
absent baselines and records the amendment parent-only. After expansion, refresh the parent and
implementer views before dispatch: stale implementation/review evidence is cleared and fresh
implementation and review are required without consuming a repair cycle.

Workers perform their role and submit a terminal MCP result through their role-specific submission
tool. After a successful terminal submission, the OpenCode adapter also requires a non-empty normal
text report to the parent. Orchestrator refreshes the parent view immediately after each terminal
worker handoff before deciding what happens next.

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
mismatch and stops before `workflow_create`. Policy reading and comparison stay bounded and
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
parent view, and dispatches the committer. Working-tree reviewers first call `workflow_begin_review`;
Workflow MCP owns receipt capture and comparison. The committer stages complete approved paths
(never partial hunks), calls `workflow_prepare_commit`, runs the external Git commit,
and submits the commit result whether Git succeeds or fails. Orchestrator performs the final parent
refresh after that terminal handoff.

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
        Plan-->>User: Approved plan (no workflow created)
        User->>Orchestrator: implement the plan
        Note over Plan,Orchestrator: Planning is pre-workflow; Orchestrator does not re-plan.
    end
    Orchestrator->>GitWorkingTree: Read-only preflight: status and HEAD
    Orchestrator->>workflow_state: Create or reuse workflow
    workflow_state-->>Orchestrator: Exact workflow_id + one parent capability
    Orchestrator->>implementer: Exact workflow_id
    implementer->>workflow_state: Initial workflow_implementer_get
    workflow_state-->>implementer: Authoritative implementer view
    implementer->>GitWorkingTree: Implement approved scope and validate
    implementer->>workflow_state: Terminal implementation submission
    implementer-->>Orchestrator: Final textual implementation report
    Orchestrator->>workflow_state: Parent workflow_parent_get refresh
    workflow_state-->>Orchestrator: REVIEWING + exact reviewer handoff identity
    Orchestrator->>code_reviewer: Exact workflow_id
    code_reviewer->>workflow_state: Initial workflow_reviewer_get
    workflow_state-->>code_reviewer: Authoritative reviewer view
    code_reviewer->>workflow_state: workflow_begin_review (working tree)
    code_reviewer->>GitWorkingTree: Independent read-only review
    code_reviewer->>workflow_state: Terminal review submission
    code_reviewer-->>Orchestrator: Final textual review report
    Orchestrator->>workflow_state: Parent workflow_parent_get refresh
    workflow_state-->>Orchestrator: STOPPED_APPROVED + sanitized approval view
    User->>Orchestrator: Explicit commit authorization
    Orchestrator->>workflow_state: Authorize commit
    Orchestrator->>workflow_state: Parent workflow_parent_get refresh
    workflow_state-->>Orchestrator: COMMIT_AUTHORIZED + exact committer handoff identity
    Orchestrator->>committer: Exact workflow_id
    committer->>workflow_state: Initial workflow_committer_get
    workflow_state-->>committer: Authoritative committer view
    committer->>GitWorkingTree: Stage exact approved paths
    committer->>workflow_state: workflow_prepare_commit
    workflow_state-->>committer: COMMIT_PREPARED
    committer->>GitWorkingTree: External git commit
    committer->>workflow_state: Terminal commit-result submission
    committer-->>Orchestrator: Final textual commit report
    Orchestrator->>workflow_state: Final parent workflow_parent_get refresh
    workflow_state-->>Orchestrator: COMMITTED (or documented stop)
```

## Findings and stop paths

When review identifies blocking findings, the parent authorizes a bounded repair loop using the exact
finding IDs, then sends the implementer back to `REPAIRING` and re-runs independent review. The
complete repair-cycle limit and transition semantics are defined in
[`.codex/agents/WORKFLOW.md`](../.codex/agents/WORKFLOW.md); this guide does not duplicate them.

The workflow also stops rather than guessing when it encounters concerns (`STOPPED_CONCERNS`), an
inconclusive review (`STOPPED_INCONCLUSIVE`), missing implementation context or an implementation
blocker, an unchanged-HEAD commit retry (`STOPPED_NOT_COMMITTED`), or a receipt/scope mismatch
(`STOPPED_COMMIT_MISMATCH`). A linked follow-up is a separate, explicitly authorized cycle for work
that is not part of the approved implementation; it is not an excuse to continue after approval.
These paths preserve the same authoritative identity and require the corresponding parent
transition.

For self-hosting, the regression scenario is A -> edit approved runtime paths -> test/review -> commit
B -> restart -> create a new workflow under B -> resume the unfinished workflow under A. Missing or
mismatched artifacts stop with dedicated runtime isolation/recovery errors. Installed hosts do not
promote runtime artifacts or resume runtime affinity; they execute the provider server directly for
the target repository.

## Boundary summary

- **Orchestrator:** primary workflow control plane; bounded read-only preflight and routing only.
- **Plan:** optional pre-workflow analysis and plan refinement; never the implementation workflow.
- **Implementer:** detailed investigation, edits, validation, and implementation evidence.
- **Code reviewer:** independent read-only review and semantic findings; receipt capture and
  comparison remain inside Workflow MCP.
- **Committer:** exact-scope staging, commit preparation, external Git commit, and commit-result
  submission after explicit authorization.
- **Build:** optional direct coding agent, not workflow orchestration, with no project-global
  orchestration instructions.
