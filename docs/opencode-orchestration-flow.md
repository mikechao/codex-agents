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

## Identity and handoffs

The authoritative server is the source of truth. Every worker handoff carries exactly these values:

- `workflow_id`: the exact workflow identifier created or reused by Orchestrator;
- `capability`: that worker's one-time role capability; and
- `expected_version`: the current optimistic-concurrency version from the parent view.

The capability is role-specific and is never guessed, regenerated, or replaced. Before dispatching
the next role, Orchestrator refreshes the parent view and uses its returned version and permitted
actions. Each worker's first authoritative action is its own `workflow_get` using those handoff
values. The returned role view supplies that worker's objective, scope, criteria, evidence, receipts,
repair context, and next actions; the prompt does not duplicate them.

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

The illustrative happy path is:

```text
IMPLEMENTING (v0) -> REVIEWING (v1) -> STOPPED_APPROVED (v2) -> COMMIT_AUTHORIZED (v3) -> COMMIT_PREPARED (v4) -> COMMITTED (v5)
```

The version numbers in this illustrative sequence are examples only and are **not normative**; the
server's returned `expected_version` is always authoritative. Review approval stops at
`STOPPED_APPROVED` until the user explicitly authorizes the commit. Review approval by itself is not
commit authorization, and optional findings do not authorize extra remediation.

After explicit user authorization, Orchestrator authorizes the commit in the workflow, refreshes the
parent view, and dispatches the committer. The committer compares the fresh receipt, stages complete
approved paths (never partial hunks), calls `workflow_prepare_commit`, runs the external Git commit,
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
    workflow_state-->>Orchestrator: Exact workflow_id, implementer capability, expected_version
    Orchestrator->>implementer: Exact workflow_id + capability + expected_version
    implementer->>workflow_state: Initial workflow_get
    workflow_state-->>implementer: Authoritative implementer view
    implementer->>GitWorkingTree: Implement approved scope and validate
    implementer->>workflow_state: Terminal implementation submission
    implementer-->>Orchestrator: Final textual implementation report
    Orchestrator->>workflow_state: Parent workflow_get refresh
    workflow_state-->>Orchestrator: REVIEWING + exact reviewer handoff identity
    Orchestrator->>code_reviewer: Exact workflow_id + capability + expected_version
    code_reviewer->>workflow_state: Initial workflow_get
    workflow_state-->>code_reviewer: Authoritative reviewer view
    code_reviewer->>GitWorkingTree: Independent read-only review and receipt
    code_reviewer->>workflow_state: Terminal review submission
    code_reviewer-->>Orchestrator: Final textual review report
    Orchestrator->>workflow_state: Parent workflow_get refresh
    workflow_state-->>Orchestrator: STOPPED_APPROVED + review receipt
    User->>Orchestrator: Explicit commit authorization
    Orchestrator->>workflow_state: Authorize commit
    Orchestrator->>workflow_state: Parent workflow_get refresh
    workflow_state-->>Orchestrator: COMMIT_AUTHORIZED + exact committer handoff identity
    Orchestrator->>committer: Exact workflow_id + capability + expected_version
    committer->>workflow_state: Initial workflow_get
    workflow_state-->>committer: Authoritative committer view
    committer->>GitWorkingTree: Stage exact approved paths
    committer->>workflow_state: workflow_prepare_commit
    workflow_state-->>committer: COMMIT_PREPARED
    committer->>GitWorkingTree: External git commit
    committer->>workflow_state: Terminal commit-result submission
    committer-->>Orchestrator: Final textual commit report
    Orchestrator->>workflow_state: Final parent workflow_get refresh
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

## Boundary summary

- **Orchestrator:** primary workflow control plane; bounded read-only preflight and routing only.
- **Plan:** optional pre-workflow analysis and plan refinement; never the implementation workflow.
- **Implementer:** detailed investigation, edits, validation, and implementation evidence.
- **Code reviewer:** independent read-only review, findings, and review receipt.
- **Committer:** exact-scope staging, commit preparation, external Git commit, and commit-result
  submission after explicit authorization.
- **Build:** optional direct coding agent, not workflow orchestration, with no project-global
  orchestration instructions.
