# Workflow-State MCP v2 Implementation Specification

This is the ordered implementation plan for workflow-state MCP v2. It is intentionally explicit:
each task must be implementable by a low-context, Flash-class subagent without inventing protocol
behavior.

Tasks are sequential. A subagent implements exactly one task, changes only its owned files, runs
focused and common verification, and returns the worktree for review. The parent makes the listed
commit only after review. Do not implement later-task behavior early. `WORKFLOW.md` and current code
remain authoritative for untouched v1 behavior until the documentation cutover.

## Global rules

- Keep Node 22+, ESM, `node:sqlite`, and the existing MCP SDK; add no runtime dependency.
- Keep the repository-local STDIO server silent on stdout except for MCP protocol output. Runtime
  SQLite remains outside the repository; tests use explicit temporary databases.
- All paths are exact repository-relative files. Reject absolute paths, backslashes, NULs, dot
  segments, globs, duplicates, directories, and symlink-parent escapes.
- Request objects reject unknown fields. Preserve current bounds: 200 paths/findings, 50 evidence
  items, 4,000-character objectives/summaries, and 2,000-character details/authorizations.
- Each mutation authenticates its owning role, checks `expected_version`, uses one
  `BEGIN IMMEDIATE` transaction, increments version exactly once, and appends exactly one event.
  Linked creation is the documented two-workflow exception. Failure changes no state or audit.
- Errors use safe `ERROR_*` responses and never expose capabilities, hashes, SQL, stack traces, Git
  stderr, receipts, findings, objectives, or authorization text.
- Capabilities are returned once and stored only as SHA-256 hashes. Migration never rotates them.
- Sort persisted path and ID sets lexicographically. Keep criteria/validation caller order.
- Use `canonicalJson`/`objectDigest` for protocol equality/digests, not raw `JSON.stringify`.
- Public revisions are full lowercase 40-character commit IDs, not arbitrary Git objects.
- Preserve unrelated changes; do not format or refactor outside task scope.

Every task runs its focused checks and then:

```sh
pnpm test
git diff --check
git status --short
```

`git status --short` must show only owned files plus pre-existing changes recorded before work.
Never update `EVAL_RESULTS.md` for an evaluation not actually executed.

## Normative v2 contract

### Common requests and receipt extension

Existing-workflow mutations contain `workflow_id` (UUID), `capability` (64 lowercase hex), and
`expected_version` (non-negative safe integer). Reads contain `workflow_id`, `capability`, and
`role`.

Receipt schema stays version 1. With explicit absent support, a path absent from both `HEAD` and
the worktree has exactly this entry, without `mode` or `digest`:

```json
{"path":"new/file.txt","state":"absent","kind":"missing"}
```

The entry participates in `overall_scope_hash`. Default calls still reject it with
`ERROR_UNTRACKED_PATH`. A tracked missing path remains `deleted`.

### Review targets and creation

The exact review target is:

```yaml
review_mode: working_tree | commit_range
base_revision: <full commit ID>
head_revision: <null for working_tree; full commit ID for commit_range>
approved_paths: [<sorted exact paths>]
include_staged: <true only for working_tree>
include_unstaged: <true only for working_tree>
include_untracked: <true only for working_tree>
```

Working-tree base must equal current `HEAD`; head is null and all flags are true. Commit-range base
and head are distinct commits, base is an ancestor of head, and all flags are false. Each approved
path must be a blob at one or both endpoint trees. Deletions may exist only at base and additions
only at head. Directories/submodules are invalid. Renames have no special meaning: authorize exact
old and new paths when both matter.

`workflow_create` accepts exactly:

```yaml
workflow_type: change | review_only
objective: <non-empty string>
approved_paths: [<one or more exact paths>]
acceptance_criteria: [<one or more non-empty strings>]
validation_requirements: [<at least one for change; may be empty for review_only>]
review_target: <complete target>
max_repair_cycles: <optional 0..2, default 2>
```

Top-level and target paths must match. `change` permits only working-tree and starts
`IMPLEMENTING`; `review_only` permits either target and starts `REVIEWING`. The server assigns
caller-order objects `{criterion_id:"AC-001", description}` and
`{validation_id:"VAL-001", description}`, incrementing three-digit IDs. It accepts no caller IDs;
duplicate descriptions get distinct IDs; over 999 is invalid; IDs never change.

Working-tree creation persists a server-computed `initial_receipt` with absent allowed.
Commit-range stores null. `dirty_baseline_paths` is the sorted initial paths in `added`, `modified`,
or `deleted`; `absent`/`unchanged` are not dirty.

### Complete persisted state

Every v2 state has all keys below; unproduced values use the shown empty value, never omission:

```yaml
schema_version: 2
version: <row version>
workflow_id: <UUID>
workflow_type: change | review_only
legacy_v1: <boolean>
phase: <phase>
objective: <string>
base_head: <working-tree HEAD or range base>
approved_paths: []
acceptance_criteria: []
validation_requirements: []
review_target: <target>
initial_receipt: <receipt or null>
dirty_baseline_paths: []
repair_cycle: 0
max_repair_cycles: 2
parent_workflow_id: <UUID or null>
source_workflow_id: <UUID or null>
linked_findings: []
remediation_context: <object or null>
implementation_summary: <string or null>
implementation_status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED | null
agent_touched_paths: []
scope_changed_paths: []
acceptance_results: []
validation_results: []
implementation_receipt: <receipt or null>
implementation_known_failures: []
finding_resolution_map: {}
prior_finding_classifications: {}
blocking_findings: []
optional_findings: []
review_receipt: <receipt or null>
stop_context: <object or null>
recovery_context: <object or null>
repair_authorized_ids: []
concern_acceptance: <object or null>
commit_authorization: <object or null>
commit_preparation: <object or null>
commit_result: <object or null>
```

Linked remediation context is exactly `{policy:"explicitly_authorized",
authorized_finding_ids:[...], repair_cycle:0, user_authorization:<string>}`. Migration alone may
add `legacy_evidence`; final new workflows never do. To keep `pnpm test` passing between sequential
cutovers, MCP-2.1 through MCP-4.1 may also carry the v1 compatibility keys
`implementation_changed_paths`, `implementation_acceptance_evidence`,
`implementation_validation_evidence`, `authorized_optional_ids`, and
`user_authorization_summary`. MCP-2.1 initializes them exactly as v1 does, existing v1 operations
continue updating them, and MCP-4.1 removes them from every `legacy_v1:false` state when it cuts
submission over. MCP-6.1 removes the final optional-follow-up aliases. These temporary keys are
included in state digests/audit changed fields and are never part of the final public role views.

### Phases and operations

```text
IMPLEMENTING, REVIEWING, REPAIR_REQUIRED, REPAIRING,
STOPPED_CONCERNS, STOPPED_NEEDS_CONTEXT, STOPPED_IMPLEMENTATION_BLOCKED,
STOPPED_INCONCLUSIVE, STOPPED_APPROVED, STOPPED_REPAIR_EXHAUSTED,
COMMIT_AUTHORIZED, COMMIT_PREPARED, STOPPED_NOT_COMMITTED,
STOPPED_COMMIT_MISMATCH, COMMITTED
```

| Tool | Owner | Source | Target |
|---|---|---|---|
| `workflow_submit_implementation` | implementer | implementing/repairing | status-dependent |
| `workflow_resume_implementation` | parent | implementation context/block stops | prior active phase |
| `workflow_accept_concerns` | parent | concerns stop | reviewing |
| `workflow_submit_review` | reviewer | reviewing | status-dependent |
| `workflow_resume_review` | parent | inconclusive stop | reviewing |
| `workflow_authorize_repair` | parent | repair required | repairing |
| `workflow_finalize_repair_exhausted` | parent | exhausted repair required | terminal exhaustion |
| `workflow_create_linked_followup` | parent | approved/exhausted stop | parent unchanged; child implementing |
| `workflow_authorize_commit` | parent | eligible approved stop | commit authorized |
| `workflow_prepare_commit` | committer | commit authorized | commit prepared |
| `workflow_submit_commit_result` | committer | commit prepared | outcome-dependent |
| `workflow_retry_commit` | parent | not committed | commit authorized |
| `workflow_record_commit` | committer | migrated authorized v1 only | committed/mismatch |

Terminal phases are `STOPPED_REPAIR_EXHAUSTED`, `STOPPED_COMMIT_MISMATCH`, and `COMMITTED`.

### Implementation and recovery schemas

`workflow_submit_implementation` adds exactly:

```yaml
status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
summary: <non-empty string>
agent_touched_paths: [<approved paths>]
acceptance_results: [{criterion_id, status: satisfied | not_satisfied, evidence: <string>}]
validation_results: [{validation_id, status: passed | failed | not_run, evidence: <string>}]
implementation_receipt: <current complete receipt>
known_failures: [<strings>]
finding_resolution_map: {<every preceding blocker ID>: resolved | still_present | superseded}
```

Every contract ID appears exactly once in contract order. The resolution map exactly covers the
immediately preceding blockers and is empty initially. The server recomputes an absent-aware
receipt covering exact approved paths/base. It derives `scope_changed_paths` by comparing final to
initial entries after removing only `state`; existence, kind, mode, or digest difference means
changed. Thus unchanged dirty baseline is not attributed, while absent-to-added is. Agent-touched
paths are a separate self-report subset of approved scope.

`DONE` requires every criterion satisfied, every validation passed, and no known failures, then
enters review. Other statuses enter their corresponding stop and store
`{status,summary,stopped_from}`. Resume accepts `resume_context`, restores `stopped_from`, clears
the stop, preserves repair state/evidence, and stores
`recovery_context:{kind:"implementation",context:resume_context,recovered_at:<ISO>}`. Accept concerns
requires `user_authorization`, stores
`concern_acceptance:{user_authorization,accepted_at:<ISO>}`, and enters review without rewriting
failed evidence. Concern acceptance never implies commit authorization.

### Review, role views, follow-ups, commit, and audit

Finding/resolution schemas remain v1. Submitted target must canonically equal persisted target.
`CHANGES_REQUESTED` requires blockers/no receipt and enters repair-required. `INCONCLUSIVE`
requires no receipt and enters its stop. `APPROVED` requires no blockers and enters approved;
working-tree approval requires a fresh receipt, commit-range requires null. `INCONCLUSIVE` stores
`stop_context:{status:"INCONCLUSIVE",summary:"review context unavailable",stopped_from:"REVIEWING"}`.
Review resume accepts `resume_context` and stores
`recovery_context:{kind:"review",context:resume_context,recovered_at:<ISO>}`. Repair increments the
cycle once; when cycle equals max only terminal
finalization is allowed.

`workflow_get` always returns `workflow_id`, `schema_version`, `version`, `workflow_type`, `phase`,
`objective`, `approved_paths`, `repair_cycle`, `max_repair_cycles`, `review_target`, and sorted
`permitted_next_actions`. Parent additionally gets every persisted field except `legacy_evidence`
and temporary compatibility aliases. Implementer additionally gets `acceptance_criteria`,
`validation_requirements`, `initial_receipt`, `dirty_baseline_paths`, `linked_findings`,
`remediation_context`, every `implementation_*` final field, `agent_touched_paths`,
`scope_changed_paths`, both result arrays, `finding_resolution_map`, `blocking_findings`,
`repair_authorized_ids`, `stop_context`, and `recovery_context`. Reviewer additionally gets
criteria/validations, `dirty_baseline_paths`, all final implementation evidence/results,
`concern_acceptance`, both finding buckets, classifications, resolution map, review receipt, stop
and recovery context; it omits initial receipt. Committer additionally gets criteria/validations,
derived paths, implementation results/failures, concern acceptance, both finding buckets,
classifications, review receipt, commit authorization/preparation/result, stop and recovery context;
it omits initial receipt. Fields named here are present with null/empty values. No view exposes
capabilities/hashes/audits. Actions are computed from the table for that role/phase.

Linked creation accepts objective, approved paths, criteria, validations, `finding_ids`, and
`user_authorization`. Source is approved or repair-exhausted. IDs are unique, known, and all from
one bucket. Child is fresh-HEAD working-tree `change`, cycle 0; it copies full finding objects,
source/parent IDs, and remediation context. Parent increments once without phase/finding change;
child starts version 0. Both rows/events commit atomically.

Commit authorization is valid only for approved working-tree workflows with receipt; range fails
`ERROR_COMMIT_NOT_ALLOWED`. After external full-file staging, prepare checks HEAD/base, fresh
receipt, global staged set equals receipt changed paths, no approved unstaged/untracked residue,
staged modes/digests/existence equal receipt, and nonempty staging. Errors are
`ERROR_STALE_RECEIPT`, `ERROR_STAGED_SCOPE`, or `ERROR_STAGED_CONTENT` without mutation. Success
persists `{attempt_id,prepared_head,prepared_tree,expected_paths,review_receipt_digest,prepared_at}`
using `git write-tree`; server never changes Git state.

Commit result adds `attempt_id`, `outcome: committed|not_committed`, `commit_hash`, and
`failure_summary`. Committed requires current HEAD/hash, one parent/prepared head, prepared tree,
and exact paths, then `COMMITTED`. Verification failure enters terminal mismatch. Not-committed
requires null hash/nonempty failure; unchanged HEAD enters retryable stop, changed HEAD enters
mismatch. Retry accepts `retry_context`, preserves authorization, clears attempt/result, and stores
`recovery_context:{kind:"commit",context:retry_context,recovered_at:<ISO>}`. Mismatch
stores only category `HEAD_CHANGED`, `PARENT_MISMATCH`, `TREE_MISMATCH`, or `PATH_MISMATCH`.
Commit authorization is exactly `{user_authorization,authorized_at:<ISO>}`. Successful result is
exactly `{outcome:"committed",commit_hash,failure_summary:null}`; unchanged-HEAD failure is exactly
`{outcome:"not_committed",commit_hash:null,failure_summary}`; mismatch is exactly
`{outcome:"mismatch",mismatch_category}`.
When multiple checks fail, mismatch category priority is `HEAD_CHANGED`, then `PARENT_MISMATCH`,
then `TREE_MISMATCH`, then `PATH_MISMATCH`, so the persisted outcome is deterministic. Migrated
legacy rows that were not already `COMMIT_AUTHORIZED` at migration cannot newly authorize a commit;
`workflow_authorize_commit` returns `ERROR_LEGACY_WORKFLOW` for them.

`workflows.state_digest` equals `objectDigest(parsed state_json)` and is verified on read/write.
New audit summaries are exactly `{schema_version:2,phase_before,phase_after,state_digest_before,
state_digest_after,changed_fields,linked_workflow_id,outcome}`. Changed fields are sorted top-level
keys excluding version. Envelopes contain no free user text, findings, paths, receipts, Git stderr,
or capabilities. Old audit rows remain byte-for-byte unchanged and are returned unsynthesized.

## Ordered tasks

### Receipt and storage foundation

- [ ] **MCP-1.1 — Separate receipt path safety from inspection**
  - **Prerequisites/commit:** none; `refactor(receipts): separate path safety from inspection`.
  - **Owned:** `.codex/agents/change-receipt.mjs`, `.codex/agents/tests/change-receipt.node.mjs`.
  - **Implement:** split lexical normalization from filesystem/Git metadata inspection. Lexical
    validation runs first. Preserve exported `createReceipt(inputs, cwd)`, CLI, JSON, schema, and
    every accepted/rejected v1 behavior.
  - **Do not:** add absent mode or weaken symlink-parent checks.
  - **Tests:** all existing cases plus unsafe nonexistent path returns `ERROR_UNSAFE_PATH`, not an
    existence-dependent error.
  - **Focused:** `node --test .codex/agents/tests/change-receipt.node.mjs`.
  - **Done:** path safety is independently testable with byte-compatible v1 receipts.

- [ ] **MCP-1.2 — Add explicit absent-path receipt mode**
  - **Prerequisites/commit:** MCP-1.1; `feat(receipts): support explicitly absent workflow paths`.
  - **Owned:** `.codex/agents/change-receipt.mjs`,
    `.codex/agents/tests/change-receipt.node.mjs`.
  - **Implement:** library becomes `createReceipt(inputs, cwd = process.cwd(), options = {})`,
    accepting only `{allowAbsent:boolean}` and defaulting false. CLI is
    `--allow-absent -- path...`; it permits that flag once and no other pre-separator arguments.
    Unknown/duplicate options give `ERROR_INVALID_ARGUMENTS`. Emit the normative absent entry;
    tracked missing remains deleted.
  - **Tests:** library/CLI opt-in success and default rejection; mixed paths sort; hash deterministic;
    deletion, addition, symlink, unsafe, metadata-only, and stdout/stderr behavior remain covered.
  - **Focused:** `node --test .codex/agents/tests/change-receipt.node.mjs && pnpm test:agents`.
  - **Done:** absent support is deterministic and cannot be enabled accidentally.

- [ ] **MCP-2.1 — Add complete v2 state construction and digest storage**
  - **Prerequisites/commit:** MCP-1.2; `feat(workflow): add digest-backed v2 state storage`.
  - **Owned:** `.codex/workflow-mcp/transitions.mjs`, `.codex/workflow-mcp/store.mjs`,
    `.codex/workflow-mcp/validation.mjs`,
    `.codex/workflow-mcp/tests/workflow.node.mjs`.
  - **Implement:** set schema 2 and construct every normative state key. Temporarily adapt the v1
    public creation call internally as a `change` with empty contract lists and synthesized
    working-tree target/initial receipt so MCP-3.1 can cut the public schema later. Initialize and
    preserve the documented temporary compatibility keys so every existing v1 transition/test
    continues to work until its cutover. Add
    `state_digest`: detect with `PRAGMA table_info`, `ALTER TABLE` nullable for old DBs, require it
    for new inserts/updates, and verify it on reads. An old null-digest row yields
    `ERROR_MIGRATION_REQUIRED` until MCP-2.2.
  - **Tests:** exact new-state keys/defaults; correct digest; JSON/digest tampering rejected; failed
    mutation preserves JSON/digest.
  - **Focused:** `node --test --test-name-pattern='schema|digest|corrupt' .codex/workflow-mcp/tests/workflow.node.mjs && pnpm test:workflow-mcp`.
  - **Done:** every newly inserted row is a complete digest-protected v2 row.

- [ ] **MCP-2.2 — Migrate v1 rows transactionally**
  - **Prerequisites/commit:** MCP-2.1; `feat(workflow): migrate v1 workflow state`.
  - **Owned:** `.codex/workflow-mcp/store.mjs`, `.codex/workflow-mcp/transitions.mjs`,
    `.codex/workflow-mcp/tests/migration.node.mjs`.
  - **Implement:** during store open, migrate all schema-1 rows in one immediate transaction before
    serving calls. Map them to complete state with `legacy_v1:true`, `workflow_type:change`,
    synthesized working-tree target, null initial receipt, empty contract lists, and
    `legacy_evidence:{acceptance_evidence,validation_evidence}`. Map old changed paths to both
    `agent_touched_paths` and `scope_changed_paths`; map summary/status/receipt/known failures,
    resolution/classification/finding/review/commit fields directly; initialize all genuinely new
    fields to their normative empty values. Map `STOPPED_BLOCKED` with
    `implementation_status:"BLOCKED"` to `STOPPED_IMPLEMENTATION_BLOCKED`; map any other
    `STOPPED_BLOCKED` to `STOPPED_REPAIR_EXHAUSTED`; preserve other phases. Unknown/malformed schemas fail
    `ERROR_STATE_CORRUPT` and roll back the batch. Each row increments N->N+1, receives digest, and
    appends one `WORKFLOW_MIGRATED` v2 envelope. Never alter old audits/capability hashes. Add
    test-only `faultAfterMigrationUpdate` after first update/before event.
  - **Tests:** one/multiple fixtures; phase/evidence mapping; capability preservation; version/stale
    check; old audits identical; injected rollback; reopen idempotent/no second event.
  - **Focused:** `node --test .codex/workflow-mcp/tests/migration.node.mjs && pnpm test:workflow-mcp`.
  - **Done:** valid v1 databases reopen as v2 with one immutable migration event per row.

- [ ] **MCP-2.3 — Standardize sanitized audit envelopes**
  - **Prerequisites/commit:** MCP-2.2; `feat(workflow): strengthen audit event envelopes`.
  - **Owned:** `.codex/workflow-mcp/store.mjs`,
    `.codex/workflow-mcp/tests/workflow.node.mjs`,
    `.codex/workflow-mcp/tests/migration.node.mjs`.
  - **Implement:** all new creation/mutation events use the normative envelope. Compute changed
    fields by canonical comparison over unioned top-level keys, excluding version. Creation lists
    every state key except version. Link IDs only on linked events; outcome only on migration,
    stops, review, and commit results; otherwise null. Preserve legacy rows exactly on reads.
  - **Tests:** exact keys/sorted fields; digest continuity; serialized audits contain none of the
    prohibited data; append-only history.
  - **Focused:** `node --test --test-name-pattern='audit|digest|append' .codex/workflow-mcp/tests/{workflow,migration}.node.mjs && pnpm test:workflow-mcp`.
  - **Done:** v2 events form a sanitized digest chain.

### Contracts, evidence, and recovery

- [ ] **MCP-3.1 — Expose complete v2 change-workflow creation**
  - **Prerequisites/commit:** MCP-2.3; `feat(workflow): persist complete execution contracts`.
  - **Owned:** `.codex/workflow-mcp/server.mjs`, `.codex/workflow-mcp/store.mjs`,
    `.codex/workflow-mcp/transitions.mjs`, `.codex/workflow-mcp/validation.mjs`,
    `.codex/workflow-mcp/git.mjs`, `.codex/workflow-mcp/tests/workflow.node.mjs`,
    `.codex/workflow-mcp/tests/protocol.node.mjs`.
  - **Implement:** replace public create schema with the normative one, normalize IDs, persist
    target/absent-aware initial receipt/dirty baseline. In this task accept only `change` plus
    working-tree; return `ERROR_UNSUPPORTED_WORKFLOW_TYPE` for review-only/range until MCP-5.2.
    Remove the old shorthand from all owned test callers. Unknown/missing fields are invalid.
  - **Tests:** exact tool schema; IDs/order/duplicate descriptions; unknown fields; target/path/base
    mismatch; planned absent; dirty baseline; restart contract persistence.
  - **Focused:** `node --test --test-name-pattern='create|contract|criteria|validation|baseline|restart' .codex/workflow-mcp/tests/{workflow,protocol}.node.mjs && pnpm test:workflow-mcp`.
  - **Done:** every new change workflow contains a complete stable handoff.

- [ ] **MCP-3.2 — Add least-authority role views and actions**
  - **Prerequisites/commit:** MCP-3.1; `feat(workflow): return role-specific workflow views`.
  - **Owned:** `.codex/workflow-mcp/store.mjs`, `.codex/workflow-mcp/transitions.mjs`,
    `.codex/workflow-mcp/server.mjs`, `.codex/workflow-mcp/tests/workflow.node.mjs`,
    `.codex/workflow-mcp/tests/protocol.node.mjs`.
  - **Implement:** implement the exact role matrix and pure `permittedNextActions(state, role)`.
    Create returns parent projection plus capabilities; get returns authenticated projection only;
    audit remains separate. No raw-state public path.
  - **Tests:** exact role keys across representative phases; sorted actions; no excluded/capability
    field in serialized views; restart version; cross-role token denial.
  - **Focused:** `node --test --test-name-pattern='role view|projection|permitted|capabil' .codex/workflow-mcp/tests/{workflow,protocol}.node.mjs && pnpm test:workflow-mcp`.
  - **Done:** each role receives all and only its authoritative dispatch data.

- [ ] **MCP-4.1 — Enforce ID-addressed implementation evidence**
  - **Prerequisites/commit:** MCP-3.2; `feat(workflow): enforce complete implementation evidence`.
  - **Owned:** `.codex/workflow-mcp/server.mjs`, `.codex/workflow-mcp/store.mjs`,
    `.codex/workflow-mcp/transitions.mjs`, `.codex/workflow-mcp/validation.mjs`,
    `.codex/workflow-mcp/tests/workflow.node.mjs`,
    `.codex/workflow-mcp/tests/protocol.node.mjs`.
  - **Implement:** replace v1 submission fields with normative evidence, exact ID/status validation,
    fresh absent-aware receipt, baseline comparison, separate touched paths, and DONE gates.
    Migrated workflows with empty contracts cannot submit new implementation and receive
    `ERROR_LEGACY_WORKFLOW`; an active migrated implementation must be replaced by a newly created
    v2 workflow. Migrated rows already beyond implementation remain readable and may use only
    operations valid for their current phase, including the later legacy commit compatibility.
  - **Tests:** missing/duplicate/unknown/reordered IDs; every status; failed/not-run validation and
    known failures block DONE; touched subset; unchanged dirty baseline excluded; absent-to-added
    included; self-report cannot control derived scope; stale receipt/restart.
  - **Focused:** `node --test --test-name-pattern='implementation|criterion|validation|touched|baseline|receipt' .codex/workflow-mcp/tests/{workflow,protocol}.node.mjs && pnpm test:workflow-mcp`.
  - **Done:** only complete evidence enters review and changed scope is server-derived.

- [ ] **MCP-4.2 — Add implementation stops, resume, and concern acceptance**
  - **Prerequisites/commit:** MCP-4.1; `feat(workflow): add implementation recovery transitions`.
  - **Owned:** `.codex/workflow-mcp/server.mjs`, `.codex/workflow-mcp/store.mjs`,
    `.codex/workflow-mcp/transitions.mjs`, `.codex/workflow-mcp/tests/workflow.node.mjs`,
    `.codex/workflow-mcp/tests/protocol.node.mjs`.
  - **Implement:** add three normative stops/stop context; parent
    `workflow_resume_implementation` (common + `resume_context`) and
    `workflow_accept_concerns` (common + `user_authorization`). Events are
    `IMPLEMENTATION_STOPPED`, `IMPLEMENTATION_RESUMED`, `CONCERNS_ACCEPTED`.
  - **Tests:** stop/resume from initial and repair; exact source restoration; repair continuity;
    wrong role/phase/version; concerns need authorization and retain failures; terminals cannot
    resume.
  - **Focused:** `node --test --test-name-pattern='stop|resume|context|concern|continuity' .codex/workflow-mcp/tests/{workflow,protocol}.node.mjs && pnpm test:workflow-mcp`.
  - **Done:** recoverable stops preserve one audit chain without weakening terminals.

### Review modes and linked follow-ups

- [ ] **MCP-5.1 — Add exact historical Git target helpers**
  - **Prerequisites/commit:** MCP-4.2; `feat(workflow): validate historical review targets`.
  - **Owned:** `.codex/workflow-mcp/git.mjs`, `.codex/workflow-mcp/tests/git.node.mjs`.
  - **Implement:** read-only helpers for commit verification, ancestry, and endpoint blob metadata.
    Apply all normative range/path rules. Map invalid/non-commit IDs to
    `ERROR_INVALID_REVISION`, ancestry to `ERROR_NON_ANCESTOR`, endpoint/path errors to
    `ERROR_INVALID_REVIEW_PATH`; never leak stderr.
  - **Tests:** valid/reversed/equal/unknown/non-commit ranges; unchanged/added/deleted/modified;
    absent both endpoints; directory/submodule; both rename paths; unsafe path.
  - **Focused:** `node --test .codex/workflow-mcp/tests/git.node.mjs && pnpm test:workflow-mcp`.
  - **Done:** historical targets validate without current-filesystem dependence.

- [ ] **MCP-5.2 — Enable review-only working-tree and range workflows**
  - **Prerequisites/commit:** MCP-5.1; `feat(workflow): support standalone review workflows`.
  - **Owned:** `.codex/workflow-mcp/server.mjs`, `.codex/workflow-mcp/store.mjs`,
    `.codex/workflow-mcp/transitions.mjs`, `.codex/workflow-mcp/validation.mjs`,
    `.codex/workflow-mcp/git.mjs`, `.codex/workflow-mcp/tests/workflow.node.mjs`,
    `.codex/workflow-mcp/tests/protocol.node.mjs`.
  - **Implement:** enable both normative review-only cases in creation. Start reviewing; working
    tree stores initial receipt, range stores null. Require canonical submitted target equality.
    Working approval alone requires receipt; range approval requires null. Reviewer views omit
    nonexistent implementer handoff; do not synthesize one.
  - **Tests:** both modes; flags; commit/path/ancestry errors; additions/deletions; range receipt
    rejected; working receipt required; range commit authorization rejected; restart/actions.
  - **Focused:** `node --test --test-name-pattern='review.only|commit.range|historical|receipt|authorization' .codex/workflow-mcp/tests/{workflow,protocol}.node.mjs && pnpm test:workflow-mcp`.
  - **Done:** historical reviews are self-contained and cannot authorize commits.

- [ ] **MCP-5.3 — Add review resume and terminal repair exhaustion**
  - **Prerequisites/commit:** MCP-5.2; `feat(workflow): add review recovery transitions`.
  - **Owned:** `.codex/workflow-mcp/server.mjs`, `.codex/workflow-mcp/store.mjs`,
    `.codex/workflow-mcp/transitions.mjs`, `.codex/workflow-mcp/tests/workflow.node.mjs`,
    `.codex/workflow-mcp/tests/protocol.node.mjs`.
  - **Implement:** add parent `workflow_resume_review` (common + `resume_context`). Rename
    `workflow_finalize_blocked` to `workflow_finalize_repair_exhausted`; target
    `STOPPED_REPAIR_EXHAUSTED`; remove `STOPPED_BLOCKED` from new schemas/actions. Events are
    `REVIEW_RESUMED` and `REPAIR_EXHAUSTED`.
  - **Tests:** resume both review modes; context/role/phase/version errors; finalization only when
    cycle equals max; remaining cycle rejected; exhaustion cannot resume/commit.
  - **Focused:** `node --test --test-name-pattern='inconclusive|resume.review|repair.exhaust|terminal' .codex/workflow-mcp/tests/{workflow,protocol}.node.mjs && pnpm test:workflow-mcp`.
  - **Done:** inconclusive reviews recover, while exhausted blockers stop distinctly and terminally.

- [ ] **MCP-6.1 — Replace optional children with linked finding follow-ups**
  - **Prerequisites/commit:** MCP-5.3; `feat(workflow): preserve findings in linked follow-ups`.
  - **Owned:** `.codex/workflow-mcp/server.mjs`, `.codex/workflow-mcp/store.mjs`,
    `.codex/workflow-mcp/transitions.mjs`, `.codex/workflow-mcp/validation.mjs`,
    `.codex/workflow-mcp/tests/workflow.node.mjs`,
    `.codex/workflow-mcp/tests/protocol.node.mjs`.
  - **Implement:** remove `workflow_create_optional_followup`; add normative
    `workflow_create_linked_followup`, complete immutable finding copy, links/remediation context,
    fresh HEAD/receipt/target/contracts, and atomic parent/child transaction. Rename injection to
    `faultAfterLinkedChildInsert`. Child event `WORKFLOW_CREATED` links source; parent event
    `LINKED_FOLLOWUP_CREATED` links child; neither leaks finding/auth text.
  - **Tests:** optional and exhausted blocker copies; child from range; unknown/duplicate/mixed IDs;
    missing auth/bad phase; absent child path; parent unchanged except version; self-contained child
    implementer view; injected rollback includes both audits.
  - **Focused:** `node --test --test-name-pattern='follow.up|linked|atomic|finding|authorization' .codex/workflow-mcp/tests/{workflow,protocol}.node.mjs && pnpm test:workflow-mcp`.
  - **Done:** child implementation needs no source capability or prompt-carried finding text.

### Two-phase external commit

- [ ] **MCP-7.1 — Verify staged state and prepare a commit**
  - **Prerequisites/commit:** MCP-6.1; `feat(workflow): prepare receipt-gated commits`.
  - **Owned:** `.codex/workflow-mcp/git.mjs`, `.codex/workflow-mcp/server.mjs`,
    `.codex/workflow-mcp/store.mjs`, `.codex/workflow-mcp/transitions.mjs`,
    `.codex/workflow-mcp/tests/git.node.mjs`,
    `.codex/workflow-mcp/tests/workflow.node.mjs`,
    `.codex/workflow-mcp/tests/protocol.node.mjs`.
  - **Implement:** helpers for global staged paths, approved cleanliness, staged entries/digests,
    and `write-tree`; add normative `workflow_prepare_commit`/`COMMIT_PREPARED`. Enforce eligible
    working-tree authorization. Do not submit results yet; prepared is temporarily terminal.
  - **Tests:** modify/add/delete/mode success; empty/partial/extra/unrelated staging; unstaged or
    untracked residue; stale receipt; content/mode mismatch; changed HEAD; range denial; exact
    preparation fields; server leaves Git untouched and executes no hooks.
  - **Focused:** `node --test --test-name-pattern='stage|prepare|receipt|tree|commit authorization' .codex/workflow-mcp/tests/{git,workflow,protocol}.node.mjs && pnpm test:workflow-mcp`.
  - **Done:** preparation binds authorization to exact HEAD, index tree, paths, and receipt.

- [ ] **MCP-7.2 — Record success and retryable non-commit outcomes**
  - **Prerequisites/commit:** MCP-7.1; `feat(workflow): record external commit outcomes`.
  - **Owned:** `.codex/workflow-mcp/git.mjs`, `.codex/workflow-mcp/server.mjs`,
    `.codex/workflow-mcp/store.mjs`, `.codex/workflow-mcp/transitions.mjs`,
    `.codex/workflow-mcp/tests/workflow.node.mjs`,
    `.codex/workflow-mcp/tests/protocol.node.mjs`.
  - **Implement:** normative `workflow_submit_commit_result`, successful verification, unchanged-
    HEAD `STOPPED_NOT_COMMITTED`, and parent `workflow_retry_commit` (common + `retry_context`).
    Events: `COMMIT_RESULT_SUBMITTED` outcomes `committed`/`not_committed`; and
    `COMMIT_RETRY_AUTHORIZED` outcome `retry`.
  - **Tests:** valid single-parent success; attempt ID and field combinations; hook/command failure
    with unchanged HEAD; bounded failure retained in state but absent audit; retry clears attempt/
    result and permits preparation; role/phase/version; success cannot retry.
  - **Focused:** `node --test --test-name-pattern='commit result|committed|not.committed|retry|hook' .codex/workflow-mcp/tests/{workflow,protocol}.node.mjs && pnpm test:workflow-mcp`.
  - **Done:** unchanged-HEAD failures are auditable and parent-retryable.

- [ ] **MCP-7.3 — Make mismatches terminal and retain legacy recording**
  - **Prerequisites/commit:** MCP-7.2; `feat(workflow): stop terminally on commit mismatch`.
  - **Owned:** `.codex/workflow-mcp/git.mjs`, `.codex/workflow-mcp/server.mjs`,
    `.codex/workflow-mcp/store.mjs`, `.codex/workflow-mcp/transitions.mjs`,
    `.codex/workflow-mcp/tests/workflow.node.mjs`,
    `.codex/workflow-mcp/tests/protocol.node.mjs`.
  - **Implement:** all mismatch branches/categories and terminal stop. Store no Git stderr/caller
    text. Restrict `workflow_record_commit` to rows with `legacy_v1:true` that migrated already in
    `COMMIT_AUTHORIZED`; new v2 rejects it. Legacy verification success commits; failure transitions
    to mismatch rather than throwing and leaving ambiguous authorization.
  - **Tests:** failure claim after changed HEAD; wrong HEAD/parent/tree/paths; hook-created unexpected
    commit; mismatch has no actions/retry; new v2 legacy-call denial; migrated success/mismatch.
  - **Focused:** `node --test --test-name-pattern='mismatch|legacy|record.commit|terminal' .codex/workflow-mcp/tests/{workflow,protocol}.node.mjs && pnpm test:workflow-mcp`.
  - **Done:** every attempt ends committed, safely retryable, or unambiguously terminal.

### Cutover and end-to-end coverage

- [ ] **MCP-8.1 — Cut contracts and documentation to v2**
  - **Prerequisites/commit:** MCP-7.3; `docs(agents): adopt authoritative workflow state v2`.
  - **Owned:** `.codex/agents/WORKFLOW.md`, `.codex/agents/implementer.toml`,
    `.codex/agents/code_reviewer.toml`, `.codex/agents/committer.toml`,
    `.codex/agents/EVALS.md`, `.codex/workflow-mcp/README.md`,
    `.codex/workflow-mcp/server.mjs`, and
    `.codex/workflow-mcp/tests/protocol.node.mjs`.
  - **Implement:** make role views authoritative. Prompts carry only workflow ID, role capability,
    expected version, and instruction to read the view; remove duplicated objective/criteria/
    evidence/finding/receipt/repair state. Document phases, recovery, review-only, linked follow-up,
    and prepare/external-attempt/result flow. Review-only dispatch skips implementer. Committer must
    submit result after success or failure. Mention `workflow_record_commit` only in a labeled
    migrated-v1 compatibility paragraph.
  - **Tests:** TOML parsing, exact tools/schemas/instructions; obsolete names and prompt-authoritative
    blocks absent; normal docs cover prepare/submit and review-only.
  - **Focused:** `node --test .codex/workflow-mcp/tests/protocol.node.mjs && node --test .codex/agents/tests/*.node.mjs`; then run
    `rg -n 'STOPPED_BLOCKED|workflow_create_optional_followup|optional-ID-only' .codex/agents .codex/workflow-mcp`, expecting exit 1/no matches. `workflow_record_commit` may match only compatibility code/docs/tests.
  - **Done:** agents, tools, and docs describe one authoritative v2 protocol.

- [ ] **MCP-9.1 — Add store lifecycle and restart coverage**
  - **Prerequisites/commit:** MCP-8.1; `test(workflow): cover v2 store lifecycles`.
  - **Owned:** `.codex/workflow-mcp/tests/lifecycle.node.mjs` only.
  - **Implement:** table-driven store scenarios with a helper asserting phase, version, digest,
    every role's actions, and exact event sequence after each step: clean change; repair/approval;
    both implementation resumes; concern acceptance; both review-only modes; review resume; linked
    optional/blocker; exhaustion; failure/retry/success; mismatch; restart at every nonterminal.
    Creation is version 0; each mutation +1; linked parent +1/child 0; reopen +0 except migration.
  - **Focused:** `node --test .codex/workflow-mcp/tests/lifecycle.node.mjs && pnpm test:workflow-mcp`.
  - **Done:** every transition/restart boundary is asserted at store level.

- [ ] **MCP-9.2 — Add real-transport lifecycle, denial, and migration coverage**
  - **Prerequisites/commit:** MCP-9.1; `test(workflow): cover v2 protocol end to end`.
  - **Owned:** `.codex/workflow-mcp/tests/protocol-v2.node.mjs`,
    `.codex/workflow-mcp/tests/migration.node.mjs`, and
    `.codex/agents/EVAL_RESULTS.md` only for manual evals actually run.
  - **Implement:** drive actual STDIO MCP for: change through external commit; range review to
    linked change/approval; repair through stop/resume/exhaustion. Assert safe errors for wrong role,
    stale version, malformed/unknown fields, phase, and range commit denial. Reopen a v1 fixture via
    STDIO and complete its allowed legacy path. Capture startup/requests/SIGINT/SIGTERM: stdout is
    valid transport frames only; project stderr contains no capability, objective, auth, finding,
    receipt digest, SQL, or stack.
  - **Manual eval rule:** leave results untouched unless parent separately runs EVALS scenarios;
    then record only date, model, scenario, outcome, and observed evidence.
  - **Focused:** `node --test .codex/workflow-mcp/tests/protocol-v2.node.mjs .codex/workflow-mcp/tests/migration.node.mjs && pnpm test:agents && pnpm test:workflow-mcp`.
  - **Done:** public protocol, compatibility, denial, restart/shutdown, and cleanliness are covered.

## Final acceptance gate

After MCP-9.2 the parent runs:

```sh
pnpm test:agents
pnpm test:workflow-mcp
pnpm test
git diff --check
git status --short
```

All suites pass; only intended changes remain; STDIO is protocol-clean; tools/views match this
specification; audit history stays append-only; capabilities and sanitized data appear in no view,
error, audit envelope, or project-emitted diagnostic.
