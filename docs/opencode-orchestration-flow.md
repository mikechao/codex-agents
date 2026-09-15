# OpenCode orchestration flow

This guide describes the current OpenCode architecture in this repository. The custom
`orchestrator` is the workflow control plane: it coordinates the authoritative `workflow_state`
MCP workflow and delegates repository work to the shared worker roles. It is not a replacement for
the normal OpenCode agents, and it does not edit, stage, or commit files.

OpenCode planning is a separate pre-workflow topology with two Native Plan routes. A standalone
audit, research, explain, trace, or report request uses Native Plan's ordinary read/search and may
fan out bounded topics to hidden, read-only `explorer` agents; Native Plan reconciles evidence,
synthesizes one provenance-bearing report, and stops without a PlanArtifact, Workflow, or mutation.
A change request (including investigate-then-change) delegates to the generated `planner`, which may
fan out zero to four explorers. Explorer context is disposable and is never persisted in Workflow
MCP or plan artifacts. Planner is the sole complete plan writer/refiner and returns one bounded
`PlannerHandoff`; Plan uses the parent surface to retrieve and render exact `full_plan` text verbatim,
then explicitly approves. Each canonical PlanArtifact explicitly authors `workflow_type` as `change`
or working-tree `review_only`. A selected report finding is supporting context only: Native Plan invokes a
fresh planner for a normal change-only plan and separate approval. Orchestrator only parent-reads the
exact current approved plan and executes it through `workflow_create_from_plan`.

Plan schema v2 is a deliberate development clean break: retained pre-change artifacts are rejected
with reset-required diagnostics and must be recreated, never migrated or retranscribed. The documented
Native Plan -> Orchestrator reviewer-first `review_only` dogfood is a post-commit, fresh-host-reload
manual activity described in [the provider-only live dogfood guide](../.codex/agents/DOGFOOD.md); it is
not an installed-target pre-commit gate.

## Authoritative-source transport investigation

The exact installed OpenCode binary used as the investigation anchor was `/opt/homebrew/bin/opencode`.
On 2026-09-02 in the repository working tree on Darwin 25.6.0 (arm64), `opencode --version` produced
the complete output:

```text
1.18.26
```

The version-matched release is [v1.18.26](https://github.com/anomalyco/opencode/releases/tag/v1.18.26),
tagged at commit [`774cc7c1914e4329eefde5a669f938b0cf566661`](https://github.com/anomalyco/opencode/commit/774cc7c1914e4329eefde5a669f938b0cf566661).
The corresponding tagged source and documentation inspected were:

- [`packages/opencode/src/tool/task.ts`](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.26/packages/opencode/src/tool/task.ts)
  defines `description`, textual `prompt`, `subagent_type`, and optional `task_id`, `command`, and
  `background` task arguments. It resolves the one `prompt` string into ordinary child prompt parts;
  there is no `authoritativeSource`/`instructions` pair or separate opaque source argument.
- [`packages/web/src/content/docs/agents.mdx`](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.26/packages/web/src/content/docs/agents.mdx)
  documents static agent prompts, permissions, modes, and task-target permissions. It does not
  document a per-invocation immutable source payload or deterministic child-prompt constructor.
- [`packages/web/src/content/docs/plugins.mdx`](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.26/packages/web/src/content/docs/plugins.mdx)
  documents project/global plugins, `tool.execute.before`/`after` hooks, and custom tools. These can
  observe or mutate model-produced tool arguments, but do not independently capture the semantically
  authoritative source before task construction or guarantee the placement of host/system context.
  Replacing `task` with a custom tool would still require the mediation model to supply the source and
  would be a new host-coupled integration, not a host-captured opaque payload.
- [`packages/web/src/content/docs/server.mdx`](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.26/packages/web/src/content/docs/server.mdx)
  and [`packages/web/src/content/docs/sdk.mdx`](https://raw.githubusercontent.com/anomalyco/opencode/v1.18.26/packages/web/src/content/docs/sdk.mdx)
  expose ordinary session message/text parts and programmatic session APIs. They do not document a
  configured built-in Plan interception point that separates source text before model-authored task
  construction.

The host boundary is therefore:

| Mechanism | What it provides | Boundary for authoritative source |
| --- | --- | --- |
| Native `task` | One model-authored textual `prompt` plus task metadata | No independent typed/opaque source field; source and wrapper share one text value |
| Agent configuration | Static prompt, permissions, mode, and task allowlist | No per-request source channel or deterministic child assembly |
| Plugin hooks and project-local custom tools | Generic tool-argument mutation and custom tools, including auto-discovered `.opencode/tools/*.ts` definitions | Can inspect/mutate the resulting task call or expose a bounded custom capability, but cannot establish source authority independently or guarantee context placement |
| Server/SDK | Session creation and ordinary text/file message parts | No documented Plan-specific pre-dispatch source interception |

The native Plan delegation path therefore retains the #77 compatibility fallback: wrapper first, a
contiguous source section, the closing marker immediately after the supplied source's final character,
and host/system reminders outside that section. This is the strongest currently supported prompt-level
fallback, not an immutable or typed transport, collision-proof parser, or semantic sandbox. Delimiters
are convention only and do not make source trusted or resist model-level prompt injection. A future
upstream structured task field or deterministic pre-dispatch hook can reopen this decision; until then,
no plugin, task replacement, source artifact/reference, or Workflow MCP transport bookkeeping is added.

This repository did not run a live provider-backed Plan-to-planner dogfood during this implementation
pass. The [provider-only live dogfood guide](../.codex/agents/DOGFOOD.md) describes how to reproduce
that check. The exact installed version and its version-corresponding source anchor are recorded, but
static configuration and source inspection must not be presented as end-to-end mechanical
preservation.
Upstream `dev` documentation/source may be useful for comparison, but it is supplemental and is not
the basis of the #84 unavailability conclusion. Re-run the version check and provider-guide checks
after an OpenCode upgrade or other host change.

Ordinary conversational requests remain bounded and never copy arbitrary history. When complete source
contents are explicitly supplied, the planner uses them directly without redundant source retrieval;
known payload-limit inability fails closed with bounded input or clarification. No Workflow MCP
persistence, phase, source artifact, transport bookkeeping, or duplicate task-intent model is involved.

Workflow MCP state/projections and the self-contained role contracts are the mechanical execution
authority. [`.codex/agents/WORKFLOW.md`](../.codex/agents/WORKFLOW.md) is retained explanatory
architecture documentation, not a runtime precondition or independent transition authority. This
guide explains how the OpenCode primary routes a normal implementation without reproducing the state
machine.

## Descriptor-driven operator refresh

After creation or reuse, each worker handoff, and each parent mutation, Orchestrator reads the fresh
`workflow_operator_decision_get` projection. Its `execution` descriptor is the first routing
discriminator; the semantic `decision` remains the user-facing summary and authorization boundary.
The projection is bounded to the requested workflow and reciprocal explicit linked lineage, read-only,
sanitized, and not a proposal store or bearer capability.

Consumers check `descriptor_version` before interpreting execution guidance. Only descriptor version 4
is executable and it supports all five modes, semantic action choices, and exact input provenance.
Any other, missing, malformed,
contradictory, or incomplete version stops with no fallback mutation or dispatch; the parent never
reconstructs a route from semantic decisions, raw phases, parent state, or conversation memory.

The descriptor loop is:

1. `dispatch` delegates only the returned route to its corresponding worker with the exact workflow
   ID.
2. `parent_mutation` presents separately advertised alternatives using each invocation's
   `semantic_choice.label` and `semantic_choice.summary`, then uses the exact selected descriptor
   entry. It passes server-fixed arguments, obtains only declared inputs from their declared sources,
   applies the declared authorization representation, and invokes the exact operation without
   interpreting operation/tool names as choice semantics. Every alternative must be complete, match
   its action to its invocation, and be host-allowlisted; one malformed or inaccessible alternative
   makes the descriptor fail closed.
3. `collect_evidence` gathers only the declared inspection, uses the returned observed outcome
   mutation, and treats unavailable evidence as `wait`; it never invents a failed validation.
4. `wait` reports its bounded reason and performs no mutation or dispatch.
5. `terminal` reports its authoritative outcome and stops.

After successful mutation, use the advertised `committed_execution` when present; otherwise refetch a
fresh descriptor. Never route from `on_success.expected`, mutation success alone, stale prose, dirty
path inference, raw phases, or a prior projection.

The operator question remains decision-first. Present one concrete safe proposal in domain language,
exact visible repository-relative paths when deterministic, and bounded semantic alternatives when
consequences differ. For `parent_mutation`, require fresh affirmative authorization tied to the
displayed proposal only when the advertised `authorization.required` is `true`; when it is `false`,
do not invent an authorization question or block the exact invocation. Negative, ambiguous,
unrelated, changed, or stale responses perform no mutation or dispatch. Authorization requirements
are not inferred from operation names, phases, or prompt policy. Repair rejection cannot authorize
adjudication; adjudication requires a separate proposal and fresh affirmative response. Conversation
memory is never a proposal or authority, and no durable proposal state or parser is introduced. After
required affirmative input, refetch the descriptor and require its proposal and binding to remain
current before invoking the advertised mutation. Do not ask for internal action/phase names or exact
payloads. Contextual `yes`, `continue`, `go ahead`, and `commit it` are valid when unambiguous;
ordinary equivalent wording is also valid.

If an advertised descriptor input has source `parent_context`, use `workflow_parent_get` and its exact
`source_path` to obtain the current value from the authoritative parent view. A `user_authored` input is a
bounded model/user-authored semantic value, including recovery context; it is not synthesized from
state prose. An `observed_evidence` input must come only from the actual declared inspection, never
from `ParentView` or conversation memory. Retain `workflow_parent_get` for explicit debug/status
inspection as well. Do not use it to reconstruct operation selection, payload shape, authorization
placement, routing, or other protocol knowledge already declared by the descriptor. If a mutation
would require an input that the descriptor does not declare, fail closed rather than inventing or
discovering it. For linked follow-ups, `finding_ids` come from the explicit
`linked_followup_binding`; select a non-empty subset of one current blocking or optional finding
bucket using its semantic summaries, never stale-binding references.

Exact repair, concern/context/review recovery, bounded linked continuation, scope expansion and
changed-intent classification, final reconciliation, and commit authorization remain explicit parent
policies. The parent compares newly supplied objective, outcome, criteria, and logical-change scope at
its input boundary; an ID-only projection never makes that classification.

Explicit linked chains can report their existing combined-review requirement. Separately created
workflows are not joined through matching work items, paths, branches, or conversation history. If
authoritative logical-change topology is absent or contradictory, Orchestrator fails closed and
requires the repository-owned relationship prerequisite described by #22 rather than synthesizing
a reconciliation workflow.

## Entry paths

There are three supported Native Plan/implementation entry paths:

1. **Standalone investigation.** A user asks Native Plan for an audit, explanation, research, trace,
   or report without requesting mutation. Native Plan may delegate bounded evidence topics to
   `explorer`, synthesizes a report with provenance and uncertainty, and stops. It never invokes
   `planner`, creates a PlanArtifact or Workflow, or converts report prose into authority.
2. **Direct Orchestrator.** A user makes a non-trivial implementation request while using the
   `orchestrator` primary. Orchestrator performs bounded, read-only preflight (the current Git
   status and `HEAD`, plus the exact objective, approved paths, acceptance criteria, and validation
   requirements), then creates or reuses the authoritative workflow. It does not investigate the
   implementation in depth or solve it in the primary session.
3. **Plan -> Orchestrator.** A user runs `/plan <request>` in the built-in Plan primary. Plan
   delegates to `planner`, retrieves the exact plan artifact, renders its `full_plan` verbatim, and
   waits for explicit approval of the exact plan ID/revision. Plan does not create an implementation
   workflow. The user then switches to Orchestrator and says `implement the approved plan` (or
   equivalent). Orchestrator consumes the one exact identity from the immediately preceding approved
   Native Plan handoff without redundant identity reconfirmation, parent-verifies current approval,
   performs policy preflight, calls `workflow_create_from_plan`, and consumes the returned execution
   descriptor. If no single exact identity is bound, Orchestrator asks which semantic plan is intended
   and never selects historical, stale, or unrelated plan state.

In both paths, the custom Orchestrator primary is the workflow control plane rather than Build.
OpenCode's built-in Build agent remains available for deliberate ordinary direct coding and receives
no project-global orchestration instructions. Select it explicitly when workflow-backed delegation
is not wanted.

The generated planner is the sole author of persisted change-plan revisions. The host-native Plan agent is
the user-facing mediator, not a second planner implementation: for change planning it delegates only
to `planner` and accepts its bounded handoff before parent retrieval and approval; for standalone
investigation it may delegate bounded topics to `explorer` and stops after report synthesis.
Orchestrator is not a planning entry point and has no plan approval or planner dispatch authority.

For change planning requests, delegate to `planner`; Native Plan may directly delegate bounded
standalone evidence topics to `explorer`, while the planner may also use `explorer`. The planner may use
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
plan ID/revision and supported creation options; the server resolves and copies the immutable authored
workflow type and `approved_plan` and
provenance from the authoritative artifact. Orchestrator must not summarize or reconstruct it.
Direct requests pass `approved_plan: null`. The returned execution descriptor determines the next
mode and route for either provenance; a wait, terminal result, or different route overrides any
narrative expectation about the authored workflow type. The parent and role views retain their
least-context projections. Objective, paths, acceptance criteria, validation requirements, and
authorized remediation/findings remain structured enforcement fields.

For a linked follow-up, the fresh operator descriptor selects the exact advertised parent mutation.
The Orchestrator presents authorization only when that invocation requires it, binds only its fixed
and declared inputs, and obtains any declared `parent_context` value from the authoritative parent
view. It must not choose between plan-native and direct operations, reconstruct their payloads, or
discover undeclared inputs. If no linked-follow-up invocation is advertised, it fails closed. The
server resolves and binds any approved child artifact inside the source/child transaction; artifact
prose and contracts are never retranscribed.

The orchestrator passes only explicit user-approved work-item metadata to `workflow_create` or
`workflow_create_from_plan`; absent tracker metadata is represented as `work_items: []`. These generic
immutable references are schema v9 state, shown only to parent and committer, and inherited automatically
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

Installed repositories have a deliberately simpler boundary: installation compiles and verifies a
standalone executable at `.codex/runtime/workflow-mcp`, which Codex and OpenCode invoke directly.
The installer does not copy the provider's Workflow MCP, bootstrap, supervisor, or runtime-artifact
sources. Installed mode has no runtime-affinity lifecycle; its executable uses the target repository's
Git and durable state and does not require Bun, target `node_modules`, or the provider checkout at
runtime. A disposable installed target can still be used for provider live dogfood, but the
provider-only `DOGFOOD.md` guide and historical results ledger are not part of installed output.

Runtime authority is never guessed, regenerated, or replaced. Before dispatching
the next role, Orchestrator refreshes the operator projection, checks its descriptor version, and
routes from its execution descriptor. It reads the parent view only when an advertised
`parent_context` input needs its exact current value or for explicit debug/status inspection. Each
worker's first authoritative action is its dedicated capability-free getter. The
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

The refresh is descriptor-first. After every terminal implementation handoff—including an authorized
repair completion—Orchestrator calls `workflow_operator_decision_get` before summarizing or routing.
The returned execution descriptor, not the semantic decision or retained blocker summary, determines
whether the next step is dispatch, parent mutation, evidence collection, wait, or terminal reporting.
Retained blockers are history/remediation context only and do not independently create a repair
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

The following is only an illustrative server-state sequence; it is not a worker-routing map:

```text
IMPLEMENTING (v0) -> REVIEWING (v1) -> STOPPED_APPROVED (v2) -> COMMIT_AUTHORIZED (v3) -> COMMIT_PREPARED (v4) -> COMMITTED (v5)
```

The version numbers in this illustrative sequence are examples only and are **not normative**; the
server's returned `expected_version` is always authoritative. Review approval stops at
`STOPPED_APPROVED` until the user explicitly authorizes the commit. Review approval by itself is not
commit authorization, and optional findings do not authorize extra remediation.

After any required authorization, Orchestrator refetches the execution descriptor and invokes only its
advertised mutation. A descriptor with `authorization.required: false` proceeds without affirmative or
negative user input. A worker is delegated only when the fresh or committed descriptor returns a
dispatch route and operation; `wait`, `terminal`, failure, or any different returned route
overrides this illustrative sequence. The selected worker follows its own role contract, and
Orchestrator refreshes the descriptor after its terminal handoff.

### Intent classification and final-tree reconciliation

Before mutation or dispatch, classify the request into one of three routes:

1. **Unchanged approved intent:** a P0-P2 defect is ordinary repair. Present the descriptor's bounded
   repair proposal, obtain explicit authorization, and follow its advertised mutation and subsequent
   route. The reviewer receives the exact active repair directive from its authoritative role view and
   must submit explicit conforming evidence before approving the re-review.
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
   content, while excluding unrelated and ignored state. The fresh execution descriptor determines
   the permitted mode, route, and any subsequent mutation; a wait, terminal result, or different
   route must be followed as returned. Optional findings never trigger remediation.

Approval is separate from commit authorization. The execution descriptor controls whether and how a
commit-related action proceeds; no narrative lifecycle step dispatches a worker or invokes a mutation
without that returned authority. Supported finding-linked follow-ups remain narrow: a supported active
source, exact current finding IDs, narrow remediation context and scope, and a fresh combined review.
When the preparation-failure descriptor advertises staged-scope reconciliation, its exact bound paths
are the only paths that may be added to the current workflow scope. The authorized mutation clears
existing review and commit authority and requires fresh review followed by fresh commit authorization.
For a supported `change` working-tree workflow, reconciliation is advertised only while the live
out-of-scope staged paths exactly match the persisted reconciliation paths. If the live set is empty,
the descriptor advertises retry only; if it changes to another non-empty set, it advertises no parent
mutation and remains fail-closed. `review_only` never advertises staged-scope reconciliation. The
parent does not infer a move from summary prose, reuse historical staged paths after a fresh read, or
substitute another workflow.
They cannot serve as changed intent or reconciliation shortcuts. After every terminal worker handoff and parent mutation, refresh the
read-only `workflow_operator_decision_get` projection, summarize only its bounded semantic result,
and route from its fresh descriptor; stale prose and dirty-path inference grant no authority. Use
`workflow_parent_get` for explicit debug/status inspection and when an advertised `parent_context`
input needs its exact current value. It must not be used to reconstruct operation selection, payload
shape, authorization placement, routing, or other descriptor-declared protocol knowledge. An
undeclared required input fails closed.

```mermaid
sequenceDiagram
    actor User
    participant Plan
    participant Orchestrator
    participant workflow_state
    participant worker as Descriptor-selected worker
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
    Orchestrator->>workflow_state: workflow_operator_decision_get
    workflow_state-->>Orchestrator: Semantic decision + versioned execution descriptor
    alt Descriptor mode: dispatch
        Orchestrator->>worker: Exact workflow_id for the returned route
        worker->>workflow_state: Dedicated role getter and terminal submission
        worker-->>Orchestrator: Final textual worker report
    else Descriptor mode: parent_mutation
        alt authorization.required === true
            Orchestrator-->>User: Bounded semantic proposal
            User->>Orchestrator: Explicit affirmative or negative response
        else authorization.required === false
            Note over Orchestrator: No affirmative or negative user input is required
        end
        Orchestrator->>workflow_state: Parent-context reads only when declared
        Orchestrator->>workflow_state: Exact advertised parent mutation
        workflow_state-->>Orchestrator: Committed execution or mutation result
    else Descriptor mode: collect_evidence
        Orchestrator->>GitWorkingTree: Gather declared inspection
        Orchestrator->>workflow_state: Advertised observed-outcome mutation
    else Descriptor mode: wait
        Orchestrator-->>User: Bounded wait reason; no mutation or dispatch
    else Descriptor mode: terminal
        Orchestrator-->>User: Authoritative terminal outcome
    end
    Orchestrator->>workflow_state: Refresh descriptor after worker handoff or mutation
    workflow_state-->>Orchestrator: Fresh descriptor selects the next mode or route
    Note over Orchestrator,workflow_state: Unknown, malformed, stale, rejected, unavailable, or undeclared-input cases fail closed with no speculative mutation or dispatch.
```

## Findings and stop paths

When review identifies blocking findings, the parent uses the fresh execution descriptor to determine
whether a bounded repair mutation or another mode is available. It binds only the descriptor's
declared inputs and follows the committed/refetched descriptor route; a wait, terminal result, or
different route performs no speculative worker handoff. The complete repair-cycle limit and
transition semantics are defined in
[`.codex/agents/WORKFLOW.md`](../.codex/agents/WORKFLOW.md); this guide does not duplicate them.

If Workflow MCP is unavailable, authoritative execution suspends. The Orchestrator preserves only
known workflow/session references, supplied paths or context, pending intent, and the outage reason;
it may provide bounded read-only diagnostics and supported reload/bootstrap/reconnection guidance.
After restoration it refreshes the authoritative projection before resuming where possible. No
implementation, review, repair, validation authorization, commit preparation, or commit continues
from conversation memory, and no versions, receipts, findings, audit state, or authority are
reconstructed in prose.

Repair, recovery, inspection, commit, and adjudication follow the same descriptor rules. A fresh
descriptor may expose the repair proposal and its exact eligible/selected finding binding; a retained
blocker list alone never prompts for repair; retained blockers are history and remediation context
only. The parent presents the bounded semantic proposal,
obtains fresh affirmative authorization when required, binds only declared inputs, invokes the
advertised operation, and routes only from its committed or freshly refetched descriptor. Rejection,
staleness, failure, unavailability, contradiction, or an undeclared required input produces no
speculative mutation or worker dispatch. Repair rejection cannot authorize adjudication; adjudication
requires a separate descriptor-backed proposal and fresh affirmative response.

Input provenance is executable: `user_authored` comes only from the current user's semantic request or
a fresh answer; `parent_context` must name an exact parent-view `source_path`; `server_derived` must be
read from its named descriptor binding; and `observed_evidence` requires the declared inspection.
Missing or unresolvable input provenance fails closed. For a plan-native linked follow-up, the child
plan identity is obtained from the exact current approved child-plan view and is explicitly bound in
the operator descriptor; the source workflow's plan provenance is never substituted.

For reconciliation, the returned descriptor remains authoritative even when implementation files are
already dirty. It determines whether the next step is a dispatch, mutation, wait, or terminal result;
staleness or unavailable authority produces no speculative worker handoff. Optional findings stop
without remediation. A changed-intent request instead starts a newly authorized bounded change
workflow, not a repair or follow-up.

The workflow also stops rather than guessing when it encounters concerns (`STOPPED_CONCERNS`), an
inconclusive review (`STOPPED_INCONCLUSIVE`), missing implementation context or an implementation
blocker, an unchanged-HEAD commit retry (`STOPPED_NOT_COMMITTED`), or a receipt/scope mismatch
(`STOPPED_COMMIT_MISMATCH`). A linked follow-up is a separate, explicitly authorized cycle for work
that is not part of the approved implementation; it is not an excuse to continue after approval.
These paths preserve the same authoritative identity and require the corresponding parent
transition. For `STOPPED_INCONCLUSIVE`, a parent may explicitly adopt exact dirty paths from an
earlier scope expansion. Adoption is content-committed at authorization time and guarded both
before review resume and when the expanded review-start receipt is established; recovery allows only
those narrow guards and the adoption itself.

For self-hosting, the regression scenario is A -> edit approved runtime paths -> test/review -> commit
B -> restart -> create a new workflow under B -> resume the unfinished workflow under A. Missing or
mismatched artifacts stop with dedicated runtime isolation/recovery errors. Installed hosts do not
promote runtime artifacts or resume runtime affinity; they execute the target-local
`.codex/runtime/workflow-mcp` executable directly for the target repository, without requiring Bun,
target `node_modules`, or the provider checkout at runtime.

## Boundary summary

OpenCode command authorization is exact and shell-free, but it is host-level defense in depth rather
than an OS-level sandbox. Explorer evidence is available only through the structured
`runEvidence({ evidenceId, argv })` custom tool, which uses the existing bounded policy runner with
an explicit `purpose: evidence` entry and the target worktree. The custom tool rejects non-explorer
callers, returns bounded provenance for success and failure, and never provides a Bash fallback; no
report, explorer transcript, or investigation workflow is persisted. The project-owned source is the
auto-discovered `.opencode/tools/runEvidence.ts` file; the obsolete `.opencode/plugins/run-evidence.ts`
  implementation and plugin registration are not used. OpenCode owns dependency synchronization in its
  writable configuration directory: it creates or updates `package.json`, lockfiles,
  `node_modules/@opencode-ai/plugin`, and its generated `.gitignore` to the running InstallationVersion.
  The installer does not create, validate, pin, or otherwise mutate those ignored host artifacts, and
  they are not repository authority or workflow persistence.

Revision-range inspection is a separate structured `inspectGitRange({ base, head })` custom tool.
It is Explorer-only, bounded, read-only, and shell-free: revisions are resolved independently to
commit IDs before fixed diff operations. It is not executable evidence, Workflow state, or a generic
Git command interface, and it never replaces `runEvidence`'s exact policy authorization.

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
