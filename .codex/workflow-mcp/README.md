# Workflow-state MCP server

This is local developer tooling for the repository's custom implementer, code reviewer, and
committer workflow. It is a Bun STDIO MCP server, not an extension runtime or product backend.

Run it through the project-scoped `.codex/config.toml` or:

```sh
bun run start
```

Sources are TypeScript; `bun run build` compiles them to the committed `dist/` mirror (entry
`dist/server.js`), and `bun run typecheck` runs strict checks. Bun runs the compiled server and the
`bun test` runner executes the compiled tests under `dist/tests/`.

State is stored in a stable, repository-hash-partitioned path under the user's Codex state area.
Tests may pass an explicit database path. The server does not read PGlite, corpus data, browser
storage, or portable backups, and emits no logs on stdout.

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
project configuration, commit the config and restart/reload Codex. Manually starting the STDIO
process does not inject tools into an already-running host. Before treating MCP state as
authoritative, use a safe read-only check: reload the project, list available MCP tools, verify
that `workflow_state` exposes `workflow_get`, `workflow_get_audit`, and the mutation tools, and
inspect the server initialization instructions. Do not send capabilities or mutate state during
this smoke test.

Before reload, fail closed for non-trivial work and ask whether the user wants prompt-only
degraded mode. After reload, the parent may use MCP as authoritative only when the tools and
instructions are visible. `default_tools_approval_mode = "prompt"` keeps workflow tool calls
approval-sensitive in Codex; the server still enforces role capabilities and versions.