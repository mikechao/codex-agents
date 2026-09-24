import * as Plugin from "@opencode/plugin/tui/plugin";
import { createComponent } from "solid-js";
import {
  loadModelPolicy,
  projectOpenCodeModelDefaults,
} from "../../../.codex/agents/model-policy.js";
import { AgentModelsDialog } from "./AgentModelsView.js";
import { displayRows } from "./presentation.js";

export const AGENT_MODELS_COMMAND_ID = "codex-agents.agent-models";

export default Plugin.define({
  id: "codex-agents.model-defaults",
  setup(context) {
    let disposed = false;
    let owned: { closed: boolean } | undefined;

    function showModelDefaults() {
      if (disposed) return;
      const rows = displayRows(projectOpenCodeModelDefaults(loadModelPolicy()));
      const previous = owned;
      const invocation = { closed: false };
      const release = () => {
        invocation.closed = true;
        // An older view's delayed cleanup must not release a reopened view.
        if (owned === invocation) owned = undefined;
      };
      owned = invocation;
      try {
        context.ui.dialog.show(() => {
          if (disposed || owned !== invocation) return null;
          return createComponent(AgentModelsDialog, { context, rows, onDispose: release });
        }, release);
      } catch (cause) {
        // Failed host setup does not establish ownership of the active dialog.
        // Content failures belong to the component's Solid ErrorBoundary.
        release();
        if (previous?.closed === false) owned = previous;
        throw new Error("Unable to show agent model defaults", { cause });
      }
    }

    const removeSlot = context.ui.slot({
      append: "app",
      render: () => {
        if (disposed) return null;
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
              run: showModelDefaults,
            },
          ],
        }));
        return null;
      },
    });
    return () => {
      if (disposed) return;
      disposed = true;
      try {
        if (owned !== undefined) {
          owned = undefined;
          context.ui.dialog.clear();
        }
      } finally {
        removeSlot();
      }
    };
  },
});
