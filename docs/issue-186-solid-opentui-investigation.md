# Issue #186: Solid/OpenTUI presentation boundary

Investigation date: 2026-09-24. Investigation only; no UI, dependency, model-policy,
agent-contract, or Workflow MCP changes.

## Recommendation

Use `context.ui.dialog.show(() => <AgentModelsView ... />)` with a project-local
TSX component, rendered inside OpenCode's existing Solid/OpenTUI root. Keep the
existing `app` slot for command registration. Set dialog options inside the
render callback/component, after `show` has replaced the previous dialog.

This works within the OpenCode **2.0.11** floor. No project build, bundler, `dist`,
or generated JavaScript is required. OpenCode supplies the runtime modules and
the Solid TSX transformation. Local typechecking/testing needs explicit UI
development dependencies and narrowly scoped TSX tooling configuration.

The current fallback is a **computed dynamic import bypassing the host's import
rewriting**, followed by ordinary package resolution failing because the project
does not install `@opentui/solid`. A literal import resolves the host-supplied
runtime successfully. Installing a separate renderer is not the appropriate fix.

There is a separate limit on future reactivity: the public plugin API exposes
persisted session selections and reactive provider/model catalogs, but does not
expose the TUI's private pending model selection or home-screen model preference.
Do not promise exact parity with the native model selector for those values.

## Baseline and provenance

Read the complete [#186 issue](https://github.com/mikechao/codex-agents/issues/186)
and [#185 discussion](https://github.com/mikechao/codex-agents/issues/185), then
inspected the checkout independently. Initial `git status --short` was empty;
branch was `main`, HEAD was
`7e5ac4dd1a06c0a4d4c139cb3bca7ceae34a1138`, “Polish OpenCode agent model defaults view.”

Inspected repository files:

- [TUI plugin](../.opencode/plugins/codex-agents-model-defaults/tui.ts), including
  command registration, formatting, custom rendering, and both alert paths.
- [Self-host dependencies](../.opencode/package.json): only `@opencode/plugin@2.0.11`.
- [View tests](../.codex/agents/tests/model-policy-view.test.ts): projection,
  formatting, and simulated slot/keymap cleanup; the dialog mock omits `show`.
- [Model-policy projection](../.codex/agents/model-policy.ts) and
  [assignments](../.codex/agents/model-policy.yaml): five assigned workers plus
  the orchestrator's explicit session-default inheritance marker. No live state
  belongs in this projection.
- Root package/lock/configuration, TypeScript/Biome configuration, and executable
  validation policy. The root also supplies `@opencode/plugin@2.0.11` as a dev
  dependency. Neither Solid nor OpenTUI is installed in repository node_modules.

| Item | Exact version inspected | Evidence |
| --- | --- | --- |
| OpenCode compatibility floor | 2.0.11, commit `9eb6902aaf3c35ce985b67c605a775992249066b` | GitHub tag and downloaded implementation source |
| Installed dogfood CLI | `@opencode/cli` 2.0.14, source commit `08462140ec0de1e4b17d4a353d8d5827f53cf7b0` | Installed manifest, executable `--version`, and live plugin `context.app.version` |
| Plugin SDK used by repository | `@opencode/plugin` 2.0.11 | Installed package implementation/declarations and repository manifests |
| OpenTUI Core/Solid/Keymap in both OpenCode tags | 0.5.10 | Both tags' package catalogs; Core and Solid published npm archives inspected |
| OpenTUI source tag | v0.5.10, commit `f6673a04ccb671b9207da358c57152bfd27c781f` | Resolved annotated GitHub tag |
| Solid in both OpenCode tags | 1.9.15, with OpenCode's cleanup patch | Both catalogs and `patches/solid-js@1.9.15.patch` |
| OpenTUI Solid package peer | `solid-js: 1.9.12` | Published `@opentui/solid@0.5.10` manifest; distinguish this from OpenCode's actual 1.9.15 |
| Bun | Local 1.3.13; installed OpenCode embeds 1.4.2 | `bun --version`; `Bun.version` logged inside the isolated TUI |

The installed command resolves through
`/Users/mike/.nvm/versions/node/v22.20.0/bin/opencode` to
`@opencode/cli/bin/opencode.exe`. A normal version invocation attempted to write
the user's log and was sandbox-blocked; the successful invocation redirected
XDG data/state/cache into the temporary investigation directory.

The current [Solid slot documentation](https://opentui.com/docs/plugins/solid/)
and [runtime-plugin documentation](https://opentui.com/docs/extend/runtime-plugins/)
were the starting point. Version conclusions below come from the pinned source
and packages, not an assumption that current documentation describes every release.

## Concrete fallback diagnosis

`showModelDefaults()` executes in this order:

1. Load YAML and call `projectOpenCodeModelDefaults`. This happens **outside** the
   broad catch; policy errors would not trigger this alert fallback.
2. Check whether `dialog.show` exists. It exists in both supported implementations
   and was a function in the installed-runtime probe.
3. Evaluate `const moduleName = "@opentui/solid/jsx-runtime"; await import(moduleName)`.
4. Only after import success, call `dialog.set`, then `dialog.show`, whose callback
   creates the box/text subtree.
5. Catch import/synchronous errors and open the formatted native alert.

**Step 3 fails in the inspected environment.** An isolated plugin in the installed
2.0.14 executable produced this error (temporary path abbreviated):

```text
ResolveMessage: Cannot find package '@opentui/solid' imported from
/private/tmp/<investigation>/probe/.opencode/plugins/probe/tui.ts
```

The same probe, in the same process and without installing dependencies, then
used `await import("@opentui/solid/jsx-runtime")`. It obtained a callable `jsx`,
successfully called `dialog.set` and `dialog.show`, entered the render callback,
and created a native text renderable.

To check the real command path as well, a temporary wrapper imported the
**unchanged repository plugin** by absolute path. It captured its registered
command and instrumented only the supplied context's `set`, `show`, and `alert`
methods. Executing `codex-agents.agent-models` logged:

```text
original: command, id: codex-agents.agent-models
original: alert, title: OpenCode agent model defaults (read-only), lines: 9
```

There were no `original: set` or `original: show` calls. Combined with the direct
computed-versus-literal import experiment and loader source, this localizes the
failure before dialog mutation or element construction. No production logging
was added. This reproduces the reported fallback in the currently installed
dogfood executable; it does not claim to recover a historical swallowed stack.

### Why the host map does not rescue this import

OpenCode's [runtime support entry](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/tui/src/plugin/runtime-plugin-support.bun.ts)
installs the Solid runtime support with an additional `@opencode/plugin/tui`
module containing the host's plugin context/provider. The
[Solid installer](https://github.com/anomalyco/opentui/blob/v0.5.10/packages/solid/scripts/runtime-plugin-support-configure.ts)
maps `@opentui/solid`, its components and JSX runtimes, `solid-js`, and
`solid-js/store`, alongside Core's host modules.

The [Core runtime loader](https://github.com/anomalyco/opentui/blob/v0.5.10/packages/core/src/runtime-plugin.ts)
rewrites recognized import strings to virtual module IDs backed by host export
objects. Its scanner handles static imports/re-exports and literal dynamic
imports/requires. It does not rewrite `import(moduleName)`. Although the loader
also registers resolution hooks, the computed import in the compiled executable
still takes the failing ordinary-resolution path, as the live comparison proves.

Thus “missing dependency” alone is an incomplete diagnosis: the host already
provides the desired module. The computed spelling prevents this code from using
the supported sharing mechanism. This is not an absent `dialog.show`, a failing
`dialog.set`, callback/JSX failure, or an observed Solid identity mismatch.

### Other defects hidden behind the import failure

- `createDialogApi.show` delegates to `dialog.replace`. The latter resets size to
  `medium` and centering to `false`. Consequently the current preceding `set`
  would be overwritten after fixing import resolution. Set presentation options
  in the new component/callback, as native dialogs do, or after `show` returns.
  See [API adapter](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/tui/src/plugin/api.tsx)
  and [dialog implementation](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/tui/src/ui/dialog.tsx).
- `style: { bold: true }` and `{ dim: true }` are not supported `TextOptions`
  emphasis properties in this version. The reconciler assigns style keys onto
  the node; text rendering consumes `attributes`, `fg`, and `bg`. Use
  `TextAttributes.BOLD`, `<b>`, and theme foreground tokens. The hand-written
  `Record<string, unknown>` runtime interface and double cast bypass this checking.
  See [text options](https://github.com/anomalyco/opentui/blob/v0.5.10/packages/core/src/renderables/TextBufferRenderable.ts)
  and [reconciler](https://github.com/anomalyco/opentui/blob/v0.5.10/packages/solid/src/reconciler.ts).
- The broad catch is not a reliable boundary for later reactive errors. Rendering
  runs in a host Solid subtree, and future updates can fail after the command
  returns. A follow-up should retain useful diagnostics and define a local Solid
  error boundary, rather than silently treating every problem as an alert fallback.
- Existing tests exercise the early “no show function” branch. They establish
  neither runtime import success nor rendering correctness.

## Supported OpenCode ownership boundary

The public [v2.0.11 Context](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/plugin/src/tui/context.ts)
provides `renderer`, `client`, `data`, theme getters, component-owned keymap layers,
and the following presentation APIs. Implementation was inspected, not just types.

| Surface | Ownership, lifecycle, styling | Suitability and compatibility |
| --- | --- | --- |
| `ui.dialog.show(render, onClose?)` and `set/clear` | OpenCode owns renderer, Solid root, modal input mode, backdrop, width constraints, focus restoration, and dismiss behavior. Plugin returns a Solid subtree wrapped in `PluginContextProvider`; component cleanup follows unmount. Theme tokens are available. | Recommended for six read-only rows. Supports later signals/memos/resources. Present in 2.0.11; runtime-loaded local TSX works. Activation teardown needs explicit handling for an open dialog, described below. |
| `ui.slot(claim)` | Host owns named slot locations and reactive input props; registrations return cleanup and are also tracked by activation. OpenCode's own Solid `For`/`Show` contributions and error boundaries manage subtrees. | Keep `append: "app"` for command registration. Sidebar/footer contributions suit persistent status; an app slot does not itself provide dialog layout or modal behavior. Same shared dependencies/source loading. |
| `ui.router.register({name, render})`, `navigate`, `current` | Host owns navigation and route render root; registered pages receive plugin context, keyed lifecycle, and plugin error boundary. Registrations are removed on deactivation. | Supported in 2.0.11, but a full route is excessive for this command. Appropriate only if a future model dashboard needs a whole page. Same source-first/reactive support. |
| `ui.panel.open/close/current` with `session.panel` slot | Host owns session panel layout/input and publishes session ID, width, focus and fullscreen state/actions. Activation teardown releases this plugin's panel. | Supported in 2.0.11; better for persistent session comparison. `open` returns false outside a session, making it unsuitable as the sole project-defaults view. Same source-first/reactive support. |
| Core renderables returned through the dialog callback | Construct `BoxRenderable`/`TextRenderable` with `context.renderer`, imported from the mapped host Core. Solid mounts/removes that renderable subtree. Plugin must clean up additional subscriptions. | Working renderer interop, confirmed experimentally; no separate public imperative dialog/slot API. Preserves source-first `.ts` but manual updates are less suitable than TSX for future reactivity. |
| `ui.dialog.alert/select` | Entire component and dismissal owned by host. Alert takes a string; select accepts option records. | Stable choices for messages or actual selection, but neither is an appropriate independently styled, nonselectable three-column view. No extra UI runtime dependencies. |

The [application root](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/tui/src/app.tsx)
creates the CLI renderer and calls OpenTUI Solid `render`, nesting dialog and
plugin providers within that root. The [plugin API adapter](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/tui/src/plugin/api.tsx)
wraps dialog/slot/route callbacks in the matching plugin context.
The [slot/route implementation](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/tui/src/plugin/render.tsx)
owns contribution placement, reactive props, and failure containment.

OpenCode uses its own slot registry/composition implementation. Generic OpenTUI
`createSolidSlotRegistry` documentation does **not** authorize plugins to create
new OpenCode slot locations. Use the host's `ui.slot` and published `SlotMap`.
It includes app, home/prompt footers, session composer/panel, and sidebar regions.
There is no separate general overlay API in this Context beyond dialog and these
host-owned surfaces.

Do not call `createCliRenderer`, start a second top-level `render`, append directly
to `context.renderer.root`, or install another runtime module map from this
plugin. Direct root mutation lacks the lifecycle/layout contract supplied by
dialog/slot/route. The imperative experiment instead returned its renderable
through `dialog.show`; it mounted successfully and `isDestroyed` became true
after `dialog.clear`. Solid's reconciler removes nodes and destroys detached
renderables on the next tick.

### Native styling

Read `context.theme.surface("dialog")` inside a reactive getter/memo, preserving
theme changes. Use `text.base` for primary cells, `text.muted` for reasoning and
inherited defaults, and restrained accent tokens if needed. Let the host draw
the dialog background; use row/column boxes, padding, widths and gaps for the
table, with a title/escape hint as content. Native dialogs use numeric text
attributes and these same theme surfaces. See
[theme types](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/theme/src/tui/types.ts),
[native alert](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/tui/src/ui/dialog-alert.tsx),
and [native selector](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/tui/src/ui/dialog-select.tsx).

The host's large width is 88 columns, capped at terminal width minus two. In the
80-column probe, setting large inside the callback yielded width 78. Follow-up
layout must account for padding and narrow terminals instead of relying only on
string padding.

## Source-first loading and dependencies

[Plugin discovery](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/tui/src/plugin/discovery.ts)
finds local plugin directories;
[Host.resolve/load](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/plugin/src/host.ts)
resolves the `tui` entry and imports it. The
[Bun source tracker](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/plugin/src/source.bun.ts)
scans local dependencies and invalidates modules on reload, leaving compilation
to the runtime loader. The
[Solid transform](https://github.com/anomalyco/opentui/blob/v0.5.10/packages/solid/scripts/solid-transform.ts)
uses the Solid universal transform and TypeScript stripping; the
[Bun plugin](https://github.com/anomalyco/opentui/blob/v0.5.10/packages/solid/scripts/solid-plugin.ts)
handles local JSX/TSX outside `node_modules`.

An isolated `.opencode/plugins/probe/tui.tsx` with **no package.json,
node_modules, tsconfig, or generated JS** was discovered by the installed CLI.
It imported `solid-js`, rendered JSX into `dialog.show`, changed a signal from
`initial` to `updated`, and the mounted text's `plainText` became `updated`.
Closing the dialog invoked its `onCleanup`. This demonstrates runtime TSX
transformation, shared reactive runtime, renderer ownership, and disposal.

Distinguish these requirements:

| Requirement | Conclusion for this repository |
| --- | --- |
| Runtime dependencies for this host-loaded view | No additional project runtime packages required for literal imports of mapped Solid/Core modules. OpenCode already supplies them. Keep the SDK boundary explicit. |
| JSX/TSX runtime support | Required, already installed by OpenCode before plugin loading. `@opentui/solid/runtime-plugin-support` is a package subpath used by the host, not an additional package or a plugin-side installation task. |
| Local static checking and UI tests | Declare the UI packages used by the future component/harness as root dev dependencies; ordinary `tsc` and `bun test` do not inherit a running OpenCode module map. |
| Build/transpile pipeline | No new project build. Transformation occurs in memory at host import time. Keep `tsc --noEmit`. |
| Packaged TSX under `node_modules` | Different constraint: the Solid runtime transform excludes it. Such a published plugin needs precompiled ESM. That does not apply to this project-local source plugin. |

For the proposed typed view using `TextAttributes`, signals/memos, JSX types, and
typed host theme tokens, the concrete development set is `@opentui/core@0.5.10`,
`@opentui/solid@0.5.10`, `solid-js@1.9.15`, and `@opencode/theme@2.0.11` alongside
the existing SDK. The theme package supplies the SDK's otherwise optional
`ResolvedTheme` type dependency; it need not be imported at runtime. Core is a
direct dependency if importing `TextAttributes` or renderable types; Solid also
depends on it transitively. These would belong in a follow-up's root dev
dependencies/lockfile, not be added blindly as `.opencode` production dependencies.

Resolve the published Solid adapter's exact 1.9.12 peer versus OpenCode's 1.9.15
deliberately when setting up local tests. OpenCode also patches Solid cleanup.
Production must use the host singleton, including its patch, rather than load a
second npm Solid instance. Do not import private `solid-js/dist/*` entrypoints or
copy OpenCode's patch into this repository to simulate production ownership.

Configure TypeScript to preserve JSX and use `jsxImportSource: "@opentui/solid"`
for typing; extend the existing agent/UI include boundary and Biome TSX coverage
as needed. The current Biome include pattern covers `.opencode/**/*.ts`, not
TSX. A local UI harness must install Solid runtime support **before** importing
the TSX under test and use the reactive Solid implementation, not Bun's ordinary
server export. This is test/runtime setup, not a build step.

### Version comparison

Byte comparisons between the complete v2.0.11 and v2.0.14 source archives found
identical plugin Context, API adapter, provider activation/cleanup, slot/route
renderer, runtime-support entry, dialog implementation, source tracker, local
model state, reactive client data implementation, theme types, and Solid patch.
Both catalogs pin the same OpenTUI and Solid versions. There is **no materially
relevant difference** for this recommendation or fallback.

Live experiments used 2.0.14, not a launched 2.0.11 executable. Floor support is
established by its directly inspected matching implementation. No minimum-version
increase is justified. The difference between local Bun 1.3.13 and the CLI's
embedded Bun 1.4.2 means standalone UI test setup still needs its own check; it
does not require changing this repository's Bun workflow.

## Lifecycle and future reactive state

The [plugin activation implementation](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/tui/src/plugin/context.tsx)
tracks registrations and setup's returned disposer. Slot removal disposes its
Solid contribution, including the component-owned keymap layer. Keep that
existing registration placement and cleanup behavior.

**Dialogs need an explicit plugin-deactivation rule.** The adapter wraps their
render callback but does not put dialog closure into the activation's owned
cleanup list. An open dialog can outlive removal of the command slot unless the
plugin handles it. Track this activation's open view with a token/active flag,
cleared by `show`'s `onClose` and component cleanup. On reload/deactivation,
invalidate pending opens and close only a dialog still owned by that activation.
Never unconditionally clear a different plugin's newer dialog. Keep view cleanup
idempotent and test replacement as well as Escape and explicit clear.

Create subscriptions inside the component's Solid owner, before asynchronous
work loses that owner. Register each unsubscribe with `onCleanup`; clear timers
and cancel or ignore stale request completions on close/session change. Prefer
existing reactive getters over duplicate event-maintained stores. Do not keep
view subscriptions in module scope, persistent storage, or model-policy.

Conceptual future boundary (not implemented):

```text
model-policy.ts: loadModelPolicy -> projectOpenCodeModelDefaults
  -> immutable configured-default rows, read once on command open

OpenCode Context: route/location + data getters + selected events
  -> presentation/controller adapter owned by the dialog component
  -> derived session/provider/model state and loading/error state

AgentModelsView(props)
  -> Solid memos for rows/theme/host state; signals/resources only as needed
  -> host dialog callback and renderer
  -> onCleanup releases subscriptions and pending work
```

Actual available inputs and their limits:

| Desired input | Public API and behavior |
| --- | --- |
| Current visible session | `context.ui.router.current()` returns home/session/plugin route; session route carries `sessionID`. Read in a memo. No session ID exists on home. |
| Persisted session model | `context.data.session.get(id)?.model` after `session.sync(id)` as needed. Model reference carries `providerID`, `id`, optional `variant`. This is the persisted selection, not every pending UI choice. |
| Providers and models | `context.data.location.provider.list(location)` and `.model.list(location)`, with `.sync(location)` for initial loading. Undefined means not loaded. Derive availability from supplied records; do not invent a connectivity status. |
| Location | Reactive `context.location`, or `context.data.location.default()` when absent; use the session's location when inspecting a particular session. Key any fetching/derived state by effective location. |
| Events | `context.data.on(type, handler)` and `.listen(handler)` return unsubscribe functions. Relevant types include `session.model.selected`, `session.agent.selected`, `session.deleted`, `provider.updated`, and `model.updated`. Filter by session/location. |
| Theme | `context.theme`/`themeMode` are host getters; use reactive reads and the dialog surface tokens. |

The [client Solid data implementation](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/client/src/solid/data.ts)
already updates session model state on `session.model.selected`. It invalidates
and refreshes provider/model collections on their update events. Its collection
`list` reads a Solid store. The
[TUI data provider](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/tui/src/context/data.tsx)
passes that data through to plugins. Therefore ordinary memos over these getters
can update without another listener/cache for every value. Use events only for
additional presentation work that these projections do not cover.

The [native local model controller](https://github.com/anomalyco/opencode/blob/v2.0.11/packages/tui/src/context/local.tsx)
also considers pending per-session/per-agent choices, home-screen preferences,
agent defaults, catalog validity, and fallback selection. `useLocal().model.current()`
is private; Context exposes neither it nor a public event for every local draft
change. Do not reconstruct that algorithm or claim `session.get(id).model` is
the exact model currently displayed by the native picker. A future requirement
for that exact transient value must wait for an upstream supported read API/event.

Configured defaults remain authoritative and clearly labeled throughout. Live
session information may be a separate annotation/section; it must not replace
the orchestrator inheritance marker or mutate the five worker defaults.

## Bounded follow-up and stop conditions

Proceed with a separate static-presentation implementation issue:

1. Keep the command ID, slash/palette registration and pure projection. Replace
   the computed runtime import and untyped element builder with a small local
   `AgentModelsView.tsx`, imported literally from the existing `tui.ts` entry.
2. Render through `dialog.show`; set options in its callback/component; use typed
   theme/text/layout primitives for the six read-only rows.
3. Add activation-aware dialog closure, component disposal and useful render
   error reporting. Preserve cleanup of the existing app-slot command layer.
4. Add only the development dependencies/configuration needed for typed TSX and
   a bounded renderer test. Expected file scope: this plugin directory,
   `model-policy-view.test.ts` (or a focused adjacent UI test), root
   `package.json`/`bun.lock`, agent TypeScript config and Biome TSX includes.
   No model-policy, agent-contract, installer, or Workflow MCP changes.
5. Cover the actual show path, shared-runtime import behavior, rendered cell
   values/styles, narrow width, dismissal/reopen, and reload without duplicate
   commands/listeners. Keep cheap projection tests; use one representative real
   rendering boundary rather than repeated full OpenCode launches in core tests.
6. Validate and manually dogfood on the supported floor/current runtime before
   claiming UI completion. Defer live data subscriptions and model switching.

**Stop recommendation:** no stop is needed for the host-owned static Solid
dialog; both the supported source and installed-runtime experiments establish
the necessary APIs. Stop any follow-up that requires private `useLocal`, a second
renderer/Solid instance, or exact uncommitted selection without a public host
API. Request an upstream API first rather than guessing state or raising the
minimum version speculatively. If floor dogfood contradicts the inspected
implementation, retain the current alert and investigate that host discrepancy
before shipping the new view.

## Experiment boundaries and validation

All downloaded sources, package archives, probe plugins and captured results
were kept under a unique `/tmp/issue-186.*` directory. The isolated CLI used
temporary XDG config/data/state/cache, no project MCP configuration, and made
no model requests. The real repository plugin was imported read-only; its
context was wrapped externally. No repository files were written for probing.
The temporary TUI processes/background service and files were cleaned up.

Validation passed: `git diff --check`, a whitespace check of the new file against
`/dev/null`, `bun run check`, and the repository-required `bun run validate`.
The full gate passed Biome, TypeScript, 389 core tests (37.34 seconds), and 52
runtime tests (37.01 seconds), with zero failures. Biome does not lint Markdown;
the document was reviewed separately. Final scope verification includes
untracked files, since a new document is absent from ordinary `git diff` until
staged. The only repository change is this document.
