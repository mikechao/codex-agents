# Ordered Workflow-State MCP v2 Execution Checklist

Each checklist item produces one focused commit. Do not start the next item until its verification commands pass. Keep unrelated worktree changes out of every commit.

## Foundation

- [ ] **MCP-1.1 — Add explicit absent-path receipt support**
  - **Prerequisites:** None.
  - **Commit:** `feat(receipts): support explicitly absent workflow paths`
  - **Work:** Add an opt-in receipt mode for planned files that do not exist. Emit deterministic `state: "absent"` metadata without weakening default rejection of absent paths. Separate lexical path safety from existence checks.
  - **Tests:** “records explicitly allowed absent paths”; “default mode rejects absent paths”; existing receipt determinism, deletion, symlink, unsafe-path, and metadata-only tests.
  - **Verification:**
    ```sh
    node --test .codex/agents/tests/change-receipt.node.mjs
    pnpm test:agents
    ```
  - **Completion:** A workflow can establish a metadata-only baseline for a planned new file, while ordinary receipt calls still reject accidental missing paths.

- [ ] **MCP-1.2 — Introduce schema-v2 migration and complete audit envelopes**
  - **Prerequisites:** MCP-1.1.
  - **Commit:** `feat(workflow): migrate state and strengthen audit history`
  - **Work:** Add schema version 2 placeholders, transactional v1 migration, state digests, and sanitized audit envelopes. Migration must increment the optimistic version, append `WORKFLOW_MIGRATED`, preserve capability hashes, and never rewrite existing audit rows.
  - **Tests:** “migrates v1 state transactionally”; “migration preserves capabilities”; “migration increments version”; “audit rows remain append-only”; “migration failure rolls back”.
  - **Verification:**
    ```sh
    node --test .codex/workflow-mcp/tests/migration.node.mjs
    pnpm test:workflow-mcp
    ```
  - **Completion:** Reopening a v1 fixture yields readable v2 state and a new immutable migration event, with stale pre-migration versions rejected.

## Authoritative Handoffs

- [ ] **MCP-1.3 — Persist complete execution contracts and role views**
  - **Prerequisites:** MCP-1.2.
  - **Commit:** `feat(workflow): persist complete agent handoffs`
  - **Work:** Extend workflow creation with type, objective, scope, criteria, validation requirements, review target, and initial receipt. Assign stable `AC-*` and `VAL-*` IDs. Add role-specific `workflow_get` projections, current version, and permitted next actions.
  - **Tests:** “normalizes criteria and validation IDs”; “returns least-authority role views”; “never exposes capabilities”; “rejects unknown contract fields”; “persists complete handoff across restart”.
  - **Verification:**
    ```sh
    node --test --test-name-pattern='contract|role view|capabilit|restart' .codex/workflow-mcp/tests/workflow.node.mjs
    pnpm test:workflow-mcp
    ```
  - **Completion:** Each agent can obtain every required dispatch field from MCP state using only its workflow ID and role capability.

- [ ] **MCP-1.4 — Enforce complete implementation evidence and recovery**
  - **Prerequisites:** MCP-1.3.
  - **Commit:** `feat(workflow): enforce implementation outcomes and recovery`
  - **Work:** Require results for every `AC-*` and `VAL-*` ID. Derive `scope_changed_paths` from receipts and store self-reported `agent_touched_paths` separately. Add distinct stopped phases and parent-owned resume/accept-concerns transitions.
  - **Tests:** “DONE requires complete satisfied criteria”; “DONE requires passed validation”; “tracks dirty baseline separately”; “resumes missing context”; “resumes implementation blockage”; “accepts concerns only with authorization”; “repair exhaustion remains terminal”.
  - **Verification:**
    ```sh
    node --test --test-name-pattern='implementation|criteria|validation|resume|concern|repair' .codex/workflow-mcp/tests/workflow.node.mjs
    pnpm test:workflow-mcp
    ```
  - **Completion:** Incomplete evidence cannot enter review, recoverable stops retain one audit chain, and final changed scope is server-derived.

## Review and Follow-Up Flows

- [ ] **MCP-1.5 — Add standalone working-tree and commit-range reviews**
  - **Prerequisites:** MCP-1.4.
  - **Commit:** `feat(workflow): support standalone commit-range reviews`
  - **Work:** Allow `review_only` workflows to begin in `REVIEWING`. Validate commit existence, ancestry, exact historical paths, and mode-specific include flags. Working-tree approval may carry a receipt; commit-range approval must not.
  - **Tests:** “creates review-only workflow”; “accepts valid commit range”; “rejects non-ancestor range”; “validates paths from either Git tree”; “rejects commit-range receipt”; “rejects commit authorization for commit range”; “resumes inconclusive review”.
  - **Verification:**
    ```sh
    node --test --test-name-pattern='review.only|commit.range|inconclusive' .codex/workflow-mcp/tests/workflow.node.mjs
    pnpm test:workflow-mcp
    ```
  - **Completion:** Historical reviews are fully represented without depending on the current filesystem and cannot circularly become commit-authorizing working-tree reviews.

- [ ] **MCP-1.6 — Generalize linked finding follow-ups**
  - **Prerequisites:** MCP-1.5.
  - **Commit:** `feat(workflow): preserve findings in linked follow-ups`
  - **Work:** Replace optional-ID-only child creation with a linked-follow-up operation supporting explicitly authorized blocking or optional findings. Copy immutable finding details, source workflow ID, authorization, fresh current-HEAD scope, and cycle-zero remediation context into the child.
  - **Tests:** “copies complete optional findings”; “creates change workflow from commit-range findings”; “requires authorization”; “rejects unknown or mixed IDs”; “creates parent and child atomically”; “preserves parent terminal state”.
  - **Verification:**
    ```sh
    node --test --test-name-pattern='follow.up|linked|atomic|finding' .codex/workflow-mcp/tests/workflow.node.mjs
    pnpm test:workflow-mcp
    ```
  - **Completion:** A child implementer receives complete authorized findings from its own MCP view and never needs the parent workflow’s capability or prompt-carried finding text.

## Commit Protocol

- [ ] **MCP-1.7 — Implement two-phase commit state**
  - **Prerequisites:** MCP-1.6.
  - **Commit:** `feat(workflow): add two-phase commit recording`
  - **Work:** Add `workflow_prepare_commit` and `workflow_submit_commit_result`. Preparation verifies current HEAD, staged path equality, staged content, approved-path cleanliness, and receipt equality. Record successful, failed, and mismatched external commit outcomes. Add parent-owned retry for `STOPPED_NOT_COMMITTED`.
  - **Tests:** “prepares exact staged scope”; “rejects partial staging”; “rejects stale receipt”; “records successful commit”; “records hook failure”; “records commit mismatch terminally”; “retries non-committed result”; “does not retry mismatch”.
  - **Verification:**
    ```sh
    node --test --test-name-pattern='commit|staged|receipt|hook|mismatch' .codex/workflow-mcp/tests/workflow.node.mjs
    pnpm test:workflow-mcp
    ```
  - **Completion:** Every authorized commit attempt reaches an auditable terminal or retryable state, including cases where Git changes HEAD but verification fails.

## Contract Cutover and End-to-End Validation

- [ ] **MCP-1.8 — Cut agent contracts and documentation over to v2**
  - **Prerequisites:** MCP-1.7.
  - **Commit:** `docs(agents): adopt authoritative workflow state v2`
  - **Work:** Update `WORKFLOW.md`, all three TOML contracts, MCP README, and evaluation checklist. Remove duplicated prompt-state requirements, document role views and recovery, and make implementer handoff conditional for review-only workflows. Retain `workflow_record_commit` only for already-authorized legacy workflows.
  - **Tests:** TOML/config parsing; protocol tool-list schemas; searches for obsolete transition names and contradictory commit-range rules.
  - **Verification:**
    ```sh
    node --test .codex/workflow-mcp/tests/protocol.node.mjs
    rg -n 'workflow_record_commit|STOPPED_BLOCKED|optional-ID-only' .codex/agents .codex/workflow-mcp
    pnpm test
    ```
  - **Completion:** Documentation, agent behavior, exposed tools, and server transitions describe one consistent protocol with no prompt-only authoritative fields.

- [ ] **MCP-1.9 — Add end-to-end protocol and migration coverage**
  - **Prerequisites:** MCP-1.8.
  - **Commit:** `test(workflow): cover v2 agent lifecycle end to end`
  - **Work:** Add protocol-level scenarios for change, repair, review-only, linked follow-up, two-phase commit, restart, migration, capability denial, and stdout cleanliness. Update `EVAL_RESULTS.md` only for evaluations actually executed.
  - **Tests:** “complete change lifecycle”; “bounded repair lifecycle”; “commit-range-to-linked-change lifecycle”; “two-phase commit lifecycle”; “restart and migration lifecycle”; “STDIO remains protocol-clean”.
  - **Verification:**
    ```sh
    pnpm test:agents
    pnpm test:workflow-mcp
    pnpm test
    git diff --check
    git status --short
    ```
  - **Completion:** All automated suites pass, `pnpm test` succeeds as required by `AGENTS.md`, no protocol output leaks to stdout, and the final worktree contains only the intended task changes.
