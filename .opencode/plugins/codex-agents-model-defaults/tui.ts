import type { Context } from "@opencode/plugin/tui/context";
import * as Plugin from "@opencode/plugin/tui/plugin";
import {
  loadModelPolicy,
  type OpenCodeModelDefaultRow,
  projectOpenCodeModelDefaults,
} from "../../../.codex/agents/model-policy.js";

export const AGENT_MODELS_COMMAND_ID = "codex-agents.agent-models";

export function formatOpenCodeModelDefaults(rows: readonly OpenCodeModelDefaultRow[]): string {
  return rows
    .map((row) => {
      if (row.reasoning === null) {
        return `${row.role}: model: ${row.model}; reasoning: inherits OpenCode/session default`;
      }
      return `${row.role}: model: ${row.model}; reasoning: ${row.reasoning}`;
    })
    .join("\n");
}

function showModelDefaults(context: Context): void {
  const rows = projectOpenCodeModelDefaults(loadModelPolicy());
  void context.ui.dialog.alert({
    title: "OpenCode agent model defaults (read-only)",
    message: formatOpenCodeModelDefaults(rows),
  });
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
