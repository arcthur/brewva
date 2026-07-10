/** @jsxImportSource @opentui/solid */

import { For, Show, createMemo, createSignal } from "solid-js";
import type { ShellRendererController } from "../../src/shell/domain/renderer-contract.js";
import { buildSubagentFooterView } from "../../src/shell/domain/subagent-footer.js";
import {
  navigateTranscriptMessage,
  type TranscriptNavDirection,
} from "../../src/shell/domain/transcript-navigation.js";
import type { OpenTuiRenderer, OpenTuiScrollBoxHandle } from "../internal-opentui-runtime.js";
import type { BoxRenderable } from "../opentui/index.js";
import { CockpitDockSurface } from "./cockpit/surface.js";
import { CompletionOverlay } from "./completion.js";
import { type ComposerKeymapMode, useComposerInputWiring } from "./composer-input-wiring.js";
import { BrewvaKeymapRoot } from "./keymap.js";
import { ModalOverlay } from "./overlays/modal-overlay.js";
import { createScrollAcceleration } from "./palette.js";
import { PromptPanel } from "./prompt.js";
import { ShellRenderProvider } from "./render-context.js";
import { type ClipboardCopy, hasOpenTuiSelectedText } from "./selection.js";
import { SubagentFooterPanel } from "./subagent-footer.js";
import { ToastStrip } from "./toast.js";
import { createToolRenderCache, type ToolRenderCache } from "./tool-render.js";
import { TranscriptRowSpacingProvider } from "./transcript-row-spacing.js";
import { projectTranscriptRowHints, transcriptRowHint } from "./transcript-rows.js";
import { TranscriptMessageView } from "./transcript.js";
import { cloneOverlayPayload } from "./utils.js";

/**
 * Keymap-mode resolver for the full-screen shell: an active modal overlay wins
 * (pager payloads use the "pager" layer, everything else "overlay"), then the
 * mouse text selection, then subagent-footer focus, then the completion popup,
 * then the bare composer. Exported for tests: the precedence IS the fix below.
 */
export function resolveShellKeymapMode(
  state: ReturnType<ShellRendererController["getViewState"]>,
  renderer: OpenTuiRenderer,
): ComposerKeymapMode {
  // Modal overlays win over a mouse text selection: the selection lives in the
  // surface UNDER the overlay, so letting it capture the keymap would strand
  // the operator on a dialog whose navigation keys (and escape) all fall into
  // the selection layer's two bindings. A drag-selection made while switching
  // windows (e.g. returning from a browser OAuth approval) froze every overlay
  // exactly this way.
  const payload = state.overlay.active?.payload;
  if (payload?.kind === "pager") {
    return "pager";
  }
  if (payload) {
    return "overlay";
  }
  // Text-bearing selections only: a bare click already leaves an empty
  // Selection object behind (see hasOpenTuiSelectedText).
  if (hasOpenTuiSelectedText(renderer)) {
    return "selection";
  }
  if (state.focus.active === "subagentFooter") {
    return "subagentFooter";
  }
  if (state.composer.completion) {
    return "completion";
  }
  return "composer";
}

/**
 * The Brewva OpenTUI interactive shell, full-screen edition: the transcript,
 * composer, and overlays all render live in the alternate screen.
 *
 * No-flicker contract (the whole point of the full-screen rework):
 *   - streaming assistant markdown renders through @opentui's native
 *     `<markdown streaming internalBlockMode="top-level">` (in TranscriptMessage
 *     View -> TextPartView), so only the trailing in-progress top-level block
 *     re-renders per chunk; settled blocks stay put;
 *   - the transcript content is fed DIRECTLY from the reactive store (no
 *     throttle/coalescing) — Solid's fine-grained reactivity re-runs only the
 *     changed `content` binding;
 *   - stickyScroll is DECLARATIVE (`stickyScroll`/`stickyStart="bottom"`) — the
 *     ScrollBox owns manual-scroll disengage/re-engage internally; there is no
 *     imperative stickyStart mutation on the live node;
 *   - viewportCulling is intentionally NOT set, matching opencode's proven
 *     no-flicker session view.
 *
 * Composer input is wired via the shared useComposerInputWiring hook (keymap,
 * keyboard/paste routing into runtime.handleInput, uncontrolled-textarea editor
 * sync, prompt-part extmarks). Overlays float in the "absolute" dialog layout;
 * notifications use the floating ToastStrip; the completion popup floats
 * anchored to the prompt.
 */
export function BrewvaFullScreenShell(input: {
  runtime: ShellRendererController;
  renderer?: OpenTuiRenderer;
  toolRenderCache?: ToolRenderCache;
  copyTextToClipboard?: ClipboardCopy;
}) {
  const [transcriptScrollBox, setTranscriptScrollBox] = createSignal<OpenTuiScrollBoxHandle | null>(
    null,
  );
  const navigateTranscript = (direction: TranscriptNavDirection): void => {
    const box = transcriptScrollBox();
    if (box) {
      navigateTranscriptMessage(box, input.runtime.getViewState().transcript.messages, direction);
    }
  };
  // Clicking question option N routes through the SAME path as pressing its
  // number key — the question handler's canonical 1-9 selection — so a click
  // selects (and, for an immediate single-choice question, submits) exactly as
  // the keyboard would. Options past 9 stay keyboard-navigable (arrows / j-k).
  const selectQuestionOption = (optionIndex: number): void => {
    const digit = optionIndex + 1;
    if (digit < 1 || digit > 9) {
      return;
    }
    void input.runtime.handleInput({
      key: String(digit),
      text: String(digit),
      ctrl: false,
      meta: false,
      shift: false,
    });
  };
  const wiring = useComposerInputWiring({
    runtime: input.runtime,
    renderer: input.renderer,
    copyTextToClipboard: input.copyTextToClipboard,
    keymapMode: resolveShellKeymapMode,
    navigateTranscriptMessage: navigateTranscript,
  });
  const { state, dimensions, theme } = wiring;

  // Runtime-owned cache (preserves tool expand/collapse across external-editor
  // remounts); falls back to a local cache when mounted standalone (tests).
  const toolRenderCache = input.toolRenderCache ?? createToolRenderCache();
  const toolDefinitions = input.runtime.getToolDefinitions();

  const shellRenderContext = {
    runtime: input.runtime,
    diffStyle: () => state.diff.style,
    diffWrapMode: () => state.diff.wrapMode,
    showThinking: () => state.view.showThinking,
    scrollAcceleration: createMemo(() =>
      createScrollAcceleration(input.runtime.getTuiConfig().scroll.acceleration),
    ),
    // The live shell folds are interactive (click-toggleable); the pager export
    // path overrides this to "static" (see buildShellRenderContext).
    folding: (): "interactive" | "static" => "interactive",
  };

  const modelLabel = createMemo(
    () => state.status.entries.model || input.runtime.getSessionIdentity().modelLabel,
  );
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
  const messages = createMemo(() => state.transcript.messages);
  const rowHints = createMemo(() => projectTranscriptRowHints(messages()));
  const promptInputBlocked = createMemo(
    () =>
      Boolean(state.overlay.active) ||
      state.focus.active === "subagentFooter" ||
      (state.cockpit.projection?.composerPolicy ?? "active") === "block",
  );
  // The active modal overlay (if any). Clone the payload so overlay components
  // that mutate draft slices locally never write back into the store snapshot.
  const modalOverlay = createMemo(() => {
    const active = state.overlay.active;
    if (!active?.payload) {
      return undefined;
    }
    return { ...active, payload: cloneOverlayPayload(active.payload) };
  });

  const [promptAnchor, setPromptAnchor] = createSignal<BoxRenderable | null>(null);
  const [completionContainer, setCompletionContainer] = createSignal<BoxRenderable | null>(null);

  const shell = (
    <ShellRenderProvider value={shellRenderContext}>
      <box
        width="100%"
        height="100%"
        flexDirection="row"
        backgroundColor={theme().background}
        onMouseUp={() => {
          void wiring.copySelection();
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
            ref={(node: OpenTuiScrollBoxHandle) => setTranscriptScrollBox(node)}
            stickyScroll={true}
            stickyStart="bottom"
            flexGrow={1}
            scrollAcceleration={shellRenderContext.scrollAcceleration()}
            backgroundColor={theme().background}
            viewportOptions={{ paddingRight: 1 }}
            verticalScrollbarOptions={{
              visible: true,
              trackOptions: {
                backgroundColor: theme().backgroundElement,
                foregroundColor: theme().border,
              },
            }}
          >
            <For each={messages()}>
              {(message, index) => {
                const hint = createMemo(() => transcriptRowHint(rowHints(), message.id));
                return (
                  <box
                    id={`transcript-row:${message.id}`}
                    width="100%"
                    flexDirection="column"
                    flexShrink={0}
                    overflow="visible"
                  >
                    <TranscriptRowSpacingProvider value={{ compactTop: () => hint().compactTop }}>
                      <TranscriptMessageView
                        message={message}
                        theme={theme()}
                        toolDefinitions={toolDefinitions}
                        toolRenderCache={toolRenderCache}
                        transcriptWidth={transcriptWidth()}
                        showToolDetails={state.view.toolDetails}
                        index={index()}
                        isLast={index() === messages().length - 1}
                        showAssistantLabel={hint().showAssistantLabel}
                        assistantLabel={assistantLabel()}
                        modelLabel={modelLabel()}
                      />
                    </TranscriptRowSpacingProvider>
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
            syncComposerFromEditor={wiring.syncComposerFromEditor}
            setAnchor={(node: BoxRenderable) => setPromptAnchor(node)}
            setTextarea={(node) => wiring.setTextarea(node)}
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
              onSelectQuestionOption={selectQuestionOption}
            />
          </Show>
        </box>
      </box>
    </ShellRenderProvider>
  );

  return wiring.keymapController ? (
    <BrewvaKeymapRoot controller={wiring.keymapController}>{shell}</BrewvaKeymapRoot>
  ) : (
    shell
  );
}
