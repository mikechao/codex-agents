import type { OpenCodeModelDefaultRow } from "../../../.codex/agents/model-policy.js";

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

export type DisplayRow = {
  agent: string;
  model: string;
  reasoning: string;
  inherited: boolean;
};

export function displayRows(rows: readonly OpenCodeModelDefaultRow[]): DisplayRow[] {
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
