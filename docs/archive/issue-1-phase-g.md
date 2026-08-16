# Issue 1 — Phase G spec: `server.ts` (MCP SDK v2 boundary) + `index.ts`

Detailed planning for Phase G of `issue-1-plan.md`. Converts `.codex/workflow-mcp/server.mjs` to
TypeScript on the MCP TypeScript SDK v2 (`@modelcontextprotocol/server`), converts `index.mjs` to
`index.ts`, deletes both `.mjs` entry files (the compiled `dist/server.js` becomes the entry), and
flips the two remaining server-entry references (`.codex/config.toml`, `install-into.sh`). All tool
names, schemas, annotations, request semantics, error results, and STDIO lifecycle are preserved.

## 0. Current state and prerequisites

- Phases A–F landed and committed. `pnpm typecheck` passes; oracle subset is 98/98. Phase F spec
  archived.
- `server.mjs` (650 lines) imports the v1 SDK; `index.mjs` is the 4-line barrel. Remaining
  `.mjs` files: the five shims (`errors/validation/git/transitions/store.mjs`) and the `.mjs`
  tests.
- Server-entry references outside `.mjs`: `.codex/config.toml:4` and `install-into.sh:57` (both
  point at `server.mjs`). `package.json start` already points at `dist/server.js` (Phase A).
  Docs (`WORKFLOW.md`, `README.md`, `AGENTS.md`) do not reference `server.mjs`.
- No `.mjs` test that can currently load spawns `server.mjs` (protocol/protocol-v2/migration —
  the spawners — are unloadable until Phase I), so deleting the `.mjs` entry breaks no oracle test.

## 1. Verified v2 API facts (from the installed `@modelcontextprotocol/server@2.0.0` types)

- `Server` class + `ServerOptions` (includes `capabilities`, `instructions`) exported from the
  package root; constructor unchanged: `new Server({ name, version }, options)`.
- Spec-method handler registration: `setRequestHandler("tools/list", handler)` /
  `setRequestHandler("tools/call", handler)`; the handler receives the request envelope
  (`request.params`). No server-side argument validation on the low-level path (our runtime
  validation stays authoritative).
- `CallToolRequestParams.arguments` is `Record<string, unknown> | undefined` — `request.params.arguments ?? {}`
  is directly indexable, no cast.
- `Tool` (exported): `{ name; title?; description?; annotations?: { title?; readOnlyHint?;
  destructiveHint?; idempotentHint?; openWorldHint? }; inputSchema: { type: "object";
  properties?: Record<string, JSONValue>; required?: string[]; [key: string]: unknown }; ... }`.
  Our `additionalProperties`, `oneOf`, `const`, `pattern`, `enum` members fall under the index
  signature; `annotations` matches our five fields verbatim.
- `JSONValue`, `CallToolResult`, `ListToolsResult` exported from the root.
- `StdioServerTransport` exported ONLY from `@modelcontextprotocol/server/stdio`;
  `new StdioServerTransport()` defaults to `process.stdin`/`process.stdout`.
- Default stdio wiring serves the 2025-era `initialize` handshake (no 2026-07-28 opt-in needed).

## 2. Imports and local types

```ts
#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import type { CallToolResult, JSONValue, ListToolsResult, Tool } from "@modelcontextprotocol/server";
import { fail, safeError } from "./errors.js";
import { openStore } from "./store.js";
import type { WorkflowStore } from "./store.js";

type JsonSchema = Record<string, JSONValue>;
```

## 3. Tool schema fragments and `tools: Tool[]`

The JSON-Schema fragments keep their exact current shapes, annotated only:

```ts
const common: {
  type: "object";
  properties: Record<string, JSONValue>;
  required: string[];
  additionalProperties: false;
} = { /* unchanged: workflow_id/capability/expected_version */ };

const resolutionMapSchema: JsonSchema = { /* unchanged */ };
const findingSchema: JsonSchema = { /* unchanged */ };
const workingTreeReviewTargetSchema: JsonSchema = { /* unchanged */ };
const commitRangeReviewTargetSchema: JsonSchema = { /* unchanged */ };
const createReviewTargetSchema: JsonSchema = { oneOf: [workingTreeReviewTargetSchema, commitRangeReviewTargetSchema] };
```

The `schema()` helper (replaces the untyped builder):

```ts
function schema(
  properties: Record<string, JSONValue>,
  required: readonly string[],
  extra: Record<string, JSONValue> = {},
): Tool["inputSchema"] {
  return { type: "object", properties, required, additionalProperties: false, ...extra };
}
```

No casts needed: `Tool["inputSchema"]` accepts the literal `type: "object"`, the
`Record<string, JSONValue>` properties, and the `additionalProperties: false` / spread members via
its index signature. Annotating `export const tools: Tool[] = [ ... ]` (16 tools, verbatim names,
descriptions, schemas, and `annotations`) resolves every remaining literal-widening; the
`workflow_create` input uses `schema({ ...common.properties, workflow_type: {...}, ... },
[...common.required, ...], ...)` exactly as today.

## 4. `createServer`

```ts
function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function errorResult(error: unknown): CallToolResult {
  const safe = safeError(error);
  return { isError: true, content: [{ type: "text", text: JSON.stringify(safe) }] };
}

export function createServer(store: WorkflowStore = openStore()): Server {
  const server = new Server(
    { name: "workflow-state", version: "1.0.0" },
    { capabilities: { tools: {} }, instructions },
  );
  server.setRequestHandler("tools/list", async () => ({ tools }));
  server.setRequestHandler("tools/call", async (request) => {
    try {
      const args = request.params.arguments ?? {};
      let result;
      switch (request.params.name) {
        case "workflow_create": result = store.create(args); break;
        case "workflow_get": result = store.get(args.workflow_id, args.role, args.capability); break;
        case "workflow_get_audit": result = store.audit(args.workflow_id, args.role, args.capability); break;
        /* ...remaining 13 dispatches verbatim... */
        default: fail("ERROR_UNKNOWN_TOOL", "tool is not available");
      }
      return json(result);
    } catch (error) {
      return errorResult(error);
    }
  });
  return server;
}
```

Notes:
- `instructions` text is copied verbatim from `server.mjs`.
- `args.workflow_id`/`args.role`/`args.capability` are `unknown` — they match the store's `unknown`
  boundary params by design (validation happens in the store in the established order).
- `result` infers the union of store returns; `json(result)` takes `unknown`.

## 5. `main()` and entry guard (verbatim wiring)

```ts
export async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  let store: WorkflowStore | undefined;
  let server: Server | undefined;
  let shuttingDown = false;
  let connected = false;
  const shutdown = async (exitCode: number | null = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    try { if (connected && server) await server.close(); } catch { /* already closed */ }
    try { await transport.close(); } catch { /* already closed */ }
    store?.close();
    if (exitCode !== null) process.exitCode = exitCode;
  };
  transport.onclose = () => { void shutdown(null); };
  process.stdin.once("end", () => { void shutdown(null); });
  process.once("SIGINT", () => { void shutdown(0); });
  process.once("SIGTERM", () => { void shutdown(0); });
  store = openStore();
  server = createServer(store);
  await server.connect(transport);
  connected = true;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(() => (process.exitCode = 1));
}
```

`transport.onclose` assignment, `server.close()`, and `server.connect(transport)` are the v2
transport contract (unchanged from v1). The compiled `dist/server.js` runs this guard identically.

## 6. `index.ts`

```ts
export { WorkflowError } from "./errors.js";
export { createServer } from "./server.js";
export { openStore, resolveStatePath, WorkflowStore } from "./store.js";
export * from "./transitions.js";
```

## 7. Deletions and entry-path flips (deviation from issue-1-plan.md)

- **Delete `server.mjs` and `index.mjs`** — no shims. The compiled `dist/server.js` is the entry
  (package `start` already points there; the unloadable SDK tests spawn the path that Phase I will
  update to `dist/server.js`).
- **Flip the two remaining server-entry references NOW** (they point at a file that no longer
  exists; the umbrella plan listed them under Phase J, but leaving them stale would break the
  project's own Codex config the moment `server.mjs` is deleted):
  - `.codex/config.toml` line 4: `args = ["--no-warnings", ".codex/workflow-mcp/dist/server.js"]`.
  - `install-into.sh` line 57: `args = ["--no-warnings", '$project_root/.codex/workflow-mcp/dist/server.js']`.
  Phase J then covers only the docs, EVALS note, installer artifact guard, and mcp-plan.md notes.
- The five remaining shims (`errors/validation/git/transitions/store.mjs`) stay until Phase I — the
  `.mjs` tests still import them.

## 8. Verification

1. `pnpm typecheck` passes.
2. `pnpm build` emits `dist/server.js`, `dist/index.js` (plus existing); committed.
3. Oracle (SDK-free subset) passes: `pnpm build && node --test
   .codex/workflow-mcp/tests/git.node.mjs .codex/workflow-mcp/tests/lifecycle.node.mjs
   .codex/workflow-mcp/tests/workflow.node.mjs` — 98/98. (The SDK-importing spawner tests remain
   unloadable until Phase I — pre-existing.)
4. **STDIO smoke test** (covers the compiled entry now that no test spawns it): start
   `node --no-warnings .codex/workflow-mcp/dist/server.js`, drive a raw JSON-RPC session — send
   `initialize` (2025-era params), `notifications/initialized`, `tools/list` (assert the 16 tool
   names), and one `tools/call` of `workflow_get` with a fabricated id (assert an
   `isError` result with `ERROR_NOT_FOUND`); then SIGTERM and assert exit. Assert stdout contains
   only JSON-RPC frames (no stray output).
5. Grep: `rg -n 'server\.mjs|index\.mjs' .codex install-into.sh .codex/config.toml package.json`
   matches nothing except historical docs (`docs/archive/`, `issue-1-plan.md`); no
   `@modelcontextprotocol/sdk` references in sources.
6. `git diff --check` clean; worktree clean after the oracle build; commit `server.ts`, `index.ts`,
   the deletions, `dist/`, `config.toml`, and `install-into.sh` together.

## 9. Decision points (with recommendation)

1. **No `server.mjs` shim — real deletion + entry flip** — RECOMMENDED: the entry is the compiled
   artifact; only unloadable tests referenced the `.mjs` path, and config/installer are flipped in
   this phase (deviation, section 7).
2. **`Tool["inputSchema"]` as the `schema()` return type with `Record<string, JSONValue>`** —
   verified against the installed v2 types; zero casts, literal `type: "object"` preserved.
3. **`json`/`errorResult` annotated `CallToolResult`** — the `type: "text"` literal needs the
   contextual return type.
4. **Handlers use the spec-method string form** and keep reading `request.params` (envelope form);
   our own runtime validation remains the only argument gate.
5. **`main()` wiring copied verbatim** — including the `import.meta.url` entry guard and
   shutdown/exit-code behavior.
6. **`index.ts` re-exports identical names** — no surface change.

## 10. Done criteria for Phase G

- `server.ts` compiles on `@modelcontextprotocol/server` v2 with every tool/schema/annotation and
  the STDIO lifecycle intact; `index.ts` re-exports the same surface.
- `server.mjs` and `index.mjs` deleted; `dist/server.js` is the committed entry; `config.toml` and
  `install-into.sh` point at `dist/server.js`.
- `pnpm typecheck`, oracle subset (98/98), and the raw-STDIO smoke test (section 8.4) all pass.
- No remaining `@modelcontextprotocol/sdk` imports in sources; no `server.mjs`/`index.mjs`
  references in runnable code or config.
- `git diff --check` clean; single commit containing sources, deletions, `dist/`, and the two
  config/installer path flips.