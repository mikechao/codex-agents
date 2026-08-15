# Custom subagent workflow

This file defines lean handoff schemas and routing. Detailed role behavior remains in the TOML
contracts beside this file. All paths are repository-relative exact file paths; directories and
globs are not valid. The parent agent owns scope, review decisions, repair-loop counting, and
commit authorization.

## Authoritative MCP state

When available, the project-scoped `workflow_state` MCP server is authoritative for non-trivial
workflow state. Create one workflow before dispatch, pass only each role's one-time capability to
the corresponding agent, and include the returned `expected_version` on every mutation. Agents
must not call tools owned by another role, and capabilities must not be included in inherited
conversation history. Capabilities are defense-in-depth orchestration controls, not a security
boundary against a process with equivalent host filesystem access. If the server is unavailable,
stop and ask the user whether to use this documented prompt-only degraded mode for the current
objective; do not silently downgrade. In degraded mode, retain the same handoff fields, receipts,
role ownership, stopping rule, and explicit commit authorization, but the parent must track the
version and audit state manually and record the decision.

The server transitions are:

```text
IMPLEMENTING -> REVIEWING -> REPAIR_REQUIRED -> REPAIRING -> REVIEWING
                                  |                |
                                  v                v
                       STOPPED_BLOCKED    STOPPED_APPROVED -> COMMIT_AUTHORIZED -> COMMITTED
```

`INCONCLUSIVE` becomes `STOPPED_INCONCLUSIVE`. `APPROVED` is a hard stop for optional findings;
an explicitly authorized optional follow-up creates a new linked cycle-0 workflow. The server
persists an append-only audit trail and verifies receipt freshness before approval/commit.

## Bootstrap and reload checklist

This installation uses the previously authorized prompt/receipt bootstrap. Commit `.codex/config.toml`,
restart/reload Codex, then perform a safe read-only smoke test by listing the `workflow_state` tools
and inspecting initialization instructions. Confirm `workflow_get`, `workflow_get_audit`, and the
expected mutation tools are visible before creating a workflow. Manually starting the STDIO child
does not inject tools into an already-running host. Before reload, fail closed and ask the user
whether prompt-only degraded mode is authorized; after reload, MCP is authoritative only when the
tools and instructions are visible. The config's `default_tools_approval_mode = "prompt"` keeps
workflow tool calls approval-sensitive in the host.

## Parent → implementer

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

For initial work, use `remediation_policy: blocking_only`, an empty
`authorized_finding_ids`, and `repair_cycle: 0`. For a blocking repair, use
`blocking_only`, exact P0-P2 IDs, and cycle 1 or 2. For an explicitly authorized optional
follow-up, use `explicitly_authorized`, exact user-approved IDs, a new objective and scope, and
`repair_cycle: 0`; include the explicit user authorization in the dispatch. The implementer may
touch only authorized finding IDs during remediation. Without matching authorization, optional or
P3 remediation returns `NEEDS_CONTEXT` and makes no mutation.

## Implementer → parent

```yaml
status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
objective: <implemented objective>
owned_files: [<materially changed exact paths>]
acceptance_criteria: <satisfied and outstanding criteria>
validation_required: [<commands or checks>]
validation_completed: [<commands and outcomes>]
changed_paths: [<exact receipt paths whose state is added, modified, or deleted>]
acceptance_evidence: [<bounded evidence>]
validation_evidence: [<bounded evidence>]
implementation_receipt: <complete metadata-only receipt>
known_failures: [<bounded known failures>]
finding_resolution_map: {<prior finding ID>: resolved | still_present | superseded}
remediation_policy: <blocking_only | explicitly_authorized>
authorized_finding_ids: <exact IDs>
repair_cycle: <0 | 1 | 2>
user_authorization: <explicit new user instruction summary or absent>
ready_for_commit: <true only for DONE>
```

The implementation receipt is evidence only. A reviewer must produce the commit-gating receipt
after independently inspecting the declared target.

## Parent → code reviewer

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
can authorize a later commit. Commit-range reviews require explicit base and head revisions, all
three include flags set to false, and never produce a commit receipt. Contradictory include flags
make the review `INCONCLUSIVE`.

## Reviewer → parent

```yaml
review_status: APPROVED | CHANGES_REQUESTED | INCONCLUSIVE
reviewed_scope: <exact target paths and mode>
reviewed_objective: <objective reviewed>
review_target: <complete target schema>
prior_finding_classifications: {<finding_id>: resolved | still_present | superseded}
blocking_findings: [<finding_id, severity, blocking, file_and_line, failure_scenario, impact,
  violated_requirement, remediation, missing_or_inadequate_test>]
optional_findings: [<finding_id, severity, blocking, file_and_line, failure_scenario, impact,
  violated_requirement, remediation, missing_or_inadequate_test>]
workflow_recommendation: REPAIR_BLOCKERS | STOPPED_APPROVED | STOPPED_INCONCLUSIVE
validation_completed: [<read-only commands and outcomes>]
review_receipt: <complete metadata-only receipt for APPROVED working_tree; otherwise none>
residual_risks: <none or concise list>
review_passed: <true only for APPROVED>
```

P0-P2 findings belong in `blocking_findings` and block approval; P3 findings belong in
`optional_findings` and are concrete non-blocking notes. Every prior finding must be classified
before new findings are reported. `CHANGES_REQUESTED` uses `REPAIR_BLOCKERS`; `APPROVED` always
uses `STOPPED_APPROVED`, even when optional findings exist; `INCONCLUSIVE` uses
`STOPPED_INCONCLUSIVE`.

## Parent → committer

```yaml
objective: <commit objective>
owned_files: [<exact approved paths>]
intended_changed_paths:
  [<approved paths whose reviewer receipt state is added, modified, or deleted>]
validation_completed: [<commands and outcomes>]
review_status: APPROVED
review_target: <working_tree target with all include flags true>
review_receipt: <complete reviewer receipt matching owned_files>
approved_for_commit: true
```

The committer treats `owned_files` as an allowlist. For receipt-gated changes it stages complete
paths only, never partial hunks, confirms no approved-path unstaged or untracked content remains,
and confirms the staged path set exactly equals `intended_changed_paths`. It compares a fresh
receipt to `review_receipt` immediately before staging and again after staging. Any mismatch stops
the commit and requests re-review. `approved_for_commit` is a separate parent/user authorization.

## Committer → parent

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

## Review/fix/re-review transition

For non-trivial changes, the parent runs one independent review after implementation. When
`CHANGES_REQUESTED` contains blocking findings, the parent sends those findings and the
implementer's resolution claims back to the implementer, then re-reviews. At most two
implementer-to-reviewer repair cycles are allowed after the initial review. If blocking findings
remain after the second cycle, stop and report them; do not loop again or commit. Trivial edits are
exempt from this loop.

The parent follows these state transitions:

- `CHANGES_REQUESTED` plus `REPAIR_BLOCKERS`: dispatch only `blocking_findings`, with
  `remediation_policy: blocking_only`, exact IDs, and the next repair cycle. If cycle 2 still has
  blockers, stop and report them; do not loop or commit.
- `APPROVED` plus `STOPPED_APPROVED`: stop optional remediation immediately, report
  `optional_findings`, and do not invoke another agent or mutation tool to address those findings.
  Spare cycle capacity does not change this state. A separately user-authorized commit, in the
  original or a later instruction, may still dispatch `committer` when review and receipt gates
  pass.
- `INCONCLUSIVE` plus `STOPPED_INCONCLUSIVE`: stop without mutation and request the missing context.
- An explicit user-approved optional follow-up starts a new objective with a new exact scope,
  `remediation_policy: explicitly_authorized`, exact authorized IDs, and `repair_cycle: 0`; it
  receives a fresh review rather than silently continuing the prior loop.

An `APPROVED` review is therefore the automatic stopping point. The repair-cycle allowance is a
safety limit, not permission to pursue every possible improvement.

## Observed end-to-end run

The workflow was exercised while hardening these contracts:

1. The implementer completed the approved scope and validation.
2. The reviewer independently found three blocking defects that passing tests had not exposed.
3. The implementer repaired them and returned a finding-resolution map.
4. The reviewer classified all prior findings as resolved and returned `APPROVED` with a receipt.
5. The committer matched that receipt before and after complete-path staging, committed only the
   approved scope, and reported a clean index and worktree.

The run also exposed a governance failure: after the first approval, the parent pursued a P3
improvement without first obtaining user approval. The change was technically useful, but the
decision exceeded the intended stopping boundary. The rule above records the correction: blocking
findings enter the bounded repair loop; non-blocking findings are reported and await user direction.

## Receipt commands

Run from the repository root with an explicit exact-path allowlist:

```sh
node .codex/agents/change-receipt.mjs -- path/a path/b
```

The command emits metadata-only JSON and never changes files or the index. The reviewer runs it at
review start and immediately before its final response. The committer runs it immediately before
staging and once after staging, comparing every receipt field.
