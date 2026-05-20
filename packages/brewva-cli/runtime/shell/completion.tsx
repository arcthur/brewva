/** @jsxImportSource @opentui/solid */

import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { truncateToWidth, visibleWidth } from "../../src/internal/tui/index.js";
import type { ShellRendererController } from "../../src/shell/domain/renderer-contract.js";
import type { ShellViewModel } from "../../src/shell/domain/view-model.js";
import type { OpenTuiScrollBoxHandle } from "../internal-opentui-runtime.js";
import type { BoxRenderable } from "../opentui/index.js";
import { COMPLETION_Z_INDEX } from "./overlay-style.js";
import { SPLIT_BORDER_CHARS, type SessionPalette } from "./palette.js";
import { useShellRenderContext } from "./render-context.js";
import { completionItemAuxText } from "./utils.js";

function truncateCompletionText(text: string, maxWidth: number): string {
  const boundedWidth = Math.max(0, Math.trunc(maxWidth));
  if (boundedWidth <= 0) {
    return "";
  }
  if (visibleWidth(text) <= boundedWidth) {
    return text;
  }
  if (boundedWidth === 1) {
    return "…";
  }
  return `${truncateToWidth(text, boundedWidth - 1)}…`;
}

export function CompletionOverlay(input: {
  runtime: ShellRendererController;
  completion: NonNullable<ShellViewModel["composer"]["completion"]>;
  anchor: () => BoxRenderable | null;
  container: () => BoxRenderable | null;
  width: number;
  height: number;
  theme: SessionPalette;
}) {
  const shellContext = useShellRenderContext();
  let scrollbox: OpenTuiScrollBoxHandle | undefined;
  const [pointerMode, setPointerMode] = createSignal<"keyboard" | "mouse">("keyboard");
  const [positionTick, setPositionTick] = createSignal(0);
  createEffect(() => {
    const anchor = input.anchor();
    if (!anchor) {
      return;
    }
    const lastPosition = {
      x: anchor.x,
      y: anchor.y,
      width: anchor.width,
    };
    const timer = setInterval(() => {
      const nextAnchor = input.anchor();
      if (!nextAnchor) {
        return;
      }
      if (
        nextAnchor.x !== lastPosition.x ||
        nextAnchor.y !== lastPosition.y ||
        nextAnchor.width !== lastPosition.width
      ) {
        lastPosition.x = nextAnchor.x;
        lastPosition.y = nextAnchor.y;
        lastPosition.width = nextAnchor.width;
        setPositionTick((value) => value + 1);
      }
    }, 50);
    onCleanup(() => clearInterval(timer));
  });
  const position = createMemo(() => {
    positionTick();
    const anchor = input.anchor();
    if (!anchor) {
      return {
        x: 2,
        y: Math.max(2, input.height - 8),
        width: Math.max(1, input.width - 4),
      };
    }
    const container = input.container() ?? anchor.parent;
    const parentX = container?.x ?? 0;
    const parentY = container?.y ?? 0;
    const x = anchor.x - parentX;
    return {
      x,
      y: anchor.y - parentY,
      width: Math.max(52, anchor.width || input.width - x - 2),
    };
  });
  const overlayContentHeight = createMemo(() => {
    const count = input.completion.items.length || 1;
    const spaceAbove = Math.max(1, position().y);
    const spaceBelow = Math.max(1, input.height - position().y - 1);
    return Math.min(10, count, Math.max(spaceAbove, spaceBelow));
  });
  const overlayTop = createMemo(() => {
    const pos = position();
    const height = overlayContentHeight();
    const spaceAbove = Math.max(1, pos.y);
    const spaceBelow = Math.max(1, input.height - pos.y - 1);
    if (spaceAbove >= height || spaceAbove >= spaceBelow) {
      return Math.max(0, pos.y - height);
    }
    return Math.max(0, Math.min(input.height - height, pos.y + 1));
  });
  const contentWidth = createMemo(() => Math.max(16, position().width - 2));
  const slashLabelColumnWidth = createMemo(() => {
    if (input.completion.trigger !== "/") {
      return 0;
    }
    const widestLabel = input.completion.items.reduce(
      (widest, item) => Math.max(widest, visibleWidth(item.label)),
      0,
    );
    return Math.min(Math.max(12, widestLabel), Math.max(12, Math.floor(contentWidth() * 0.32)));
  });
  createEffect(() => {
    void input.completion.query;
    setPointerMode("keyboard");
  });
  createEffect(() => {
    const node = scrollbox;
    if (!node || node.isDestroyed) {
      return;
    }
    const selectedIndex = input.completion.selectedIndex;
    const viewportHeight = Math.max(1, node.viewport.height);
    const scrollBottom = node.scrollTop + viewportHeight;
    if (selectedIndex < node.scrollTop) {
      node.scrollBy(selectedIndex - node.scrollTop);
      return;
    }
    if (selectedIndex + 1 > scrollBottom) {
      node.scrollBy(selectedIndex + 1 - scrollBottom);
    }
  });
  return (
    <box
      position="absolute"
      zIndex={COMPLETION_Z_INDEX}
      left={position().x}
      top={overlayTop()}
      width={position().width}
      border={["left", "right"]}
      customBorderChars={SPLIT_BORDER_CHARS}
      borderColor={input.theme.border}
      backgroundColor={input.theme.backgroundMenu}
    >
      <scrollbox
        ref={(node: OpenTuiScrollBoxHandle) => {
          scrollbox = node;
        }}
        height={overlayContentHeight()}
        backgroundColor={input.theme.backgroundMenu}
        scrollbarOptions={{ visible: false }}
        scrollAcceleration={shellContext.scrollAcceleration()}
      >
        <Show
          when={input.completion.items.length > 0}
          fallback={
            <box paddingLeft={1} paddingRight={1}>
              <text fg={input.theme.textMuted}>No matching items</text>
            </box>
          }
        >
          <For each={input.completion.items}>
            {(item, index) => {
              const selected = createMemo(() => index() === input.completion.selectedIndex);
              const auxText = createMemo(() => completionItemAuxText(item));
              const showSlashColumns = createMemo(
                () => input.completion.trigger === "/" && Boolean(auxText()),
              );
              const labelText = createMemo(() =>
                showSlashColumns()
                  ? truncateCompletionText(item.label, slashLabelColumnWidth())
                  : item.label,
              );
              const descriptionText = createMemo(() => {
                const text = auxText();
                if (!text) {
                  return undefined;
                }
                if (!showSlashColumns()) {
                  return text;
                }
                return truncateCompletionText(
                  text,
                  Math.max(1, contentWidth() - slashLabelColumnWidth() - 3),
                );
              });
              return (
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={selected() ? input.theme.primary : undefined}
                  flexDirection="row"
                  gap={showSlashColumns() ? 3 : 1}
                  onMouseMove={() => setPointerMode("mouse")}
                  onMouseOver={() => {
                    if (pointerMode() !== "mouse") {
                      return;
                    }
                    void input.runtime.handleInput({ type: "completion.select", index: index() });
                  }}
                  onMouseDown={() => {
                    setPointerMode("mouse");
                    void input.runtime.handleInput({ type: "completion.select", index: index() });
                  }}
                  onMouseUp={() => void input.runtime.handleInput({ type: "completion.accept" })}
                >
                  <text
                    fg={selected() ? input.theme.selectionText : input.theme.text}
                    flexShrink={0}
                    width={showSlashColumns() ? slashLabelColumnWidth() : undefined}
                    wrapMode="none"
                  >
                    {labelText()}
                  </text>
                  <Show when={descriptionText()}>
                    <text
                      flexGrow={showSlashColumns() ? 1 : undefined}
                      fg={selected() ? input.theme.selectionText : input.theme.textMuted}
                      wrapMode="none"
                    >
                      {descriptionText()}
                    </text>
                  </Show>
                </box>
              );
            }}
          </For>
        </Show>
      </scrollbox>
    </box>
  );
}
