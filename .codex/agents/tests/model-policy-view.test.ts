import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { formatOpenCodeModelDefaults } from "../../../.opencode/plugins/codex-agents-model-defaults/presentation.js";
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

test("the source-first view uses literal host-runtime imports", () => {
  const directory = resolve(
    import.meta.dir,
    "../../../.opencode/plugins/codex-agents-model-defaults",
  );
  const controller = readFileSync(resolve(directory, "tui.ts"), "utf8");
  const view = readFileSync(resolve(directory, "AgentModelsView.tsx"), "utf8");
  assert.match(controller, /import \{ AgentModelsDialog \} from "\.\/AgentModelsView\.js"/);
  assert.match(view, /import \{ TextAttributes \} from "@opentui\/core"/);
  assert.match(view, /from "@opentui\/solid"/);
  assert.match(view, /from "solid-js"/);
  assert.doesNotMatch(
    controller + view,
    /import\(|solid-js\/dist|createCliRenderer|renderer\.root/,
  );
});

test("the host-owned Solid dialog renders and releases its activation", () => {
  // One bounded process selects Solid's public reactive export without changing
  // package-wide Bun conditions or installing a second runtime in the plugin.
  const result = spawnSync(
    process.execPath,
    ["--conditions=browser", resolve(import.meta.dir, "fixtures/model-policy-dialog.ts")],
    { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 },
  );
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("model-default formatting remains a pure six-row presentation", () => {
  const rows = projectOpenCodeModelDefaults(parseModelPolicy(fixture));
  const output = formatOpenCodeModelDefaults(rows);
  assert.equal(output.split("\n").length, 9);
  assert.deepEqual(
    output
      .split("\n")
      .slice(1, 7)
      .map((line) => line.split(/\s{2,}/u)[0]),
    ["Orchestrator", "Planner", "Explorer", "Implementer", "Code Reviewer", "Committer"],
  );
  assert.match(output, /Code Reviewer\s+openai\/sol\s+high/);
  assert.match(output, /Orchestrator\s+Session default\s+Session default/);
  assert.doesNotMatch(output, /inherits OpenCode\/session default/);
});
