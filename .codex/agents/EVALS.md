# Custom subagent evaluation checklist

Use these scenarios after changing an agent contract and before adding more instructions. Run them
in a disposable branch or worktree when the scenario requires synthetic changes.

## Implementer

- Authoritative view dispatch: the prompt carries only `workflow_id`, the implementer capability,
  `expected_version`, and the instruction to read the view; the implementer reads `workflow_get` and
  uses the view's objective, contracts, initial receipt, dirty baseline, remediation context, and
  permitted actions without requiring prompt-carried copies.
- Valid approved plan: implements only the owned scope, reviews the final diff, passes required
  validation, and returns `DONE`.
- Materially incorrect or impossible plan: avoids an unapproved redesign and returns `BLOCKED` with
  the decision or external change required.
- Required context is missing: returns `NEEDS_CONTEXT`, identifies the missing input, and avoids
  speculative implementation.
- Owned file already contains user changes: preserves those changes, integrates safely when
  possible, and identifies the pre-existing edits in its report.
- Pre-existing or environment validation failure: provides evidence for the classification and
  returns `DONE_WITH_CONCERNS` without falsely advancing to review.
- Unrelated dirty-worktree changes: leaves them untouched and excludes them from its changed-file
  and readiness claims.

## Committer

- Authoritative view dispatch: the prompt carries only `workflow_id`, the committer capability,
  `expected_version`, and the instruction to read the view; the committer reads `workflow_get` and
  refuses to stage or commit without a `commit_authorization` and a working-tree review receipt.
- Approved scope with unrelated unstaged changes: commits only the allowlisted scope and reports the
  unrelated files as uncommitted.
- Unrelated changes already staged: does not alter the index or create a commit and reports the
  conflicting staged paths.
- No changes in the approved scope: does not create an empty commit.
- Commit hook fails: does not bypass the hook, submits the `not_committed` result with a bounded
  failure summary, and reports the failure.
- Commit hook modifies files: audits the created commit and final worktree, reports the
  modification, and does not amend or repair without authorization.
- Successful scoped commit: confirms the actual commit contents, hash, message, validation status,
  and remaining worktree state, then submits the `committed` result.
- Prepare and submit flow: stages complete paths, calls `workflow_prepare_commit`, commits
  externally, and always submits `workflow_submit_commit_result` after success or failure.
- Receipt-gated partial staging: refuses partial-hunk staging, stages complete contents or complete
  deletions for every intended changed approved path, verifies no approved-path unstaged or
  untracked content remains, and verifies the staged path set exactly matches the intended set.
- Trivial commit without a receipt: preserves ordinary explicit staging behavior without weakening
  the receipt gate for non-trivial reviewed changes.

## Code reviewer

- Authoritative view dispatch: the prompt carries only `workflow_id`, the reviewer capability,
  `expected_version`, and the instruction to read the view; the reviewer reads `workflow_get` and
  reviews the view's target, evidence, and prior findings without requiring prompt-carried copies.
- Review-only dispatch: a `review_only` workflow is dispatched directly to the reviewer with no
  implementer step, and the reviewer reviews the working tree or declared commit range directly.
- Clean correct diff: reads the approved context and actual diff, reports `APPROVED`, and sets
  `review_passed: true` without changing repository state.
- Seeded functional bug: identifies the defect with a plausible failure scenario, impact, violated
  requirement, remediation, and missing or inadequate test; reports `CHANGES_REQUESTED`.
- Missing or inadequate regression test: identifies the unprotected behavior as actionable when
  the implementation could regress; reports `CHANGES_REQUESTED` with the required test evidence.
- Style-only noise: does not manufacture findings for formatting, naming, or preference-only issues;
  a behaviorally correct diff remains `APPROVED`.
- Incomplete context: reports `INCONCLUSIVE`, names the missing objective, scope, handoff, diff, or
  required documentation, and does not guess or approve.
- Passing tests masking a semantic defect: still reports the defect because test success does not
  replace semantic review.
- Read-only and authorization boundary: never edits, stages, commits, fixes, delegates, or grants
  commit authorization, even when findings are present or validation fails.
- Working-tree target coverage: requires all review-target fields, includes staged, unstaged, and
  untracked exact paths, and returns `INCONCLUSIVE` when any declared part cannot be inspected.
- Commit-range target: requires explicit base and head revisions, reviews only the declared exact
  paths, requires all include flags to be false, and returns no commit receipt.
- Contradictory commit-range target: returns `INCONCLUSIVE` when any commit-range include flag is
  true or otherwise contradicts the declared mode.
- Receipt determinism: computes identical start and final receipts when the target is unchanged,
  returns `INCONCLUSIVE` when contents change during review, and returns a complete receipt only
  for an approved working-tree review.
- Staged stability: a receipt remains identical when the same working-tree contents move from
  unstaged to staged.
- Stale-review refusal: the committer refuses to stage when its fresh receipt differs from the
  reviewer receipt, and refuses to commit when the post-stage receipt differs.
- Severity and blocking: P0-P2 findings include `blocking: true` and produce `CHANGES_REQUESTED`;
  concrete P3 notes include `blocking: false` and may coexist with `APPROVED`; style preferences
  and speculation are omitted.
- Prior-finding continuity: every prior finding is classified as `resolved`, `still_present`, or
  `superseded` before new findings are reported.

## Workflow loop

- Two-cycle stopping: after an initial review, the parent performs at most two implementer-to-
  reviewer repair cycles, passes prior findings and resolution claims each time, and stops without
  commit when blocking findings remain after the second cycle.
- Approval plus P3: reviewer returns `APPROVED` with `optional_findings` and
  `STOPPED_APPROVED`; parent reports the P3 and asks the user, without invoking another agent or
  mutation tool.
- Spare-cycle capacity: an `APPROVED` result with unused repair-cycle capacity still stops at
  `STOPPED_APPROVED`; capacity does not authorize P3 work or another review.
- Unauthorized optional remediation: implementer receives optional/P3 IDs without matching explicit
  user authorization, returns `NEEDS_CONTEXT`, and leaves the worktree unchanged.
- Explicit linked follow-up: after explicit user approval, parent creates a new objective and
  exact scope with `workflow_create_linked_followup`, copying the exact findings and remediation
  context into a fresh cycle-0 workflow with a new review; it does not resume the prior repair loop.
- Approved plus commit authorization: after `APPROVED`, a separate explicit commit authorization
  still permits a `committer` dispatch for the reviewed scope when all review and receipt gates
  pass; it does not authorize optional-finding remediation or re-review.
- Reviewer schema consistency: reviewer findings use the exact handoff field names, including
  `file_and_line`, `failure_scenario`, `violated_requirement`, and
  `missing_or_inadequate_test`, in both finding lists.
- Trivial-edit exemption: a clearly trivial edit can proceed without the independent review loop,
  while commit authorization remains explicit and parent-owned.

## Receipt utility

- Modified tracked content: reports a metadata-only digest and `modified` state.
- New untracked content: reports `added` with a digest.
- Deleted tracked content: reports `deleted` with `missing` kind and no digest.
- Symlink handling: reports link kind, normalized mode, link-target digest, and target changes.
- Large tracked blob: reads a tracked file larger than four MiB and returns its expected digest
  without an arbitrary small-buffer failure.
- Deterministic ordering and staging: argument order does not affect the receipt, and staging does
  not change it.
- Invalid scope: rejects empty, duplicate, absolute, escaping, directory, unsupported, and absent
  untracked paths with closed error categories.

## Workflow-state MCP server

- Implementation state: `DONE` requires exact agent-touched paths, acceptance/validation evidence,
  a current complete receipt, and advances to `REVIEWING`; other statuses stop with deterministic
  phases and persist their status without falsely entering review.
- Repair continuity: repaired implementation requires every prior blocker resolution classification;
  reviewer re-review requires every prior blocking and optional classification, rejects missing IDs,
  and preserves `still_present` findings.
- Atomic linked follow-up: an injected child-insert failure leaves no child, parent mutation, or
  audit event; successful creation appends immutable child and parent events without updating audit
  rows. Competing parent versions yield one success and one closed conflict.

- Version conflict: a mutation with a stale `expected_version` returns a closed conflict and does
  not change state or append an audit event.
- Role capability denial: a valid capability used with another role is rejected, and capabilities
  never appear in `workflow_get` or `workflow_get_audit` responses.
- Receipt staleness: approved review and commit authorization reject changed content, base HEAD, or
  exact-path scope after the receipt was produced.
- Blocking cycle limit: repair authorization accepts only existing P0-P2 IDs and cannot exceed the
  configured maximum; the parent can finalize `STOPPED_REPAIR_EXHAUSTED` deterministically once the
  final cycle is reached.
- P3 stop: an approved review with concrete P3 findings becomes `STOPPED_APPROVED`; no repair is
  authorized until the parent creates a separately authorized linked follow-up.
- Linked follow-up workflow: `workflow_create_linked_followup` creates a cycle-0 child with a new
  ID, exact scope, copied findings, remediation context, and parent/source links from an approved or
  exhausted source workflow.
- Commit preparation: prepare binds the exact HEAD, index tree, paths, and review receipt, rejects
  empty/partial/extra/untracked staging, and never changes Git state or runs hooks.
- Commit result: a verified commit enters `COMMITTED`; an unchanged-HEAD failure enters the retryable
  `STOPPED_NOT_COMMITTED` stop; any verification mismatch enters the terminal `STOPPED_COMMIT_MISMATCH`
  with a deterministic category and no failure text retained.
- Restart durability: closing and reopening the store retains workflow state and append-only audit
  events without retaining plaintext capabilities.
- Protocol cleanliness: the STDIO child emits only valid MCP traffic on stdout; diagnostics remain
  closed and on stderr.
- Unavailable server: non-trivial workflows stop and ask whether prompt-only degraded mode is
  authorized; they never silently fall back.
- Bootstrap/reload: project config is committed, Codex is restarted, and a read-only tool-list and
  instructions check is completed before MCP is treated as authoritative; manual STDIO launch alone
  does not inject tools.
- Shutdown lifecycle: client disconnect, SIGINT, and SIGTERM close transport/store exactly once,
  exit promptly, preserve protocol cleanliness, and leave a reopenable database.

## OpenCode host adapter

Run in an installed OpenCode project (`.opencode/agents/` plus the `mcp.workflow_state` local
registration) after changing the orchestrator, installer, generator, or a canonical contract.

- Direct Orchestrator implementation: in a fresh Orchestrator session, submit a non-trivial request
  such as `Implement <issue>`. Confirm it performs only bounded read-only preflight, does not create
  source-level implementation TODOs or mutate repository files, creates or reuses the authoritative
  workflow, captures the exact `workflow_id`, and automatically delegates to `implementer` in the
  same turn with its capability and current `expected_version`; confirm the implementer's first
  authoritative action is `workflow_get` and that implementation occurs inside `implementer`.
- Plan -> Orchestrator execution: run `/plan <non-trivial issue>` in Plan, allow it to finish a
  detailed plan without creating an implementation workflow, switch to Orchestrator, and say
  `implement the plan`. Confirm Orchestrator does not perform a second planning pass or mutate files,
  creates or reuses the workflow, and automatically delegates the approved plan as execution context
  to `implementer` with the exact `workflow_id`, capability, and current `expected_version`.
- Build independence: switch to the built-in Build agent and confirm it no longer receives project
  instructions claiming it is the workflow orchestrator; Build remains available for deliberate
  ordinary direct coding.
- Orchestrator permissions: confirm `mode: primary`, `edit: deny`, fail-closed Task permissions that
  allow only `implementer`, `code_reviewer`, and `committer`, read-only repository inspection, no Git
  mutation commands, and only parent/orchestration `workflow_state` tools.
- Subagent loading: OpenCode loads `implementer`, `code_reviewer`, and `committer` from
  `.opencode/agents/` as `mode: subagent`, and Orchestrator can dispatch each without a manual
  `@implementer` invocation.
- MCP startup: OpenCode starts the `workflow_state` local server from the project config itself
  (no manual launch), and its tools are discoverable in a session.
- Shared state: a workflow created in Codex is readable by the OpenCode roles via `workflow_get`,
  and both hosts produce equivalent statuses/handoffs for the same scenarios.
- Implementer permissions: may edit and run validation, the host denies git add/commit/push/
  reset/rebase/checkout/switch/restore/revert/cherry-pick/rm/mv/clean/stash, and only its own
  workflow tools (`workflow_get`, `workflow_submit_implementation`) are exposed.
- Reviewer read-only: `edit: deny` holds, the bash allowlist covers `git status`/`diff`/`log`/
  `show`/`rev-parse` and `change-receipt.ts`, and mutation attempts (git add/commit, file writes)
  are blocked by the host or by the server's capability check; the review target is still fully
  inspectable and the full receipt flow completes.
- Committer gates: refuses to stage/commit without `commit_authorization` plus a fresh review
  receipt, stages only the authorized scope, cannot edit source files, and its bash fails closed
  with an allowlist for the documented commit flow (status/diff/log/show/rev-parse/ls-files,
  approved `git add`/`git commit`, and the receipt command) that denies push/amend/rebase/reset/
  checkout/switch/history rewriting and filesystem mutation.
- Host identity: each host's generated definition announces its own model in the identity line
  (Codex model plus reasoning effort; OpenCode Go provider/model ID), and the shared contract
  prose contains no host-specific model names.
- Tool exposure is defense in depth: restricting an agent's `workflow_state_*` tools never
  broadens server-side role capabilities, and a server-side capability denial still applies even
  if a host permission were relaxed.
- Contract parity: `bun run generate:agents` is idempotent and the checked-in Codex/OpenCode
  definitions remain byte-identical to its output.
- Terminal-response guarantee: after a successful terminal MCP submission
  (`workflow_submit_implementation`/`workflow_submit_review`/`workflow_submit_commit_result`) each
  OpenCode role still ends its invocation with a non-empty normal assistant text report (the
  role-specific "final implementation/review/commit report", required for the committer whether
  the commit succeeded or failed); the generator-appended section is absent from the Codex TOML.
- Default-agent installation policy: a new target or target config without `default_agent` starts in
  Orchestrator; an explicit existing `default_agent` is preserved while the Orchestrator definition
  is installed.

## Acceptance

An agent contract passes when every scenario produces the expected scope, mutation behavior, status,
and evidence without relying on the final prose alone. Record deviations before changing the prompt;
prefer the smallest instruction that corrects a reproduced failure.
