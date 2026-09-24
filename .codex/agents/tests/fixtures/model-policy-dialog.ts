import assert from "node:assert/strict";
import type { Context, DialogOptions, KeymapLayer, SlotClaim } from "@opencode/plugin/tui/context";
import {
  type BaseRenderable,
  RGBA,
  ScrollBoxRenderable,
  TextAttributes,
  TextRenderable,
} from "@opentui/core";
import {
  type BoxProps,
  createElement,
  spread,
  testRender,
  useTerminalDimensions,
} from "@opentui/solid";
import "@opentui/solid/runtime-plugin-support";
import {
  batch,
  createComponent,
  createRoot,
  createSignal,
  getOwner,
  type JSX,
  type Owner,
  onCleanup,
  runWithOwner,
  Show,
} from "solid-js";
import { loadModelPolicy, projectOpenCodeModelDefaults } from "../../model-policy.js";

// OpenCode installs this same runtime support before loading project-local TSX.
// The parent launches Bun with --conditions=browser: no private Solid entrypoints
// or host cleanup patch are copied into the test environment.
const { default: plugin, AGENT_MODELS_COMMAND_ID } = await import(
  "../../../../.opencode/plugins/codex-agents-model-defaults/tui.js"
);

type Entry = { render: () => JSX.Element; onClose?: () => void };
const [current, setCurrent] = createSignal<Entry>();
const [size, setSize] = createSignal<DialogOptions["size"]>("medium");
const [centered, setCentered] = createSignal(false);
let owner: Owner | null = null;
const harness = await testRender(
  () => {
    owner = getOwner();
    const dimensions = useTerminalDimensions();
    const hostBox = createElement("box");
    spread(hostBox, {
      get width() {
        return Math.min(size() === "large" ? 88 : 60, dimensions().width - 2);
      },
      flexDirection: "column",
      get children() {
        return createComponent(Show, {
          get when() {
            return current();
          },
          keyed: true,
          children: (entry: Entry) => entry.render(),
        });
      },
    } satisfies BoxProps);
    return hostBox;
  },
  { width: 100, height: 35 },
);

const layers = new Set<KeymapLayer>();
type Slot = { render: () => JSX.Element; dispose?: () => void };
const slots = new Set<Slot>();
const transitions: string[] = [];
const base = RGBA.fromHex("#eeeeee");
const muted = RGBA.fromHex("#888888");
let failTheme = false;
let failShow = false;
let clears = 0;
const context = {
  renderer: harness.renderer,
  theme: {
    surface(name: string) {
      assert.equal(name, "dialog");
      if (failTheme) throw new Error("test theme unavailable");
      return { text: { base, muted } };
    },
  },
  keymap: {
    layer(input: () => KeymapLayer) {
      assert.ok(getOwner(), "command registration needs a Solid owner");
      const layer = input();
      layers.add(layer);
      onCleanup(() => layers.delete(layer));
    },
  },
  ui: {
    slot(claim: SlotClaim<"app">) {
      assert.equal(claim.append, "app");
      const slot: Slot = { render: () => claim.render({}) };
      slots.add(slot);
      return () => {
        slot.dispose?.();
        slots.delete(slot);
      };
    },
    dialog: {
      // The v2.0.11 host calls onClose before replacement and resets options
      // in the same batch as replacement. Rendering is owned by the Solid root.
      show(render: () => JSX.Element, onClose?: () => void) {
        if (failShow) throw new Error("test host setup unavailable");
        current()?.onClose?.();
        batch(() => {
          transitions.push("replace/reset");
          setSize("medium");
          setCentered(false);
          setCurrent({ render, onClose });
        });
      },
      set(options: DialogOptions) {
        transitions.push("set");
        setSize(options.size);
        setCentered(options.centered ?? false);
      },
      clear() {
        clears++;
        current()?.onClose?.();
        batch(() => {
          setSize("medium");
          setCentered(false);
          setCurrent(undefined);
        });
      },
      alert() {
        assert.fail("supported rendering must never fall back to an alert");
      },
    },
  },
} as unknown as Context;

function renderSlot(slot: Slot) {
  slot.dispose?.();
  runWithOwner(owner, () =>
    createRoot((dispose) => {
      slot.dispose = dispose;
      assert.equal(slot.render(), null);
    }),
  );
}

async function activate() {
  const cleanup = await plugin.setup(context);
  assert.equal(typeof cleanup, "function");
  assert.equal(layers.size, 0, "setup must only register the app slot");
  assert.equal(slots.size, 1);
  const slot = [...slots][0];
  assert.ok(slot);
  renderSlot(slot);
  renderSlot(slot);
  assert.equal(layers.size, 1, "app remount must dispose its previous keymap layer");
  const commands = [...layers].flatMap((layer) => layer.commands ?? []);
  assert.equal(commands.length, 1);
  const command = commands[0];
  assert.ok(command);
  assert.equal(command.id, AGENT_MODELS_COMMAND_ID);
  assert.equal(command.palette, true);
  assert.deepEqual(command.slash, { name: "agent-models" });
  return { cleanup: cleanup as () => void, run: () => command.run() };
}

function descendants(node: BaseRenderable): BaseRenderable[] {
  return node.getChildren().flatMap((child) => [child, ...descendants(child)]);
}

function texts() {
  return descendants(harness.renderer.root).filter(
    (node): node is TextRenderable => node instanceof TextRenderable,
  );
}

async function flush() {
  await harness.flush();
  // The OpenTUI reconciler destroys detached renderables on the next tick.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const expectedAgents = [
  "Orchestrator",
  "Planner",
  "Explorer",
  "Implementer",
  "Code Reviewer",
  "Committer",
];
const defaults = projectOpenCodeModelDefaults(loadModelPolicy());
const orderedRoles = [
  "orchestrator",
  "planner",
  "explorer",
  "implementer",
  "code_reviewer",
  "committer",
];
const expectedRows = orderedRoles.map((role, index) => {
  const row = defaults.find((candidate) => candidate.role === role);
  assert.ok(row);
  return [
    expectedAgents[index],
    row.reasoning === null ? "Session default" : row.model,
    row.reasoning ?? "Session default",
  ];
});

function assertTable() {
  const cells = texts();
  assert.deepEqual(
    cells.slice(1, 4).map((cell) => cell.plainText),
    ["Agent", "Model", "Reasoning"],
  );
  assert.deepEqual(
    cells.slice(4, 22).map((cell) => cell.plainText),
    expectedRows.flat(),
  );
  assert.equal(cells.length, 24, "title, headers, exactly six rows, and two hints");
  for (const cell of cells.slice(1, 4)) assert.equal(cell.attributes, TextAttributes.BOLD);
  for (let index = 0; index < 6; index++) {
    const [agent, model, reasoning] = cells.slice(4 + index * 3, 7 + index * 3);
    assert.ok(agent && model && reasoning);
    assert.equal(agent.attributes, TextAttributes.BOLD);
    assert.deepEqual(agent.fg, base);
    assert.deepEqual(model.fg, index === 0 ? muted : base);
    assert.deepEqual(reasoning.fg, muted);
    assert.ok(agent.x + agent.width <= model.x, "agent/model columns do not overlap");
    assert.ok(model.x + model.width <= reasoning.x, "model/reasoning columns do not overlap");
    assert.equal(agent.y, model.y);
    assert.equal(model.y, reasoning.y);
    assert.ok(reasoning.x + reasoning.width <= harness.renderer.width - 2);
  }
  assert.deepEqual(cells.at(-1)?.fg, muted);
}

try {
  const baselineListeners = harness.renderer.listenerCount("resize");
  let activation = await activate();
  await activation.run();
  await flush();
  assert.deepEqual(transitions, ["replace/reset", "set"]);
  assert.equal(size(), "large");
  assert.equal(centered(), true);
  assertTable();
  for (const agent of expectedAgents) assert.ok(harness.captureCharFrame().includes(agent));
  assert.equal(harness.renderer.listenerCount("resize"), baselineListeners + 1);

  // Use the same renderer for narrow-width and disposal coverage.
  harness.resize(48, 35);
  await flush();
  assertTable();
  const narrow = harness.captureCharFrame();
  assert.ok(narrow.includes("Committer"));
  assert.ok(narrow.includes("esc to close"));

  harness.resize(40, 20);
  await flush();
  assertTable();
  const scrollbox = descendants(harness.renderer.root).find(
    (node): node is ScrollBoxRenderable => node instanceof ScrollBoxRenderable,
  );
  assert.ok(scrollbox);
  assert.ok(scrollbox.scrollHeight > scrollbox.height, "short terminals can scroll the table");
  scrollbox.scrollTo(scrollbox.scrollHeight);
  await flush();
  assert.match(harness.captureCharFrame(), /Committ[^\n]*\n\s+er/u);
  assert.ok(harness.captureCharFrame().includes("esc to close"), harness.captureCharFrame());
  harness.resize(48, 35);
  await flush();

  const dismissed = texts();
  current()?.onClose?.(); // Host Escape dismissal calls onClose before popping.
  setCurrent(undefined);
  await flush();
  assert.ok(dismissed.every((node) => node.isDestroyed));
  assert.equal(harness.renderer.listenerCount("resize"), baselineListeners);

  await activation.run();
  await flush();
  assertTable();
  const replaced = texts();
  const previousClose = current()?.onClose;
  await activation.run(); // Reopen over our own active dialog.
  previousClose?.(); // A late callback from the old invocation is harmless.
  await flush();
  assert.ok(replaced.every((node) => node.isDestroyed));
  assertTable();
  activation.cleanup();
  activation.cleanup();
  await activation.run(); // Retained stale commands cannot open after disposal.
  await flush();
  assert.equal(clears, 1);
  assert.equal(current(), undefined);
  assert.equal(slots.size, 0);
  assert.equal(layers.size, 0);
  assert.equal(harness.renderer.listenerCount("resize"), baselineListeners);

  activation = await activate(); // Reload installs only one command/layer.
  await activation.run();
  await flush();
  context.ui.dialog.show(() => null); // Another plugin replaces this view.
  const unrelated = current();
  activation.cleanup();
  assert.equal(current(), unrelated);
  assert.equal(clears, 1, "deactivation must preserve another plugin's replacement");

  activation = await activate();
  await activation.run();
  await flush();
  // Exercise component disposal independently of onClose (e.g. host unmount).
  setCurrent({ render: () => null });
  await flush();
  const unmountedReplacement = current();
  activation.cleanup();
  assert.equal(current(), unmountedReplacement);
  assert.equal(clears, 1);

  activation = await activate();
  await activation.run();
  context.ui.dialog.clear();
  activation.cleanup();
  assert.equal(clears, 2, "explicit clear already released ownership");

  activation = await activate();
  // Teardown before the host evaluates the pending render callback.
  batch(() => {
    activation.run();
    const pending = current();
    activation.cleanup();
    assert.equal(pending?.render(), null);
  });
  assert.equal(current(), undefined);
  assert.equal(clears, 3);

  activation = await activate();
  context.ui.dialog.show(() => null);
  const setupReplacement = current();
  failShow = true;
  assert.throws(() => activation.run(), {
    message: "Unable to show agent model defaults",
    cause: new Error("test host setup unavailable"),
  });
  failShow = false;
  activation.cleanup();
  assert.equal(current(), setupReplacement);
  assert.equal(clears, 3, "failed setup must not claim an unrelated dialog");

  activation = await activate();
  await activation.run();
  failShow = true;
  assert.throws(() => activation.run(), /Unable to show agent model defaults/);
  failShow = false;
  activation.cleanup();
  assert.equal(current(), undefined, "failed reopen must retain ownership of the previous view");
  assert.equal(clears, 4);

  activation = await activate();
  failTheme = true;
  await activation.run();
  await flush();
  assert.match(harness.captureCharFrame(), /Unable to render agent model defaults/);
  assert.match(harness.captureCharFrame(), /test theme unavailable/);
  activation.cleanup();
  await flush();
  assert.equal(current(), undefined, "the error boundary retains dialog ownership");
  activation = await activate();
  failTheme = false;
  await activation.run();
  await flush();
  assertTable();
  activation.cleanup();
  await flush();
  assert.equal(current(), undefined);
  assert.equal(slots.size, 0);
  assert.equal(layers.size, 0);
  assert.equal(harness.renderer.listenerCount("resize"), baselineListeners);
} finally {
  for (const slot of slots) slot.dispose?.();
  harness.renderer.destroy();
}
