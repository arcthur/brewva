/** @jsxImportSource @opentui/solid */

import type { OpenTuiScrollBoxHandle } from "@brewva/brewva-tui/internal-opentui-runtime";
import { type BoxRenderable } from "@opentui/core";
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { CliShellController } from "../../src/shell/controller.js";
import type { CliShellState } from "../../src/shell/state/index.js";
import { DEFAULT_SCROLL_ACCELERATION, type SessionPalette } from "./palette.js";
import { completionItemAuxText } from "./utils.js";

export function CompletionOverlay(input: {
  controller: CliShellController;
  completion: NonNullable<CliShellState["composer"]["completion"]>;
  anchor: () => BoxRenderable | null;
  container: () => BoxRenderable | null;
  width: number;
  height: number;
  theme: SessionPalette;
}) {
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
        width: Math.min(72, input.width - 4),
      };
    }
    const container = input.container() ?? anchor.parent;
    const parentX = container?.x ?? 0;
    const parentY = container?.y ?? 0;
    return {
      x: anchor.x - parentX,
      y: anchor.y - parentY,
      width: Math.max(38, anchor.width),
    };
  });
  const overlayWidth = createMemo(() =>
    Math.max(52, Math.min(Math.max(position().width, 52), input.width - position().x - 2, 88)),
  );
  // Content height inside the bordered menu. Keep one row minimum for the empty-state copy.
  const overlayContentHeight = createMemo(() =>
    Math.min(
      10,
      Math.max(1, input.completion.items.length === 0 ? 1 : input.completion.items.length),
      Math.max(1, position().y - 2),
    ),
  );
  const overlayOuterHeight = createMemo(() => overlayContentHeight() + 2);
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
      zIndex={20}
      left={position().x}
      top={Math.max(1, position().y - overlayOuterHeight())}
      width={overlayWidth()}
      border={true}
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
        scrollAcceleration={DEFAULT_SCROLL_ACCELERATION}
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
              const selected = index() === input.completion.selectedIndex;
              const auxText = completionItemAuxText(item);
              return (
                <box
                  paddingLeft={1}
                  paddingRight={1}
                  backgroundColor={selected ? input.theme.selectionBg : undefined}
                  flexDirection="row"
                  gap={1}
                  onMouseMove={() => setPointerMode("mouse")}
                  onMouseOver={() => {
                    if (pointerMode() !== "mouse") {
                      return;
                    }
                    input.controller.setCompletionSelection(index());
                  }}
                  onMouseDown={() => {
                    setPointerMode("mouse");
                    input.controller.setCompletionSelection(index());
                  }}
                  onMouseUp={() => input.controller.acceptCurrentCompletion()}
                >
                  <text
                    fg={selected ? input.theme.selectionText : input.theme.text}
                    flexShrink={0}
                    wrapMode="none"
                  >
                    {item.label}
                  </text>
                  <Show when={auxText}>
                    <text
                      fg={selected ? input.theme.selectionText : input.theme.textMuted}
                      wrapMode="none"
                    >
                      {auxText}
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
