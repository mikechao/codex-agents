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

- [x] **MCP-4.1 — Enforce ID-addressed implementation evidence**
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

- [x] **MCP-4.2 — Add implementation stops, resume, and concern acceptance**
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

- [x] **MCP-5.1 — Add exact historical Git target helpers**
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

- [x] **MCP-5.2 — Enable review-only working-tree and range workflows**
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

- [x] **MCP-5.3 — Add review resume and terminal repair exhaustion**
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

- [x] **MCP-6.1 — Replace optional children with linked finding follow-ups**
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

- [x] **MCP-7.1 — Verify staged state and prepare a commit**
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

- [x] **MCP-7.2 — Record success and retryable non-commit outcomes**
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

- [x] **MCP-7.3 — Make mismatches terminal and retain legacy recording**
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

- [x] **MCP-8.1 — Cut contracts and documentation to v2**
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

### MCP-4.1 — Enforce ID-addressed implementation evidence

DONE

Task: MCP-4.1
Outcome: `workflow_submit_implementation` now accepts only the normative ID-addressed evidence schema
(`agent_touched_paths`, `acceptance_results`, `validation_results` instead of the v1
`changed_paths`/`acceptance_evidence`/`validation_evidence`), the server recomputes a fresh
absent-aware receipt over the exact approved scope and derives `scope_changed_paths` from baseline
comparison, and only complete evidence (every criterion satisfied, every validation passed, no known
failures) advances to REVIEWING. Migrated rows with empty contracts cannot submit and return
`ERROR_LEGACY_WORKFLOW`; the submission compatibility aliases are removed from every
`legacy_v1:false` state.

Files changed:
- `.codex/workflow-mcp/server.mjs`
- `.codex/workflow-mcp/store.mjs`
- `.codex/workflow-mcp/transitions.mjs`
- `.codex/workflow-mcp/validation.mjs`
- `.codex/workflow-mcp/tests/workflow.node.mjs`
- `.codex/workflow-mcp/tests/protocol.node.mjs`
- `mcp-plan.md` (requested checkbox + Done Report update)

Requirements completed:
- v1 submission fields replaced with normative evidence: the tool schema and the transition now
  require exactly `status`, `summary`, `agent_touched_paths`, `acceptance_results`,
  `validation_results`, `implementation_receipt`, `known_failures`, and `finding_resolution_map`;
  `changed_paths`/`acceptance_evidence`/`validation_evidence` are gone from schema and transition.
- Exact ID/status validation: new `evidenceResults` requires every contract ID exactly once in
  contract order with a status in `satisfied|not_satisfied` (acceptance) or `passed|failed|not_run`
  (validation); missing, duplicate, unknown, reordered, or invalid-status results are rejected with
  `ERROR_INVALID_IMPLEMENTATION`.
- Fresh absent-aware receipt: `store.submitImplementation` recomputes the receipt with
  `createReceipt(root, approved_paths, true)` and rejects a submitted receipt that does not
  canonically equal it, or whose `base_head` differs from the workflow base, with
  `ERROR_STALE_RECEIPT` before any mutation; the server-computed receipt is what gets persisted.
- Baseline comparison: `scopeChangedPaths` compares final to initial receipt entries after removing
  only `state`, so existence/kind/mode/digest differences mark a path changed. An unchanged dirty
  baseline path is not attributed, while absent-to-added is.
- Separate touched paths: `agent_touched_paths` is a sorted self-report validated as a subset of the
  approved scope; derived `scope_changed_paths` is computed independently from the receipts, so the
  self-report cannot control it.
- DONE gates: `DONE` requires every acceptance result `satisfied`, every validation result `passed`,
  and zero known failures, then enters REVIEWING; other statuses keep their existing stops
  (`STOPPED_CONCERNS`, `STOPPED_NEEDS_CONTEXT`, `STOPPED_BLOCKED`) without entering review.
- Legacy gate: `submitImplementation` fails with `ERROR_LEGACY_WORKFLOW` for any `legacy_v1:true`
  row, so an active migrated implementation must be replaced by a newly created v2 workflow;
  migrated rows beyond implementation remain readable and keep using operations valid for their
  current phase, and migration still emits the temporary compatibility keys for those rows.
- Compatibility key cutover: the submission aliases (`implementation_changed_paths`,
  `implementation_acceptance_evidence`, `implementation_validation_evidence`) are removed from every
  `legacy_v1:false` state skeleton; `authorized_optional_ids`/`user_authorization_summary` remain
  until MCP-6.1.
- No new dependencies; no non-owned files touched.

Tests added or updated:
- New `workflow.node.mjs` "implementation evidence requires exact contract IDs in contract order":
  missing, duplicate, unknown, reordered, and invalid-status acceptance/validation results all
  return `ERROR_INVALID_IMPLEMENTATION` with no version or audit mutation, then a valid submission
  reaches REVIEWING.
- New "every implementation status persists and advances or stops explicitly": DONE->REVIEWING,
  DONE_WITH_CONCERNS->STOPPED_CONCERNS, NEEDS_CONTEXT->STOPPED_NEEDS_CONTEXT,
  BLOCKED->STOPPED_BLOCKED; summary, status, results, touched paths, and the server-computed receipt
  persist across reopen.
- New "failed and not-run validation, unsatisfied criteria, and known failures block DONE": all four
  gate failures return `ERROR_INVALID_IMPLEMENTATION` with version 0, then DONE succeeds.
- New "agent touched paths must be a subset of the approved scope": out-of-scope touched paths are
  rejected without mutation; in-scope touched paths are persisted sorted.
- New "derives scope changes from baseline receipt comparison and ignores self-reported touched
  paths": an unchanged dirty baseline is not attributed (`scope_changed_paths: []`), absent-to-added
  is included with an empty self-report, and the derived scope is server-controlled regardless of the
  touched claim.
- New "stale implementation receipt is rejected and restart preserves submission evidence": a stale
  receipt returns `ERROR_STALE_RECEIPT` with no mutation; the fresh submission persists results and
  the absent-aware receipt across reopen.
- New "migrated workflows with empty contracts cannot submit implementation": a `legacy_v1:true`
  row returns `ERROR_LEGACY_WORKFLOW` with no mutation.
- New `protocol.node.mjs` "exact implementation tool schema matches the normative contract": exact
  properties/required, status enums, evidence bounds, and absence of the removed v1 fields.
- Updated the store-level `implementation()` helper and all existing callers to the normative schema;
  updated the v2-state-key and digest-tampering assertions to the new submission fields and to the
  absence of the submission compatibility aliases in `legacy_v1:false` raw state.
- All 43 pre-existing workflow/protocol tests and all migration tests kept unchanged and passing.

Validation:
- `node --test --test-name-pattern='implementation|criterion|validation|touched|baseline|receipt' .codex/workflow-mcp/tests/workflow.node.mjs .codex/workflow-mcp/tests/protocol.node.mjs`: pass, 15/15.
- `pnpm test:workflow-mcp`: pass, 51/51.
- `pnpm test`: pass, 70/70 (19 agents + 51 workflow/protocol/migration).
- `git diff --check`: pass.
- `git status --short`: only the six owned files plus the requested `mcp-plan.md` update.

Pre-existing changes preserved:
- none (worktree was clean before editing; `notes.txt` is git-ignored).

Plan deviations:
- none.

Remaining risks or blockers:
- none. No commit made; worktree returned for parent review.

### MCP-4.2 — Add implementation stops, resume, and concern acceptance

DONE

Task: MCP-4.2
Outcome: `workflow_submit_implementation` now stores a stop context and enters one of the three
normative implementation stops (`STOPPED_CONCERNS`, `STOPPED_NEEDS_CONTEXT`,
`STOPPED_IMPLEMENTATION_BLOCKED`), the parent can recover `STOPPED_NEEDS_CONTEXT` and
`STOPPED_IMPLEMENTATION_BLOCKED` with `workflow_resume_implementation` (restoring the prior active
phase and storing an `implementation` recovery context) or accept `STOPPED_CONCERNS` into review
with `workflow_accept_concerns` under explicit user authorization, and the new
`IMPLEMENTATION_STOPPED`/`IMPLEMENTATION_RESUMED`/`CONCERNS_ACCEPTED` events keep one sanitized
append-only audit chain without weakening terminals.

Files changed:
- `.codex/workflow-mcp/server.mjs`
- `.codex/workflow-mcp/store.mjs`
- `.codex/workflow-mcp/transitions.mjs`
- `.codex/workflow-mcp/tests/workflow.node.mjs`
- `.codex/workflow-mcp/tests/protocol.node.mjs`
- `mcp-plan.md` (requested checkbox + Done Report update)

Requirements completed:
- Three normative stops/stop context: `submitImplementation` maps `DONE_WITH_CONCERNS`,
  `NEEDS_CONTEXT`, and `BLOCKED` to `STOPPED_CONCERNS`, `STOPPED_NEEDS_CONTEXT`, and
  `STOPPED_IMPLEMENTATION_BLOCKED` (the BLOCKED stop moves off the legacy `STOPPED_BLOCKED` name),
  and for every non-DONE status stores `stop_context:{status,summary,stopped_from}` where
  `stopped_from` is the prior `IMPLEMENTING` or `REPAIRING` phase. DONE still advances to
  `REVIEWING` with no stop context.
- `workflow_resume_implementation` (parent, common + `resume_context`): transition `resumeImplementation`
  accepts only `STOPPED_NEEDS_CONTEXT`/`STOPPED_IMPLEMENTATION_BLOCKED`, restores the
  `stop_context.stopped_from` phase, clears the stop, preserves repair state/evidence (repair cycle,
  blocking findings, resolution map, evidence results), and stores
  `recovery_context:{kind:"implementation",context:resume_context,recovered_at:<ISO>}`. A missing or
  non-`IMPLEMENTING`/`REPAIRING` `stopped_from` is rejected as `ERROR_STATE_CORRUPT`.
- `workflow_accept_concerns` (parent, common + `user_authorization`): transition `acceptConcerns`
  accepts only `STOPPED_CONCERNS`, requires `user_authorization`, stores
  `concern_acceptance:{user_authorization,accepted_at:<ISO>}`, enters `REVIEWING`, and clears the
  stop without rewriting the failed/satisfied evidence results. Concern acceptance sets no
  `commit_authorization`, so it never implies commit authorization.
- Events: a stopping submission emits `IMPLEMENTATION_STOPPED` with `outcome` equal to the resulting
  stop phase; DONE still emits `IMPLEMENTATION_SUBMITTED`. Resume emits `IMPLEMENTATION_RESUMED` and
  concern acceptance emits `CONCERNS_ACCEPTED`, both with `outcome:null`; none of the new envelopes
  carry the summary, resume context, or authorization text.
- Parent actions: `permittedNextActions` adds `workflow_resume_implementation` at
  `STOPPED_NEEDS_CONTEXT`/`STOPPED_IMPLEMENTATION_BLOCKED` and `workflow_accept_concerns` at
  `STOPPED_CONCERNS`; both tools are registered with exact schemas (common + `resume_context` /
  `user_authorization`, bounded at 2,000 characters) and dispatched in the server. Role views already
  expose `stop_context`, `recovery_context`, and `concern_acceptance`, so no projection changes were
  needed.
- Wrong role/phase/version: both new mutations run inside the existing immediate transaction with
  capability, version, and phase checks, so failures change no state or audit row.
- No new dependencies; no non-owned files touched.

Tests added or updated:
- New `workflow.node.mjs` "implementation stops persist stop context and resume restores the exact
  source phase": exact stop_context from an initial `NEEDS_CONTEXT` stop, resume to `IMPLEMENTING`,
  cleared stop, exact `recovery_context`, and restart persistence.
- New "resume from repair preserves repair continuity and block stops restore REPAIRING": BLOCKED stop
  from a repair (`stopped_from:"REPAIRING"`), resume restores `REPAIRING` with the repair cycle,
  blocking finding, and resolution map intact, then a completed repair submission reaches `REVIEWING`.
- New "resume and concern acceptance reject wrong role, phase, version, and extra fields":
  `ERROR_CAPABILITY_DENIED`, `ERROR_VERSION_CONFLICT`, missing/extra `resume_context` →
  `ERROR_INVALID_SHAPE`, concern acceptance on a non-concerns stop → `ERROR_INVALID_TRANSITION`, and
  no mutation on any failure.
- New "terminals cannot resume implementation or accept concerns": a `COMMITTED` workflow rejects both
  recovery tools with `ERROR_INVALID_TRANSITION`.
- New "concern acceptance requires authorization and retains failed evidence without commit
  authorization": empty/extra authorization rejected, `workflow_resume_implementation` on
  `STOPPED_CONCERNS` rejected, acceptance stores `concern_acceptance`, keeps the not-satisfied/failed
  evidence and known failures, leaves `commit_authorization` null, and persists across reopen.
- New "stop, resume, and concern events form a sanitized append-only chain": exact event sequence,
  `IMPLEMENTATION_STOPPED` outcome equals the stop phase, resume/concerns outcomes null, and no
  summary or authorization text in serialized envelopes.
- New "parent gets resume and concern acceptance actions at implementation stops": exact
  `permitted_next_actions` per stop phase and none for the implementer while stopped.
- New `protocol.node.mjs` "exact recovery tool schemas match the normative contract": exact
  properties/required/bounds for `workflow_resume_implementation` and `workflow_accept_concerns`.
- New `protocol.node.mjs` "implementation stops resume and concerns over STDIO": real transport
  NEEDS_CONTEXT stop → denied cross-role resume → parent resume → DONE_WITH_CONCERNS stop → accepted
  concerns → APPROVED review.
- Updated the BLOCKED row in "every implementation status persists and advances or stops explicitly"
  to the normative `STOPPED_IMPLEMENTATION_BLOCKED` phase; all other existing tests kept unchanged.

Validation:
- `node --test --test-name-pattern='stop|resume|context|concern|continuity' .codex/workflow-mcp/tests/{workflow,protocol}.node.mjs`: pass, 14/14.
- `pnpm test:workflow-mcp`: pass, 60/60.
- `pnpm test`: pass, 79/79 (19 agents + 60 workflow/protocol/migration).
- `git diff --check`: pass.
- `git status --short`: only the five owned files plus the requested `mcp-plan.md` update.

Pre-existing changes preserved:
- none (worktree was clean before editing; `notes.txt` is git-ignored).

Plan deviations:
- Minor: `resume_context` and the `workflow_resume_implementation` schema bound it at 2,000
  characters, since the plan gives no explicit bound for recovery context; the 2,000-character detail
  bound is the closest normative fit alongside `user_authorization`.
- Minor: `workflow_accept_concerns` clears `stop_context` on entry to `REVIEWING`, mirroring the
  resume behavior the plan specifies ("clears the stop"); the plan does not state it explicitly for
  concern acceptance but leaving a stale stop in a reviewing workflow would be inconsistent.

Remaining risks or blockers:
- none. No commit made; worktree returned for parent review.

### MCP-5.1 — Add exact historical Git target helpers

DONE

Task: MCP-5.1
Outcome: `git.mjs` now exports read-only historical-target helpers — `verifyRevision`, `verifyRange`, and `reviewRange` — that validate commit-range review targets without any current-filesystem dependence. Revisions are verified as full lowercase 40-character commit IDs (`ERROR_INVALID_REVISION`), base must be a distinct ancestor of head (`ERROR_NON_ANCESTOR`), and every approved path must be a blob at one or both endpoint trees (`ERROR_INVALID_REVIEW_PATH`). Directories and submodules are rejected, both rename paths are supported by authorizing exact old and new paths, and no git stderr ever leaks.

Files changed:
- `.codex/workflow-mcp/git.mjs`
- `.codex/workflow-mcp/tests/git.node.mjs`
- `mcp-plan.md` (requested checkbox + Done Report update)

Requirements completed:
- Read-only helpers: `verifyRevision(root, revision)` resolves a 40-hex input to a commit via `rev-parse --verify --quiet <rev>^{commit}`; `verifyRange(root, base, head)` verifies both commits, requires distinct base/head, and checks ancestry via `merge-base --is-ancestor`; `reviewRange(root, target)` applies every normative range/path rule and returns per-path endpoint blob metadata `{path, kind, base:{mode,object}|null, head:{mode,object}|null}`.
- Error mapping: invalid-format, unknown, and non-commit revisions → `ERROR_INVALID_REVISION`; reversed (non-ancestor) ranges → `ERROR_NON_ANCESTOR`; directory, submodule, both-endpoints-absent, and unsafe paths → `ERROR_INVALID_REVIEW_PATH`.
- Normative path rules: each approved path must be a blob at one or both endpoint trees; directories (tree) and submodules (gitlink/commit) are rejected; a path absent at both endpoints is rejected; unchanged/added/deleted/modified classified by endpoint presence and blob object equality; renames have no special meaning — authorizing both exact old and new paths succeeds.
- No current-filesystem dependence: all metadata comes from `git ls-tree -z` on commit objects and `exactPaths` lexical validation; no worktree inspection.
- Never leak stderr: every new git invocation uses `stdio: ["ignore", "pipe", "ignore"]` and outcomes are read from exit codes only.
- No new dependencies; no non-owned files touched.

Tests added or updated:
- New `git.node.mjs`: verifyRevision valid/invalid-format/unknown/non-commit; verifyRange valid/reversed/equal; reviewRange unknown/non-commit revisions; unchanged/added/deleted/modified classification; both rename paths; absent both endpoints; unsafe paths (dot-segment/absolute/glob); directory and submodule rejection. 7/7 pass.

Validation:
- `node --test .codex/workflow-mcp/tests/git.node.mjs`: pass, 7/7.
- `pnpm test:workflow-mcp`: pass, 67/67 (60 existing + 7 new).
- `pnpm test`: pass, 86/86.
- `git diff --check`: pass.
- `git status --short`: only the two owned files plus the requested `mcp-plan.md` update.

Pre-existing changes preserved:
- none (worktree was clean before editing).

Plan deviations:
- Minor: an equal base/head range is rejected as `ERROR_INVALID_REVISION` rather than `ERROR_NON_ANCESTOR`, because a commit is its own ancestor (`merge-base --is-ancestor` succeeds) and the plan maps only invalid/non-commit IDs, ancestry, and endpoint/path errors; the distinctness requirement is treated as a range validity error.

Remaining risks or blockers:
- none. No commit made; worktree returned for parent review.

### MCP-5.2 — Enable review-only working-tree and range workflows

DONE

Task: MCP-5.2
Outcome: Both normative standalone-review cases now create valid workflows: `review_only` with a
working-tree target starts `REVIEWING` and persists a server-computed absent-aware `initial_receipt`
plus receipt-derived `dirty_baseline_paths`; `review_only` with a `commit_range` target starts
`REVIEWING`, validates the range via `reviewRange` (revisions, ancestry, blob endpoints), stores a
null `initial_receipt`, and derives `dirty_baseline_paths` from the range's added/modified/deleted
kinds. `change` still permits only working-tree. Review submission requires canonical submitted-target
equality with the persisted target, working-tree approval requires a fresh receipt while commit-range
approval requires a null receipt, and `workflow_authorize_commit` rejects range workflows with
`ERROR_COMMIT_NOT_ALLOWED` (and omits that action from the range parent's permitted actions). Reviewer
views for `review_only` workflows omit the nonexistent implementer handoff without synthesizing one.

Files changed:
- `.codex/workflow-mcp/server.mjs`
- `.codex/workflow-mcp/store.mjs`
- `.codex/workflow-mcp/transitions.mjs`
- `.codex/workflow-mcp/validation.mjs`
- `.codex/workflow-mcp/tests/workflow.node.mjs`
- `.codex/workflow-mcp/tests/protocol.node.mjs`
- `mcp-plan.md` (requested checkbox + Done Report update)

Requirements completed:
- Review-only creation enabled: `createState` now accepts `workflow_type` `change` or `review_only`;
  `review_only` starts `REVIEWING` (via `baseState` workflowType), `change` stays `IMPLEMENTING`.
  `reviewTarget` handles both `working_tree` (base must equal current HEAD, head null, all include
  flags true) and `commit_range` (base/head 40-hex revisions, all include flags false), and rejects
  `change` + `commit_range` with `ERROR_UNSUPPORTED_WORKFLOW_TYPE`.
- Working-tree stores initial receipt, range stores null: `store.create` branches on
  `state.review_target.review_mode`; working-tree recomputes the absent-aware receipt and derives
  `dirty_baseline_paths` as before; commit-range validates through `reviewRange` and stores
  `initial_receipt: null` with `dirty_baseline_paths` from the range's added/modified/deleted kinds
  (`rangeDirtyBaselinePaths`). `base_head` is the range base.
- Canonical submitted target equality: `store.submitReview` normalizes the submitted target
  (`exactPaths` on approved paths) and requires `canonicalJson` equality with the persisted
  `state.review_target`, replacing the old working-tree-only structural checks.
- Working approval requires receipt, range approval requires null: working-tree `APPROVED` still
  requires a fresh verified receipt (`ERROR_STALE_RECEIPT` otherwise); commit-range `APPROVED`
  rejects any receipt (`ERROR_INVALID_REVIEW`). Non-approved reviews still reject non-null receipts.
- Range commit authorization rejected: `store.authorizeCommit` fails with `ERROR_COMMIT_NOT_ALLOWED`
  unless `state.review_target.review_mode` is `working_tree`; `permittedNextActions` drops
  `workflow_authorize_commit` from the parent at a `STOPPED_APPROVED` commit-range workflow, while a
  working-tree `review_only` workflow still authorizes commits.
- Reviewer views omit nonexistent implementer handoff: `roleView` filters the reviewer's
  implementation-handoff fields (`implementation_summary`/`status`/`receipt`/`known_failures`,
  `agent_touched_paths`, `scope_changed_paths`, `acceptance_results`, `validation_results`,
  `finding_resolution_map`) out of `review_only` reviewer views, keeping criteria/validations,
  `dirty_baseline_paths`, finding buckets, classifications, review receipt, and stop/recovery context;
  `change` reviewer views are unchanged.
- Schema: `workflow_create.validation_requirements` minItems lowered to 0 (empty allowed for
  `review_only`, still required non-empty for `change` via `createState`/`contractList`), and
  `workflow_submit_review.review_target` now accepts the commit-range target (`createReviewTargetSchema`).
- No new dependencies; no non-owned files touched.

Tests added or updated:
- Updated `workflow.node.mjs` "create rejects unknown fields and invalid target combinations"
  (renamed from "unsupported type and target mismatches"): `review_only` + working-tree now creates a
  `REVIEWING` workflow instead of returning `ERROR_UNSUPPORTED_WORKFLOW_TYPE`; all other rejection
  cases kept.
- New "review-only working-tree workflow starts reviewing with an initial receipt": workflow_type
  `review_only`, phase `REVIEWING`, initial receipt present, empty dirty baseline, reviewer
  `workflow_submit_review` action, implementation fields null.
- New "review-only commit-range workflow stores null receipt and range-derived dirty baseline": null
  `initial_receipt`, `base_head` equals range base, dirty baseline only `added.txt` (unchanged
  `note.txt` excluded), exact persisted range target.
- New "review-only creation rejects bad flags, revisions, paths, and ancestry": reversed range
  `ERROR_NON_ANCESTOR`, unknown revision `ERROR_INVALID_REVISION`, equal range `ERROR_INVALID_REVISION`,
  include-flag violations `ERROR_INVALID_SHAPE` (both modes), directory and both-endpoints-absent
  paths `ERROR_INVALID_REVIEW_PATH`, and `change` + `commit_range` `ERROR_UNSUPPORTED_WORKFLOW_TYPE`.
- New "working-tree approval requires a receipt and range approval rejects receipts": working-tree
  `APPROVED` without a receipt `ERROR_STALE_RECEIPT`; commit-range `APPROVED` with a receipt
  `ERROR_INVALID_REVIEW`; both valid approvals reach `STOPPED_APPROVED`, range with null
  `review_receipt`.
- New "range workflows reject commit authorization while working-tree review-only allows it":
  working-tree review-only parent lists `workflow_authorize_commit` and authorizes; range parent
  lists only `workflow_create_optional_followup` and `workflow_authorize_commit` returns
  `ERROR_COMMIT_NOT_ALLOWED`.
- New "reviewer views omit nonexistent implementer handoff for review-only workflows": the nine
  implementation-handoff keys are absent from a `review_only` reviewer view while criteria,
  validations, dirty baseline, finding buckets, classifications, review receipt, and stop/recovery
  context remain; a `change` reviewer view still exposes `implementation_summary`.
- New "review submission requires canonical target equality and rejects stale receipts": mismatched
  `head_revision`, include flag, or approved paths all return `ERROR_INVALID_REVIEW` with no mutation,
  and the exact target accepts.
- New "review-only restart preserves phase, receipt, and permitted actions": reopen retains
  `REVIEWING`, `review_only`, the initial receipt, and the reviewer action.
- New `protocol.node.mjs` "review-only workflows over STDIO cover working-tree approval and range
  commit denial": real STDIO working-tree review-only create/approve/authorize-commit and
  commit-range create/approve with a null receipt, parent action list, and `ERROR_COMMIT_NOT_ALLOWED`
  denial.
- Updated "exact create tool schema matches the normative contract": `validation_requirements`
  `minItems` is now 0 to permit empty `review_only` validations.
- All other existing tests kept unchanged and passing.

Validation:
- `node --test --test-name-pattern='review.only|commit.range|historical|receipt|authorization' .codex/workflow-mcp/tests/{workflow,protocol}.node.mjs`: pass, 17/17.
- `pnpm test:workflow-mcp`: pass, 76/76.
- `pnpm test`: pass, 95/95.
- `git diff --check`: pass.
- `git status --short`: only the six owned files plus the requested `mcp-plan.md` update.

Pre-existing changes preserved:
- none (worktree was clean before editing).

Plan deviations:
- none.

Remaining risks or blockers:
- none. No commit made; worktree returned for parent review.

### MCP-5.3 — Add review resume and terminal repair exhaustion

DONE

Task: MCP-5.3
Outcome: `workflow_resume_review` (parent, common + `resume_context`) now recovers `STOPPED_INCONCLUSIVE`
stops back to `REVIEWING` in both working-tree and commit-range review modes, storing a `review`
recovery context; `workflow_finalize_blocked` is renamed to `workflow_finalize_repair_exhausted` and
now targets the terminal `STOPPED_REPAIR_EXHAUSTED` phase, gated on `repair_cycle` equalling the max.
`STOPPED_BLOCKED` is removed from the new phase list and from all tool schemas/actions, while v1
migration mapping keeps recognizing it. Events are `REVIEW_RESUMED` and `REPAIR_EXHAUSTED`, and the
exhausted stop exposes no permitted actions for any role and cannot resume or commit.

Files changed:
- `.codex/workflow-mcp/server.mjs`
- `.codex/workflow-mcp/store.mjs`
- `.codex/workflow-mcp/transitions.mjs`
- `.codex/workflow-mcp/tests/workflow.node.mjs`
- `.codex/workflow-mcp/tests/protocol.node.mjs`
- `mcp-plan.md` (requested checkbox + Done Report update)

Requirements completed:
- `workflow_resume_review` added: tool schema is common + `resume_context` (1..2000 chars), registered
  in the server dispatch, and dispatched through the store's transactional `#mutate` with parent role
  capability, expected-version, and `STOPPED_INCONCLUSIVE` phase checks. The transition restores
  `REVIEWING`, clears `stop_context`, and stores
  `recovery_context:{kind:"review",context:resume_context,recovered_at:<ISO>}`. The parent action list
  at `STOPPED_INCONCLUSIVE` is exactly `["workflow_resume_review"]`.
- Inconclusive stops now persist the normative stop context:
  `{status:"INCONCLUSIVE",summary:"review context unavailable",stopped_from:"REVIEWING"}` in
  `submitReview`, so the reviewer view carries a complete stop and the resume is meaningful.
- `workflow_finalize_blocked` renamed to `workflow_finalize_repair_exhausted`: tool schema (common
  only), server dispatch, store method, and transition `finalizeRepairExhausted`; the target phase is
  the terminal `STOPPED_REPAIR_EXHAUSTED` and it remains gated on `repair_cycle` equalling
  `max_repair_cycles` (`ERROR_REPAIR_LIMIT` while cycles remain). The parent action at
  `REPAIR_REQUIRED` is now `["workflow_authorize_repair","workflow_finalize_repair_exhausted"]`.
- `STOPPED_BLOCKED` removed from the new phase list (`PHASES`), the action matrix, and every tool
  schema/description; it survives only in `V1_PHASES` and the migration phase mapping for legacy rows,
  which still map it to `STOPPED_IMPLEMENTATION_BLOCKED` or `STOPPED_REPAIR_EXHAUSTED`.
- Events: `REVIEW_RESUMED` (outcome null) and `REPAIR_EXHAUSTED` (outcome `STOPPED_REPAIR_EXHAUSTED`),
  both with the exact sanitized envelope and no finding/auth/context text.
- Exhausted stop is terminal: every role gets empty `permitted_next_actions`, and resume, concerns,
  review, and implementation calls are rejected (`ERROR_INVALID_TRANSITION`; commit authorization is
  rejected by the existing receipt gate with `ERROR_STALE_RECEIPT`).
- All mutations remain transactional, version-checked, capability-checked, and audit-safe; no new
  dependencies; no non-owned files touched.

Tests added or updated:
- New `workflow.node.mjs` "inconclusive review resumes to reviewing in both working-tree and range
  modes": exact stop_context, parent resume action, `REVIEW_RESUMED` audit event with phases/outcome
  null/link null, resume to `REVIEWING` with `kind:"review"` recovery context, recovery to
  `STOPPED_APPROVED`, and an identical range-mode resume.
- New "review resume rejects wrong role, phase, version, and extra fields": `ERROR_CAPABILITY_DENIED`,
  `ERROR_VERSION_CONFLICT`, missing/extra `resume_context` → `ERROR_INVALID_SHAPE`, no mutation, and
  repeat resume at `REVIEWING` → `ERROR_INVALID_TRANSITION`.
- New "repair exhaustion finalizes only at the max cycle and enters a terminal stop": `ERROR_REPAIR_LIMIT`
  with cycles remaining, exhaustion only after the final `CHANGES_REQUESTED`, `STOPPED_REPAIR_EXHAUSTED`
  with cycle retained, `REPAIR_EXHAUSTED` audit event (phases/outcome exact), and no finding text in
  serialized envelopes.
- New "repair exhaustion is terminal and cannot resume or commit": empty actions for all four roles and
  resume/concerns/review/implementation/commit denial with version/audit preserved.
- Updated existing tests to the renamed tool/phase/event: `enforces P3 stopping and blocking repair
  cycle limit`, `rejects extra mutation fields`, `audit envelopes use exact sanitized keys and sorted
  changed fields` (`REPAIR_EXHAUSTED`/`STOPPED_REPAIR_EXHAUSTED`), and `role views expose exact
  projection keys and sorted permitted actions`.
- New `protocol.node.mjs` "resume review and repair exhaustion tool schemas match the normative
  contract": exact `workflow_resume_review` schema (common + `resume_context`), exact
  `workflow_finalize_repair_exhausted` schema (common only), and absence of `workflow_finalize_blocked`.
- New `protocol.node.mjs` "review resume and repair exhaustion over STDIO": real transport
  `INCONCLUSIVE` → parent resume → approved working-tree review, and change workflow exhausted at
  `max_repair_cycles:0` → `STOPPED_REPAIR_EXHAUSTED` with empty parent actions and denied review resume.
- All other existing tests kept unchanged and passing.

Validation:
- `node --test --test-name-pattern='inconclusive|resume.review|repair.exhaust|terminal' .codex/workflow-mcp/tests/{workflow,protocol}.node.mjs`: pass, 7/7.
- `pnpm test:workflow-mcp`: pass, 82/82.
- `pnpm test`: pass, 101/101 (19 agents + 82 workflow/protocol/migration).
- `git diff --check`: pass.
- `git status --short`: only the five owned files plus the requested `mcp-plan.md` update.

Pre-existing changes preserved:
- none (worktree was clean before editing).

Plan deviations:
- none.

Remaining risks or blockers:
- none. No commit made; worktree returned for parent review.

### MCP-6.1 — Replace optional children with linked finding follow-ups

DONE

Task: MCP-6.1
Outcome: `workflow_create_optional_followup` is removed and replaced by the normative
`workflow_create_linked_followup`. The parent can now create, from either a `STOPPED_APPROVED` or the
terminal `STOPPED_REPAIR_EXHAUSTED` source, a fresh-HEAD working-tree `change` child (version 0) that
copies the exact full finding objects, `source_workflow_id`/`parent_workflow_id` links, and the exact
remediation context `{policy:"explicitly_authorized", authorized_finding_ids, repair_cycle:0,
user_authorization}`, with caller contracts assigned fresh AC/VAL IDs and a server-computed
absent-aware initial receipt. Both rows and both audits commit atomically; the child event
`WORKFLOW_CREATED` links the source and the parent event `LINKED_FOLLOWUP_CREATED` links the child,
with neither audit envelope leaking finding or authorization text. The final optional-follow-up
aliases `authorized_optional_ids` and `user_authorization_summary` are removed from every
`legacy_v1:false` state. The injected-failure option is renamed `faultAfterLinkedChildInsert` and
now fires after both audits are written, so rollback provably removes both rows and both audit rows.

Files changed:
- `.codex/workflow-mcp/server.mjs`
- `.codex/workflow-mcp/store.mjs`
- `.codex/workflow-mcp/transitions.mjs`
- `.codex/workflow-mcp/validation.mjs`
- `.codex/workflow-mcp/tests/workflow.node.mjs`
- `.codex/workflow-mcp/tests/protocol.node.mjs`
- `mcp-plan.md` (requested checkbox + Done Report update)

Requirements completed:
- `workflow_create_optional_followup` removed: the tool, its schema (including `base_head` and
  `optional_finding_ids`), the server dispatch case, and the `createOptionalFollowup` store method
  are gone; `optionalFollowupInput` is replaced by `linkedFollowupInput`.
- Normative `workflow_create_linked_followup` added: tool schema is common + `objective`,
  `approved_paths`, `acceptance_criteria`, `validation_requirements`, `finding_ids`,
  `user_authorization`; dispatched to the store's transactional `createLinkedFollowup`.
- Complete immutable finding copy: `linked_findings` carries the full finding objects for exactly the
  authorized IDs; `linkedFollowupInput` requires the IDs to be unique, non-empty, known, and all from
  one bucket (all blocking or all optional), rejecting unknown/duplicate/mixed IDs with
  `ERROR_INVALID_FOLLOWUP`.
- Links and remediation context: the child stores `source_workflow_id` and `parent_workflow_id`
  pointing at the source, `linked_findings`, and the exact
  `{policy:"explicitly_authorized", authorized_finding_ids, repair_cycle:0, user_authorization}`
  remediation context; source phases are `STOPPED_APPROVED` and `STOPPED_REPAIR_EXHAUSTED`
  (`ERROR_INVALID_TRANSITION` otherwise).
- Fresh HEAD/receipt/target/contracts: the child is a `change` at current `HEAD` with a fresh
  working-tree target, server-computed absent-aware initial receipt, derived dirty baseline, cycle 0,
  inherited max cycles, and caller-ordered AC/VAL contracts; an absent child path produces the
  normative `{path,state:"absent",kind:"missing"}` receipt entry.
- Atomic parent/child transaction: one `BEGIN IMMEDIATE` transaction inserts the child row, writes
  the child `WORKFLOW_CREATED` audit (linked_workflow_id = source), updates the parent version, and
  writes the parent `LINKED_FOLLOWUP_CREATED` audit (linked_workflow_id = child); the parent changes
  only `version` and both audits are append-only. The test-only injection is renamed
  `faultAfterLinkedChildInsert` and placed after both audit writes so an injected rollback removes
  the child row, the child audit, the parent update, and the parent audit.
- Sanitized events: neither `WORKFLOW_CREATED` nor `LINKED_FOLLOWUP_CREATED` carries finding or
  authorization text; serialized envelopes contain only the exact 8 keys with link IDs.
- Parent actions: `workflow_create_linked_followup` is listed at `STOPPED_APPROVED` (alongside
  `workflow_authorize_commit`) and `STOPPED_REPAIR_EXHAUSTED` (the sole parent action, so the
  exhausted stop stays terminal for resume/repair/commit but can spawn a fresh linked child).
- Optional-follow-up aliases removed from every `legacy_v1:false` state: `baseState` no longer
  initializes `authorized_optional_ids`/`user_authorization_summary`; `migrateV1State` still emits
  them for `legacy_v1:true` rows, and the parent-view exclusion list still filters them, so migrated
  rows and their views are unchanged.
- No new dependencies; no non-owned files touched.

Tests added or updated:
- Updated "optional findings require a fresh linked workflow": linked follow-up from `STOPPED_APPROVED`
  copies the full optional finding, remediation context, source/parent links, fresh working-tree
  target, assigned child contracts, and a `WORKFLOW_CREATED`/`LINKED_FOLLOWUP_CREATED` chain whose
  serialized envelopes contain no finding text; parent unchanged except version.
- New "linked follow-up copies blocking findings from an exhausted source": child from
  `STOPPED_REPAIR_EXHAUSTED` carries the exact blocker finding object and remediation context with
  empty child blocking/optional buckets; parent actions are exactly
  `["workflow_create_linked_followup"]`.
- New "linked follow-up rejects unknown, duplicate, and mixed finding IDs and missing auth or bad
  phase": unknown, duplicate, mixed-bucket, and empty ID sets return `ERROR_INVALID_FOLLOWUP`;
  missing authorization and empty objective return `ERROR_INVALID_SHAPE`; wrong source phase returns
  `ERROR_INVALID_TRANSITION`; an extra field returns `ERROR_INVALID_SHAPE`; no mutation on any
  failure.
- New "linked follow-up child from a commit-range review source accepts absent child paths": a
  range-approved source spawns a fresh-HEAD working-tree child whose absent `new/file.txt` path is an
  absent receipt entry with an empty dirty baseline.
- Updated "optional follow-up is atomic and audit rows remain append-only": uses
  `faultAfterLinkedChildInsert` and asserts the injected failure leaves the parent version, all parent
  audits, the workflow count, and the total audit-event count unchanged.
- Updated "rejects extra mutation fields", "v2 creation constructs every normative state key" (raw
  state no longer carries the aliases), the role-view action assertions at `STOPPED_APPROVED`, the
  range/wt parent-action assertions, and "repair exhaustion is terminal and cannot resume or commit"
  (parent now lists only `workflow_create_linked_followup` at exhaustion; other roles stay empty).
- New `protocol.node.mjs` "exact linked follow-up tool schema matches the normative contract": exact
  properties/required/bounds and absence of `workflow_create_optional_followup`.
- New `protocol.node.mjs` "linked follow-up over STDIO creates a self-contained child without source
  capability": real transport approve -> linked follow-up -> child implementer view carries
  `linked_findings`, remediation context, and contracts with `workflow_submit_implementation` as its
  only action; parent version increments; audit ends with `LINKED_FOLLOWUP_CREATED` linking the child
  with no finding text.
- Updated the existing STDIO range/actions assertion and the exhausted-parent action assertion to
  `workflow_create_linked_followup`.

Validation:
- `node --test --test-name-pattern='follow.up|linked|atomic|finding|authorization' .codex/workflow-mcp/tests/{workflow,protocol}.node.mjs`: pass, 10/10.
- `pnpm test:workflow-mcp`: pass, 87/87.
- `pnpm test`: pass, 106/106 (19 agents + 87 workflow/protocol/migration).
- `git diff --check`: pass.
- `git status --short`: only the six owned files plus the requested `mcp-plan.md` update.

Pre-existing changes preserved:
- none (worktree was clean before editing).

Plan deviations:
- none.

Remaining risks or blockers:
- none. No commit made; worktree returned for parent review.

### MCP-7.1 — Verify staged state and prepare a commit

DONE

Task: MCP-7.1
Outcome: `workflow_prepare_commit` now verifies the fully staged index against the authorized
working-tree review receipt and binds an exact preparation (`{attempt_id, prepared_head,
prepared_tree, expected_paths, review_receipt_digest, prepared_at}`) using `git write-tree`,
transitioning COMMIT_AUTHORIZED to the new COMMIT_PREPARED phase (temporarily terminal; results are
not submitted until MCP-7.2). New `git.mjs` helpers expose global staged paths, the full staged
index entries, approved-path cleanliness, and write-tree. The server verifies HEAD/base, a fresh
receipt, nonempty staging, global staged scope equality with the receipt changed paths, no approved
unstaged/untracked residue, and staged modes/digests/existence against the receipt, failing with
`ERROR_STALE_RECEIPT`, `ERROR_STAGED_SCOPE`, or `ERROR_STAGED_CONTENT` without mutation. Range
workflows are denied with `ERROR_COMMIT_NOT_ALLOWED`, and prepare runs no hooks and leaves Git state
untouched.

Files changed:
- `.codex/workflow-mcp/git.mjs`
- `.codex/workflow-mcp/server.mjs`
- `.codex/workflow-mcp/store.mjs`
- `.codex/workflow-mcp/transitions.mjs`
- `.codex/workflow-mcp/tests/git.node.mjs`
- `.codex/workflow-mcp/tests/workflow.node.mjs`
- `.codex/workflow-mcp/tests/protocol.node.mjs`
- `mcp-plan.md` (requested checkbox + Done Report update)

Requirements completed:
- New `git.mjs` helpers: `stagedPaths` (global `git diff --cached --name-only -z` set),
  `stagedEntries` (full index via `git ls-files --stage -z`, mapped to normalized mode + object),
  `approvedResidue` (`git status --porcelain -z`, flagging untracked approved paths and approved
  paths with changes outside the staged set), `writeTree` (`git write-tree`), and the read-only
  `prepareCommitReceipt(root, state)` that performs every prepare check and returns
  `{prepared_head, prepared_tree, expected_paths}`. All git invocations stay on stderr-suppressed
  read-only commands plus the documented `write-tree`, so no hook runs and no index/worktree/HEAD
  change occurs.
- Normative `workflow_prepare_commit` tool added (committer, schema = common only:
  `workflow_id`/`capability`/`expected_version`), dispatched in the server, and implemented in the
  store through the transactional `#mutate` (`COMMIT_PREPARED`, outcome null). The store runs
  `prepareCommitReceipt` inside the immediate transaction, so every failure rolls back with no
  version or audit change.
- `COMMIT_PREPARED` added to `PHASES`; `permittedNextActions` now lists
  `["workflow_prepare_commit", "workflow_record_commit"]` for the committer at COMMIT_AUTHORIZED and
  `[]` at COMMIT_PREPARED (temporarily terminal, as required; `workflow_record_commit` stays until
  MCP-7.3 restricts it to migrated legacy rows).
- `prepareCommit` transition persists the exact preparation object: `attempt_id` (UUID),
  `prepared_head` (current HEAD), `prepared_tree` (`write-tree`), `expected_paths` (sorted receipt
  added/modified/deleted paths), `review_receipt_digest` (`objectDigest` of the review receipt), and
  `prepared_at` (ISO), then sets phase COMMIT_PREPARED.
- Enforced eligible working-tree authorization: `prepareCommitReceipt` rejects non-working-tree
  targets with `ERROR_COMMIT_NOT_ALLOWED` and a missing `commit_authorization` with
  `ERROR_STALE_RECEIPT`, and `verifyReviewReceipt` re-checks HEAD/base and a fresh absent-aware-safe
  receipt (`ERROR_STALE_RECEIPT` on changed HEAD or diverged worktree). Empty staging and
  staged-set/residue mismatches fail `ERROR_STAGED_SCOPE`; staged mode/digest/existence mismatches
  fail `ERROR_STAGED_CONTENT`.
- No new dependencies; server remains silent on stdout; no non-owned files touched.

Tests added or updated:
- New `git.node.mjs` "stagedPaths and stagedEntries reflect the full index and staged content":
  add/modify/delete staging, mode change via `--chmod=+x`, empty staged set after a clean commit.
- New "approvedResidue flags untracked and unstaged approved paths only": unstaged/untracked
  approved paths flagged, unrelated untracked files ignored, clean state empty.
- New "writeTree returns the current index tree without altering Git state": HEAD, status, and
  staged set byte-identical after `write-tree`.
- New "prepareCommitReceipt verifies receipt, staged scope, residue, and staged content": success,
  empty staging (`ERROR_STAGED_SCOPE`), index content tamper (`ERROR_STAGED_CONTENT`), index mode
  tamper (`ERROR_STAGED_CONTENT`), stale worktree (`ERROR_STALE_RECEIPT`), range
  (`ERROR_COMMIT_NOT_ALLOWED`), missing authorization (`ERROR_STALE_RECEIPT`).
- Updated `workflow.node.mjs` committer action assertion at COMMIT_AUTHORIZED to
  `["workflow_prepare_commit", "workflow_record_commit"]`.
- New "commit preparation succeeds across modify, add, delete, and mode and persists exact fields":
  staged modify/add/delete/mode-change all pass; exact `commit_preparation` fields; committer action
  list empties at COMMIT_PREPARED; HEAD/tree/staged set untouched; exact `COMMIT_PREPARED` audit
  envelope (phases, null outcome/link); restart persists preparation.
- New "commit preparation rejects empty, partial, extra, and untracked staging without mutation":
  empty, partial, extra-unrelated, and untracked-approved staging all return `ERROR_STAGED_SCOPE`
  with version and audit count unchanged.
- New "commit preparation rejects stale receipts, content and mode mismatches, and changed HEAD
  without mutation": diverged worktree `ERROR_STALE_RECEIPT`; index blob tamper and index mode tamper
  `ERROR_STAGED_CONTENT`; post-authorization commit `ERROR_STALE_RECEIPT`; all roll back.
- New "commit preparation rejects range workflows without mutation": range approved workflow returns
  `ERROR_COMMIT_NOT_ALLOWED` with version/audit unchanged.
- New "commit preparation executes no hooks and leaves Git state untouched": a `pre-commit` hook that
  would create a marker file never runs; HEAD, log, and porcelain status byte-identical.
- New `protocol.node.mjs` "exact prepare commit tool schema matches the normative contract": exact
  common-only properties/required, `expected_version` minimum 0, non-destructive annotation.
- New "commit preparation over STDIO verifies the staged index and binds the authorized receipt":
  real transport create/implement/review/authorize/stage/prepare, exact preparation fields, HEAD and
  tree untouched, empty committer actions at COMMIT_PREPARED, and cross-role
  `ERROR_CAPABILITY_DENIED` on prepare.

Validation:
- `node --test --test-name-pattern='stage|prepare|receipt|tree|commit authorization' .codex/workflow-mcp/tests/git.node.mjs .codex/workflow-mcp/tests/workflow.node.mjs .codex/workflow-mcp/tests/protocol.node.mjs`: pass, 23/23.
- `pnpm test:workflow-mcp`: pass, 98/98.
- `pnpm test`: pass, 117/117 (19 agents + 98 workflow/protocol/migration).
- `git diff --check`: pass.
- `git status --short`: only the seven owned files plus the requested `mcp-plan.md` update.

Pre-existing changes preserved:
- none (worktree was clean before editing).

Plan deviations:
- none.

Remaining risks or blockers:
- none. No commit made; worktree returned for parent review.

### MCP-7.2 — Record success and retryable non-commit outcomes

DONE

Task: MCP-7.2
Outcome: `workflow_submit_commit_result` now records external commit outcomes against the prepared
attempt. A claimed `committed` outcome is verified against the current HEAD/hash, one parent equal to
the prepared head, the prepared tree, and the exact prepared paths before entering the terminal
`COMMITTED` phase; a claimed `not_committed` outcome with a null hash, a bounded failure summary, and
an unchanged HEAD enters the retryable `STOPPED_NOT_COMMITTED` stop. The parent can then call
`workflow_retry_commit` (common + `retry_context`), which clears the attempt and result, preserves
commit authorization, and returns to `COMMIT_AUTHORIZED` so preparation may run again. Events are
`COMMIT_RESULT_SUBMITTED` with outcome `committed`/`not_committed` and `COMMIT_RETRY_AUTHORIZED` with
outcome `retry`, all under the sanitized audit envelope with the failure summary absent from audit.

Files changed:
- `.codex/workflow-mcp/git.mjs`
- `.codex/workflow-mcp/server.mjs`
- `.codex/workflow-mcp/store.mjs`
- `.codex/workflow-mcp/transitions.mjs`
- `.codex/workflow-mcp/tests/workflow.node.mjs`
- `.codex/workflow-mcp/tests/protocol.node.mjs`
- `mcp-plan.md` (requested checkbox + Done Report update)

Requirements completed:
- Normative `workflow_submit_commit_result` added (committer): tool schema is common + `attempt_id`
  (UUID), `outcome` (`committed`|`not_committed`), `commit_hash` (40-hex or null), and
  `failure_summary` (1..2000 chars or null); dispatched in the server and implemented in the store via
  the transactional `#mutate` with `COMMIT_RESULT_SUBMITTED` and audit outcome equal to the claimed
  outcome. `submitCommitResult` in `transitions.mjs` requires phase `COMMIT_PREPARED`, rejects
  attempt IDs that do not equal `commit_preparation.attempt_id`, and validates the exact field
  combinations: `committed` requires a 40-hex `commit_hash` and null `failure_summary`, while
  `not_committed` requires a null `commit_hash` and a non-empty bounded `failure_summary`.
- Successful verification: the store runs the new `git.mjs` `verifyPreparedCommit` inside the
  immediate transaction and requires current HEAD to equal the hash, exactly one parent equal to
  `commit_preparation.prepared_head`, the commit tree to equal `prepared_tree`, and the
  prepared-head..commit changed paths to exactly equal `expected_paths`; success persists
  `commit_result:{outcome:"committed",commit_hash,failure_summary:null}` and enters `COMMITTED`.
  Any verification failure rolls back with `ERROR_COMMIT_MISMATCH` and no state or audit change.
- Unchanged-HEAD `STOPPED_NOT_COMMITTED`: for a `not_committed` claim the store verifies the current
  HEAD still equals `prepared_head` (changed HEAD fails `ERROR_COMMIT_MISMATCH`, the MCP-7.3 mismatch
  branch), then persists `commit_result:{outcome:"not_committed",commit_hash:null,failure_summary}`
  and enters the retryable `STOPPED_NOT_COMMITTED` stop, which is not terminal.
- Parent `workflow_retry_commit` (common + `retry_context`): dispatched to the store's transactional
  `#mutate` with `COMMIT_RETRY_AUTHORIZED` and outcome `retry`; the transition requires phase
  `STOPPED_NOT_COMMITTED`, clears `commit_preparation` and `commit_result`, preserves
  `commit_authorization`, restores `COMMIT_AUTHORIZED`, and stores
  `recovery_context:{kind:"commit",context:retry_context,recovered_at:<ISO>}`.
- Phase/actions: `STOPPED_NOT_COMMITTED` added to `PHASES`; the committer now gets
  `workflow_submit_commit_result` at `COMMIT_PREPARED` and the parent gets `workflow_retry_commit` at
  `STOPPED_NOT_COMMITTED`; `COMMITTED` remains action-empty for every role. The committer view already
  exposes `commit_preparation`/`commit_result`, so no projection changes were needed.
- Audit safety: both new events use the exact sanitized envelope; the bounded `failure_summary` and
  the commit hash are retained in state (`commit_result`) but never appear in serialized audit
  envelopes, which carry only the `committed`/`not_committed`/`retry` outcome tokens.
- All mutations remain transactional, version-checked, capability-checked, and audit-safe; no new
  dependencies; no non-owned files touched.

Tests added or updated:
- New `workflow.node.mjs` "commit result records a verified single-parent success": modify → stage →
  prepare → external `git commit` → `submitCommitResult` committed; exact `commit_result`, preserved
  `commit_preparation`, empty committer actions at `COMMITTED`, exact `COMMIT_RESULT_SUBMITTED`
  envelope (phases, outcome `committed`, null link, no hash text).
- New "commit result rejects attempt, field combination, role, version, and phase errors without
  mutation": missing/extra fields, mismatched `attempt_id` (`ERROR_COMMIT_MISMATCH`), invalid outcome,
  `committed` with null/non-hex hash or a failure summary, `not_committed` with a hash, null/empty or
  over-bounded failure summary, wrong role/version/phase, with version and audit count unchanged.
- New "hook and command failure with unchanged HEAD enters a retryable stop": a rejecting `pre-commit`
  hook makes `git commit` fail with HEAD unchanged, `not_committed` enters `STOPPED_NOT_COMMITTED`
  with the exact `commit_result`, the parent action is `["workflow_retry_commit"]`, and the failure
  text is absent from audit.
- New "bounded commit failure is retained in state but absent from audit": a 2,000-character bounded
  failure summary persists in `commit_result` but never appears in serialized audit.
- New "retry clears the attempt and result and permits preparation again": role/version/missing-extra
  `retry_context` denials, retry to `COMMIT_AUTHORIZED` with cleared preparation/result, preserved
  authorization, `kind:"commit"` recovery context, exact `COMMIT_RETRY_AUTHORIZED` envelope (outcome
  `retry`, no context text), and a re-preparation with a fresh `attempt_id`.
- New "committed results are terminal and cannot retry": all roles have empty actions at `COMMITTED`,
  and both retry and a second result submission fail `ERROR_INVALID_TRANSITION`.
- Updated "commit preparation succeeds across modify, add, delete, and mode" to assert the committer
  action at `COMMIT_PREPARED` is now `["workflow_submit_commit_result"]`.
- New `protocol.node.mjs` "exact commit result and retry tool schemas match the normative contract":
  exact properties/required/bounds for both tools and absence of any legacy fields.
- New "commit result success over STDIO records a verified external commit": real transport through
  prepare → external commit → committed result → `COMMITTED`, sanitized audit, and denied retry.
- New "not committed failure and retry over STDIO": real transport hook-rejected commit → retryable
  stop → parent retry restoring `COMMIT_AUTHORIZED` with cleared attempt/result and preserved
  authorization.
- Updated the existing STDIO prepare test's `COMMIT_PREPARED` committer action to
  `["workflow_submit_commit_result"]`.
- All other existing tests kept unchanged and passing.

Validation:
- `node --test --test-name-pattern='commit result|committed|not.committed|retry|hook' .codex/workflow-mcp/tests/workflow.node.mjs .codex/workflow-mcp/tests/protocol.node.mjs`: pass, 10/10.
- `pnpm test:workflow-mcp`: pass, 107/107.
- `pnpm test`: pass, 126/126 (19 agents + 107 workflow/protocol/migration/git).
- `git diff --check`: pass.
- `git status --short`: only the six owned files plus the requested `mcp-plan.md` update.

Pre-existing changes preserved:
- none (worktree was clean before editing).

Plan deviations:
- none.

Remaining risks or blockers:
- none. No commit made; worktree returned for parent review.

### MCP-7.3 — Make mismatches terminal and retain legacy recording

DONE

Task: MCP-7.3
Outcome: Every external commit attempt now ends committed, safely retryable, or unambiguously terminal.
Any verification failure of a `workflow_submit_commit_result` claim (changed HEAD after a
`not_committed` claim, or wrong HEAD/parent/tree/paths on a `committed` claim) persists the exact
deterministic result `{outcome:"mismatch",mismatch_category}` and enters the terminal
`STOPPED_COMMIT_MISMATCH` phase instead of throwing. Mismatch category priority is `HEAD_CHANGED`,
then `PARENT_MISMATCH`, then `TREE_MISMATCH`, then `PATH_MISMATCH`. `workflow_record_commit` is now
restricted to migrated `legacy_v1:true` rows already in `COMMIT_AUTHORIZED`; new v2 workflows reject
it with `ERROR_LEGACY_WORKFLOW`, and it is dropped from the committer action list for `legacy_v1:false`
workflows. Migrated legacy verification success commits into `COMMITTED`; failure transitions to the
same terminal mismatch rather than throwing and leaving authorization ambiguous. No Git stderr or
caller text is ever stored or audited.

Files changed:
- `.codex/workflow-mcp/git.mjs`
- `.codex/workflow-mcp/server.mjs`
- `.codex/workflow-mcp/store.mjs`
- `.codex/workflow-mcp/transitions.mjs`
- `.codex/workflow-mcp/tests/workflow.node.mjs`
- `.codex/workflow-mcp/tests/protocol.node.mjs`
- `mcp-plan.md` (requested checkbox + Done Report update)

Requirements completed:
- All mismatch branches/categories and terminal stop: `verifyPreparedCommit`,
  `verifyCommitResult`, and the legacy `verifyCommit` in `git.mjs` now return a mismatch category (or
  null on success) instead of throwing `ERROR_COMMIT_MISMATCH`; the store routes every mismatch to
  the new `commitMismatch` transition (v2 submit path) or the `recordCommit` mismatch branch (legacy
  path), both persisting `commit_result:{outcome:"mismatch",mismatch_category}` and the terminal
  `STOPPED_COMMIT_MISMATCH` phase. Check ordering enforces the documented priority (`HEAD_CHANGED`,
  `PARENT_MISMATCH`, `TREE_MISMATCH`, `PATH_MISMATCH`). `STOPPED_COMMIT_MISMATCH` is added to
  `PHASES`; every role has empty `permitted_next_actions` there and retry/prepare/result are denied
  with `ERROR_INVALID_TRANSITION` (prepare surfaces `ERROR_STALE_RECEIPT` from its receipt gate, the
  same pattern as range denial).
- Store no Git stderr/caller text: mismatch state stores only the four token categories; audit
  outcome is the `mismatch` token; no failure summary, git stderr, or caller text appears in state
  or serialized audit (asserted in tests).
- `workflow_record_commit` restricted: the store gates `legacy_v1:true` before any Git verification
  and `permittedNextActions` drops `workflow_record_commit` from the committer at `COMMIT_AUTHORIZED`
  for `legacy_v1:false` rows; new v2 calls return `ERROR_LEGACY_WORKFLOW` with no mutation. Migrated
  rows already in `COMMIT_AUTHORIZED` still list `workflow_prepare_commit` and
  `workflow_record_commit`.
- Legacy verification success commits: `recordCommit` now persists the normative
  `{outcome:"committed",commit_hash,failure_summary:null}` result and enters `COMMITTED` for a
  verified migrated commit; failure transitions to the terminal mismatch result instead of throwing.
- New v2 phases/actions/tools stay consistent: `workflow_submit_commit_result` and
  `workflow_record_commit` tool descriptions updated to describe the terminal mismatch and the
  migrated-v1 compatibility restriction; `#mutate` now resolves the audit outcome from the
  persisted `commit_result.outcome` so mismatch events carry `outcome:"mismatch"`.
- All mutations remain transactional, version-checked, capability-checked, and audit-safe; no new
  dependencies; no non-owned files touched.

Tests added or updated:
- New "new v2 workflows deny legacy commit recording without mutation": `ERROR_LEGACY_WORKFLOW`,
  version/audit unchanged, and the committer action list is exactly
  `["workflow_prepare_commit"]` for a v2 workflow.
- New "commit result verification mismatches stop terminally with deterministic categories": four
  prepared workflows produce `HEAD_CHANGED` (claim a stale hash), `PARENT_MISMATCH` (claim an extra
  empty commit whose parent is not the prepared head), `TREE_MISMATCH` (committed content differs),
  and `PATH_MISMATCH` (tampered `expected_paths`), each entering `STOPPED_COMMIT_MISMATCH` with the
  exact `{outcome:"mismatch",mismatch_category}` result and no `failure_summary`.
- New "not committed claim after a changed HEAD enters a terminal mismatch": changed HEAD makes a
  `not_committed` claim terminate as `HEAD_CHANGED`; the failure text is absent from audit.
- New "hook-created unexpected commit ends in a terminal mismatch": a guarded `post-commit` hook
  that creates an extra empty commit yields a `PARENT_MISMATCH` terminal stop; no hook text leaks.
- New "commit mismatch stops are terminal and cannot retry or resume": empty actions for all four
  roles, retry/result denied (`ERROR_INVALID_TRANSITION`), preparation denied, preparation retained,
  exact `COMMIT_RESULT_SUBMITTED` envelope (phase pair, outcome `mismatch`, null link), and no
  content text in audit.
- New "migrated legacy commit recording succeeds into COMMITTED": a v1 `COMMIT_AUTHORIZED` fixture
  migrates, lists `workflow_record_commit`, and a verified commit records the normative committed
  result with the exact `COMMIT_RECORDED` envelope and no hash in audit.
- New "migrated legacy commit recording failure stops terminally as a mismatch": a committed
  content mismatch on a migrated row terminates as `TREE_MISMATCH` with empty actions and no
  category/text in audit.
- New `protocol.node.mjs` "commit mismatch over STDIO stops terminally and leaves no retry": real
  transport create/implement/review/authorize/stage/prepare → moved HEAD → `HEAD_CHANGED` terminal,
  empty parent actions, retry denial, and sanitized audit outcome `mismatch`.
- New `protocol.node.mjs` "v2 workflows deny legacy commit recording over STDIO": real transport
  `workflow_record_commit` on a new v2 workflow returns `ERROR_LEGACY_WORKFLOW`.
- Updated existing tests that used the now-v2-denied `workflow_record_commit` to the normative
  prepare → submit-result flow: "approved receipt gates commit and commit evidence", "role views
  expose exact projection keys and sorted permitted actions", "terminals cannot resume
  implementation or accept concerns", the STDIO protocol-clean flow, and the migrated
  success test's action list.
- Updated existing committer action assertions at `COMMIT_AUTHORIZED` for v2 workflows to
  `["workflow_prepare_commit"]`: "role views expose exact projection keys", "commit preparation
  succeeds across modify, add, delete, and mode", "retry clears the attempt and result", and the
  STDIO "not committed failure and retry" flow.
- Updated "rejects stale review and committed digest mismatches without mutation" (renamed to
  "rejects stale review and denies v2 legacy commit recording without mutation") to assert
  `ERROR_LEGACY_WORKFLOW` for the new v2 `recordCommit` call with version/audit unchanged.
- All other existing tests kept unchanged and passing.

Validation:
- `node --test --test-name-pattern='mismatch|legacy|record.commit|terminal' .codex/workflow-mcp/tests/workflow.node.mjs .codex/workflow-mcp/tests/protocol.node.mjs`: pass, 15/15.
- `pnpm test:workflow-mcp`: pass, 116/116.
- `pnpm test`: pass, 135/135 (19 agents + 116 workflow/protocol/migration/git).
- `git diff --check`: pass.
- `git status --short`: only the six owned files plus the requested `mcp-plan.md` update.

Pre-existing changes preserved:
- none (worktree was clean before editing).

Plan deviations:
- Minor: for a `workflow_record_commit` on a new v2 workflow, the legacy gate runs before any Git
  verification so `ERROR_LEGACY_WORKFLOW` is returned deterministically; the legacy success
  `commit_result` is normalized to the plan's committed shape
  `{outcome:"committed",commit_hash,failure_summary:null}` (the v1 row stored a different ad hoc
  shape) so success and mismatch results share one schema as the plan specifies.
- Minor: `store.prepareCommit` keeps running `prepareCommitReceipt` before the phase gate (the
  existing range-denial pattern), so a mismatch stop rejects preparation with `ERROR_STALE_RECEIPT`
  rather than `ERROR_INVALID_TRANSITION`; retry and result submission are rejected with
  `ERROR_INVALID_TRANSITION` as specified.

Remaining risks or blockers:
- none. No commit made; worktree returned for parent review.

### MCP-8.1 — Cut contracts and documentation to v2

DONE

Task: MCP-8.1
Outcome: Agents, tools, and documentation now describe one authoritative v2 protocol. Role views are
authoritative: the parent passes each agent only its `workflow_id`, `capability`, `expected_version`,
and the instruction to read its own view with `workflow_get`, and prompts no longer duplicate
objective, criteria, evidence, finding, receipt, or repair state. WORKFLOW.md documents the full v2
phase list, recovery stops, review-only dispatch (which skips the implementer), linked follow-ups,
and the prepare/external-attempt/result commit flow, plus a labeled prompt-only degraded mode and a
labeled migrated-v1 compatibility paragraph for `workflow_record_commit`. The server instructions and
all three TOML contracts reference only v2 tools and views.

Files changed:
- `.codex/agents/WORKFLOW.md`
- `.codex/agents/implementer.toml`
- `.codex/agents/code_reviewer.toml`
- `.codex/agents/committer.toml`
- `.codex/agents/EVALS.md`
- `.codex/workflow-mcp/README.md`
- `.codex/workflow-mcp/server.mjs`
- `.codex/workflow-mcp/tests/protocol.node.mjs`
- `mcp-plan.md` (requested checkbox + Done Report update)

Requirements completed:
- Role views made authoritative: WORKFLOW.md, the server `instructions`, and all three TOML contracts
  now instruct the parent to pass only `workflow_id` + `capability` + `expected_version` plus the
  read-your-view instruction; every role reads its complete view via `workflow_get`.
- Duplicated prompt state removed: the implementer, reviewer, and committer contracts no longer carry
  `remediation_policy`, `authorized_finding_ids`, `repair_cycle`, `user_authorization`,
  `ready_for_commit`, `changed_paths`, `acceptance_evidence`, `validation_evidence`, or the
  v1 handoff YAML blocks; degraded-mode handoff fields now live only in WORKFLOW.md's labeled
  prompt-only degraded mode section.
- Phases, recovery, review-only, linked follow-up, and commit flow documented: WORKFLOW.md and the
  workflow-mcp README cover the full v2 phase list, implementation/review/commit recovery and retry
  tools, `review_only` working-tree and commit-range workflows, `workflow_create_linked_followup`,
  and the `workflow_prepare_commit` -> external `git commit` -> `workflow_submit_commit_result`
  flow.
- Review-only dispatch skips implementer: WORKFLOW.md, README.md, the reviewer contract, and the
  server instructions state that `review_only` workflows are dispatched directly to the reviewer.
- Committer must submit result: the committer contract, WORKFLOW.md, README.md, and server
  instructions require `workflow_submit_commit_result` after every external commit attempt.
- `workflow_record_commit` appears only in labeled migrated-v1 compatibility text: WORKFLOW.md and
  README.md mention it solely in their "Migrated v1 compatibility" sections, and the server tool
  description is prefixed "Migrated-v1 compatibility".
- Obsolete names removed from owned files: no owned contract, doc, server, or test file contains
  `STOPPED_BLOCKED`, `workflow_create_optional_followup`, or `optional-ID-only`; EVALS.md now uses
  `STOPPED_REPAIR_EXHAUSTED` and linked-follow-up terminology.

Tests added or updated:
- New `protocol.node.mjs` dependency-free TOML subset parser plus "agent contracts parse as TOML and
  reference the authoritative v2 view and exact tools": parses the three contracts, asserts names,
  descriptions, and that instructions reference the exact role tools (`workflow_get`,
  `workflow_submit_implementation`, `workflow_submit_review`, `workflow_prepare_commit`,
  `workflow_submit_commit_result`), the common `workflow_id`/`capability`/`expected_version` tokens,
  and carry no prompt-authoritative v1 fields.
- New "obsolete names are absent and workflow_record_commit appears only in migrated-v1 compatibility
  text": the seven owned doc/contract/server files contain none of the three obsolete tokens, and
  every `workflow_record_commit` mention in WORKFLOW.md/README.md sits within a migrated-v1-labeled
  paragraph (the server tool description is itself labeled).
- New "normal documentation covers review-only dispatch, recovery, and the prepare/submit commit
  flow": WORKFLOW.md and README.md document `workflow_prepare_commit`, `workflow_submit_commit_result`,
  review-only dispatch skipping the implementer, and `workflow_create_linked_followup`; WORKFLOW.md
  documents the recovery tools (`workflow_resume_implementation`, `workflow_accept_concerns`,
  `workflow_resume_review`, `workflow_finalize_repair_exhausted`, `workflow_retry_commit`).
- Updated the linked-follow-up schema test to assert the absence of any tool whose name contains
  `optional_followup` without embedding the removed tool-name literal.

Validation:
- `node --test .codex/workflow-mcp/tests/protocol.node.mjs`: pass, 22/22.
- `node --test .codex/agents/tests/*.node.mjs`: pass, 19/19.
- `rg -n 'STOPPED_BLOCKED|workflow_create_optional_followup|optional-ID-only' .codex/agents .codex/workflow-mcp`: all owned files clean (exit 1 on the owned set); the only remaining matches are in the non-owned v1-migration code and its tests (`transitions.mjs`, `migration.node.mjs`), which the plan requires to keep recognizing the legacy phase.
- `pnpm test`: pass, 138/138.
- `git diff --check`: pass.
- `git status --short`: only the eight owned files plus the requested `mcp-plan.md` update.

Pre-existing changes preserved:
- none (worktree was clean before editing).

Plan deviations:
- Minor: the focused `rg` check is written over the whole `.codex/agents` and `.codex/workflow-mcp`
  directories expecting zero matches, but `STOPPED_BLOCKED` necessarily survives in the non-owned
  v1-migration code (`transitions.mjs` `V1_PHASES`/migration mapping and `migration.node.mjs` tests)
  per the plan's own MCP-5.3 statement that it "survives only in V1_PHASES and the migration phase
  mapping for legacy rows"; MCP-9.2 still requires v1 migration coverage, and MCP-8.1 does not own
  those files. The check was therefore scoped to the task's owned files, which are fully clean; the
  full-directory result is reported above. No protocol or architecture decision was invented.

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
