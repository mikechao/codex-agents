# Workflow-state MCP server

This is local developer tooling for the repository's custom implementer, code reviewer, and
committer workflow. It is a Node 22 STDIO MCP server, not an extension runtime or product backend.

Run it through the project-scoped `.codex/config.toml` or:

```sh
pnpm start
```

State is stored in a stable, repository-hash-partitioned path under the user's Codex state area.
Tests may pass an explicit database path. The server does not read PGlite, corpus data, browser
storage, or portable backups, and emits no logs on stdout.

The parent creates a workflow and passes only the one-time role capability to the matching agent.
Every mutation supplies the current `expected_version`. Capabilities are stored only as SHA-256
hashes and are defense-in-depth orchestration controls, not a security boundary against another
process with equivalent filesystem access. If the server is unavailable for non-trivial work, the
parent must ask the user before using prompt-only degraded mode.

`APPROVED` is a hard stop for optional findings. Explicit optional work creates a fresh linked
workflow. Commit authorization is separate from review approval, and commit recording verifies
current HEAD, parent, changed paths, modes, and content digests against the review receipt.

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
