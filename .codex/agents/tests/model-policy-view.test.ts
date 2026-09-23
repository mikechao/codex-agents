import { test } from "bun:test";
import assert from "node:assert/strict";
import type { Context } from "@opencode/plugin/tui/context";
import modelDefaultsPlugin, {
  AGENT_MODELS_COMMAND_ID,
  formatOpenCodeModelDefaults,
} from "../../../.opencode/plugins/codex-agents-model-defaults/tui.js";
import { parseModelPolicy, projectOpenCodeModelDefaults } from "../model-policy.js";

const fixture = `models:
  luna:
    codex: codex/luna
    opencode: openai/luna
  sol:
    codex: codex/sol
    opencode: openai/sol
agents:
  implementer:
    codex: { model: luna, reasoning: low }
    opencode: { model: luna, reasoning: medium }
  code_reviewer:
    codex: { model: sol, reasoning: low }
    opencode: { model: sol, reasoning: high }
  committer:
    codex: { model: luna, reasoning: high }
    opencode: { model: luna, reasoning: low }
  planner:
    opencode: { model: sol, reasoning: medium }
  explorer:
    opencode: { model: luna, reasoning: low }
`;

test("OpenCode model defaults project exactly the six project-owned rows", () => {
  const rows = projectOpenCodeModelDefaults(parseModelPolicy(fixture));
  assert.deepEqual(
    rows.map((row) => row.role),
    ["orchestrator", "implementer", "code_reviewer", "committer", "planner", "explorer"],
  );
  assert.deepEqual(rows[0], {
    role: "orchestrator",
    source: "opencode-session-default",
    model: "inherits OpenCode/session default",
    reasoning: null,
  });
  assert.deepEqual(rows.slice(1), [
    { role: "implementer", source: "model-policy", model: "openai/luna", reasoning: "medium" },
    { role: "code_reviewer", source: "model-policy", model: "openai/sol", reasoning: "high" },
    { role: "committer", source: "model-policy", model: "openai/luna", reasoning: "low" },
    { role: "planner", source: "model-policy", model: "openai/sol", reasoning: "medium" },
    { role: "explorer", source: "model-policy", model: "openai/luna", reasoning: "low" },
  ]);
  assert.ok(!rows.some((row) => row.role === ("plan" as never)));
});

test("aliases and host-specific reasoning flow through the shared policy resolver", () => {
  const rows = projectOpenCodeModelDefaults(
    parseModelPolicy(
      fixture.replace("model: luna, reasoning: medium", "model: sol, reasoning: low"),
    ),
  );
  assert.deepEqual(rows[1], {
    role: "implementer",
    source: "model-policy",
    model: "openai/sol",
    reasoning: "low",
  });
});

test("the TUI plugin registers its command in the app render scope and cleans up its slot", async () => {
  type RegisteredCommand = {
    id?: string;
    palette?: boolean;
    slash?: { name: string };
    run: () => void;
  };
  type RegisteredLayer = { commands?: readonly RegisteredCommand[] };
  type Slot = { render: () => unknown; disposeLayer: Array<() => void> };
  const slots = new Set<Slot>();
  const activeLayers = new Set<RegisteredLayer>();
  let currentSlot: Slot | undefined;
  let alert: { title: string; message: string } | undefined;
  function disposeRender(slot: Slot) {
    for (const dispose of slot.disposeLayer.splice(0)) dispose();
  }
  function renderSlot(slot: Slot) {
    disposeRender(slot);
    currentSlot = slot;
    try {
      assert.equal(slot.render(), null);
    } finally {
      currentSlot = undefined;
    }
  }
  function activeCommands() {
    return [...activeLayers].flatMap((layer) => layer.commands ?? []);
  }
  const context = {
    keymap: {
      layer(callback: () => unknown) {
        assert.ok(currentSlot, "keymap registration requires the app provider");
        const layer = callback() as RegisteredLayer;
        activeLayers.add(layer);
        currentSlot.disposeLayer.push(() => activeLayers.delete(layer));
      },
    },
    ui: {
      slot(claim: { append: string; render: () => unknown }) {
        assert.equal(claim.append, "app");
        const slot: Slot = { render: claim.render, disposeLayer: [] };
        slots.add(slot);
        return () => {
          disposeRender(slot);
          slots.delete(slot);
        };
      },
      dialog: {
        alert(options: { title: string; message: string }) {
          alert = options;
          return Promise.resolve();
        },
      },
    },
  } as unknown as Context;

  const cleanup = await modelDefaultsPlugin.setup(context);
  assert.equal(activeLayers.size, 0, "setup must not register outside the provider");
  const slot = [...slots][0];
  assert.ok(slot);
  renderSlot(slot);
  assert.equal(activeLayers.size, 1);
  assert.equal(activeCommands().length, 1);
  renderSlot(slot);
  assert.equal(activeLayers.size, 1, "rerender must dispose the previous layer");
  assert.equal(activeCommands().length, 1, "rerender must not duplicate the command");
  const command = activeCommands()[0];
  assert.ok(command);
  assert.equal(command.id, AGENT_MODELS_COMMAND_ID);
  assert.equal(command.palette, true);
  assert.deepEqual(command.slash, { name: "agent-models" });
  command.run();
  assert.equal(alert?.title, "OpenCode agent model defaults (read-only)");
  const message = alert?.message ?? "";
  assert.equal(message.split("\n").length, 9);
  assert.match(message, /Agent\s+Model\s+Reasoning/);
  assert.deepEqual(
    message
      .split("\n")
      .slice(1, 7)
      .map((line) => line.trimStart().split(/\s{2,}/u)[0]),
    ["Orchestrator", "Planner", "Explorer", "Implementer", "Code Reviewer", "Committer"],
  );
  assert.match(message, /Orchestrator\s+Session default\s+Session default/);
  assert.match(message, /Planner\s+openai\/gpt-5\.6-luna\s+high/);
  assert.match(message, /Read-only · values loaded when \/agent-models is opened/);
  assert.doesNotMatch(message, /inherits OpenCode\/session default/);
  assert.equal(typeof cleanup, "function");
  if (typeof cleanup === "function") await cleanup();
  assert.equal(slots.size, 0);
  assert.equal(activeLayers.size, 0);
  assert.equal(activeCommands().length, 0);

  const reloadCleanup = await modelDefaultsPlugin.setup(context);
  assert.equal(activeLayers.size, 0);
  const reloadedSlot = [...slots][0];
  assert.ok(reloadedSlot);
  renderSlot(reloadedSlot);
  assert.equal(activeLayers.size, 1);
  assert.equal(activeCommands().length, 1);
  assert.equal(typeof reloadCleanup, "function");
  if (typeof reloadCleanup === "function") await reloadCleanup();
  assert.equal(slots.size, 0);
  assert.equal(activeLayers.size, 0);
  assert.equal(activeCommands().length, 0);
});

test("model-default formatting remains a pure six-row presentation", () => {
  const rows = projectOpenCodeModelDefaults(parseModelPolicy(fixture));
  const output = formatOpenCodeModelDefaults(rows);
  assert.equal(output.split("\n").length, 9);
  assert.match(output, /Code Reviewer\s+openai\/sol\s+high/);
  assert.match(output, /Orchestrator\s+Session default\s+Session default/);
  assert.doesNotMatch(output, /inherits OpenCode\/session default/);
});
