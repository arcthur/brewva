/** @jsxImportSource @opentui/solid */

import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import {
  buildPromptPartSignature,
  cloneCliShellPromptParts,
} from "../../src/shell/domain/prompt-parts.js";
import type { CliShellPromptPart } from "../../src/shell/domain/prompt.js";
import type { ShellRendererController } from "../../src/shell/domain/renderer-contract.js";
import { buildSubagentFooterView } from "../../src/shell/domain/subagent-footer.js";
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
  useRenderer,
  useTerminalDimensions,
} from "../opentui/index.js";
import { CockpitDockSurface } from "./cockpit/surface.js";
import { CompletionOverlay } from "./completion.js";
import { BrewvaKeymapRoot, registerBrewvaKeymap } from "./keymap.js";
import { ModalOverlay } from "./overlays/modal-overlay.js";
import { createPalette, createScrollAcceleration } from "./palette.js";
import { PromptPanel, createPromptPartStyle } from "./prompt.js";
import { ShellRenderProvider } from "./render-context.js";
import {
  copyOpenTuiSelection,
  copyTextWithShellFeedback,
  type ClipboardCopy,
} from "./selection.js";
import { SubagentFooterPanel } from "./subagent-footer.js";
import { ToastStrip } from "./toast.js";
import { createToolRenderCache, type ToolRenderCache } from "./tool-render.js";
import { createRetainedTranscriptRows } from "./transcript-retention.js";
import { TranscriptMessageView } from "./transcript.js";
import {
  applySurfaceNavigationRequest,
  cloneOverlayPayload,
  readSurfaceScrollMetrics,
  toSemanticInput,
  textOffsetFromLogicalCursor,
  logicalCursorFromTextOffset,
  useShellState,
} from "./utils.js";

const COMPOSER_EDITOR_SYNC_DEBOUNCE_MS = 80;
const SURFACE_SCROLL_EPSILON = 1;

interface TranscriptScrollSnapshot {
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly viewportHeight: number;
}

type OpenTuiFrameHandler = (event?: unknown) => void;
type OpenTuiEventHandler = (event?: unknown) => void;

interface OpenTuiFrameEmitter {
  on(event: "frame", handler: OpenTuiFrameHandler): void;
  off(event: "frame", handler: OpenTuiFrameHandler): void;
}

interface OpenTuiEventEmitter {
  on(event: string, handler: OpenTuiEventHandler): void;
  off(event: string, handler: OpenTuiEventHandler): void;
}

function isOpenTuiFrameEmitter(value: unknown): value is OpenTuiFrameEmitter {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<OpenTuiFrameEmitter>;
  return typeof candidate.on === "function" && typeof candidate.off === "function";
}

function isOpenTuiEventEmitter(value: unknown): value is OpenTuiEventEmitter {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<OpenTuiEventEmitter>;
  return typeof candidate.on === "function" && typeof candidate.off === "function";
}

function readScrollboxMetricEmitters(node: OpenTuiScrollBoxHandle): readonly OpenTuiEventEmitter[] {
  const candidate = node as OpenTuiScrollBoxHandle & {
    readonly verticalScrollBar?: unknown;
    readonly horizontalScrollBar?: unknown;
  };
  return [candidate.verticalScrollBar, candidate.horizontalScrollBar, node].filter(
    isOpenTuiEventEmitter,
  );
}

function setScrollboxStickyTail(node: OpenTuiScrollBoxHandle, enabled: boolean): void {
  if (node.stickyScroll !== enabled) {
    node.stickyScroll = enabled;
  }
  if (enabled && node.stickyStart !== "bottom") {
    node.stickyStart = "bottom";
  }
}

function scrollboxHasManualScroll(node: OpenTuiScrollBoxHandle): boolean {
  const manualScrollKey = ["_has", "ManualScroll"].join("");
  const candidate = node as OpenTuiScrollBoxHandle & Record<string, unknown>;
  return candidate[manualScrollKey] === true;
}

function setScrollTopIfChanged(node: OpenTuiScrollBoxHandle, target: number): void {
  const boundedTarget = Math.max(0, target);
  if (Math.abs(node.scrollTop - boundedTarget) > SURFACE_SCROLL_EPSILON) {
    node.scrollTop = boundedTarget;
  }
}

function sameTranscriptScrollSnapshot(
  left: TranscriptScrollSnapshot,
  right: TranscriptScrollSnapshot,
): boolean {
  return (
    Math.abs(left.scrollTop - right.scrollTop) <= SURFACE_SCROLL_EPSILON &&
    Math.abs(left.scrollHeight - right.scrollHeight) <= SURFACE_SCROLL_EPSILON &&
    Math.abs(left.viewportHeight - right.viewportHeight) <= SURFACE_SCROLL_EPSILON
  );
}

function readTranscriptScrollSnapshot(node: OpenTuiScrollBoxHandle): TranscriptScrollSnapshot {
  return {
    scrollTop: Math.max(0, node.scrollTop),
    scrollHeight: Math.max(0, node.scrollHeight),
    viewportHeight: Math.max(1, node.viewport.height),
  };
}

function installScrollboxMetricObserver(
  node: OpenTuiScrollBoxHandle,
  renderer: OpenTuiRenderer,
  notify: () => void,
): () => void {
  let disposed = false;
  let lastSnapshot = readTranscriptScrollSnapshot(node);
  const notifyWhenChanged = (): void => {
    if (disposed || node.isDestroyed) {
      return;
    }
    const nextSnapshot = readTranscriptScrollSnapshot(node);
    if (sameTranscriptScrollSnapshot(lastSnapshot, nextSnapshot)) {
      return;
    }
    lastSnapshot = nextSnapshot;
    notify();
  };

  const emitter = isOpenTuiFrameEmitter(renderer) ? renderer : undefined;
  const scrollEmitters = readScrollboxMetricEmitters(node);
  const onScrollMetricChanged: OpenTuiEventHandler = () => {
    notifyWhenChanged();
    queueMicrotask(notifyWhenChanged);
  };
  for (const scrollEmitter of scrollEmitters) {
    scrollEmitter.on("change", onScrollMetricChanged);
  }

  const cleanupScrollEmitters = (): void => {
    for (const scrollEmitter of scrollEmitters) {
      scrollEmitter.off("change", onScrollMetricChanged);
    }
  };

  if (emitter) {
    const onFrame: OpenTuiFrameHandler = () => notifyWhenChanged();
    emitter.on("frame", onFrame);
    queueMicrotask(notifyWhenChanged);
    return () => {
      disposed = true;
      cleanupScrollEmitters();
      emitter.off("frame", onFrame);
    };
  }

  const timer = setInterval(notifyWhenChanged, 16);
  queueMicrotask(notifyWhenChanged);
  return () => {
    disposed = true;
    cleanupScrollEmitters();
    clearInterval(timer);
  };
}

function supportsOpenTuiKeymap(renderer: OpenTuiRenderer): boolean {
  const candidate = renderer as unknown as {
    root?: unknown;
    keyInput?: unknown;
    currentFocusedRenderable?: unknown;
  };
  return Boolean(candidate.root && candidate.keyInput);
}

export function BrewvaOpenTuiShell(input: {
  runtime: ShellRendererController;
  toolRenderCache?: ToolRenderCache;
  renderer?: OpenTuiRenderer;
  copyTextToClipboard?: ClipboardCopy;
}) {
  const toolRenderCache = input.toolRenderCache ?? createToolRenderCache();
  const toolDefinitions = input.runtime.getToolDefinitions();
  const state = useShellState(input.runtime);
  const dimensions = useTerminalDimensions();
  const renderer = (input.renderer ?? useRenderer()) as OpenTuiRenderer;
  const theme = createMemo(() => createPalette(state.theme));
  const scrollAcceleration = createMemo(() =>
    createScrollAcceleration(input.runtime.getTuiConfig().scroll.acceleration),
  );
  const shellRenderContext = {
    runtime: input.runtime,
    diffStyle: () => state.diff.style,
    diffWrapMode: () => state.diff.wrapMode,
    showThinking: () => state.view.showThinking,
    scrollAcceleration,
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
  const [scrollbox, setScrollbox] = createSignal<OpenTuiScrollBoxHandle | null>(null);
  const [textarea, setTextarea] = createSignal<OpenTuiTextareaHandle | null>(null);
  const [completionContainer, setCompletionContainer] = createSignal<BoxRenderable | null>(null);
  const [promptAnchor, setPromptAnchor] = createSignal<BoxRenderable | null>(null);
  const [transcriptScrollSnapshot, setTranscriptScrollSnapshot] =
    createSignal<TranscriptScrollSnapshot>({
      scrollTop: 0,
      scrollHeight: 0,
      viewportHeight: Math.max(1, dimensions().height),
    });
  const syncTranscriptScrollSnapshot = (): void => {
    const node = scrollbox();
    if (!node || node.isDestroyed) {
      return;
    }
    const next = readTranscriptScrollSnapshot(node);
    setTranscriptScrollSnapshot((current) =>
      sameTranscriptScrollSnapshot(current, next) ? current : next,
    );
  };

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
  const emptyPromptPartSignature = buildPromptPartSignature([]);

  const promptPartIdMapsEqual = (
    left: ReadonlyMap<number, string>,
    right: ReadonlyMap<number, string>,
  ): boolean => {
    if (left.size !== right.size) {
      return false;
    }
    for (const [key, value] of left) {
      if (right.get(key) !== value) {
        return false;
      }
    }
    return true;
  };

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
    const extmarks = node.extmarks.getAllForTypeId(typeId);
    if (extmarks.length === 0) {
      if (promptPartIdByExtmarkId().size > 0) {
        setPromptPartIdByExtmarkId(new Map());
      }
      if (appliedPromptPartSignature() !== emptyPromptPartSignature) {
        setAppliedPromptPartSignature(emptyPromptPartSignature);
      }
      return [];
    }
    const partsById = new Map(
      state.composer.parts.map((part) => [part.id, part] satisfies [string, CliShellPromptPart]),
    );
    const nextParts: CliShellPromptPart[] = [];
    const nextMap = new Map<number, string>();
    for (const extmark of extmarks) {
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
    if (!promptPartIdMapsEqual(promptPartIdByExtmarkId(), nextMap)) {
      setPromptPartIdByExtmarkId(nextMap);
    }
    const nextSignature = buildPromptPartSignature(nextParts);
    if (appliedPromptPartSignature() !== nextSignature) {
      setAppliedPromptPartSignature(nextSignature);
    }
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
      renderer,
      copyText: input.copyTextToClipboard,
      notifier: input.runtime.ui,
    });
  let composerEditorSyncTimer: ReturnType<typeof setTimeout> | undefined;
  const clearScheduledComposerEditorSync = (): void => {
    const timer = composerEditorSyncTimer;
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    composerEditorSyncTimer = undefined;
  };
  const syncComposerFromEditor = async (): Promise<void> => {
    clearScheduledComposerEditorSync();
    const node = textarea();
    if (!node || node.isDestroyed) {
      return;
    }
    await input.runtime.handleInput({
      type: "composer.editorSync",
      text: node.plainText,
      cursor: textOffsetFromLogicalCursor(node.plainText, node.logicalCursor),
      parts: readPromptPartsFromExtmarks(node),
    });
  };
  const scheduleComposerEditorSync = (): void => {
    clearScheduledComposerEditorSync();
    composerEditorSyncTimer = setTimeout(() => {
      composerEditorSyncTimer = undefined;
      void syncComposerFromEditor();
    }, COMPOSER_EDITOR_SYNC_DEBOUNCE_MS);
  };

  const keymapRenderer = supportsOpenTuiKeymap(renderer) ? renderer : undefined;
  const keymapController = keymapRenderer
    ? registerBrewvaKeymap({
        renderer: keymapRenderer,
        runtime: input.runtime,
        copySelection,
        clearSelection: () => renderer.clearSelection?.(),
        syncComposerFromEditor,
      })
    : undefined;

  onCleanup(() => keymapController?.dispose());
  onCleanup(() => clearScheduledComposerEditorSync());

  const keymapMode = createMemo(() => {
    if (renderer.getSelection?.()) {
      return "selection" as const;
    }
    const payload = state.overlay.active?.payload;
    if (payload?.kind === "pager") {
      return "pager" as const;
    }
    if (payload) {
      return "overlay" as const;
    }
    if (state.focus.active === "subagentFooter") {
      return "subagentFooter" as const;
    }
    if (state.composer.completion) {
      return "completion" as const;
    }
    return "composer" as const;
  });

  createEffect(() => {
    keymapController?.setMode(keymapMode());
  });

  createEffect(() => {
    if (!renderer.console) {
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
    const cleanup = installScrollboxMetricObserver(node, renderer, syncTranscriptScrollSnapshot);
    syncTranscriptScrollSnapshot();
    onCleanup(cleanup);
  });

  createEffect(() => {
    transcriptScrollSnapshot();
    const node = scrollbox();
    if (!node || node.isDestroyed) {
      return;
    }
    if (state.surface.navigationRequest) {
      applySurfaceNavigationRequest({
        runtime: input.runtime,
        scrollbox: node,
        request: state.surface.navigationRequest,
      });
      return;
    }

    const { maxScrollTop, currentOffset } = readSurfaceScrollMetrics(node);
    if (state.surface.followMode === "live") {
      if (scrollboxHasManualScroll(node) && currentOffset > SURFACE_SCROLL_EPSILON) {
        setScrollboxStickyTail(node, false);
        void input.runtime.handleInput({
          type: "surface.scrollSync",
          followMode: "scrolled",
          scrollOffset: currentOffset,
        });
        return;
      }
      setScrollboxStickyTail(node, true);
      return;
    }

    if (currentOffset <= SURFACE_SCROLL_EPSILON && maxScrollTop > 0) {
      setScrollboxStickyTail(node, true);
      void input.runtime.handleInput({
        type: "surface.scrollSync",
        followMode: "live",
        scrollOffset: 0,
      });
      return;
    }
    if (Math.abs(currentOffset - state.surface.scrollOffset) > SURFACE_SCROLL_EPSILON) {
      setScrollboxStickyTail(node, false);
      void input.runtime.handleInput({
        type: "surface.scrollSync",
        followMode: "scrolled",
        scrollOffset: currentOffset,
      });
      return;
    }
    setScrollboxStickyTail(node, false);
    setScrollTopIfChanged(node, maxScrollTop - state.surface.scrollOffset);
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
      scheduleComposerEditorSync();
    };
    node.editBuffer.on("content-changed", syncFromEditor);
    node.editBuffer.on("cursor-changed", syncFromEditor);
    onCleanup(() => {
      node.editBuffer.off("content-changed", syncFromEditor);
      node.editBuffer.off("cursor-changed", syncFromEditor);
    });
  });

  useKeyboard((event) => {
    if ((event as { propagationStopped?: boolean }).propagationStopped === true) {
      return;
    }
    if (keymapController) {
      return;
    }
    const key = event as OpenTuiKeyEvent;
    if (!renderer.getSelection?.()) {
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
      renderer.clearSelection?.();
      return;
    }
    renderer.clearSelection?.();
  }, {});

  useKeyboard((event) => {
    if ((event as { propagationStopped?: boolean }).propagationStopped === true) {
      return;
    }
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
    if (!overlay?.payload) {
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
  const assistantLabel = createMemo(() => {
    const presetLabel = state.status.entries.preset;
    return input.runtime.getSessionIdentity().assistantLabel || presetLabel || "Brewva";
  });
  const thinkingLevel = createMemo(
    () => state.status.entries.thinking ?? input.runtime.getSessionIdentity().thinkingLevel,
  );
  const lineageLabel = createMemo(
    () => state.status.entries.lineage ?? input.runtime.getSessionIdentity().lineageLabel ?? "",
  );
  const subagentFooterView = createMemo(() =>
    buildSubagentFooterView({
      runs: state.operator.taskRuns,
      state: state.subagentFooter,
      getSessionWireFrames: (sessionId) => input.runtime.getSessionWireFrames(sessionId),
    }),
  );
  const transcriptWidth = createMemo(() => Math.max(20, dimensions().width - 6));
  const transcriptRows = createRetainedTranscriptRows(() => state.transcript.messages);
  const composerPolicy = createMemo(() => state.cockpit.projection?.composerPolicy ?? "active");
  const promptInputBlocked = createMemo(
    () =>
      Boolean(state.overlay.active) ||
      state.focus.active === "subagentFooter" ||
      composerPolicy() === "block",
  );

  const shell = (
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
            stickyScroll={state.surface.followMode === "live"}
            stickyStart="bottom"
            viewportCulling={true}
            flexGrow={1}
            scrollAcceleration={scrollAcceleration()}
            backgroundColor={theme().background}
          >
            <For each={transcriptRows.rows()}>
              {(message, index) => {
                return (
                  <box
                    id={`transcript-row:${message.id}`}
                    width="100%"
                    flexDirection="column"
                    flexShrink={0}
                    overflow="visible"
                  >
                    <TranscriptMessageView
                      message={message}
                      theme={theme()}
                      toolDefinitions={toolDefinitions}
                      toolRenderCache={toolRenderCache}
                      transcriptWidth={transcriptWidth()}
                      showToolDetails={state.view.toolDetails}
                      index={index()}
                      isLast={index() === transcriptRows.rowCount() - 1}
                      assistantLabel={assistantLabel()}
                      modelLabel={modelLabel()}
                      renderSurface="interactive"
                    />
                  </box>
                );
              }}
            </For>
          </scrollbox>

          <CockpitDockSurface
            projection={state.cockpit.projection}
            theme={theme()}
            width={dimensions().width}
          />

          <SubagentFooterPanel
            runtime={input.runtime}
            view={subagentFooterView()}
            theme={theme()}
            width={dimensions().width}
            height={dimensions().height}
            shortcutLabel={(id) => input.runtime.getShortcutLabel(id)}
          />

          <PromptPanel
            runtime={input.runtime}
            composer={state.composer}
            queue={state.queue}
            status={state.status}
            overlayActive={promptInputBlocked()}
            theme={theme()}
            width={dimensions().width}
            assistantLabel={assistantLabel()}
            modelLabel={modelLabel()}
            thinkingLevel={thinkingLevel()}
            lineageLabel={lineageLabel()}
            tuiConfig={input.runtime.getTuiConfig()}
            shortcutLabel={(id) => input.runtime.getShortcutLabel(id)}
            syncComposerFromEditor={syncComposerFromEditor}
            setAnchor={(node) => setPromptAnchor(node)}
            setTextarea={(node) => setTextarea(node)}
          />

          <ToastStrip
            notifications={state.notifications}
            theme={theme()}
            inboxShortcutLabel={input.runtime.getShortcutLabel("operator.inbox")}
          />

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

  return keymapController ? (
    <BrewvaKeymapRoot controller={keymapController}>{shell}</BrewvaKeymapRoot>
  ) : (
    shell
  );
}
