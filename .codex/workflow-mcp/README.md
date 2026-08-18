# Workflow-state MCP server

This is local developer tooling for the repository's custom implementer, code reviewer, and
committer workflow. It is a Bun STDIO MCP server, not an extension runtime or product backend.

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

This abstraction owns revision resolution, trusted-input fingerprinting, packaging, validation, and
cache publication. The supervisor persists the returned `runtime_id` plus committed provider
revision on every new workflow. A provider commit never hot-swaps an already running child; after a
host restart the new default artifact is promoted for new workflows while affinity routes existing
workflows back to their owner. Missing, mismatched, corrupt, or unlaunchable artifacts fail closed
with `ERROR_RUNTIME_ISOLATION` or `ERROR_RUNTIME_RECOVERY`, never as capability or receipt errors.

The store is the runtime-ownership enforcement boundary. After role capability authentication, an
affined workflow may be read or mutated only by a store whose complete `WORKFLOW_MCP_RUNTIME_ID`
and `WORKFLOW_MCP_RUNTIME_REVISION` match the persisted owner and which has a valid ephemeral
`WORKFLOW_MCP_RUNTIME_ATTESTATION`/nonce pair signed with the private key stored in that immutable
artifact. Missing, mismatched, or unverifiable identity or launch attestation returns
`ERROR_RUNTIME_ISOLATION` before role views, audit reads, transition callbacks, or linked follow-up
insertion; an incomplete persisted pair remains `ERROR_RUNTIME_RECOVERY`. The per-artifact key and
per-child attestation are kept outside the checkout, are never persisted in workflow state, and are
not exposed through MCP. This also protects state from direct mutable `server.ts` launches, while
leaving un-affined installed-mode and temporary/in-memory test stores compatible. Supervisor routing
may inspect affinity and adopt an un-affined legacy row before dispatching it; those are
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

The parent creates a workflow and passes each role only its one-time capability together with the
`workflow_id`, the current `expected_version`, and the instruction to read its own view with
`workflow_get`. The returned view is the authoritative least-authority projection for that role and
carries the role's full handoff and its sorted `permitted_next_actions`; prompts carry no duplicated
objective, criteria, evidence, finding, receipt, or repair state. Capabilities are stored only as
SHA-256 hashes and are defense-in-depth orchestration controls, not a security boundary against
another process with equivalent filesystem access. If the server is unavailable for non-trivial work,
the parent must ask the user before using the documented prompt-only degraded mode.

## Phases, recovery, and stops

```text
IMPLEMENTING, REVIEWING, REPAIR_REQUIRED, REPAIRING,
STOPPED_CONCERNS, STOPPED_NEEDS_CONTEXT, STOPPED_IMPLEMENTATION_BLOCKED,
STOPPED_INCONCLUSIVE, STOPPED_APPROVED, STOPPED_REPAIR_EXHAUSTED,
COMMIT_AUTHORIZED, COMMIT_PREPARED, STOPPED_NOT_COMMITTED,
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
  with `workflow_create_linked_followup`, copying the exact findings and remediation context.
  `APPROVED` is a hard stop for optional findings; explicit optional work creates that fresh linked
  workflow instead of silently continuing the loop.

## Commit flow

Commit authorization is separate from review approval and is valid only for approved working-tree
workflows with a fresh review receipt; commit-range workflows reject it. After authorization, the
committer stages complete approved paths and calls `workflow_prepare_commit`, which verifies the
fully staged index (HEAD, staged scope, modes, digests, and absence of residue) against the
authorized receipt and binds the exact prepared tree without changing Git state. The committer then
runs the external `git commit` and submits the result with `workflow_submit_commit_result` whether
the attempt succeeded or failed. A verified commit enters the terminal `COMMITTED` phase; an
unchanged-HEAD failure enters the retryable `STOPPED_NOT_COMMITTED` stop cleared by
`workflow_retry_commit`; any verification mismatch enters the terminal `STOPPED_COMMIT_MISMATCH`.
Recording verifies current HEAD, parent, changed paths, modes, and content digests against the
prepared attempt.

## Migrated v1 compatibility

`workflow_record_commit` exists only for migrated v1 workflows that were already in `COMMIT_AUTHORIZED`
at migration; new v2 workflows reject it with `ERROR_LEGACY_WORKFLOW`. For such a migrated row only,
it records an already-created Git commit after verifying current HEAD and reviewed content. New v2
workflows always use `workflow_prepare_commit` plus `workflow_submit_commit_result`.

## Bootstrap and reload

This installation uses the previously authorized prompt/receipt bootstrap. After changing the
project configuration, commit the config and restart/reload the host (Codex and/or OpenCode).
Manually starting the STDIO process does not inject tools into an already-running host. Before
treating MCP state as authoritative, use a safe read-only check: reload the project, list
available MCP tools, verify that `workflow_state` exposes `workflow_get`, `workflow_get_audit`,
and the mutation tools, and inspect the server initialization instructions. Do not send
capabilities or mutate state during this smoke test.

Before reload, fail closed for non-trivial work and ask whether the user wants prompt-only
degraded mode. After reload, the parent may use MCP as authoritative only when the tools and
instructions are visible. `default_tools_approval_mode = "prompt"` keeps workflow tool calls
approval-sensitive in Codex; OpenCode agents instead gate the same tools per role through
permission blocks (see `.codex/agents/WORKFLOW.md`). The server still enforces role capabilities
and versions for both hosts.
