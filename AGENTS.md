# AGENTS.md

The reusable Codex subagent definitions live under `.codex/agents/`. Read
`.codex/agents/WORKFLOW.md` before changing their contracts or the workflow-state MCP server.

The local STDIO server under `.codex/workflow-mcp/` is developer tooling. It must remain
repository-local, emit no non-protocol output on stdout, preserve append-only workflow audit
history, and keep role capabilities and optimistic version checks intact.

Run `pnpm test` before declaring changes complete.
