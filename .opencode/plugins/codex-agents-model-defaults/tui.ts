import type { Context } from "@opencode/plugin/tui/context";
import * as Plugin from "@opencode/plugin/tui/plugin";
import {
  loadModelPolicy,
  type OpenCodeModelDefaultRow,
  projectOpenCodeModelDefaults,
} from "../../../.codex/agents/model-policy.js";

export const AGENT_MODELS_COMMAND_ID = "codex-agents.agent-models";

const DISPLAY_ORDER: readonly OpenCodeModelDefaultRow["role"][] = [
  "orchestrator",
  "planner",
  "explorer",
  "implementer",
  "code_reviewer",
  "committer",
];

const ROLE_LABELS: Readonly<Record<OpenCodeModelDefaultRow["role"], string>> = {
  orchestrator: "Orchestrator",
  planner: "Planner",
  explorer: "Explorer",
  implementer: "Implementer",
  code_reviewer: "Code Reviewer",
  committer: "Committer",
};

type DisplayRow = {
  agent: string;
  model: string;
  reasoning: string;
  inherited: boolean;
};

type NativeDialogElement = ReturnType<Parameters<Context["ui"]["dialog"]["show"]>[0]>;

type NativeJsxRuntime = {
  jsx(type: string, props?: Record<string, unknown>): NativeDialogElement;
};

function displayRows(rows: readonly OpenCodeModelDefaultRow[]): DisplayRow[] {
  return DISPLAY_ORDER.flatMap((role) => {
    const row = rows.find((candidate) => candidate.role === role);
    return row === undefined ? [] : [row];
  }).map((row) => ({
    agent: ROLE_LABELS[row.role],
    model: row.reasoning === null ? "Session default" : row.model,
    reasoning: row.reasoning ?? "Session default",
    inherited: row.reasoning === null,
  }));
}

function displayWidths(display: readonly DisplayRow[]): { agent: number; model: number } {
  return {
    agent: Math.max("Agent".length, ...display.map((row) => row.agent.length)),
    model: Math.max("Model".length, ...display.map((row) => row.model.length)),
  };
}

export function formatOpenCodeModelDefaults(rows: readonly OpenCodeModelDefaultRow[]): string {
  const display = displayRows(rows);
  const widths = displayWidths(display);

  return [
    `${"Agent".padEnd(widths.agent)}  ${"Model".padEnd(widths.model)}  Reasoning`,
    ...display.map(
      (row) =>
        `${row.agent.padEnd(widths.agent)}  ${row.model.padEnd(widths.model)}  ${row.reasoning}`,
    ),
    "",
    "Read-only · values loaded when /agent-models is opened",
  ].join("\n");
}

function nativeDialogContent(runtime: NativeJsxRuntime, rows: readonly OpenCodeModelDefaultRow[]) {
  const jsx = runtime.jsx;
  const display = displayRows(rows);
  const widths = displayWidths(display);
  const text = (content: string, style?: Record<string, unknown>) =>
    jsx("text", style === undefined ? { content } : { content, style });
  const header = (label: string, width: number) => text(`${label.padEnd(width)}  `, { bold: true });

  return jsx("box", {
    title: "OpenCode agent model defaults (read-only)",
    flexDirection: "column",
    padding: 1,
    children: [
      jsx("box", {
        flexDirection: "row",
        children: [
          header("Agent", widths.agent),
          header("Model", widths.model),
          text("Reasoning", { bold: true }),
        ],
      }),
      ...display.map((row) =>
        jsx("box", {
          flexDirection: "row",
          children: [
            text(`${row.agent.padEnd(widths.agent)}  `, { bold: true }),
            text(`${row.model.padEnd(widths.model)}  `, row.inherited ? { dim: true } : undefined),
            text(row.reasoning, { dim: true }),
          ],
        }),
      ),
      text("\nRead-only · values loaded when /agent-models is opened", { dim: true }),
    ],
  });
}

async function showModelDefaults(context: Context): Promise<void> {
  const rows = projectOpenCodeModelDefaults(loadModelPolicy());
  if (typeof context.ui.dialog.show !== "function") {
    await context.ui.dialog.alert({
      title: "OpenCode agent model defaults (read-only)",
      message: formatOpenCodeModelDefaults(rows),
    });
    return;
  }

  try {
    const moduleName = "@opentui/solid/jsx-runtime";
    const runtime = (await import(moduleName)) as unknown as NativeJsxRuntime;
    context.ui.dialog.set({ size: "large", centered: true });
    context.ui.dialog.show(() => nativeDialogContent(runtime, rows));
  } catch {
    await context.ui.dialog.alert({
      title: "OpenCode agent model defaults (read-only)",
      message: formatOpenCodeModelDefaults(rows),
    });
  }
}

export default Plugin.define({
  id: "codex-agents.model-defaults",
  setup(context) {
    return context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: AGENT_MODELS_COMMAND_ID,
              title: "Show agent model defaults",
              description: "Show the six project-owned OpenCode model defaults.",
              group: "Codex Agents",
              palette: true,
              slash: { name: "agent-models" },
              run: () => showModelDefaults(context),
            },
          ],
        }));
        return null;
      },
    });
  },
});
