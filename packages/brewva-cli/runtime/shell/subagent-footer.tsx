/** @jsxImportSource @opentui/solid */

import { For, Show, createMemo } from "solid-js";
import { truncateToWidth, visibleWidth } from "../../src/internal/tui/index.js";
import type { ShellRendererController } from "../../src/shell/domain/renderer-contract.js";
import {
  selectCompactSubagentFooterTabs,
  type SubagentFooterTab,
  type SubagentFooterView,
} from "../../src/shell/domain/subagent-footer.js";
import { TextAttributes } from "../opentui/index.js";
import { SPLIT_BORDER_CHARS, type SessionPalette } from "./palette.js";
import { TextLineBlock } from "./transcript.js";
import { visibleLineWindow } from "./utils.js";

function toneColor(tab: SubagentFooterTab, theme: SessionPalette): string {
  switch (tab.tone) {
    case "running":
      return theme.accent;
    case "success":
      return theme.success;
    case "warning":
      return theme.warning;
    case "error":
      return theme.error;
    case "muted":
      return theme.textMuted;
    default:
      return theme.textMuted;
  }
}

function formatTabText(tab: SubagentFooterTab, width: number): string {
  const label = `${tab.roleLabel} ${tab.status} · ${tab.title}`;
  if (visibleWidth(label) <= width) {
    return label;
  }
  if (width <= 1) {
    return "…";
  }
  return `${truncateToWidth(label, width - 1)}…`;
}

function formatBoundedText(text: string, width: number): string {
  if (visibleWidth(text) <= width) {
    return text;
  }
  if (width <= 1) {
    return "…";
  }
  return `${truncateToWidth(text, width - 1)}…`;
}

export function SubagentFooterPanel(input: {
  runtime: ShellRendererController;
  view: SubagentFooterView;
  theme: SessionPalette;
  width: number;
  height: number;
  shortcutLabel(id: string): string | undefined;
}) {
  const narrow = createMemo(() => input.width < 96);
  const compactTabs = createMemo(() =>
    selectCompactSubagentFooterTabs({
      tabs: input.view.tabs,
      selectedRunId: input.view.selectedRunId,
      maxTabs: narrow() ? 3 : 5,
    }),
  );
  const hiddenCount = createMemo(() => Math.max(0, input.view.tabs.length - compactTabs().length));
  const tabWidth = createMemo(() => {
    if (narrow()) {
      return Math.max(18, input.width - 14);
    }
    const count = Math.max(1, compactTabs().length);
    const fixedWidth = 18 + (hiddenCount() > 0 ? 6 : 0);
    return Math.max(12, Math.floor((input.width - fixedWidth) / count));
  });
  const detailRows = createMemo(() =>
    input.view.mode === "inspecting"
      ? Math.min(14, Math.max(8, Math.floor(input.height * 0.44)))
      : 0,
  );
  const detailLineRows = createMemo(() => Math.max(4, detailRows() - 3));
  const detailWindow = createMemo(() =>
    visibleLineWindow(
      input.view.detail?.lines ?? [],
      input.view.detail?.scrollOffset ?? 0,
      detailLineRows(),
    ),
  );
  const detailHeadingWidth = createMemo(() => Math.max(12, input.width - 34));
  const detailMetaWidth = createMemo(() => Math.max(8, Math.min(30, Math.floor(input.width / 3))));
  const shortcuts = createMemo(() =>
    [
      input.shortcutLabel("subagentFooter.next")
        ? `${input.shortcutLabel("subagentFooter.next")} next`
        : undefined,
      input.shortcutLabel("subagentFooter.close")
        ? `${input.shortcutLabel("subagentFooter.close")} close`
        : undefined,
      input.shortcutLabel("subagentFooter.openSession")
        ? `${input.shortcutLabel("subagentFooter.openSession")} open`
        : undefined,
      input.shortcutLabel("subagentFooter.cancel")
        ? `${input.shortcutLabel("subagentFooter.cancel")} cancel`
        : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
  );

  return (
    <Show when={input.view.visible}>
      <box
        id="brewva-subagent-footer"
        width="100%"
        flexShrink={0}
        flexDirection="column"
        border={["left"]}
        customBorderChars={{
          ...SPLIT_BORDER_CHARS,
          bottomLeft: "╹",
        }}
        borderColor={
          input.view.mode === "inspecting" ? input.theme.borderActive : input.theme.borderSubtle
        }
        backgroundColor={input.theme.backgroundPanel}
      >
        <box
          id="brewva-subagent-footer-tabs"
          width="100%"
          flexDirection={narrow() ? "column" : "row"}
          gap={narrow() ? 0 : 2}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
        >
          <text fg={input.theme.textMuted} wrapMode="none" flexShrink={0}>
            subagents
          </text>
          <box flexDirection={narrow() ? "column" : "row"} gap={narrow() ? 0 : 2} flexGrow={1}>
            <For each={compactTabs()}>
              {(tab) => {
                const selected = createMemo(() => tab.runId === input.view.selectedRunId);
                return (
                  <box
                    flexDirection="row"
                    gap={1}
                    flexShrink={narrow() ? 0 : 1}
                    backgroundColor={selected() ? input.theme.backgroundElement : undefined}
                    onMouseDown={() => {
                      void input.runtime.handleInput({
                        type: "keymap.effect",
                        effect: { type: "subagentFooter.select", runId: tab.runId },
                      });
                    }}
                  >
                    <text fg={toneColor(tab, input.theme)} wrapMode="none" flexShrink={0}>
                      {tab.icon}
                    </text>
                    <text
                      fg={selected() ? input.theme.text : input.theme.textMuted}
                      attributes={selected() ? TextAttributes.BOLD : undefined}
                      wrapMode="none"
                      overflow="hidden"
                    >
                      {formatTabText(tab, tabWidth())}
                    </text>
                  </box>
                );
              }}
            </For>
          </box>
          <Show when={hiddenCount() > 0}>
            <text fg={input.theme.textDim} wrapMode="none" flexShrink={0}>
              +{hiddenCount()}
            </text>
          </Show>
        </box>
        <Show when={input.view.mode === "inspecting" && input.view.detail}>
          {(detail) => (
            <box
              id="brewva-subagent-footer-detail"
              width="100%"
              height={detailRows()}
              flexDirection="column"
              border={["top"]}
              customBorderChars={SPLIT_BORDER_CHARS}
              borderColor={input.theme.borderSubtle}
              backgroundColor={input.theme.backgroundElement}
              paddingLeft={2}
              paddingRight={2}
              paddingTop={1}
            >
              <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
                <text
                  fg={input.theme.text}
                  attributes={TextAttributes.BOLD}
                  wrapMode="none"
                  overflow="hidden"
                  flexShrink={1}
                >
                  {formatBoundedText(`subagent detail · ${detail().title}`, detailHeadingWidth())}
                </text>
                <text fg={input.theme.textMuted} wrapMode="none" flexShrink={0}>
                  {formatBoundedText(
                    detail().workerSessionId ?? detail().status,
                    detailMetaWidth(),
                  )}
                </text>
              </box>
              <box marginTop={1} flexGrow={1}>
                <TextLineBlock lines={detailWindow().visibleLines} color={input.theme.text} />
              </box>
              <box flexDirection="row" justifyContent="space-between" flexShrink={0}>
                <text fg={input.theme.textDim} wrapMode="none">
                  lines {detailWindow().start}-{detailWindow().end} of {detail().lines.length}
                </text>
                <text fg={input.theme.textDim} wrapMode="none" overflow="hidden" flexShrink={1}>
                  {shortcuts()}
                </text>
              </box>
            </box>
          )}
        </Show>
      </box>
    </Show>
  );
}
