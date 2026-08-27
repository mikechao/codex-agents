# AGENTS.md

This is a Bun ESM project. Bun is required to run the local MCP server, the test suite, and the
package manager (`bun install`/`bun run`); TypeScript/tsc handles static typechecking via
`tsc --noEmit`; Biome owns formatting and linting for the TypeScript/JavaScript/JSON sources
listed in the root `biome.json`. The reusable `implementer`, `code_reviewer`, and `committer`
definitions are host adapters: Codex TOML under `.codex/agents/` and OpenCode Markdown under
`.opencode/agents/` are both generated from the canonical host-neutral fragments in
`.codex/agents/contracts/` and `.codex/agents/model-policy.yaml` by `bun run generate:agents`; the checked-in definitions must stay
byte-identical to the generator output (`bun run test:agents` enforces this). The project-scoped
configuration in `.codex/config.toml` registers the local workflow-state server for Codex; the
root `opencode.json` registers the same server for direct OpenCode use of this repository and applies
the native built-in `agent.plan` mediator override, and
`install-into.ts` registers it for OpenCode in target repositories. The generated
`implementer`, `code_reviewer`, and `committer` files are the shared cross-host worker adapters;
.opencode also receives OpenCode-only generated `planner` and hidden read-only `explorer` adapters;
`.opencode/agents/orchestrator.md` is intentionally an OpenCode-only `mode: primary` agent outside
the shared generator and must not be added to the host-neutral contracts or overwritten by
generation. The root `opencode.json` selects that primary with `default_agent: "orchestrator"` and
does not inject orchestration instructions globally into the built-in Build agent. The installer
copies the orchestrator into target repositories, adds the canonical Plan override only when
`agent.plan` is absent, refuses malformed agent shapes, defaults a new OpenCode config (or one without
`default_agent`) to `orchestrator`, and preserves existing explicit `default_agent`, `agent.plan`,
and unrelated configuration while still installing the orchestrator as an available primary agent.
The historical v2
implementation spec and the TypeScript/SDK-v2 migration records live under `docs/archive/`.

`.codex/agents/model-policy.yaml` is the only supported edit point for managed worker model and
reasoning assignments. It supports distinct Codex and OpenCode assignments by role; the typed
generator owns permissions, sandboxing, tools, and other structural host configuration. Generation
and installation materialize fresh definitions in memory. Policy changes activate on generation or
installation, not through hot reload, and running host sessions must be restarted to load changed
definitions. Model policy is host metadata and is not carried in delegation prompts or Workflow MCP
state.

## Architectural boundaries

- Self-hosting bootstrap, immutable runtime artifacts, runtime affinity, and reload recovery are
  self-hosting concerns; do not make them installed-target requirements without an independent
  target-repository need.
- Runtime-specific workflow values—including work items, plans, findings, capabilities, versions,
  and receipts—come from authoritative runtime state and must not be embedded in reusable, static,
  or generated agent definitions, examples, or fixtures.
- Workflow MCP is the authoritative durable state boundary. Model handoffs should carry only the
  necessary routing or semantic context and must not replace an authoritative lookup with
  conversation memory or duplicate durable state.
- Worker attempts, retries, process lifecycle, and worktree or execution-loop mechanics are
  orchestration concerns unless persistence is required for correctness or recovery; they should
  not create workflow fields or phases by default.
- Planner-to-explorer fan-out is disposable OpenCode context: keep explorer findings, transcripts,
  counts, and retries out of Workflow MCP and plan artifacts. Repository-specific planning guidance
  belongs in the optional target-owned `.codex/planner-policy.json`, not reusable contracts.
- Built-in OpenCode Plan is the user-facing planning mediator: it delegates persisted planning and
  refinements to generated `planner`, parent-reads and presents exact `full_plan` text, and explicitly
  approves. Orchestrator is execution-only for an exact current approved plan and retains the direct
  non-plan workflow fallback; do not duplicate plan state or authority in prompts or agents.
- Host reload, stale configuration, transport, and similar infrastructure failures belong at their
  owning boundary; do not model them as workflow-domain phases without genuine durable meaning.

For normative workflow semantics, read `.codex/agents/WORKFLOW.md`; do not duplicate its state
machine here or add transition details, recovery procedures, operator runbook content, or unfinished
planner mechanics.

Read `.codex/agents/WORKFLOW.md` before changing an agent contract or the workflow-state MCP
server. Keep the generated host definitions, workflow documentation, MCP tool schemas and
transitions, and their tests consistent. When an agent contract changes, regenerate the host
definitions (`bun run generate:agents`), keep the generator's per-host frontmatter accurate, and
use `.codex/agents/EVALS.md` as the manual evaluation checklist; add to `EVAL_RESULTS.md` only
for scenarios actually executed.

The local STDIO server under `.codex/workflow-mcp/` is developer tooling. It must remain
repository-local, emit no non-protocol output on stdout, preserve append-only workflow audit
history, and keep parent capability authentication and optimistic version checks intact. Runtime SQLite state
belongs outside the repository by default; tests may override its location explicitly.

Use `bun run test:agents` for focused receipt/contract checks, `bun run test:installer` for
focused installer checks, and `bun run test:workflow-mcp` for focused server checks. Run the full
`bun run test` suite before declaring any change complete.

The workflow-state server and its tests are TypeScript under `.codex/workflow-mcp/` and run
directly from source with Bun; there is no compiled `dist/` mirror.

Biome is the single formatter/linter for the supported sources included in the root
`biome.json` (the hidden `.codex/**/*.ts` tree, `install-into.ts`, and root JSON config).
`bun run format` applies Biome formatting; `bun run format:check`, `bun run lint`, and
`bun run check` are read-only gates that must never modify the working tree. TOML stays outside
Biome: `.codex/agents/*.toml` and `.codex/config.toml` continue to rely on
`Bun.TOML.parse` and the existing semantic assertions.

`bun run validate` (`bun run check && bun run typecheck && bun run test`) is the normal
pre-completion/pre-commit validation gate and must leave the working tree unchanged. A change is
complete only when Biome check, `tsc --noEmit`, and the full `bun run test` suite all pass.

Subprocess execution keeps Node-compatible `node:child_process` (`execFileSync`/`spawnSync`)
semantics: Bun's `spawnSync` does not throw on `maxBuffer` overflow (it SIGTERMs with no error),
so the binary-blob protections and `ERROR_GIT`/`ERROR_RECEIPT_UNAVAILABLE` categorization rely on
the Node APIs and must not be swapped out. TOML contracts and project config are parsed with
`Bun.TOML.parse`, not a custom parser.
