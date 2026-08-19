# Custom subagent workflow

This file defines the authoritative MCP-based workflow and routing. The workflow-state server's role
views carry all handoff state; agent prompts carry only the workflow ID, the role capability, the
expected version, and the instruction to read the role's own view. Detailed role behavior remains in
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
  implementer and committer).
- OpenCode has no filesystem sandbox. The reviewer gets `edit: deny` plus a narrow bash allowlist
  (status/diff/log/show/rev-parse, the receipt command, and the project-owned
  `.codex/agents/reviewer-validation.ts` runner); the committer gets `edit: deny` and a
  fail-closed bash allowlist covering the documented commit flow (status/diff/log/show/rev-parse/
  ls-files inspection, approved `git add`/`git commit`, and the receipt command) while denying
  push/amend/rebase/reset/checkout/switch/history rewriting and filesystem mutation; the
  implementer keeps broad bash for validation with explicit denies for staging, committing,
  pushing, resetting, rebasing, checking out, switching, and the other mutating Git/history
  commands. Every OpenCode agent only exposes its own role's `workflow_state` tools
  (`workflow_state_*` deny plus role-specific allows). These are host-level defense in depth for
  context size and isolation; the server-side role capability, `expected_version`, and transition
  checks remain authoritative and are unchanged between hosts.
- Model/reasoning identity is host metadata, not contract prose: each generated definition
  announces its own identity line (Codex model plus reasoning effort in the TOML, the OpenCode Go
  provider/model ID in the Markdown), injected by the generator in place of the contract's
  `__HOST_IDENTITY__` marker.
- OpenCode requires a dual-handoff terminal response: after the role's MCP submission tool
  (`workflow_submit_implementation`/`workflow_submit_review`/`workflow_submit_commit_result`)
  succeeds, the agent must still write a non-empty normal assistant text report to the parent
  (labeled "final implementation/review/commit report", required for the committer whether the
  commit succeeded or failed). This ordering invariant is appended to the OpenCode definitions by
  the generator only; it is not contract prose and is never present in the Codex TOML, whose
  terminal handoff stays the MCP submission itself.

## Authoritative MCP state

For non-trivial work, the project-scoped `workflow_state` MCP server is authoritative. The parent
creates one workflow before dispatch and passes each role only its one-time capability together with
the `workflow_id`, the current `expected_version`, and the instruction to call `workflow_get` for its
  own view. The returned role view is authoritative and complete: it carries that role's objective,
  contracts, semantic evidence, findings, repair state, and sorted `permitted_next_actions`, so
prompts never duplicate objective, criteria, evidence, finding, receipt, or repair state. Mutations
pass the common `workflow_id`, `capability`, and `expected_version` fields, and the returned view
supplies the next `expected_version`.

Each role must not call tools owned by another role, and capabilities must not be included in
inherited conversation history. Capabilities are defense-in-depth orchestration controls, not a
security boundary against a process with equivalent host filesystem access. If the server is
unavailable, stop and ask the user whether to use the documented prompt-only degraded mode below; do
not silently downgrade. In degraded mode the parent tracks the version and audit state manually and
records the decision.

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
COMMIT_AUTHORIZED, COMMIT_PREPARED, STOPPED_NOT_COMMITTED,
STOPPED_COMMIT_MISMATCH, COMMITTED
```

The main flow and its recoverable/terminal branches:

```text
IMPLEMENTING -> REVIEWING -> REPAIR_REQUIRED -> REPAIRING -> REVIEWING
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
                        |  `-> (unchanged-HEAD failure) STOPPED_NOT_COMMITTED -> COMMIT_AUTHORIZED
                        |
                        `-> STOPPED_REPAIR_EXHAUSTED (terminal, when cycles exhausted)
```

`REPAIR_REQUIRED` enters `REPAIRING` via `workflow_authorize_repair` and becomes terminal
`STOPPED_REPAIR_EXHAUSTED` via `workflow_finalize_repair_exhausted` only when the repair cycle equals
the maximum. `STOPPED_APPROVED` and `STOPPED_REPAIR_EXHAUSTED` can spawn a fresh linked cycle-0
workflow with `workflow_create_linked_followup`. `INCONCLUSIVE` becomes `STOPPED_INCONCLUSIVE` and is
recoverable with `workflow_resume_review`. Implementation context/block stops are recoverable with
`workflow_resume_implementation`. `STOPPED_CONCERNS` enters review via `workflow_accept_concerns`
under explicit user authorization. Terminal phases are `STOPPED_REPAIR_EXHAUSTED`,
`STOPPED_COMMIT_MISMATCH`, and `COMMITTED`.

### Role views and dispatch

- Parent view: the full persisted workflow (minus capabilities, hashes, audits, internal fields,
  and all receipt structures/digests). The parent owns user and commit authorization, repair and
  resume authorization, retry, and linked follow-up creation.
- Implementer view: objective, acceptance criteria, validation requirements, dirty
  baseline, remediation context, linked findings, final implementation fields, result arrays, finding
  resolution map, blocking findings, and permitted actions. A `change` workflow starts `IMPLEMENTING`
  and the implementer submits with `workflow_submit_implementation`.
- Reviewer view: criteria, validations, dirty baseline, implementation evidence and results, concern
  acceptance, finding buckets and classifications, resolution map, and permitted actions. Working-
  tree reviewers call `workflow_begin_review` before inspection; the internal start snapshot is
  never exposed. Review-only workflows start `REVIEWING` and are dispatched directly to the reviewer,
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

### Commit flow

A commit is authorized only for an approved working-tree workflow with a fresh internal review
receipt and an explicit parent/user `commit_authorization`; a `commit_range` review never authorizes
a commit. After the parent authorizes, the committer stages complete approved paths and calls
`workflow_prepare_commit`, which checks the current HEAD and the staged scope, file modes, and blob
digests against the internal authorized receipt, rejects approved-path residue, and binds the
prepared tree and path set without changing Git state. The committer then runs the external
`git commit` and calls `workflow_submit_commit_result` whether the commit succeeded or failed.
Result submission verifies the current HEAD, commit parent, prepared tree, and changed paths against
the prepared attempt (or confirms that HEAD stayed unchanged for a not-committed result). A verified
commit enters `COMMITTED`; an unchanged-HEAD failure enters the retryable `STOPPED_NOT_COMMITTED`
stop (cleared by `workflow_retry_commit`); any verification mismatch enters the terminal
`STOPPED_COMMIT_MISMATCH`. The server never changes Git state; the committer owns staging and the
commit.

## Bootstrap and reload checklist

This installation uses the previously authorized prompt/receipt bootstrap. Commit `.codex/config.toml`,
restart/reload Codex, then perform a safe read-only smoke test by listing the `workflow_state` tools
and inspecting initialization instructions. Confirm `workflow_get`, `workflow_get_audit`, and the
expected mutation tools are visible before creating a workflow. Manually starting the STDIO child
does not inject tools into an already-running host. Before reload, fail closed and ask the user
whether prompt-only degraded mode is authorized; after reload, MCP is authoritative only when the
tools and instructions are visible. The config's `default_tools_approval_mode = "prompt"` keeps
workflow tool calls approval-sensitive in the host.

## Review/fix/re-review transition

For non-trivial changes, the parent runs one independent review after implementation. When
`CHANGES_REQUESTED` contains blocking findings, the parent authorizes repair with those exact
finding IDs, sends the implementer back into `REPAIRING`, then re-reviews. At most two
implementer-to-reviewer repair cycles are allowed after the initial review. If blocking findings
remain after the second cycle, finalize `STOPPED_REPAIR_EXHAUSTED` and stop; do not loop again or
commit. Trivial edits are exempt from this loop.

The parent follows these state transitions:

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

An `APPROVED` review is therefore the automatic stopping point. The repair-cycle allowance is a
safety limit, not permission to pursue every possible improvement.

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
status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
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

Persisted Workflow MCP state has one current schema. Incompatible databases are rejected at startup
with an actionable reset-required `ERROR_MIGRATION_REQUIRED` diagnostic; startup never rewrites rows
or upgrades SQLite tables. Current workflows use `workflow_authorize_commit`,
`workflow_prepare_commit`, external commit, and `workflow_submit_commit_result`.

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
