# Custom subagent workflow

This file defines the authoritative MCP-based workflow and routing. The workflow-state server's role
views carry all handoff state; worker prompts carry only the workflow ID, while parent control-plane
prompts carry the parent capability and expected version. Detailed role behavior remains in
the role contracts beside this file. All paths are repository-relative exact file paths; directories
and globs are not valid. The parent agent owns scope, review decisions, repair-loop counting, commit
authorization, and linked follow-up creation.

## Host adapters

The same three roles are available in Codex and OpenCode. The host-neutral role prose lives in
`.codex/agents/contracts/`; `bun run generate:agents` emits the Codex TOML definitions
(`.codex/agents/`) and the OpenCode Markdown definitions (`.opencode/agents/`) from it, and the
agents test suite fails on drift. Both hosts launch the same Bun/TypeScript `workflow_state` server
and share its durable per-repository state.

Host permission syntax differs and must not be treated as equivalent:

- Codex uses filesystem `sandbox_mode` (`read-only` for the reviewer, `workspace-write` for the
  implementer and committer). Each standalone worker definition is also a complete ConfigToml
  layer: its `[mcp_servers.workflow_state]` table must contain exactly one valid transport (`command`
  or `url`) in addition to the role's allowlist. Checked-in definitions carry the disabled self-host
  bootstrap stdio registration; installer materialization carries the enabled absolute provider
  stdio registration matching the installed parent.
- The target Codex CLI version is `0.148.0`. Its standalone custom-agent TOML layers support an
  `[mcp_servers.<id>]` table, including `enabled_tools` as a fail-closed allowlist of MCP tool
  names. The generated worker layers therefore allow only the role's Workflow MCP tools:
    implementer (`workflow_implementer_get`, `workflow_submit_implementation`), code reviewer
    (`workflow_reviewer_get`, `workflow_begin_review`, `workflow_submit_review`), and committer
    (`workflow_committer_get`, `workflow_prepare_commit`, `workflow_submit_commit_result`). The parent
  registration remains unrestricted; this repository's own `.codex/config.toml` keeps its agent
  and Workflow MCP registrations disabled. Automated checks verify the serialized configuration,
  not Codex runtime enforcement.
- OpenCode has no filesystem sandbox. The reviewer gets `edit: deny` plus a narrow bash allowlist
  (status/diff/log/show/rev-parse/git grep, the receipt command, and the project-owned
  `.codex/agents/reviewer-validation.ts` runner); the committer gets `edit: deny` and a
  fail-closed bash allowlist covering the documented commit flow (status/diff/log/show/rev-parse/
  ls-files inspection, approved `git add`/`git commit`, and the receipt command) while denying
  push/amend/rebase/reset/checkout/switch/history rewriting and filesystem mutation; the
  implementer keeps broad bash for validation with explicit denies for staging, committing,
  pushing, resetting, rebasing, checking out, switching, and the other mutating Git/history
  commands. Every OpenCode agent only exposes its own role's `workflow_state` tools
  (`workflow_state_*` deny plus role-specific allows). These are host-level defense in depth for
context size and isolation; the server-side parent capability, `expected_version`, and transition
  checks remain authoritative and are unchanged between hosts.
- Model/reasoning identity is host metadata, not contract prose: each generated definition
  announces its own identity line (resolved model plus reasoning effort in both hosts), injected by
  the generator in place of the contract's `__HOST_IDENTITY__` marker. Edit
  `.codex/agents/model-policy.yaml` for these assignments; do not put policy in prompts or Workflow
  MCP state. Generation and installation materialize definitions in memory, and running host
  sessions must be restarted after policy changes.
- OpenCode requires a dual-handoff terminal response: after the role's MCP submission tool
  (`workflow_submit_implementation`/`workflow_submit_review`/`workflow_submit_commit_result`)
  succeeds, the agent must still write a non-empty normal assistant text report to the parent
  (labeled "final implementation/review/commit report", required for the committer whether the
  commit succeeded or failed). This ordering invariant is appended to the OpenCode definitions by
  the generator only; it is not contract prose and is never present in the Codex TOML, whose
  terminal handoff stays the MCP submission itself.

## Authoritative MCP state

For non-trivial work, the project-scoped `workflow_state` MCP server is authoritative. The parent
creates one workflow and receives one parent capability. Delegation passes workers only the exact
`workflow_id`; each worker calls its dedicated capability-free getter
(`workflow_implementer_get`, `workflow_reviewer_get`, or `workflow_committer_get`) before mutation.
The returned role view is authoritative and complete: it carries that role's objective, contracts,
semantic evidence, findings, repair state, and sorted `permitted_next_actions`, so prompts never
duplicate objective, criteria, evidence, finding, receipt, or repair state. Worker mutations pass
`workflow_id` and `expected_version`; parent control-plane mutations and audit pass the parent
capability and `expected_version`.

Each role must not call tools owned by another role, and capabilities must not be included in
inherited conversation history. Capabilities are defense-in-depth orchestration controls, not a
security boundary against a process with equivalent host filesystem access. If the server is
unavailable, stop and ask the user whether to use the documented prompt-only degraded mode below; do
not silently downgrade. In degraded mode the parent tracks the version and audit state manually and
records the decision.

### OpenCode planning topology

Planning is a separate pre-workflow activity. OpenCode's native built-in `agent.plan` override is the
user-facing mediator and presenter; it delegates substantial planning and every material refinement
only to the generated `planner`. The planner never dispatches an `explorer` directly. It may launch
zero to four disposable read-only explorers, with no recursive fan-out. Explorer findings, transcripts,
counts, retries, and lifecycle bookkeeping remain in planner context and are never persisted in
Workflow MCP or plan artifacts. The planner is the sole complete plan writer/refiner through exactly
`plan_create`, `plan_get`, and `plan_revise`. Built-in Plan uses the parent surface `plan_parent_get`
to retrieve the exact revision, renders authoritative `full_plan` verbatim, and calls `plan_approve`
only after explicit user approval. Orchestrator is execution-only: it parent-reads an already-approved
exact plan identity and calls `workflow_create_from_plan`; it has no plan approval or planner dispatch
authority. Planner handoffs are bounded routing summaries rather than full plans. Material refinements
carry the plan identity, exact base revision, and bounded feedback without pasted old plan text. When
the immediately preceding Native Plan handoff unambiguously binds one exact current approved
PlanArtifact identity, Orchestrator may consume that handoff for execution without asking the operator
to repeat the identity or revision. It must still parent-read and verify current approval before
`workflow_create_from_plan`. Generic handoffs, pasted prose, historical or stale artifacts, missing
identity, and conflicting or ambiguous handoffs fail closed and require bounded semantic clarification;
conversation memory never binds a plan.

Native Plan is also the mediation boundary for task-source provenance. When a current planning request
explicitly identifies complete contents of an issue, ticket, specification, design brief, or equivalent
source as authoritative, it carries those contents losslessly and character-for-character in a distinct
authoritative-source section of the planner task, separate from bounded wrapper instructions and any
genuinely separate caller context. The delegated task places the bounded wrapper first, closes the
authoritative-source section immediately after the source's final character, and places any separate
caller or host/system instructions after that closing marker; no Plan Mode or `<system-reminder>` text
may occur inside the source section. Host-injected reminders are wrapper instructions, never source
content, even when adjacent to the supplied source in the current Plan context. Ordinary conversational requests, missing or explicitly incomplete
sources, and explicitly summarized or non-authoritative context retain their existing bounded
formulation, retrieval, or clarification behavior; arbitrary parent conversation history is never
copied, and a source available only in an inaccessible parent message is not a valid handoff. A hard
payload or context limit fails closed with bounded input or clarification rather than silently
compressing or truncating an authoritative source. This documents the existing planning boundary only:
it adds no workflow phases, persistence, transport bookkeeping, or planner mechanics.
Planning policy is optional, repository-relative, advisory guidance only; malformed or authority-bearing
policy is bounded input risk and cannot grant capability, approval, scope, or validation authority.

Before a planner marks a revision ready for approval, every executable validation requirement must
match `.codex/reviewer-validation.json` by exact argv array equality, including length, ordering, and
every argument. This planning check complements, and does not replace, the orchestrator's workflow
creation preflight and the review runner. The planner discovers exact implementation and verification
paths and keeps repository-specific guidance in the target-owned `.codex/planner-policy.json` rather
than reusable contracts. Only the current approved revision can seed execution; stale or historical
revisions stop without workflow creation. `workflow_create_from_plan` server-side snapshots exact
text, execution brief, normalized contracts, digest, and provenance, so no plan prose is retranscribed.

`approved_plan` is immutable execution intent. `approved_paths` is the effective append-only
execution scope: only the parent may call `workflow_expand_scope`, and only with fresh explicit user
authorization naming exact additional paths, a bounded reason, and clean tracked or absent
authorization-time baselines. The amendment history is parent-only; all role views receive the
refreshed effective path list. Expansion preserves the active implementation/repair phase and does
not consume a repair cycle, but clears stale implementation/review/commit evidence so fresh
implementation and review are required.
From `STOPPED_INCONCLUSIVE`, `workflow_adopt_dirty_scope` separately records an authorization-time
commitment for exact dirty paths originating in an existing scope expansion; that commitment is
guarded before review resume and review-start snapshot creation.

### Intent routing and final-tree reconciliation

Before mutating state or dispatching a role, the parent classifies the request against the immutable
approved intent. An unchanged objective, desired outcome, acceptance criteria, and logical-change
scope with a P0-P2 violation is ordinary repair: use the latest refreshed review's exact blocking
finding IDs, obtain explicit parent/user authorization, call `workflow_authorize_repair`, dispatch
the implementer, and obtain a fresh independent review. Repair is limited to those exact IDs and does
not alter the approved intent.

A material alteration to the objective, desired outcome, acceptance criteria, or logical change is
changed intent. Stop the current route. Do not use repair, finding adjudication, `workflow_expand_scope`,
or a generic linked follow-up as a substitute. Obtain explicit authorization for a new bounded
`change` workflow with its own exact objective, paths, criteria, validations, and approved plan where
applicable. The new workflow is a separate authority boundary; earlier approval or dirty-path
inference does not authorize it.

Final-tree reconciliation is a separate explicit-authorization path for an already-dirty logical
change. Create `workflow_type: review_only` with `review_mode: working_tree`, the current HEAD as
`base_revision`, `head_revision: null`, `include_staged: true`, `include_unstaged: true`, and
`include_untracked: true`. Its `approved_paths` must be the exact complete repository-relative
allowlist for the whole logical change, including staged, unstaged, and approved-untracked content;
exclude unrelated and ignored state. Dispatch `code_reviewer` directly, never implementer first.
Approval still requires separate explicit commit authorization; after it, the committer stages the
complete exact scope for one coherent commit. Only a fresh reconciliation review reports blocking
findings; ordinary exact-ID repair authorization is then required before dispatching an implementer. Optional
findings never trigger remediation. Finding-linked follow-ups remain limited to supported active
source states, exact current finding IDs, narrow remediation context and scope, and a fresh combined
review; they are not changed-intent or reconciliation shortcuts.

After every terminal worker handoff and every parent mutation, the parent refreshes the read-only
`workflow_operator_decision_get` projection, summarizes only its bounded semantic result, and routes
from its state-provable decision. Worker prose, earlier summaries, dirty-path inference, and stale
state never grant authority. The parent reads `workflow_parent_get` only for exact mutation inputs
and version/capability or an explicit debug/status request. This routing distinction adds no
Workflow MCP phase, schema, persistence, or authority change.

The read-only `workflow_operator_decision_get` projection is the normal semantic refresh above the
parent view. It is bounded to one workflow and validated explicit linked lineage, derives only
state-provable decisions and existing permitted actions, and never writes, authorizes, persists
routing state, or creates a second state machine. It reports automatic `no_user_action` routes for
implementation, review, re-review, and commit preparation; exact repair, recovery, bounded linked
continuation, scope/new-intent, final reconciliation, and commit authorization remain explicit
boundaries. Raw IDs, phases, actions, audits, capabilities, receipts, and PlanArtifact identity
remain available only through explicit debug/status reads or exact mutation-input reads. The projection
is not authorization and does not create a proposal: the parent resolves a concrete safe proposal from
the projection plus an exact `workflow_parent_get`, presents its consequence and deterministic exact
repository-relative visible paths, and asks only for a genuine semantic user choice. Natural-language
responses such as contextual `yes`, `continue`, `go ahead`, and `commit it` are acceptable without a
magic phrase or `Reply ...` syntax. Negative, ambiguous, unrelated, changed, or stale responses fail
closed. After affirmative input, the parent re-reads authoritative state, verifies proposal, scope,
findings, lineage, plan binding, permitted action, capability, and version, then encodes exactly that
proposal in the existing mutation. No durable proposal state, natural-language parser, or replacement
authority is added. Ordinary summaries do not expose internal action/phase names or raw action/tool names;
preserved semantic enum values include `approve_recovery`, `retry_commit`,
`approve_bounded_continuation`, `no_user_action`, `route: review`, and `route: re_review`.

The projection cannot classify a newly supplied request: the parent compares objective, outcome,
criteria, and logical-change scope at the input boundary. A material change requires a new bounded
workflow, not repair, adjudication, expansion, or a generic follow-up. Explicit linked lineage may
provide an existing combined-review boundary, but separately created workflows are never joined by
matching work items, paths, branches, or conversational history. Missing or contradictory topology
fails closed and requires an authoritative repository-owned relationship design.

For an already-affined workflow, the store also requires the complete current `runtime_id` and
`runtime_revision` to match the persisted owner after capability authentication, plus the ephemeral
supervisor launch attestation signed with the private key belonging to the immutable child artifact
that contains the executing `store.ts`/`server.ts`. Verification derives that artifact from the
executing module location and validates its external completion marker, manifest, closure digests,
and dependency tree; environment configuration cannot redirect verification to a borrowed key or
mutable checkout code.
Missing, mismatched, or unverifiable identity or attestation is rejected with
`ERROR_RUNTIME_ISOLATION` before role views, audit reads, transition callbacks, or linked child
insertion can run. An incomplete persisted pair remains a runtime-recovery failure.
`runtimeAffinity()` and `adoptRuntime()` are supervisor-only routing paths; un-affined current,
installed-mode, and temporary/in-memory test workflows remain supported.
Restarting the host is safe: the supervisor reads persisted affinity and routes the workflow back to
the owning committed runtime. Direct mutable `server.ts` launches can serve un-affined workflows,
but cannot read or mutate affined workflows without the matching identity. Corrupt or otherwise
invalid persisted state fails closed during startup with its `ERROR_STATE_CORRUPT`,
`ERROR_MIGRATION_REQUIRED`, or runtime-recovery diagnostic on stderr, while stdout remains protocol
clean.

### Phases

```text
IMPLEMENTING, REVIEWING, REPAIR_REQUIRED, REPAIRING,
STOPPED_CONCERNS, STOPPED_NEEDS_CONTEXT, STOPPED_IMPLEMENTATION_BLOCKED,
STOPPED_INCONCLUSIVE, STOPPED_APPROVED, STOPPED_REPAIR_EXHAUSTED,
COMMIT_AUTHORIZED, COMMIT_PREPARED, STOPPED_COMMIT_PREPARATION, STOPPED_NOT_COMMITTED,
STOPPED_COMMIT_MISMATCH, COMMITTED
```

The main flow and its recoverable/terminal branches:

```text
IMPLEMENTING -> REVIEWING -> REPAIR_REQUIRED -> REPAIRING -> REVIEWING
IMPLEMENTING -- INCOMPLETE --> IMPLEMENTING
REPAIRING   -- INCOMPLETE --> REPAIRING
   |  |            |   \                  |
   |  |            |    `-> STOPPED_INCONCLUSIVE -> (resume) REVIEWING
   |  |            |                 |                    |
   |  |            |                 `-> APPROVED -> STOPPED_APPROVED
   |  |            |
   |  |            `-> CHANGES_REQUESTED -> REPAIR_REQUIRED
   |  |
   |  `-> STOPPED_CONCERNS -> (accept) REVIEWING
   |
   `-> STOPPED_NEEDS_CONTEXT / STOPPED_IMPLEMENTATION_BLOCKED -> (resume) IMPLEMENTING/REPAIRING

STOPPED_APPROVED -> COMMIT_AUTHORIZED -> COMMIT_PREPARED -> COMMITTED   (terminal)
                        |  |                 |   `-> STOPPED_COMMIT_MISMATCH (terminal)
                        |  `-> STOPPED_COMMIT_PREPARATION -> (retry) COMMIT_AUTHORIZED
                        |                              `-> (review) REVIEWING
                        |  `-> (unchanged-HEAD failure) STOPPED_NOT_COMMITTED -> COMMIT_AUTHORIZED
                        |
                        `-> STOPPED_REPAIR_EXHAUSTED (terminal, when cycles exhausted)
```

`REPAIR_REQUIRED` may record an explicit parent/user finding adjudication with
`workflow_adjudicate_findings` when a blocking finding is inconsistent with the approved contract
or outside approved scope. Adjudication preserves the finding snapshot and requires a fresh review;
it never dispatches an implementer and never approves the workflow. Remaining effective blockers
enter `REPAIRING` via `workflow_authorize_repair` and become terminal
`STOPPED_REPAIR_EXHAUSTED` via `workflow_finalize_repair_exhausted` only when the repair cycle equals
the maximum. `STOPPED_APPROVED` and `STOPPED_REPAIR_EXHAUSTED` can spawn a fresh linked cycle-0
workflow with the legacy direct-contract `workflow_create_linked_followup` or the identity-only
`workflow_create_linked_followup_from_plan`. The latter resolves the exact current approved child
PlanArtifact server-side. `INCONCLUSIVE` becomes `STOPPED_INCONCLUSIVE` and is
recoverable with `workflow_resume_review`. Implementation context/block stops are recoverable with
`workflow_resume_implementation`. `STOPPED_CONCERNS` enters review via `workflow_accept_concerns`
under explicit user authorization. Terminal phases are `STOPPED_REPAIR_EXHAUSTED`,
`STOPPED_COMMIT_MISMATCH`, and `COMMITTED`.

`INCOMPLETE` is an implementation-attempt outcome, not a phase or stop. It increments the workflow
version, appends an audit event, and preserves `IMPLEMENTING` or `REPAIRING` with the implementer
action still available. It creates no stop/recovery context and cannot expose concern acceptance or
review. The latest attempt evidence occupies the existing implementation fields and is replaced by
a later attempt; phase gating prevents interim evidence from becoming a reviewable receipt.

### Role views and dispatch

- Parent view: the full persisted workflow (minus capabilities, hashes, audits, internal fields,
  and all receipt structures/digests). `approved_plan` is immutable execution intent exposed only
  to the parent and implementer; structured objective, scope, and contracts remain enforceable
  boundaries. The parent owns user and commit authorization, repair and
  resume authorization, retry, and linked follow-up creation.
- Implementer view: objective, acceptance criteria, validation requirements, dirty
  baseline, remediation context, linked findings, final implementation fields, result arrays, finding
  resolution map, blocking findings, and permitted actions. A `change` workflow starts `IMPLEMENTING`
  and the implementer submits with `workflow_submit_implementation`.
- Reviewer view: criteria, validations, dirty baseline, implementation evidence and results, concern
  acceptance, finding buckets and classifications, resolution map, and permitted actions. The
  reviewer view exposes `validation_results` for both workflow types. Implementers remain the sole
  producer of `state.validation_results` for `change` workflows; reviewers must omit that field
  there. For `review_only` workflows, reviewers submit only the ordered executable results after
  the existing exact-policy runner completes them. Manual requirements are never executed or
  submitted by reviewers, and parent terminal manual evidence remains authoritative. Working-tree
  reviewers call `workflow_begin_review` before inspection; the internal start snapshot is never
  exposed. Review-only workflows start `REVIEWING` and are dispatched directly to the reviewer,
  skipping the implementer; the reviewer view omits the nonexistent implementer handoff.
- Committer view: criteria, validations, derived paths, implementation results and failures, concern
  acceptance, finding buckets, sanitized commit preparation, commit authorization, and permitted
  actions. Receipt JSON and digests remain internal; the committer prepares and then submits the
  commit result.

Validation requirements are workflow-local contracts. The server assigns `VAL-001`, `VAL-002`, and
so on in caller order; those IDs correlate a requirement with its result within that workflow and
are never repository-global command selectors. Each requirement exposes `description` plus either
an exact structured executable `argv` array or `argv: null` for a manual check. The reviewer policy
authorizes exact argv entries independently, so descriptions are never parsed as commands and
manual requirements are never executed.

Required manual validation is authoritative workflow evidence, not a prompt or conversation claim.
Implementers must submit `not_run` for every manual (`argv: null`) requirement; only the parent may
record bounded terminal `passed` or `failed` evidence. A complete implementation may enter
`REVIEWING` while that evidence is pending, but reviewer routing and commit authorization remain
gated until the parent records it. Later implementation or repair replaces the current validation
results, returning manual checks to unresolved `not_run` and requiring fresh parent evidence.

The OpenCode orchestrator performs a bounded, read-only policy preflight before
`workflow_create`: it reads `.codex/reviewer-validation.json` and checks every proposed non-null
`argv` by exact array equality, including length, ordering, and every individual argument. Validation
IDs, descriptions, prefixes, and approximate matches never authorize execution. An unauthorized
requirement may be reformulated only as a genuinely manual `argv: null` check or as an already-
authorized exact argv that is genuinely sufficient for the same check; otherwise the orchestrator
stops and reports the mismatch without creating the workflow. It never edits the policy, executes
reviewer validations, silently drops required checks, or claims an unavailable executable check
passed manually. A missing or malformed policy is a stop condition rather than a reason to guess.

### Generic work-item provenance

Workflow creation may include optional `work_items` records with provider-neutral `provider`, `id`,
exact `display_ref`, and nullable absolute HTTP(S) `url`. Provenance is immutable schema v8 state,
survives restart, is visible only to parent and committer views, and is inherited by linked follow-ups
without caller retranscription. It is separate from scope, criteria, remediation, receipts, review,
and commit authorization. Schema v8 is a clean break from schema v7 and earlier; incompatible
databases require a clean reset rather than backfill.

The committer renders only authoritative items as one neutral `Refs <display_ref>` line per distinct
display reference, preserving first occurrence and exact text. Empty provenance emits no lines; no
tracker API is called and no completion keyword is inferred.

Finding adjudications are append-only schema v8 records. A parent may disposition an exact current
blocking finding only with explicit user authorization and a bounded reason identifying a contract
inconsistency or approved-scope mismatch. The original finding snapshot is retained in state and
parent audit projection; effective blockers are calculated from the latest review result, and a
fresh independent review is required after the last effective blocker is adjudicated.

### Commit flow

A commit is authorized only for an approved working-tree workflow with a fresh internal review
receipt and an explicit parent/user `commit_authorization`; a `commit_range` review never authorizes
a commit. After the parent authorizes, the committer stages complete approved paths and calls
`workflow_prepare_commit`, which checks the current HEAD and the staged scope, file modes, and blob
digests against the internal authorized receipt, rejects approved-path residue, and binds the
prepared tree and path set without changing Git state. Receipt paths use exact delete+add semantics
for renames. Staged and post-commit path derivation disables Git rename detection, so user Git
configuration cannot collapse or change the reviewed path set. The committer then runs the external
`git commit` and calls `workflow_submit_commit_result` with only the semantic outcome and bounded
failure summary when applicable, whether the commit succeeded or failed. Workflow MCP observes and
verifies authoritative Git HEAD itself and persists the verified SHA. Result submission verifies the
current HEAD, commit parent, prepared tree, and changed paths against the prepared attempt (or
confirms that HEAD stayed unchanged for a not-committed result). A verified commit enters `COMMITTED`;
an unchanged-HEAD failure enters the retryable `STOPPED_NOT_COMMITTED`
stop (cleared by `workflow_retry_commit`); any verification mismatch enters the terminal
`STOPPED_COMMIT_MISMATCH`. A supported preparation failure before a commit exists is persisted as
`STOPPED_COMMIT_PREPARATION` with its category, bounded diagnostic, failure version/timestamp, and
recovery class. Retryable scope/content failures expose only
`workflow_retry_commit_preparation`; stale receipt failures expose only
`workflow_return_commit_to_review`, which clears authorization and requires a fresh review and
fresh authorization. The committer has no permitted action while stopped. The server never changes
Git state; the committer owns staging and the commit.

If commit-result bookkeeping fails after Git has already created the commit, never retry the Git
commit. Prefer ordinary `workflow_submit_commit_result` when the owning corrected runtime is
available; the parent-only `workflow_reconcile_commit_result` operation exists only to route this
bounded verification to the current runtime for workflows stranded on an older immutable runtime.
It leaves runtime affinity unchanged and never creates, amends, or duplicates a commit. After a
successful reconciliation, only an attested current non-owner runtime may serve the terminal
`workflow_parent_get` view when the current persisted version has the parent reconciliation audit
transition from `COMMIT_PREPARED` to `COMMITTED` or `STOPPED_COMMIT_MISMATCH` with a matching state
digest. Ordinary parent, worker, and audit reads remain routed to the persisted owner, and the
exception does not apply to same-owner reconciliation or any mutation.

## Bootstrap and reload checklist

This installation uses the previously authorized prompt/receipt bootstrap. Commit `.codex/config.toml`,
restart/reload Codex, then perform a safe read-only smoke test by listing the `workflow_state` tools
and inspecting initialization instructions. Confirm the dedicated role getters, `workflow_get_audit`, and the
expected mutation tools are visible before creating a workflow. Manually starting the STDIO child
does not inject tools into an already-running host. Before reload, fail closed and ask the user
whether prompt-only degraded mode is authorized; after reload, MCP is authoritative only when the
tools and instructions are visible. The config's `default_tools_approval_mode = "prompt"` keeps
workflow tool calls approval-sensitive in the host.

### Separate Codex runtime smoke gate

This is a disposable, manual gate for Codex CLI `0.148.0`, not a step in the OpenCode
implementation workflow. It is required before claiming that issue #28 is unblocked:

1. Make a disposable copy of the repository, verify it is clean, and use a disposable Workflow
   MCP state location. Do not run this against an active workflow or production state.
2. Start Codex in that copy, reload the project configuration, and spawn each configured custom
   worker (`implementer`, `code_reviewer`, and `committer`) one at a time. Capture the actual
   Workflow MCP tool list shown to each worker during initialization or its MCP inspection command.
3. For each worker, perform one representative permitted operation in a disposable workflow. Then
   attempt a cross-role operation (for example, implementer -> `workflow_submit_review`) and a
   parent-only operation (for example, `workflow_create` or `workflow_get_audit`). Each forbidden
   operation must be absent from the worker's exposed tool surface or fail closed; record the
   observed result and the Codex version.
4. Confirm the parent session still exposes the unrestricted Workflow MCP registration and that
   the repository's self-host configuration remains disabled. Preserve the transcript or screenshots
   as external evidence; do not claim success from the generated TOML alone.

If any worker exposes an unexpected tool or a forbidden call succeeds, record **#28 remains
blocked** with the observed Codex limitation. Record **#28 prerequisite satisfied** only after all
three worker surfaces and representative denial attempts pass.

## Review/fix/re-review transition

For non-trivial changes, the parent runs one independent review after implementation. When
`CHANGES_REQUESTED` contains blocking findings, the parent authorizes repair with those exact
finding IDs, sends the implementer back into `REPAIRING`, then re-reviews. At most two
implementer-to-reviewer repair cycles are allowed after the initial review. If blocking findings
remain after the second cycle, finalize `STOPPED_REPAIR_EXHAUSTED` and stop; do not loop again or
commit. Trivial edits are exempt from this loop.

The parent follows these state transitions:

`workflow_expand_scope` is available to the parent only in `IMPLEMENTING`, `REPAIR_REQUIRED`,
`REPAIRING`, `STOPPED_NEEDS_CONTEXT`, and `STOPPED_IMPLEMENTATION_BLOCKED`. It is rejected during
review snapshots, approval, commit, exhausted, and terminal phases. Expansion preserves the phase
and repair cycle; after expansion the implementer must submit fresh evidence before review resumes.

- `CHANGES_REQUESTED` plus `REPAIR_BLOCKERS`: authorize repair on exactly the `blocking_findings`
  IDs with `workflow_authorize_repair`, advancing to the next repair cycle. If the final cycle still
  has blockers, `workflow_finalize_repair_exhausted` stops terminally; do not loop or commit.
- `APPROVED` plus `STOPPED_APPROVED`: stop optional remediation immediately, report
  `optional_findings`, and do not invoke another agent or mutation tool to address those findings.
  Spare cycle capacity does not change this state. A separately user-authorized commit, in the
  original or a later instruction, may still dispatch `committer` when review and receipt gates
  pass. An explicitly user-authorized linked follow-up spawns a fresh cycle-0 child that copies the
  exact findings and remediation context.
- `INCONCLUSIVE` plus `STOPPED_INCONCLUSIVE`: stop without mutation and request the missing context;
  resume with `workflow_resume_review` once the context is available.
- `STOPPED_NEEDS_CONTEXT` / `STOPPED_IMPLEMENTATION_BLOCKED`: resume implementation with
  `workflow_resume_implementation` once the missing context or blocker is resolved.
- `STOPPED_CONCERNS`: accept with `workflow_accept_concerns` under explicit user authorization; this
  enters review without rewriting the failed evidence and never implies commit authorization.

For `INCOMPLETE`, the parent refreshes authoritative state and may redispatch the implementer
directly. OpenCode allows at most two consecutive automatic redispatches after the initial attempt;
the third incomplete continuation stops unattended dispatch for explicit intervention while the
workflow remains active. This counter is execution-local operational bookkeeping, not durable
workflow semantics or an authorization boundary. Losing or resetting it cannot broaden authority:
every attempt remains constrained by the same approved plan, scope, phase, runtime affinity, and
optimistic version check. Do not add a workflow phase, SQLite field, or persisted counter for this
guard.

An `APPROVED` review is therefore the automatic stopping point. The repair-cycle allowance is a
safety limit, not permission to pursue every possible improvement.

Linked follow-ups are an explicit two-stage exception: the child keeps a narrow mutation allowlist
for authorized remediation, then requires a fresh independent combined review over the inherited
logical-change scope before commit eligibility. The source is superseded atomically so only the
active linked leaf can eventually authorize and prepare a commit.

### Transition-summary convention

After every terminal subagent handoff, the parent must refresh `workflow_operator_decision_get` before
summarizing or routing. The summary is a concise user-visible decision record sourced only from that
refreshed semantic projection: report its decision, semantic outcome, blocker summaries, recovery
choice, available authority boundaries, and material linked-workflow summary when present. It must
not dump raw workflow or plan identity, phase/action names, receipts, audit events, capabilities,
validation logs, or a complete worker report. Use `workflow_parent_get` only for exact mutation
inputs/version or an explicit debug/status request.

The semantic decision is the first discriminator after this refresh. After a terminal implementation
handoff, including completion of an authorized repair, `no_user_action/review` or
`no_user_action/re_review` routes directly to a fresh `code_reviewer` even when blocker summaries
still retain an earlier blocker such as `REV-X-001`. Retained blockers are history/remediation
context only; a non-empty retained list is not a fresh review result and never authorizes, requests,
or invokes repair by itself. Only a fresh review whose projection reports `approve_exact_repairs`
with its authority boundary available may lead to an exact-ID repair-authorization prompt. The
parent then reads the full view for the current exact blocking finding IDs, capability, version, and
permitted mutation action. If that action is absent, fail closed without prompting or invoking
repair. This convention changes neither Workflow MCP authority nor phases, schema, persistence,
transition semantics, repair-cycle policy, or attempt bookkeeping.

The summary must cover the following transitions without changing their existing semantics:

- Implementation completion, incomplete continuation, concern, context, and block outcomes identify
  the result and the available review, continuation, or recovery decision. Incomplete work never
  routes through concern acceptance or review.
- A `CHANGES_REQUESTED` review surfaces every blocking finding identifier and a bounded human-readable
  reason before repair authorization or implementer redispatch. Repair authorization communicates the
  current repair cycle and next role; exhaustion communicates the terminal stop and forbids another
  cycle.
- An approval communicates approval and optional findings before requesting explicit commit
  authorization; optional findings do not automatically dispatch remediation.
- Inconclusive review, implementation stop, commit-preparation recovery, and commit-failure stops
  communicate the bounded stop/recovery decision without implying authorization.
- Commit outcomes communicate the authoritative result and material linked follow-ups communicate
  their linked metadata and narrow purpose.

After every parent mutation, the parent must refresh `workflow_operator_decision_get` again and issue
a fresh semantic summary before redispatching a role or requesting the next authorization. This is a
presentation and routing convention only: it does not change Workflow MCP phases, persisted
presentation fields, worker-attempt bookkeeping, authorization rules, the state machine, persistence
schema, or worker isolation. The parent still owns all parent mutations and authorization; workers
still receive only their exact workflow ID and use their dedicated authoritative getter. Read
`workflow_parent_get` again only when the next explicit mutation needs exact inputs/version or the
user requests debug/status detail.

## Prompt-only degraded mode

Use this mode only when the user explicitly authorizes it for a stopped, non-trivial workflow. The
parent retains the same handoff fields and role ownership below, tracks the version and audit state
manually, and records the decision. The parent passes the full handoff state in the prompt because no
authoritative view exists. Receipt JSON and comparison data stay inside Workflow MCP; managed
workers submit semantic fields only. The degraded handoff below retains explicit receipt commands
because no server-side snapshot exists in that mode.

### Parent -> implementer

```yaml
objective: <approved implementation objective>
approved_plan: <exact immutable approved plan text, or null for direct/non-plan work>
owned_files: [<exact paths>]
acceptance_criteria: [<observable criteria>]
validation_required: [<commands or checks>]
remediation_policy: blocking_only | explicitly_authorized
authorized_finding_ids: []
repair_cycle: 0 | 1 | 2
user_authorization: <explicit new user instruction summary or absent>
review_target:
  review_mode: working_tree
  base_revision: <current HEAD or explicit revision>
  head_revision: null
  approved_paths: [<same exact owned paths>]
  include_staged: true
  include_unstaged: true
  include_untracked: true
prior_findings: []
resolution_claims: []
```

For initial work, use `remediation_policy: blocking_only`, an empty `authorized_finding_ids`, and
`repair_cycle: 0`. For a blocking repair, use `blocking_only`, exact P0-P2 IDs, and cycle 1 or 2.
For an explicitly authorized optional follow-up, use `explicitly_authorized`, exact user-approved
IDs, a new objective and scope, and `repair_cycle: 0`; include the explicit user authorization in
the dispatch. The implementer may touch only authorized finding IDs during remediation. Without
matching authorization, optional or P3 remediation returns `NEEDS_CONTEXT` and makes no mutation.

### Implementer -> parent

```yaml
status: DONE | DONE_WITH_CONCERNS | INCOMPLETE | NEEDS_CONTEXT | BLOCKED
objective: <implemented objective>
owned_files: [<materially changed exact paths>]
acceptance_criteria: <satisfied and outstanding criteria>
validation_required: [<commands or checks>]
validation_completed: [<commands and outcomes>]
changed_paths: [<exact paths derived by Workflow MCP from the authoritative receipt>]
acceptance_evidence: [<bounded evidence>]
validation_evidence: [<bounded evidence>]
known_failures: [<bounded known failures>]
finding_resolution_map: {<prior finding ID>: resolved | still_present | superseded}
remediation_policy: <blocking_only | explicitly_authorized>
authorized_finding_ids: <exact IDs>
repair_cycle: <0 | 1 | 2>
user_authorization: <explicit new user instruction summary or absent>
ready_for_commit: <true only for DONE>
```

### Parent -> code reviewer

```yaml
objective: <approved implementation objective>
acceptance_criteria: [<observable criteria>]
implementer_handoff: <complete prior handoff>
review_target:
  review_mode: working_tree | commit_range
  base_revision: <explicit revision>
  head_revision: <null for working_tree; explicit revision for commit_range>
  approved_paths: [<exact repository-relative file paths>]
  include_staged: <true for working_tree; false for commit_range>
  include_unstaged: <true for working_tree; false for commit_range>
  include_untracked: <true for working_tree; false for commit_range>
prior_findings: [<complete prior findings, if re-review>]
resolution_claims: [<implementer claims for prior finding IDs>]
prior_finding_classifications: {<finding_id>: resolved | still_present | superseded}
```

Working-tree reviews require all three include flags to be true and are the only review mode that
can authorize a later commit. Their `approved_paths` are an exact allowlist for inspection and
scope accounting, not an existence requirement: a path may be provably absent and still be reviewed
and recorded as absent. A required-but-absent artifact is a blocking finding when an authoritative
contract requires it; an unknown, contradictory, or uninspectable path state is `INCONCLUSIVE`.
For semantic review, the repository-wide corpus is tracked working-tree content plus present
untracked content at exact paths in `approved_paths`; unrelated untracked and ignored files remain
outside that corpus. `include_untracked` includes untracked state only for those approved paths and
does not authorize checkout-wide searches. `approved_paths` remains the exact ownership and receipt
boundary even when tracked files outside that list are read for context. Ambient untracked files
remain outside semantic review unless they observably interfere with an authorized validation.
Commit-range reviews require explicit base and head revisions, all three include flags set to false,
and never produce a commit receipt. A path absent at both commit-range endpoints remains rejected
under the existing range rules. Contradictory include flags make the review `INCONCLUSIVE`.

### Reviewer -> parent

```yaml
review_status: APPROVED | CHANGES_REQUESTED | INCONCLUSIVE
reviewed_scope: <exact target paths and mode>
reviewed_objective: <objective reviewed>
prior_finding_classifications: {<finding_id>: resolved | still_present | superseded}
blocking_findings: [<finding_id, severity, blocking, file_and_line, failure_scenario, impact,
  violated_requirement, remediation, missing_or_inadequate_test>]
optional_findings: [<finding_id, severity, blocking, file_and_line, failure_scenario, impact,
  violated_requirement, remediation, missing_or_inadequate_test>]
workflow_recommendation: REPAIR_BLOCKERS | STOPPED_APPROVED | STOPPED_INCONCLUSIVE
validation_completed: [<read-only commands and outcomes>]
residual_risks: <none or concise list>
review_passed: <true only for APPROVED>
```

P0-P2 findings belong in `blocking_findings` and block approval; P3 findings belong in
`optional_findings` and are concrete non-blocking notes. Every prior finding must be classified
before new findings are reported. `CHANGES_REQUESTED` uses `REPAIR_BLOCKERS`; `APPROVED` always
uses `STOPPED_APPROVED`, even when optional findings exist; `INCONCLUSIVE` uses
`STOPPED_INCONCLUSIVE`.

### Parent -> committer

```yaml
objective: <commit objective>
owned_files: [<exact approved paths>]
intended_changed_paths:
  [<approved paths recorded by Workflow MCP as added, modified, or deleted>]
validation_completed: [<commands and outcomes>]
review_status: APPROVED
review_target: <working_tree target with all include flags true>
approved_for_commit: true
```

The committer treats `owned_files` as an allowlist. For receipt-gated changes it stages complete
paths only, never partial hunks, confirms no approved-path unstaged or untracked content remains,
and confirms the staged path set exactly equals `intended_changed_paths`. Workflow MCP performs the
fresh internal receipt checks immediately before staging and again after staging. Any mismatch stops
the commit and requests re-review. `approved_for_commit` is a separate parent/user authorization.

### Committer -> parent

```yaml
status: COMMITTED | NOT_COMMITTED
commit_hash: <hash or absent>
commit_message: <subject and optional body>
committed_files: [<exact paths or empty>]
validation_status: <inherited implementation/review status>
receipt_comparisons: <pre-stage and post-stage outcomes>
remaining_worktree: <staged and unstaged state>
hook_changes: <none or exact summary>
known_failures: <none or concise list>
```

## Persistence schema

Planning is a separate pre-workflow domain. Complete PlanArtifact revisions are insert-only and
read/revise operations require exact optimistic revision numbers. Parent approval is a separate
exact-revision operation; planner-facing writes cannot self-approve. Historical approved revisions
remain readable but only the current approved revision can seed a workflow. `workflow_create_from_plan`
and `workflow_create_linked_followup_from_plan` construct workflows server-side and snapshot the authoritative full plan,
bounded execution brief, normalized contracts, and digest provenance. Plans are not runtime-affined,
and planning adds no WorkflowPhase or worker-attempt state. Direct `workflow_create` remains supported.

Persisted Workflow MCP state has one current schema. `approved_plan` is stored as exact text in the
state JSON: `workflow_create_from_plan` copies it from the exact current approved revision, while
direct/non-plan workflow creation supplies `null`; it cannot be changed by ordinary mutations or
runtime adoption. Legacy linked follow-ups retain their raw direct-contract and null-plan behavior;
plan-native linked follow-ups receive only plan identity and never silently copy the source plan.
Incompatible databases are rejected at startup
with an actionable reset-required `ERROR_MIGRATION_REQUIRED` diagnostic; startup never rewrites rows
or upgrades SQLite tables. Current workflows use `workflow_authorize_commit`,
`workflow_prepare_commit`, external commit, and `workflow_submit_commit_result`.
The current schema is v8, including planning tables and schema-v7 finding-adjudication fields;
schema-v7 and earlier databases require a clean durable-state reset, so unfinished historical
workflows cannot cross this schema break.

## Observed end-to-end run

The workflow was exercised while hardening these contracts:

1. The implementer completed the approved scope and validation and submitted complete evidence.
2. The reviewer independently found three blocking defects that passing tests had not exposed.
3. The parent authorized repair, the implementer repaired them, and returned a finding-resolution map.
4. The reviewer classified all prior findings as resolved and returned `APPROVED` with a receipt.
5. The committer prepared the staged index, committed only the approved scope, submitted the commit
   result, and reported a clean index and worktree.

The run also exposed a governance failure: after the first approval, the parent pursued a P3
improvement without first obtaining user approval. The change was technically useful, but the
decision exceeded the intended stopping boundary. The rule above records the correction: blocking
findings enter the bounded repair loop; non-blocking findings are reported and await user direction.

## Prompt-only degraded-mode receipt commands

These commands are for explicitly authorized prompt-only degraded mode only. Managed-mode workers do
not generate, compare, or submit receipt JSON. Run from the repository root with an exact-path allowlist:

```sh
bun .codex/agents/change-receipt.ts -- path/a path/b
```

The command emits metadata-only JSON and never changes files or the index. The reviewer runs it at
review start and immediately before its final response. The committer runs it immediately before
staging and once after staging, comparing every receipt field.
