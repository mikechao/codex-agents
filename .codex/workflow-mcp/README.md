# Workflow-state MCP server

This is local developer tooling for the repository's custom implementer, code reviewer, and
committer workflow. It is a Bun STDIO MCP server, not an extension runtime or product backend.

Workflow state schema v6 optionally persists generic immutable `work_items` provenance. Each
provider-neutral record has `provider`, `id`, exact `display_ref`, and nullable absolute HTTP(S) `url`.
The field survives restart and is inherited by linked follow-ups; parent and committer views expose it,
while implementer and reviewer views omit it. It cannot broaden scope, criteria, remediation, receipts,
review, or commit authorization. Schema v5 state requires a clean reset rather than implicit migration.

Managed commits use only authoritative committer-view provenance: one neutral `Refs <display_ref>`
line per distinct display reference, preserving exact text and first occurrence. Empty provenance emits
no lines; there is no tracker discovery/API call and no `Fixes`, `Closes`, or `Resolves` inference.

Run it through the project-scoped `.codex/config.toml` (Codex) or the `workflow_state` local MCP
registration that `install-into.ts` writes into the project's `opencode.json`/`opencode.jsonc`
(OpenCode), or directly:

```sh
bun run start
```

When this repository hosts itself, both host registrations materialize `bootstrap.ts` from the
provider checkout's committed `HEAD` before starting it; a dirty checkout copy cannot replace the
launcher. The bootstrap requires the supervised and provider paths to resolve to the same canonical
Git root, then the supervisor resolves the provider's committed runtime and launches only its
immutable artifact. It proxies requests for older unfinished workflows to the artifact that owns
them. The hosts share repository-hash-partitioned durable state, so workflows are interchangeable
between hosts.

Installed repositories use a different boundary: their Codex and OpenCode registrations invoke the
provider's absolute `.codex/workflow-mcp/server.ts` directly. The installer does not copy the
bootstrap, supervisor, or runtime-artifact sources, and installed mode has no runtime-artifact
affinity or promotion lifecycle; the direct server operates on the target repository's Git and
durable state.

Sources are TypeScript and run directly under Bun (`server.ts`); `bun run typecheck` runs strict
`tsc --noEmit` checks. There is no compiled `dist/` mirror and no build step.

State is stored in a stable, repository-hash-partitioned path under the user's Codex state area.
Tests may pass an explicit database path. The server does not read PGlite, corpus data, browser
storage, or portable backups, and emits no logs on stdout.

## Opt-in diagnostics

The tactical diagnostic flight recorder is disabled unless `WORKFLOW_MCP_DIAGNOSTICS=1` is present
in the process environment. When enabled, each supervisor or runtime process appends bounded JSONL
records to `~/.codex/state/workflow-mcp/<repository-hash>/diagnostics/`, using one
`supervisor-<pid>.jsonl` or `runtime-<pid>.jsonl` file. Files stop recording at 64 KiB and startup
keeps only the newest eight files for each process layer; cleanup and write failures are ignored.

Records are limited to timestamps, process/layer, JSON-RPC correlation IDs, method/tool names,
bounded workflow-ID metadata, database path, lookup outcome, bounded runtime identity/revision,
phase/version, and a small safe error category set. They never contain request arguments or results,
capabilities, hashes or attestation material, environment contents, authorization text, plans,
findings, or receipts. Supervisor records show request receipt, affinity, selected runtime,
forwarding, and routing outcomes; runtime records show tool receipt and result. A malformed ID and a
valid but absent ID are therefore distinguishable only in diagnostics while both remain public
`ERROR_NOT_FOUND` results. A lookup record localizes a problem to the supervisor-store or
runtime-store layer; diagnostics are observational and outside WorkflowState and audit authority.

## Runtime artifacts

`materializeRuntimeArtifact(repositoryRoot, revision)` (also exported as
`resolveRuntimeArtifact`) resolves a full committed Git revision to a deterministic `runtime_id`
and an absolute `runtimePath`. The trusted manifest is deliberately narrow: it contains the server's
local import closure, both receipt modules, and the committed `package.json`/`bun.lock` dependency
metadata. Literal string dynamic imports are supported and included in the committed closure;
non-literal dynamic imports are rejected. It reads those bytes from Git, never from dirty checkout
files, rejects committed runtime symlinks, and rejects missing local imports rather than silently
producing an incomplete runtime.

Artifacts are installed and validated in a staging directory, then atomically renamed into an
external content-addressed cache under `~/.codex/state/workflow-mcp/runtime-artifacts` (or an
explicit external cache root). A completion marker and manifest are checked on every reuse, so a
partial or corrupted entry is rebuilt. Cache entries may not be symlinks, and validation and reuse
reject cache or artifact paths that escape the external cache/artifact boundary or resolve back into
the supervised repository. The returned artifact is self-contained, including its committed source
closure and production dependencies, and can be launched with Bun using `runtimePath` while keeping
the supervised repository as the working directory.

`runtime_id` hashes the trusted runtime closure and committed package metadata while excluding the
revision selector from the identity. Therefore selector-only differences that resolve to the same
trusted inputs, and unrelated repository changes, do not change the ID.

The manifest's `revision` is historical materialization metadata and is intentionally not part of
artifact reuse validation. A reused artifact is launched for the requested revision, which remains
bound to that launch by the ephemeral HMAC attestation.

This abstraction owns revision resolution, trusted-input fingerprinting, packaging, validation, and
cache publication. The supervisor persists the returned `runtime_id` plus committed provider
revision on every new workflow. A provider commit never hot-swaps an already running child; after a
host restart the new default artifact is promoted for new workflows while affinity routes existing
workflows back to their owner. Missing, mismatched, corrupt, or unlaunchable artifacts fail closed
with `ERROR_RUNTIME_ISOLATION` or `ERROR_RUNTIME_RECOVERY`, never as capability or receipt errors.

The store is the runtime-ownership enforcement boundary. After parent capability authentication for
control-plane operations, an
affined workflow may be read or mutated only by a store whose complete `WORKFLOW_MCP_RUNTIME_ID`
and `WORKFLOW_MCP_RUNTIME_REVISION` match the persisted owner and which has a valid ephemeral
`WORKFLOW_MCP_RUNTIME_ATTESTATION`/nonce pair signed with the private key stored in the immutable
artifact containing the executing `store.ts`/`server.ts`. The store derives that artifact from its
own module location and requires the external artifact markers, manifest, closure digests, and
dependency tree to validate against the supplied identity; the key path is not configurable.
Environment configuration cannot redirect attestation verification to a key borrowed from another
artifact or from mutable checkout code. Missing, mismatched, or unverifiable identity or launch
attestation returns
`ERROR_RUNTIME_ISOLATION` before role views, audit reads, transition callbacks, or linked follow-up
insertion; an incomplete persisted pair remains `ERROR_RUNTIME_RECOVERY`. The per-artifact key and
per-child attestation are kept outside the checkout, are never persisted in workflow state, and are
not exposed through MCP. This also protects state from direct mutable `server.ts` launches, while
leaving un-affined installed-mode and temporary/in-memory test stores compatible. Supervisor routing
may inspect affinity and adopt an un-affined current row before dispatching it; those are
supervisor-only paths.

On restart, the supervisor reopens the same durable database, resolves the persisted owning
revision, and launches that immutable runtime, so unfinished workflows remain safely routable
across runtime promotions. Invalid persisted state fails closed at startup with an actionable
`ERROR_STATE_CORRUPT`, `ERROR_MIGRATION_REQUIRED`, or runtime-recovery diagnostic on stderr; the
STDIO server never writes diagnostics to stdout.

## Self-host A-to-B dogfooding lifecycle

The self-hosted regression is deliberately chronological: start the self-hosted host on committed runtime A,
create a workflow, edit approved runtime paths and commit them as B, verify the running A child is
unchanged, then restart the host. Bootstrap promotes B for new workflows and routes the unfinished
A workflow to a recovered A child. Installed hosts intentionally do not exercise this lifecycle:
they invoke the provider server directly and do not persist runtime affinity.

## Authoritative role views

The parent creates a workflow and receives one parent capability. Delegation passes workers only the
exact `workflow_id`; each worker first calls its dedicated capability-free getter
(`workflow_implementer_get`, `workflow_reviewer_get`, or `workflow_committer_get`). The returned view
is the authoritative least-authority projection for that role and carries the role's full handoff and
its sorted `permitted_next_actions`; prompts carry no duplicated objective, criteria, evidence, finding,
receipt, or repair state. Only the parent capability is stored as a SHA-256 hash. If the server is
unavailable for non-trivial work, the parent must ask the user before using the documented prompt-only
degraded mode.

The reviewer view includes the authoritative sanitized `review_target` for inspection. Managed
reviewers submit only semantic findings and prior classifications to `workflow_submit_review`; the
target is not accepted from the model at that boundary. Workflow MCP uses the persisted target for
working-tree snapshot and receipt gating, and rejects corrupt or stale authoritative target state.

## Phases, recovery, and stops

### Append-only scope expansion

The approved plan remains immutable, while the parent may append exact repository-relative paths to
an active working-tree `change` workflow with `workflow_expand_scope`. The action requires fresh
user authorization naming the paths and records a bounded reason, authorization-time version, and
clean tracked or absent baseline. Dirty paths, directories, globs, duplicates, already-approved
paths, and scope overflow are rejected. Expansion is unavailable during review, approval, commit,
exhausted, and terminal phases, does not consume a repair cycle, and clears stale implementation and
review evidence so a fresh implementation and review are required.

```text
IMPLEMENTING, REVIEWING, REPAIR_REQUIRED, REPAIRING,
STOPPED_CONCERNS, STOPPED_NEEDS_CONTEXT, STOPPED_IMPLEMENTATION_BLOCKED,
STOPPED_INCONCLUSIVE, STOPPED_APPROVED, STOPPED_REPAIR_EXHAUSTED,
COMMIT_AUTHORIZED, COMMIT_PREPARED, STOPPED_COMMIT_PREPARATION, STOPPED_NOT_COMMITTED,
STOPPED_COMMIT_MISMATCH, COMMITTED
```

- `change` workflows start `IMPLEMENTING` and advance through implementation to review. `review_only`
  workflows start `REVIEWING` and are dispatched directly to the reviewer, skipping the implementer;
  they may review the working tree or a commit range.
- Implementation context and block stops resume to their prior active phase with
  `workflow_resume_implementation`; a concerns stop enters review under explicit user authorization
  with `workflow_accept_concerns`.
- An inconclusive review resumes with `workflow_resume_review`. `REPAIR_REQUIRED` advances through
  bounded cycles with `workflow_authorize_repair`; when the final cycle is reached,
  `workflow_finalize_repair_exhausted` stops terminally.
- `STOPPED_APPROVED` and `STOPPED_REPAIR_EXHAUSTED` can spawn a fresh cycle-0 linked change workflow
  with `workflow_create_linked_followup`, copying the exact findings and remediation context. The
  child mutation allowlist remains narrow; remediation approval transitions it back to `REVIEWING`
  with an authoritative combined target covering the inherited logical-change scope. Only a fresh
  independent approval of that combined target can authorize a commit, and the source workflow is
  superseded so it cannot create a competing successor or commit.
  `APPROVED` is a hard stop for optional findings; explicit optional work creates that fresh linked
  workflow instead of silently continuing the loop.

## Commit flow

Commit authorization is separate from review approval and is valid only for approved working-tree
workflows with a fresh review receipt; commit-range workflows reject it. After authorization, the
committer stages complete approved paths and calls `workflow_prepare_commit`, which checks the
current HEAD and the staged scope, file modes, and blob digests against the authorized receipt,
rejects approved-path residue, and binds the exact prepared tree and path set without changing Git
state. Rename paths are always represented as exact delete+add paths; staged and post-commit path
derivation disables Git rename detection. The committer then runs the external `git commit` and
submits only the semantic result with
`workflow_submit_commit_result` whether the attempt succeeded or failed; it does not supply a commit
SHA. Workflow MCP observes and verifies the authoritative Git state. Result submission verifies the
current HEAD, commit parent, prepared tree, and changed paths against the prepared attempt (or
confirms that HEAD stayed unchanged for a
not-committed result), then persists the verified SHA. A verified commit enters the
terminal `COMMITTED` phase; an unchanged-HEAD failure enters the retryable `STOPPED_NOT_COMMITTED`
stop cleared by `workflow_retry_commit`; any verification mismatch enters the terminal
`STOPPED_COMMIT_MISMATCH`. Supported failures before a commit exists enter
`STOPPED_COMMIT_PREPARATION` with a bounded category/diagnostic, timestamp, failed version, and
recovery class. Scope/content failures expose `workflow_retry_commit_preparation`; stale receipt
failures expose `workflow_return_commit_to_review`, which clears authorization and requires fresh
review and fresh commit authorization. No committer action is permitted while stopped.

## Persistence schema

Workflow MCP supports one current persisted schema (v6, including linked-continuation provenance).
Incompatible SQLite tables and persisted state
schemas fail closed at startup with an actionable reset-required `ERROR_MIGRATION_REQUIRED` diagnostic;
startup never performs implicit schema upgrades or row rewrites. Current workflows always use
`workflow_prepare_commit` plus `workflow_submit_commit_result` after commit authorization.

The current state stores `approved_plan` exactly in the JSON state: Plan-mode execution supplies the
non-empty approved text, while direct/non-plan workflows explicitly supply `null`. It is immutable
execution intent exposed only to parent and implementer views. Structured objective, paths, criteria,
validations, and remediation/findings remain enforceable contracts. Linked follow-ups receive their
own explicit plan input and never reconstruct or silently inherit the source plan. The current v4
state also stores append-only parent-only scope amendments and authorization-time baselines; v3
state is incompatible and requires resetting the database. State schema changes are clean breaks
and require resetting incompatible databases.

## Bootstrap and reload

This installation uses the previously authorized prompt/receipt bootstrap. After changing the
project configuration, commit the config and restart/reload the host (Codex and/or OpenCode).
Manually starting the STDIO process does not inject tools into an already-running host. Before
treating MCP state as authoritative, use a safe read-only check: reload the project, list
available MCP tools, verify that `workflow_state` exposes the dedicated role getters and
`workflow_get_audit`,
and the mutation tools, and inspect the server initialization instructions. Do not send
capabilities or mutate state during this smoke test.

Before reload, fail closed for non-trivial work and ask whether the user wants prompt-only
degraded mode. After reload, the parent may use MCP as authoritative only when the tools and
instructions are visible. `default_tools_approval_mode = "prompt"` keeps workflow tool calls
approval-sensitive in Codex; OpenCode agents instead gate the same tools per role through
permission blocks (see `.codex/agents/WORKFLOW.md`). The server still enforces the parent capability
and versions for both hosts.
