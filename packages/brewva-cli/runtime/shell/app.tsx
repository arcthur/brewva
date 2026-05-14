/** @jsxImportSource @opentui/solid */

import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { For } from "solid-js";
import {
  buildPromptPartSignature,
  cloneCliShellPromptParts,
} from "../../src/shell/domain/prompt-parts.js";
import type { CliShellPromptPart } from "../../src/shell/domain/prompt.js";
import type { ShellRendererController } from "../../src/shell/domain/renderer-contract.js";
import type {
  OpenTuiKeyEvent,
  OpenTuiRenderer,
  OpenTuiScrollBoxHandle,
  OpenTuiTextareaHandle,
} from "../internal-opentui-runtime.js";
import {
  decodePasteBytes,
  type BoxRenderable,
  type PasteEvent,
  useKeyboard,
  usePaste,
  useTerminalDimensions,
} from "../opentui/index.js";
import { CompletionOverlay } from "./completion.js";
import { InlineApprovalPrompt, InlineQuestionPrompt } from "./inline-cards.js";
import { ModalOverlay } from "./overlays/modal-overlay.js";
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
  runtime: ShellRendererController;
  toolRenderCache?: ToolRenderCache;
  renderer?: OpenTuiRenderer;
  copyTextToClipboard?: ClipboardCopy;
}) {
  const toolRenderCache = input.toolRenderCache ?? createToolRenderCache();
  const state = useShellState(input.runtime);
  const dimensions = useTerminalDimensions();
  const theme = createMemo(() => createPalette(state.theme));
  const shellRenderContext = {
    runtime: input.runtime,
    diffStyle: () => state.diff.style,
    diffWrapMode: () => state.diff.wrapMode,
    showThinking: () => state.view.showThinking,
  };
  const showScrollbar = createMemo(() => dimensions().width >= 96);
  // Belt-and-braces vs seed-scoped message ids alone: ids fix Solid reconcile collisions;
  // sessionId still differentiates empty transcripts across sessions; endpoints disambiguate same-length swaps.
  const bundleRefreshKey = createMemo(() => {
    const messages = state.transcript.messages;
    const sessionId = input.runtime.getSessionIdentity().sessionId;
    const firstId = messages[0]?.id ?? "";
    const lastId = messages.length > 0 ? (messages[messages.length - 1]?.id ?? "") : "";
    return `${sessionId}:${messages.length}:${firstId}:${lastId}`;
  });
  const toolDefinitions = createMemo(() => {
    bundleRefreshKey();
    return input.runtime.getToolDefinitions();
  });
  const transcriptWidth = createMemo(() => Math.max(20, dimensions().width - 8));
  const [scrollbox, setScrollbox] = createSignal<OpenTuiScrollBoxHandle | null>(null);
  const [textarea, setTextarea] = createSignal<OpenTuiTextareaHandle | null>(null);
  const [completionContainer, setCompletionContainer] = createSignal<BoxRenderable | null>(null);
  const [promptAnchor, setPromptAnchor] = createSignal<BoxRenderable | null>(null);

  const promptPartStyle = createMemo(() => createPromptPartStyle(theme()));
  const filePromptPartStyleId = createMemo(() => promptPartStyle().getStyleId("extmark.file"));
  const textPromptPartStyleId = createMemo(() => promptPartStyle().getStyleId("extmark.text"));
  const agentPromptPartStyleId = createMemo(() => promptPartStyle().getStyleId("extmark.agent"));
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
      const styleId =
        part.type === "file"
          ? filePromptPartStyleId()
          : part.type === "agent"
            ? agentPromptPartStyleId()
            : textPromptPartStyleId();
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
      input.runtime
        .getViewState()
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
    void input.runtime.handleInput({
      type: "viewport.resize",
      columns: dimensions().width,
      rows: dimensions().height,
    });
  });

  const copySelection = async (): Promise<boolean> =>
    await copyOpenTuiSelection({
      renderer: input.renderer,
      copyText: input.copyTextToClipboard,
      notifier: input.runtime.ui,
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
        notifier: input.runtime.ui,
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
    const sessionId = input.runtime.getSessionIdentity().sessionId;
    toolRenderCache.resetForSession(sessionId);
  });

  createEffect(() => {
    const node = scrollbox();
    if (!node || node.isDestroyed) {
      return;
    }
    if (state.transcript.navigationRequest) {
      applyTranscriptNavigationRequest({
        runtime: input.runtime,
        scrollbox: node,
        request: state.transcript.navigationRequest,
      });
      return;
    }

    const { maxScrollTop, currentOffset } = readTranscriptScrollMetrics(node);
    if (state.transcript.followMode === "live") {
      if (currentOffset > 1 && node.scrollHeight > node.viewport.height) {
        void input.runtime.handleInput({
          type: "transcript.scrollSync",
          followMode: "scrolled",
          scrollOffset: currentOffset,
        });
        return;
      }
      node.stickyScroll = true;
      node.stickyStart = "bottom";
      node.scrollTop = maxScrollTop;
      return;
    }

    if (currentOffset <= 1 && maxScrollTop > 0) {
      void input.runtime.handleInput({
        type: "transcript.scrollSync",
        followMode: "live",
        scrollOffset: 0,
      });
      return;
    }
    if (Math.abs(currentOffset - state.transcript.scrollOffset) > 1) {
      void input.runtime.handleInput({
        type: "transcript.scrollSync",
        followMode: "scrolled",
        scrollOffset: currentOffset,
      });
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
      void input.runtime.handleInput({
        type: "composer.editorSync",
        text: node.plainText,
        cursor: textOffsetFromLogicalCursor(node.plainText, node.logicalCursor),
        parts: readPromptPartsFromExtmarks(node),
      });
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
    if (!input.runtime.wantsInput(semanticInput)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void input.runtime.handleInput(semanticInput);
  }, {});

  usePaste((event: PasteEvent) => {
    if (state.overlay.active?.payload?.kind !== "input") {
      return;
    }
    const pastedText = decodePasteBytes(event.bytes).replace(/\r\n/gu, "\n").replace(/\r/gu, "\n");
    if (pastedText.length === 0) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void input.runtime.handleInput({
      key: "paste",
      text: pastedText,
      ctrl: false,
      meta: false,
      shift: false,
    });
  });

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
    return input.runtime.getSessionIdentity().modelLabel;
  });
  const thinkingLevel = createMemo(
    () => state.status.entries.thinking ?? input.runtime.getSessionIdentity().thinkingLevel,
  );
  const lineageLabel = createMemo(
    () => state.status.entries.lineage ?? input.runtime.getSessionIdentity().lineageLabel ?? "",
  );
  const inlineApproval = createMemo(() => {
    const payload = activeOverlay()?.payload;
    return payload?.kind === "approval" ? payload : undefined;
  });
  const inlineQuestion = createMemo(() => {
    const payload = activeOverlay()?.payload;
    return payload?.kind === "question" ? payload : undefined;
  });
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
            focused={!state.overlay.active}
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
                  showToolDetails={state.view.toolDetails}
                  index={index()}
                  isLast={message.id === lastAssistantId()}
                  modelLabel={modelLabel()}
                />
              )}
            </For>
          </scrollbox>

          <Show when={inlineApproval()}>
            <InlineApprovalPrompt
              runtime={input.runtime}
              payload={inlineApproval()!}
              theme={theme()}
              transcriptWidth={transcriptWidth()}
            />
          </Show>
          <Show when={!inlineApproval() && inlineQuestion()}>
            <InlineQuestionPrompt
              runtime={input.runtime}
              payload={inlineQuestion()!}
              theme={theme()}
            />
          </Show>

          <PromptPanel
            runtime={input.runtime}
            composer={state.composer}
            queue={state.queue}
            status={state.status}
            overlayActive={Boolean(state.overlay.active)}
            theme={theme()}
            width={dimensions().width}
            modelLabel={modelLabel()}
            thinkingLevel={thinkingLevel()}
            lineageLabel={lineageLabel()}
            setAnchor={(node) => setPromptAnchor(node)}
            setTextarea={(node) => setTextarea(node)}
          />

          <ToastStrip notifications={state.notifications} theme={theme()} />

          <Show when={state.composer.completion && !state.overlay.active}>
            <CompletionOverlay
              runtime={input.runtime}
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
