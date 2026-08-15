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

- [x] **MCP-1.1 — Separate receipt path safety from inspection**
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

- [x] **MCP-1.2 — Add explicit absent-path receipt mode**
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

- [x] **MCP-2.1 — Add complete v2 state construction and digest storage**
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

- [x] **MCP-2.2 — Migrate v1 rows transactionally**
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

- [x] **MCP-2.3 — Standardize sanitized audit envelopes**
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

- [x] **MCP-3.1 — Expose complete v2 change-workflow creation**
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

- [x] **MCP-3.2 — Add least-authority role views and actions**
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

## Done Report

### MCP-1.1 — Separate receipt path safety from inspection

DONE

Task: MCP-1.1
Outcome: Lexical path normalization and symlink-parent safety are split from filesystem/Git metadata inspection; path safety is now independently testable with byte-compatible v1 receipts.

Files changed:
- `.codex/agents/change-receipt.mjs`
- `.codex/agents/tests/change-receipt.node.mjs`

Requirements completed:
- Split lexical normalization from inspection: `normalizePath` (pure lexical) plus the extracted `assertSafeParent` symlink-parent check now live in an exported `safePaths(root, inputs)` step; `headEntry`/`currentMetadata` no longer perform any path-safety checks. `createReceiptAtRoot` routes all inputs through `safePaths` before inspection.
- Lexical validation runs first: within `safePaths`, lexical `normalizePath` runs for all inputs before the filesystem `assertSafeParent` checks, and the whole safety step precedes `headEntry`/metadata inspection.
- Preserved `createReceipt(inputs, cwd)`, CLI, JSON, and schema_version 1. A/B comparison against the committed HEAD version produced byte-identical receipts across modified/unchanged/deleted/added/symlink paths.
- Did not add absent mode; symlink-parent escape check preserved in full (rejects both existing and nonexistent leaves under an escaping parent with `ERROR_UNSAFE_PATH`).
- No new dependencies; no non-owned files touched.

Tests added or updated:
- New: "rejects a path nested under an escaping symlink parent regardless of leaf existence" — asserts `escape/present.txt` and `escape/missing.txt` both return `ERROR_UNSAFE_PATH` (not an existence-dependent error).
- New: "validates path safety independently of repository inspection" — exercises exported `safePaths` directly (normalization/sort, empty, unsafe, absolute, duplicate) with no git repo.
- All 11 existing cases kept unchanged and passing.

Validation:
- `node --test .codex/agents/tests/change-receipt.node.mjs`: pass, 13/13.
- `pnpm test`: pass, 28/28 (13 receipt + 15 workflow/protocol).
- `pnpm test:agents`: pass, 13/13; `pnpm test:workflow-mcp`: pass, 15/15.
- `git diff --check`: pass.
- `git status --short`: only the two owned files.

Pre-existing changes preserved:
- none (worktree was clean before editing).

Plan deviations:
- Minor: the symlink-parent check now compares `relative(realpathSync(root), parent)` instead of `relative(root, parent)`. In the receipt flow `root` is git's canonical toplevel (verified `/private/var`), so v1 output is byte-identical; the canonical base makes the exported `safePaths` correct for any caller-supplied root, which the task's independent-testability requirement needs.

Remaining risks or blockers:
- none. No commit made; worktree returned for parent review.

### MCP-1.2 — Add explicit absent-path receipt mode

DONE

Task: MCP-1.2
Outcome: `createReceipt` and the CLI now support an explicit, opt-in absent-path mode that emits the normative `{path,state:"absent",kind:"missing"}` entry (no mode/digest) while default calls still reject such paths with `ERROR_UNTRACKED_PATH` and tracked deletions remain `deleted`.

Files changed:
- `.codex/agents/change-receipt.mjs`
- `.codex/agents/tests/change-receipt.node.mjs`

Requirements completed:
- Library signature is now `createReceipt(inputs, cwd = process.cwd(), options = {})`; a new `validateOptions` accepts only `{allowAbsent:boolean}` (defaulting false) and throws `ERROR_INVALID_ARGUMENTS` for null/non-object/array options, unknown keys, or non-boolean `allowAbsent`.
- CLI is `--allow-absent -- path...`; `main()` permits the flag at most once and rejects any other pre-separator argument (unknown flags, duplicates, or bare paths) with `ERROR_INVALID_ARGUMENTS`, preserving the old all-invalid behavior for non-flag pre-separator arguments.
- The normative absent entry `{path,state:"absent",kind:"missing"}` is emitted without `mode`/`digest` for paths absent from both `HEAD` and the worktree when opt-in; it participates in `overall_scope_hash` via the unchanged canonical receipt.
- Default calls (library without options or CLI without the flag) still reject absent paths with `ERROR_UNTRACKED_PATH`; tracked missing paths remain `deleted` with HEAD mode and no digest.
- No new dependencies; no non-owned files touched.

Tests added or updated:
- Library opt-in success and default rejection (`createReceipt(["new/file.txt"], root)` and `{allowAbsent:false}` throw `ERROR_UNTRACKED_PATH`; `{allowAbsent:true}` yields the exact absent entry with no `mode`/`digest`).
- Library options validation: `null`, `true`, `[]`, `{allowAbsent:"yes"}`, `{allowAbsent:1}`, and `{bogus:true}` all throw `ERROR_INVALID_ARGUMENTS`; `{}` stays false.
- Mixed present/absent paths sort lexicographically and produce a deterministic `overall_scope_hash`; adding another absent path changes the hash.
- `allowAbsent` keeps tracked deletions `deleted`, never `absent`.
- CLI opt-in emits absent entries (with `base_head`) and default calls reject them, with empty stdout on error and non-empty stdout only for the JSON line on success.
- CLI rejects duplicate `--allow-absent`, unknown flags, and paths before the separator with `ERROR_INVALID_ARGUMENTS` and empty stdout.
- All 13 existing receipt cases (deletion, addition, symlink, unsafe, metadata-only, stdout/stderr) kept unchanged and passing.

Validation:
- `node --test .codex/agents/tests/change-receipt.node.mjs`: pass, 19/19.
- `pnpm test:agents`: pass, 19/19.
- `pnpm test`: pass, 34/34.
- `git diff --check`: pass.
- `git status --short`: only the two owned files.

Pre-existing changes preserved:
- none (worktree was clean before editing; `notes.txt` is git-ignored).

Plan deviations:
- none.

Remaining risks or blockers:
- none. No commit made; worktree returned for parent review.

### MCP-2.1 — Add complete v2 state construction and digest storage

DONE

Task: MCP-2.1
Outcome: Every newly inserted workflow row is now a complete digest-protected v2 row: `createState` builds the full normative state skeleton (`schema_version: 2`, `workflow_type: "change"`, `legacy_v1: false`, empty contract lists, synthesized working-tree `review_target`, plus every new normative key and the documented temporary compatibility keys), the store persists a server-computed `initial_receipt` and derived `dirty_baseline_paths`, and a `state_digest` column is required on every insert/update and verified on every read.

Files changed:
- `.codex/workflow-mcp/transitions.mjs`
- `.codex/workflow-mcp/store.mjs`
- `.codex/workflow-mcp/tests/workflow.node.mjs`

Requirements completed:
- Schema set to 2 (`SCHEMA_VERSION = 2`); `createState` constructs every normative v2 key with its documented empty value and never omits one.
- The v1 public creation call is adapted internally as a `change`: `workflow_type: "change"`, `acceptance_criteria: []`, `validation_requirements: []`, and a synthesized working-tree `review_target` (`base_revision` = base HEAD, `head_revision: null`, all include flags true) so MCP-3.1 can cut the public schema later.
- `store.create` (and the linked optional-follow-up child) computes the server receipt, checks `base_head`, and persists it as `initial_receipt`; `dirty_baseline_paths` is derived as the sorted paths in `added`/`modified`/`deleted` (unchanged/absent excluded).
- Temporary compatibility keys (`implementation_changed_paths`, `implementation_acceptance_evidence`, `implementation_validation_evidence`, `authorized_optional_ids`, `user_authorization_summary`) are initialized exactly as v1 did and are still updated by the untouched v1 `submitImplementation`.
- `state_digest`: the constructor detects the column with `PRAGMA table_info(workflows)` and runs `ALTER TABLE workflows ADD COLUMN state_digest TEXT` for old DBs; all new inserts/updates set `state_digest = objectDigest(state)`; `#row` verifies the digest on every read. A null-digest row yields `ERROR_MIGRATION_REQUIRED`; a mismatched digest yields `ERROR_STATE_CORRUPT`.
- Digest verification applies inside the same immediate transactions, so a corrupt or old row aborts reads and mutations without any state or audit change.
- No new dependencies; no non-owned files touched.

Tests added or updated:
- New: "v2 creation constructs every normative state key and stores a verified digest" — asserts schema 2, all normative keys/defaults (including synthesized review target, initial receipt, empty contract/result/finding arrays), and that the stored digest equals `objectDigest` of the parsed `state_json`.
- New: "records dirty baseline paths from the initial receipt" — modified + added paths are included sorted; an unchanged path yields an empty baseline.
- New: "rejects digest and JSON tampering and preserves state on failed mutation" — tampered `state_json` and tampered digest both yield `ERROR_STATE_CORRUPT`; null digest yields `ERROR_MIGRATION_REQUIRED`; a failed mutation leaves `state_json`/`state_digest` byte-identical; a successful mutation advances the digest and read-back.
- All 15 existing workflow tests kept unchanged and passing.

Validation:
- `node --test --test-name-pattern='schema|digest|corrupt' .codex/workflow-mcp/tests/workflow.node.mjs`: pass, 3/3.
- `pnpm test:workflow-mcp`: pass, 18/18.
- `pnpm test`: pass, 37/37.
- `git diff --check`: pass.
- `git status --short`: only the three owned files plus the requested `mcp-plan.md` update.

Pre-existing changes preserved:
- none (worktree was clean before editing).

Plan deviations:
- none.

Remaining risks or blockers:
- none. No commit made; worktree returned for parent review.

### MCP-2.2 — Migrate v1 rows transactionally

DONE

Task: MCP-2.2
Outcome: Valid v1 databases now reopen as v2. During store open, all schema-1 rows are migrated in one immediate transaction before serving calls: each row maps to complete digest-protected state with `legacy_v1:true`, `workflow_type:"change"`, a synthesized working-tree target, null initial receipt, empty contract lists, `legacy_evidence:{acceptance_evidence,validation_evidence}`, and every genuinely new field at its normative empty value; each row increments N->N+1 and appends exactly one immutable `WORKFLOW_MIGRATED` event. Old audits and capability hashes are never altered. A test-only `faultAfterMigrationUpdate` option rolls back the whole batch after the first update/before the event.

Files changed:
- `.codex/workflow-mcp/store.mjs`
- `.codex/workflow-mcp/transitions.mjs`
- `.codex/workflow-mcp/tests/migration.node.mjs`
- `mcp-plan.md` (requested checkbox + Done Report update)

Requirements completed:
- Migration runs during store open: `#migrateLegacyRows` scans every workflow row inside one `BEGIN IMMEDIATE` transaction before any call is served, so the batch is atomic.
- Complete state mapping in `migrateV1State`: `legacy_v1:true`, `workflow_type:"change"`, synthesized working-tree `review_target` from the v1 base/paths, `initial_receipt:null`, empty `acceptance_criteria`/`validation_requirements`, and `legacy_evidence:{acceptance_evidence,validation_evidence}`.
- Old changed paths map to both `agent_touched_paths` and `scope_changed_paths` (and the temporary `implementation_changed_paths` compatibility key).
- Summary/status/receipt/known failures, resolution/classification/finding/review/commit fields, `repair_authorized_ids`, and the temporary compatibility keys map directly; all genuinely new fields (acceptance/validation results, stop/recovery context, concern acceptance, commit preparation, dirty baseline, source/linked/remediation fields) are set to their normative empty values.
- Phase mapping: `STOPPED_BLOCKED` with `implementation_status:"BLOCKED"` becomes `STOPPED_IMPLEMENTATION_BLOCKED`; any other `STOPPED_BLOCKED` becomes `STOPPED_REPAIR_EXHAUSTED`; all other v1 phases are preserved.
- Unknown/malformed schemas (missing/extra keys, bad types, non-1/2 `schema_version`, JSON that fails to parse) fail `ERROR_STATE_CORRUPT` and roll back the batch; the store closes its connection when migration fails.
- Each row increments `version` N->N+1, receives `state_digest = objectDigest(state)`, and appends one `WORKFLOW_MIGRATED` v2 envelope (summary `{phase}`), matching the existing audit summary style. Old audit rows and capability hashes are untouched; reopens are idempotent with no second event.
- Added test-only `faultAfterMigrationUpdate` that fails after the first workflow UPDATE and before its event insert, exercising full-batch rollback.
- No new dependencies; no non-owned files touched.

Tests added or updated:
- New `migration.node.mjs`: single-row full mapping to complete v2 state plus digest and one migration event; STOPPED_BLOCKED/phase mapping; capability-hash preservation with stale-version rejection after migration (expected 0 fails, 1 succeeds, 1 again fails); byte-for-byte old audit preservation plus one appended migration event; multi-row batch with one event per row; injected-rollback leaving every row and all audits untouched; reopen idempotence; malformed-missing-key and unknown-schema `ERROR_STATE_CORRUPT` with batch rollback. 8/8 pass.
- All 18 existing workflow tests and all other suites kept unchanged and passing.

Validation:
- `node --test .codex/workflow-mcp/tests/migration.node.mjs`: pass, 8/8.
- `pnpm test:workflow-mcp`: pass, 26/26 (18 workflow + 8 migration).
- `pnpm test`: pass, 45/45.
- `git diff --check`: pass.
- `git status --short`: only the three owned files plus the requested `mcp-plan.md` update.

Pre-existing changes preserved:
- none (worktree was clean before editing; `notes.txt` is git-ignored).

Plan deviations:
- none.

Remaining risks or blockers:
- none. No commit made; worktree returned for parent review.

### MCP-2.3 — Standardize sanitized audit envelopes

DONE

Task: MCP-2.3
Outcome: Every new creation and mutation event now writes the normative sanitized audit envelope.
`WORKFLOW_CREATED`, `WORKFLOW_MIGRATED`, `IMPLEMENTATION_SUBMITTED`, `REVIEW_SUBMITTED`,
`REPAIR_AUTHORIZED`, `WORKFLOW_BLOCKED`, `COMMIT_AUTHORIZED`, `COMMIT_RECORDED`, and the two linked
`WORKFLOW_CREATED`/`OPTIONAL_FOLLOWUP_CREATED` events store exactly
`{schema_version:2, phase_before, phase_after, state_digest_before, state_digest_after,
changed_fields, linked_workflow_id, outcome}`. Changed fields are computed by canonical comparison
over unioned top-level keys excluding `version`; creation lists every state key except `version`.
Link IDs appear only on linked events; `outcome` is set only on migration, stops, review, and
commit results and is null otherwise. Old audit rows stay byte-for-byte unchanged and are returned
unsynthesized, so v2 events form a sanitized digest chain.

Files changed:
- `.codex/workflow-mcp/store.mjs`
- `.codex/workflow-mcp/tests/workflow.node.mjs`
- `.codex/workflow-mcp/tests/migration.node.mjs`
- `mcp-plan.md` (requested checkbox + Done Report update)

Requirements completed:
- All creation/mutation events use the normative envelope: a new `auditEnvelope(before, after,
  digestBefore, {linked_workflow_id, outcome})` helper always emits exactly the 8 envelope keys;
  `create`, `#migrateLegacyRows`, and `#mutate` all build envelopes, with `phase_before` and
  `state_digest_before` taken from the prior row (null for creation/migration).
- Changed fields computed by canonical comparison over unioned top-level keys, excluding `version`:
  `changedFields` compares `canonicalJson(before[key]) !== canonicalJson(after[key])` over the
  sorted union of `Object.keys(before)` and `Object.keys(after)` and drops `version`.
- Creation lists every state key except `version`: `auditEnvelope(null, state, null)` yields exactly
  the created state's keys minus `version` (asserted in tests).
- Link IDs only on linked events: child `WORKFLOW_CREATED` sets `linked_workflow_id` to the parent
  workflow ID and parent `OPTIONAL_FOLLOWUP_CREATED` sets it to the child ID; all other events null.
- Outcome only on migration, stops, review, and commit results; otherwise null:
  `WORKFLOW_MIGRATED` and `WORKFLOW_BLOCKED` carry the resulting phase, `REVIEW_SUBMITTED` carries
  `review_status`, `COMMIT_RECORDED` carries `committed`; implementation, repair, commit-authorization,
  creation, and linked events carry null.
- Legacy rows preserved exactly on reads: `audit()` still returns stored `summary_json` parsed
  unsynthesized; the byte-for-byte old-audit preservation test still passes unchanged.
- Envelopes sanitized: only phase names, state digests, key names, workflow IDs, and outcome tokens;
  no objective, summary, finding, path, receipt, or capability text.
- No new dependencies; no non-owned files touched.

Tests added or updated:
- New `workflow.node.mjs` "audit envelopes use exact sanitized keys and sorted changed fields":
  exact 8-key envelope across create/implementation/review/stop, sorted changed fields, creation
  lists every state key except `version`, review outcome `CHANGES_REQUESTED`, stop outcome
  `STOPPED_BLOCKED`, link/outcome null where required.
- New "audit digests form a continuity chain across mutations": `state_digest_after` equals the
  persisted row digest and `objectDigest` of the returned state; `state_digest_before` equals the
  previous event's `state_digest_after`.
- New "serialized audit envelopes contain none of the prohibited data": objective, implementation
  summary, finding ID/text, path, and all four capability tokens absent from serialized audit.
- New "audit history is append-only and versioned across mutations": exactly one event per mutation,
  monotonic unique event IDs, failed mutations append nothing, event versions track workflow versions.
- New `migration.node.mjs` "migration audit envelope uses the normative sanitized envelope": exact
  keys, phase mapping across `phase_before`/`phase_after`/`outcome`, `state_digest_after` equals the
  persisted digest, sanitized serialization, sorted changed fields.
- Updated "preserves old audits byte-for-byte and appends one migration event" to assert the
  normative envelope on the appended `WORKFLOW_MIGRATED` event (exact keys, phases, outcome, digest,
  and exact sorted `changed_fields`) while the byte-for-byte preservation of the pre-existing rows
  is unchanged.
- All other existing tests kept unchanged and passing.

Validation:
- `node --test --test-name-pattern='audit|digest|append' .codex/workflow-mcp/tests/{workflow,migration}.node.mjs`: pass, 10/10.
- `pnpm test:workflow-mcp`: pass, 31/31.
- `pnpm test`: pass, 50/50.
- `git diff --check`: pass.
- `git status --short`: only the three owned files plus the requested `mcp-plan.md` update.

Pre-existing changes preserved:
- none (worktree was clean before editing; `notes.txt` is git-ignored).

Plan deviations:
- none.

Remaining risks or blockers:
- none. No commit made; worktree returned for parent review.

### MCP-3.1 — Expose complete v2 change-workflow creation

DONE

Task: MCP-3.1
Outcome: The public `workflow_create` now uses the normative v2 schema, and every new change workflow persists a complete stable handoff: `workflow_type`, `objective`, `approved_paths`, server-assigned contract objects `{criterion_id:"AC-001",description}` / `{validation_id:"VAL-001",description}`, a persisted working-tree `review_target`, an absent-aware server-computed `initial_receipt`, and derived `dirty_baseline_paths`. Only `change` plus working-tree is accepted; `review_only` and `commit_range` return `ERROR_UNSUPPORTED_WORKFLOW_TYPE` until MCP-5.2.

Files changed:
- `.codex/workflow-mcp/server.mjs`
- `.codex/workflow-mcp/store.mjs`
- `.codex/workflow-mcp/transitions.mjs`
- `.codex/workflow-mcp/validation.mjs`
- `.codex/workflow-mcp/git.mjs`
- `.codex/workflow-mcp/tests/workflow.node.mjs`
- `.codex/workflow-mcp/tests/protocol.node.mjs`
- `mcp-plan.md` (requested checkbox + Done Report update)

Requirements completed:
- Public create schema replaced with the normative one: `workflow_create` accepts exactly `workflow_type`, `objective`, `approved_paths`, `acceptance_criteria`, `validation_requirements`, `review_target`, and optional `max_repair_cycles`; `base_head` is removed. Unknown/missing fields are invalid (`exactKeys`), and the advertised tool schema rejects unknown fields.
- Server-assigned contract IDs: `contractList` maps caller-order descriptions to `{criterion_id:"AC-001",description}` and `{validation_id:"VAL-001",description}` with incrementing three-digit IDs; duplicate descriptions receive distinct IDs; over 999 is invalid.
- Target/top-level consistency: `reviewTarget` requires working-tree mode, `base_revision` equal to current HEAD, null `head_revision`, all three include flags true, and target approved paths that canonically match the top-level approved paths.
- Only `change` plus working-tree accepted: `workflow_type` other than `change` or `review_mode` other than `working_tree` returns `ERROR_UNSUPPORTED_WORKFLOW_TYPE` until MCP-5.2.
- Absent-aware initial receipt and dirty baseline: `store.create` computes the initial receipt with `--allow-absent` (planned-absent paths emit `{path,state:"absent",kind:"missing"}` without mode/digest); `dirty_baseline_paths` are the sorted added/modified/deleted paths (absent/unchanged excluded).
- Old shorthand removed from all owned test callers (`workflow.node.mjs`, `protocol.node.mjs`); the internal optional-follow-up child now uses a private `createState(..., {internal:true})` path preserving its empty contracts and synthesized working-tree target.
- No new dependencies; no non-owned files touched.

Tests added or updated:
- New `workflow.node.mjs` "create assigns ordered contract IDs and preserves duplicate descriptions": exact AC/VAL IDs in caller order with duplicate descriptions getting distinct IDs.
- New "create rejects empty and oversized contract lists": empty criteria/validations and a 1000-item criteria list return `ERROR_INVALID_SHAPE`.
- New "create rejects unknown fields and unsupported type and target mismatches": extra field, `review_only` and `commit_range` (`ERROR_UNSUPPORTED_WORKFLOW_TYPE`), target path mismatch and non-null head (`ERROR_INVALID_SHAPE`), and stale base (`ERROR_STALE_BASE`).
- New "create persists planned absent initial receipt and dirty baseline": a nonexistent approved path yields the exact absent entry (no mode/digest) with an empty dirty baseline; modified+added paths are listed sorted in the dirty baseline.
- New "restart persists execution contracts and review target": reopen retains version 0, phase, objective, contracts, review target, and initial receipt.
- New `protocol.node.mjs` "exact create tool schema matches the normative contract": asserts the advertised `workflow_create` schema (exact keys/required, both workflow types, review-target `oneOf` with working-tree/commit-range modes, bounds, no `base_head`).
- Updated every existing create caller to the normative schema, removed the pre-existing `ERROR_UNTRACKED_PATH` expectation for a planned-absent path, and updated the "v2 creation constructs every normative state key" assertions to the assigned contract objects.

Validation:
- `node --test --test-name-pattern='create|contract|criteria|validation|baseline|restart' .codex/workflow-mcp/tests/workflow.node.mjs .codex/workflow-mcp/tests/protocol.node.mjs`: pass, 7/7.
- `pnpm test:workflow-mcp`: pass, 37/37.
- `pnpm test`: pass, 56/56 (19 agents + 37 workflow/protocol).
- `git diff --check`: pass.
- `git status --short`: only the seven owned files plus the requested `mcp-plan.md` update.

Pre-existing changes preserved:
- none (worktree was clean before editing; `notes.txt` is git-ignored).

Plan deviations:
- none.

Remaining risks or blockers:
- none. No commit made; worktree returned for parent review.

### MCP-3.2 — Add least-authority role views and actions

DONE

Task: MCP-3.2
Outcome: `workflow_get`, `workflow_create`, and every mutation result now return role-scoped
least-authority projections. All views start with the common dispatch fields (`workflow_id`,
`schema_version`, `version`, `workflow_type`, `phase`, `objective`, `approved_paths`,
`repair_cycle`, `max_repair_cycles`, `review_target`) plus sorted `permitted_next_actions`
computed by the pure `permittedNextActions(state, role)`; the parent additionally gets every
persisted field except `legacy_evidence` and the temporary compatibility aliases, the implementer
gets its handoff fields (contracts, initial receipt, dirty baseline, remediation, final
implementation fields, derived paths, result arrays, resolution map, blockers, authorized repair
IDs, stop/recovery context), the reviewer gets criteria/validations plus review evidence but omits
the initial receipt, and the committer gets criteria/validations plus derived paths and commit
authorization/preparation/result but omits the initial receipt. No view exposes capabilities,
hashes, audits, `legacy_evidence`, or temporary compatibility keys, and there is no raw-state
public path.

Files changed:
- `.codex/workflow-mcp/store.mjs`
- `.codex/workflow-mcp/transitions.mjs`
- `.codex/workflow-mcp/server.mjs`
- `.codex/workflow-mcp/tests/workflow.node.mjs`
- `.codex/workflow-mcp/tests/protocol.node.mjs`
- `.codex/workflow-mcp/tests/migration.node.mjs`
- `mcp-plan.md` (requested checkbox + Done Report update)

Requirements completed:
- Implemented the exact role matrix and pure `permittedNextActions(state, role)` in
  `transitions.mjs`: implementer gets `workflow_submit_implementation` in IMPLEMENTING/REPAIRING;
  reviewer gets `workflow_submit_review` in REVIEWING; parent gets
  `workflow_authorize_repair`/`workflow_finalize_blocked` in REPAIR_REQUIRED and
  `workflow_authorize_commit`/`workflow_create_optional_followup` in STOPPED_APPROVED; committer
  gets `workflow_record_commit` in COMMIT_AUTHORIZED. Actions are always returned sorted; the
  function is pure (unit-tested to leave its state input byte-identical).
- Added pure `roleView(state, role)` returning the common dispatch fields first, then
  `permitted_next_actions`, then role-specific fields. The parent view is every persisted key
  except `legacy_evidence` and the five temporary compatibility aliases; implementer/reviewer/
  committer views use the exact field lists from the plan (reviewer and committer omit
  `initial_receipt`; committer omits `finding_resolution_map`; implementer omits review/commit
  fields).
- `workflow_create` returns the parent projection plus capabilities; `workflow_get` returns the
  authenticated role projection only; audit remains a separate `workflow_get_audit` path. Mutation
  results (`submitImplementation`, `submitReview`, `authorizeRepair`, `finalizeBlocked`,
  `authorizeCommit`, `recordCommit`, `createOptionalFollowup`) now return the acting role's
  projection, so no raw-state value escapes the store.
- No view includes capabilities, hashes, audit data, `legacy_evidence`, or temporary compatibility
  keys; `legacy_v1` and `base_head` remain visible to the parent.
- Adapted the digest-chain, creation-key, optional-follow-up, and migration assertions to compare
  full-state digests and temporary keys against the persisted `state_json` row rather than a
  projection, preserving the original intent of each test. Cross-role token denial remains
  enforced before any projection is built.

Tests added or updated:
- New `workflow.node.mjs` "role views expose exact projection keys and sorted permitted actions":
  exact key arrays per role at a fresh workflow plus the sorted action list at IMPLEMENTING,
  REVIEWING, REPAIR_REQUIRED, REPAIRING, STOPPED_APPROVED, COMMIT_AUTHORIZED, and COMMITTED.
- New "role views exclude capabilities, hashes, and compatibility fields in serialized output":
  no capability token, `legacy_evidence`, or temp alias in any serialized view; reviewer/committer
  omit `initial_receipt`; implementer omits `commit_authorization`; actions always sorted.
- New "restart preserves role view versions and projections": reopen retains version 1 and
  REVIEWING for every role view.
- New "permittedNextActions and roleView are pure and follow the role and phase matrix": input
  state byte-identical after calls, expected actions per role.
- New "cross-role tokens are denied on role views": exhaustive 4x4 cross-role
  `ERROR_CAPABILITY_DENIED`.
- New `protocol.node.mjs` "role view projection over STDIO returns only role data without
  capabilities": real STDIO `workflow_get` per role, exact present/absent fields, sorted actions,
  no capability or `legacy_evidence` text in serialized views, and cross-role token denial; the
  existing create call now asserts `created.workflow.permitted_next_actions` is `[]`.
- Updated existing creation/digest/follow-up/migration tests to assert excluded fields are absent
  from views and full-state data via the persisted row, preserving their original coverage.

Validation:
- `node --test --test-name-pattern='role view|projection|permitted|capabil' .codex/workflow-mcp/tests/workflow.node.mjs .codex/workflow-mcp/tests/protocol.node.mjs`: pass, 8/8.
- `pnpm test:workflow-mcp`: pass, 43/43.
- `pnpm test`: pass, 62/62 (19 agents + 43 workflow/protocol/migration).
- `git diff --check`: pass.
- `git status --short`: only the seven owned files plus the requested `mcp-plan.md` update.

Pre-existing changes preserved:
- none (worktree was clean before editing; `notes.txt` is git-ignored).

Plan deviations:
- Minor: the plan's Owned list omits `.codex/workflow-mcp/tests/migration.node.mjs`, but the
  role-view behavior (projections, excluded temporary aliases, added `permitted_next_actions`)
  necessarily changes what `store.get` returns, so its raw-state/digest assertions cannot hold.
  Per parent decision, migration assertions were adapted to assert the parent projection and to
  verify full-state fields/digests against the persisted row. No protocol or architecture decision
  was invented; all behavior follows the plan's role matrix.

Remaining risks or blockers:
- none. No commit made; worktree returned for parent review.

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
