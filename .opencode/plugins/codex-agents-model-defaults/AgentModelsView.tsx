import type { Context } from "@opencode/plugin/tui/context";
import { TextAttributes } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/solid";
import { ErrorBoundary, For, onCleanup } from "solid-js";
import type { DisplayRow } from "./presentation.js";

type ViewProps = {
  context: Context;
  rows: readonly DisplayRow[];
};

export function AgentModelsDialog(props: ViewProps & { onDispose: () => void }) {
  // Keep ownership of the diagnostic too if the content fails to render.
  onCleanup(props.onDispose);
  return (
    <ErrorBoundary
      fallback={(error: unknown) => (
        <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="column">
          <text attributes={TextAttributes.BOLD}>Unable to render agent model defaults</text>
          <text wrapMode="word">
            {(error instanceof Error ? error.message : String(error)).slice(0, 240)}
          </text>
          <text>esc to close · reopen /agent-models to retry</text>
        </box>
      )}
    >
      <AgentModelsView {...props} />
    </ErrorBoundary>
  );
}

export function AgentModelsView(props: ViewProps) {
  // show() replaces the dialog and resets its options before rendering this subtree.
  props.context.ui.dialog.set({ size: "large", centered: true });
  const dimensions = useTerminalDimensions();
  const sideWidth = () => Math.max(6, Math.min(16, Math.floor((dimensions().width - 8) * 0.28)));
  const theme = () => props.context.theme.surface("dialog");

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} flexDirection="column" gap={1}>
      <text fg={theme().text.base} attributes={TextAttributes.BOLD} wrapMode="word">
        OpenCode agent model defaults (read-only)
      </text>
      <scrollbox
        flexGrow={0}
        maxHeight={Math.max(3, dimensions().height - 10)}
        scrollX={false}
        wrapperOptions={{ flexGrow: 0 }}
        viewportOptions={{ flexGrow: 0 }}
        contentOptions={{ minHeight: 0 }}
      >
        <box flexDirection="row" flexShrink={0}>
          <box width={sideWidth()} flexShrink={0} paddingRight={1}>
            <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
              Agent
            </text>
          </box>
          <box flexGrow={1} flexBasis={0} minWidth={0} paddingRight={1}>
            <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
              Model
            </text>
          </box>
          <box width={sideWidth()} flexShrink={0}>
            <text fg={theme().text.base} attributes={TextAttributes.BOLD}>
              Reasoning
            </text>
          </box>
        </box>
        <For each={props.rows}>
          {(row) => (
            <box flexDirection="row" flexShrink={0}>
              <box width={sideWidth()} flexShrink={0} paddingRight={1}>
                <text wrapMode="word" fg={theme().text.base} attributes={TextAttributes.BOLD}>
                  {row.agent}
                </text>
              </box>
              <box flexGrow={1} flexBasis={0} minWidth={0} paddingRight={1}>
                <text wrapMode="word" fg={row.inherited ? theme().text.muted : theme().text.base}>
                  {row.model}
                </text>
              </box>
              <box width={sideWidth()} flexShrink={0}>
                <text wrapMode="word" fg={theme().text.muted}>
                  {row.reasoning}
                </text>
              </box>
            </box>
          )}
        </For>
      </scrollbox>
      <text fg={theme().text.muted} wrapMode="word">
        Read-only · values loaded when /agent-models is opened
      </text>
      <text fg={theme().text.muted}>esc to close</text>
    </box>
  );
}
