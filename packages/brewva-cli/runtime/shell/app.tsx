/** @jsxImportSource @opentui/solid */

import type {
  OpenTuiKeyEvent,
  OpenTuiRenderer,
  OpenTuiScrollBoxHandle,
  OpenTuiTextareaHandle,
} from "@brewva/brewva-tui/internal-opentui-runtime";
import type { BoxRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { For } from "solid-js";
import type { CliShellController } from "../../src/shell/controller.js";
import {
  buildPromptPartSignature,
  cloneCliShellPromptParts,
} from "../../src/shell/prompt-parts.js";
import type { CliShellPromptPart } from "../../src/shell/types.js";
import type {
  CliApprovalOverlayPayload,
  CliQuestionOverlayPayload,
} from "../../src/shell/types.js";
import { CompletionOverlay } from "./completion.js";
import { InlineApprovalPrompt, InlineQuestionPrompt } from "./inline-cards.js";
import { ModalOverlay } from "./overlay.js";
import { createPalette, DEFAULT_SCROLL_ACCELERATION } from "./palette.js";
import { PromptPanel, createPromptPartStyle } from "./prompt.js";
import { ShellRenderProvider } from "./render-context.js";
import {
  copyOpenTuiSelection,
  copyTextWithShellFeedback,
  type ClipboardCopy,
} from "./selection.js";
import { ToastStrip } from "./toast.js";
import { createToolRenderCache, type ToolRenderCache } from "./tool-render.js";
import { TranscriptMessageView } from "./transcript.js";
import {
  applyTranscriptNavigationRequest,
  cloneOverlayPayload,
  readTranscriptScrollMetrics,
  toSemanticInput,
  textOffsetFromLogicalCursor,
  logicalCursorFromTextOffset,
  useShellState,
} from "./utils.js";

export function BrewvaOpenTuiShell(input: {
  controller: CliShellController;
  toolRenderCache?: ToolRenderCache;
  renderer?: OpenTuiRenderer;
  copyTextToClipboard?: ClipboardCopy;
}) {
  const toolRenderCache = input.toolRenderCache ?? createToolRenderCache();
  const state = useShellState(input.controller);
  const dimensions = useTerminalDimensions();
  const theme = createMemo(() => createPalette(state.theme));
  const shellRenderContext = {
    controller: input.controller,
    diffStyle: () => state.diff.style,
    diffWrapMode: () => state.diff.wrapMode,
    showThinking: () => state.view.showThinking,
  };
  const showScrollbar = createMemo(() => dimensions().width >= 96);
  const bundleRefreshKey = createMemo(() => `${state.transcript.messages.length}`);
  const toolDefinitions = createMemo(() => {
    bundleRefreshKey();
    return input.controller.getBundle().toolDefinitions;
  });
  const transcriptWidth = createMemo(() => Math.max(20, dimensions().width - 8));
  const [scrollbox, setScrollbox] = createSignal<OpenTuiScrollBoxHandle | null>(null);
  const [textarea, setTextarea] = createSignal<OpenTuiTextareaHandle | null>(null);
  const [completionContainer, setCompletionContainer] = createSignal<BoxRenderable | null>(null);
  const [promptAnchor, setPromptAnchor] = createSignal<BoxRenderable | null>(null);

  const promptPartStyle = createMemo(() => createPromptPartStyle(theme()));
  const filePromptPartStyleId = createMemo(() => promptPartStyle().getStyleId("extmark.file"));
  const textPromptPartStyleId = createMemo(() => promptPartStyle().getStyleId("extmark.text"));
  const [promptPartTypeId, setPromptPartTypeId] = createSignal<number | null>(null);
  const [promptPartIdByExtmarkId, setPromptPartIdByExtmarkId] = createSignal(
    new Map<number, string>(),
  );
  const [appliedPromptPartSignature, setAppliedPromptPartSignature] = createSignal(
    buildPromptPartSignature(state.composer.parts),
  );

  const rebuildPromptPartExtmarks = (
    node: OpenTuiTextareaHandle,
    parts: readonly CliShellPromptPart[],
  ) => {
    const typeId = promptPartTypeId();
    if (!typeId || node.isDestroyed) {
      return;
    }
    node.extmarks.clear();
    const nextMap = new Map<number, string>();
    for (const part of parts) {
      const source = part.source.text;
      if (source.end <= source.start) {
        continue;
      }
      const styleId = part.type === "file" ? filePromptPartStyleId() : textPromptPartStyleId();
      const extmarkId = node.extmarks.create({
        start: source.start,
        end: source.end,
        virtual: true,
        styleId: styleId ?? undefined,
        typeId,
      });
      nextMap.set(extmarkId, part.id);
    }
    setPromptPartIdByExtmarkId(nextMap);
    setAppliedPromptPartSignature(buildPromptPartSignature(parts));
  };

  const readPromptPartsFromExtmarks = (node: OpenTuiTextareaHandle): CliShellPromptPart[] => {
    const typeId = promptPartTypeId();
    if (!typeId || node.isDestroyed) {
      return [];
    }
    const partsById = new Map(
      input.controller
        .getState()
        .composer.parts.map((part) => [part.id, part] satisfies [string, CliShellPromptPart]),
    );
    const nextParts: CliShellPromptPart[] = [];
    const nextMap = new Map<number, string>();
    for (const extmark of node.extmarks.getAllForTypeId(typeId)) {
      const partId = promptPartIdByExtmarkId().get(extmark.id);
      const part = partId ? partsById.get(partId) : undefined;
      if (!part) {
        continue;
      }
      const nextPart = cloneCliShellPromptParts([part])[0];
      if (!nextPart) {
        continue;
      }
      nextPart.source.text.start = extmark.start;
      nextPart.source.text.end = extmark.end;
      nextParts.push(nextPart);
      nextMap.set(extmark.id, nextPart.id);
    }
    setPromptPartIdByExtmarkId(nextMap);
    setAppliedPromptPartSignature(buildPromptPartSignature(nextParts));
    return nextParts;
  };

  createEffect(() => {
    input.controller.setViewportSize(dimensions().width, dimensions().height);
  });

  const copySelection = async (): Promise<boolean> =>
    await copyOpenTuiSelection({
      renderer: input.renderer,
      copyText: input.copyTextToClipboard,
      notifier: input.controller.ui,
    });

  createEffect(() => {
    const renderer = input.renderer;
    if (!renderer?.console) {
      return;
    }
    const handleCopySelection = (text: string): void => {
      void copyTextWithShellFeedback({
        text,
        renderer,
        copyText: input.copyTextToClipboard,
        notifier: input.controller.ui,
      });
    };
    renderer.console.onCopySelection = handleCopySelection;
    onCleanup(() => {
      if (renderer.console?.onCopySelection === handleCopySelection) {
        renderer.console.onCopySelection = undefined;
      }
    });
  });

  createEffect(() => {
    bundleRefreshKey();
    const sessionId = input.controller.getBundle().session.sessionManager.getSessionId();
    toolRenderCache.resetForSession(sessionId);
  });

  createEffect(() => {
    const node = scrollbox();
    if (!node || node.isDestroyed) {
      return;
    }
    if (state.transcript.navigationRequest) {
      applyTranscriptNavigationRequest({
        controller: input.controller,
        scrollbox: node,
        request: state.transcript.navigationRequest,
      });
      return;
    }

    const { maxScrollTop, currentOffset } = readTranscriptScrollMetrics(node);
    if (state.transcript.followMode === "live") {
      if (currentOffset > 1 && node.scrollHeight > node.viewport.height) {
        input.controller.syncTranscriptScrollState("scrolled", currentOffset);
        return;
      }
      node.stickyScroll = true;
      node.stickyStart = "bottom";
      node.scrollTop = maxScrollTop;
      return;
    }

    if (currentOffset <= 1 && maxScrollTop > 0) {
      input.controller.syncTranscriptScrollState("live", 0);
      return;
    }
    if (Math.abs(currentOffset - state.transcript.scrollOffset) > 1) {
      input.controller.syncTranscriptScrollState("scrolled", currentOffset);
      return;
    }
    node.stickyScroll = false;
    node.scrollTop = Math.max(0, maxScrollTop - state.transcript.scrollOffset);
  });

  createEffect(() => {
    const node = textarea();
    const composer = state.composer;
    if (!node || node.isDestroyed) {
      return;
    }
    if (node.plainText !== composer.text) {
      node.setText(composer.text);
    }
    const desiredCursor = logicalCursorFromTextOffset(composer.text, composer.cursor);
    if (
      node.logicalCursor.row !== desiredCursor.row ||
      node.logicalCursor.col !== desiredCursor.col
    ) {
      node.setCursor(desiredCursor.row, desiredCursor.col);
    }
  });

  createEffect(() => {
    const node = textarea();
    if (!node || node.isDestroyed) {
      return;
    }
    const nextTypeId = node.extmarks.registerType("brewva-prompt-part");
    setPromptPartTypeId((current) => (current === nextTypeId ? current : nextTypeId));
  });

  createEffect(() => {
    const node = textarea();
    if (!node || node.isDestroyed || promptPartTypeId() === null) {
      return;
    }
    const signature = buildPromptPartSignature(state.composer.parts);
    if (signature === appliedPromptPartSignature()) {
      return;
    }
    rebuildPromptPartExtmarks(node, state.composer.parts);
  });

  createEffect(() => {
    const node = textarea();
    if (!node || node.isDestroyed) {
      return;
    }
    const syncFromEditor = () => {
      if (node.isDestroyed) {
        return;
      }
      input.controller.syncComposerFromEditor(
        node.plainText,
        textOffsetFromLogicalCursor(node.plainText, node.logicalCursor),
        readPromptPartsFromExtmarks(node),
      );
    };
    node.editBuffer.on("content-changed", syncFromEditor);
    node.editBuffer.on("cursor-changed", syncFromEditor);
    onCleanup(() => {
      node.editBuffer.off("content-changed", syncFromEditor);
      node.editBuffer.off("cursor-changed", syncFromEditor);
    });
  });

  useKeyboard((event) => {
    const key = event as OpenTuiKeyEvent;
    if (!input.renderer?.getSelection?.()) {
      return;
    }
    if (key.ctrl && key.name.toLowerCase() === "c") {
      event.preventDefault();
      event.stopPropagation();
      void copySelection();
      return;
    }
    if (key.name === "escape") {
      event.preventDefault();
      event.stopPropagation();
      input.renderer.clearSelection?.();
      return;
    }
    input.renderer.clearSelection?.();
  }, {});

  useKeyboard((event) => {
    const semanticInput = toSemanticInput(event as OpenTuiKeyEvent);
    if (!input.controller.wantsSemanticInput(semanticInput)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void input.controller.handleSemanticInput(semanticInput);
  }, {});

  const activeOverlay = createMemo(() => {
    const active = state.overlay.active;
    if (!active) {
      return undefined;
    }
    return {
      ...active,
      payload: active.payload ? cloneOverlayPayload(active.payload) : undefined,
    };
  });
  const modalOverlay = createMemo(() => {
    const overlay = activeOverlay();
    if (
      !overlay?.payload ||
      overlay.payload.kind === "approval" ||
      overlay.payload.kind === "question"
    ) {
      return undefined;
    }
    return overlay;
  });
  const modelLabel = createMemo(() => {
    if (state.status.entries.model) {
      return state.status.entries.model;
    }
    const model = input.controller.getBundle().session.model;
    if (!model?.provider || !model.id) {
      return "unresolved-model";
    }
    return `${model.provider}/${model.id}`;
  });
  const thinkingLevel = createMemo(
    () =>
      state.status.entries.thinking ?? input.controller.getBundle().session.thinkingLevel ?? "off",
  );
  const inlineApproval = createMemo(() =>
    activeOverlay()?.payload?.kind === "approval"
      ? (activeOverlay()!.payload as CliApprovalOverlayPayload)
      : undefined,
  );
  const inlineQuestion = createMemo(() =>
    activeOverlay()?.payload?.kind === "question"
      ? (activeOverlay()!.payload as CliQuestionOverlayPayload)
      : undefined,
  );
  const lastAssistantId = createMemo(() => {
    const messages = state.transcript.messages;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role === "assistant") {
        return message.id;
      }
    }
    return undefined;
  });

  return (
    <ShellRenderProvider value={shellRenderContext}>
      <box
        width="100%"
        height="100%"
        flexDirection="row"
        backgroundColor={theme().background}
        onMouseUp={() => {
          void copySelection();
        }}
      >
        <box
          ref={(node: BoxRenderable) => setCompletionContainer(node)}
          flexGrow={1}
          paddingBottom={1}
          paddingLeft={2}
          paddingRight={2}
          gap={1}
        >
          <scrollbox
            ref={(node: OpenTuiScrollBoxHandle) => setScrollbox(node)}
            viewportOptions={{
              paddingRight: showScrollbar() ? 1 : 0,
            }}
            verticalScrollbarOptions={{
              visible: showScrollbar(),
              trackOptions: {
                backgroundColor: theme().backgroundElement,
                foregroundColor: theme().border,
              },
            }}
            stickyScroll={state.transcript.followMode === "live"}
            stickyStart="bottom"
            viewportCulling={true}
            flexGrow={1}
            scrollAcceleration={DEFAULT_SCROLL_ACCELERATION}
            backgroundColor={theme().background}
          >
            <box height={1} />
            <For each={state.transcript.messages}>
              {(message, index) => (
                <TranscriptMessageView
                  message={message}
                  theme={theme()}
                  toolDefinitions={toolDefinitions()}
                  toolRenderCache={toolRenderCache}
                  transcriptWidth={transcriptWidth()}
                  showToolDetails={state.status.toolsExpanded}
                  index={index()}
                  isLast={message.id === lastAssistantId()}
                  modelLabel={modelLabel()}
                />
              )}
            </For>
          </scrollbox>

          <Show when={inlineApproval()}>
            <InlineApprovalPrompt
              controller={input.controller}
              payload={inlineApproval()!}
              theme={theme()}
              transcriptWidth={transcriptWidth()}
            />
          </Show>
          <Show when={!inlineApproval() && inlineQuestion()}>
            <InlineQuestionPrompt
              controller={input.controller}
              payload={inlineQuestion()!}
              theme={theme()}
            />
          </Show>

          <PromptPanel
            controller={input.controller}
            composer={state.composer}
            status={state.status}
            overlayActive={Boolean(state.overlay.active)}
            theme={theme()}
            width={dimensions().width}
            modelLabel={modelLabel()}
            thinkingLevel={thinkingLevel()}
            setAnchor={(node) => setPromptAnchor(node)}
            setTextarea={(node) => setTextarea(node)}
          />

          <ToastStrip notifications={state.notifications} theme={theme()} />

          <Show when={state.composer.completion && !state.overlay.active}>
            <CompletionOverlay
              controller={input.controller}
              completion={state.composer.completion!}
              anchor={promptAnchor}
              container={completionContainer}
              width={dimensions().width}
              height={dimensions().height}
              theme={theme()}
            />
          </Show>

          <Show when={modalOverlay()}>
            <ModalOverlay
              overlay={modalOverlay()!}
              width={dimensions().width}
              height={dimensions().height}
              theme={theme()}
            />
          </Show>
        </box>
      </box>
    </ShellRenderProvider>
  );
}
