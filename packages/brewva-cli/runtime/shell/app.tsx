/** @jsxImportSource @opentui/solid */

import { Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { ShellRendererController } from "../../src/shell/domain/renderer-contract.js";
import { buildSubagentFooterView } from "../../src/shell/domain/subagent-footer.js";
import type { CliShellNotification } from "../../src/shell/domain/view-model.js";
import type { OpenTuiRenderer, SplitFooterRenderer } from "../internal-opentui-runtime.js";
import type { BoxRenderable } from "../opentui/index.js";
import { CockpitDockSurface } from "./cockpit/surface.js";
import { CompletionOverlay } from "./completion.js";
import { type ComposerKeymapMode, useComposerInputWiring } from "./composer-input-wiring.js";
import { BrewvaKeymapRoot } from "./keymap.js";
import { DialogLayoutProvider } from "./overlays/frame.js";
import { ModalOverlay } from "./overlays/modal-overlay.js";
import { createScrollAcceleration, type SessionPalette } from "./palette.js";
import { PromptPanel } from "./prompt.js";
import { ShellRenderProvider } from "./render-context.js";
import { type ClipboardCopy } from "./selection.js";
import { SubagentFooterPanel } from "./subagent-footer.js";
import { cloneOverlayPayload, renderNotificationSummary } from "./utils.js";

/**
 * Rows kept clear above the footer when a modal overlay is open, so at least a
 * sliver of the native scrollback transcript stays visible behind the footer.
 * Mirrors opencode's per-view row budgets (RunFooter.applyHeight): the footer
 * never consumes the whole terminal, and a modal taller than the cap scrolls
 * within its own surface (the overlay components already self-cap to the height
 * they are given via resolveDialogSurfaceDimensions / internal scrollboxes).
 */
const FOOTER_OVERLAY_RESERVE_ROWS = 2;

/**
 * Rows the footer always keeps for the composer (and the inline notification row
 * directly above it) when the stacked NON-modal secondary surfaces (cockpit dock
 * + subagent footer + inline completion) would otherwise grow tall enough to push
 * the composer off the bottom-anchored viewport. The composer box is the LAST
 * child and content-sized (the footer box is flexShrink={0}); without a cap on
 * the secondary surfaces a very tall stack on a short terminal overflows the
 * viewport and the user cannot see what they type. Four rows ≈ the composer's
 * minimum footprint (top border + one input line + bottom border + a status/hint
 * line) plus the single notification row. Modals are exempt — they self-cap via
 * modalHeight and replace (not stack above) the composer.
 */
const COMPOSER_RESERVE_ROWS = 4;

/**
 * Combined max-height for the stacked NON-modal secondary surfaces (cockpit dock
 * + subagent footer + inline completion popup), so they can never consume the
 * rows reserved for the composer + notification on a short terminal. Returns the
 * terminal-row budget minus the overlay reserve (a sliver of scrollback) and the
 * composer reserve, floored at 1 so the container is always at least one row.
 * When the terminal height is unknown (<= 0) there is no cap (Infinity).
 *
 * Pure + exported for isolated unit testing (no renderer mount required).
 */
export function resolveStackedSurfaceMaxHeight(terminalRows: number): number {
  if (!Number.isFinite(terminalRows) || terminalRows <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.max(1, terminalRows - FOOTER_OVERLAY_RESERVE_ROWS - COMPOSER_RESERVE_ROWS);
}

// ---------------------------------------------------------------------------
// Inline notification row — mirrors ToastStrip's latest-visible behavior but
// renders IN FLOW (no position="absolute") so the footer-height router can
// measure and allocate the correct footerHeight.
// ---------------------------------------------------------------------------

const FOOTER_NOTIFICATION_VISIBLE_MS = 5_000;

/**
 * Returns the text and level-color for the latest notification, or undefined
 * when there is nothing to show (no notifications, or the latest has expired).
 * Pure function — testable without Solid.
 */
export function buildFooterNotificationRow(
  notifications: readonly CliShellNotification[],
  nowMs: number,
  theme: SessionPalette,
): { text: string; color: string } | undefined {
  const latest = notifications.at(-1);
  if (!latest) {
    return undefined;
  }
  if (nowMs - latest.createdAt >= FOOTER_NOTIFICATION_VISIBLE_MS) {
    return undefined;
  }
  const color =
    latest.level === "error"
      ? theme.error
      : latest.level === "warning"
        ? theme.warning
        : theme.text;
  return { text: renderNotificationSummary(latest), color };
}

/**
 * Renders the latest transient notification INLINE (in normal flow) above the
 * composer. In-flow placement means the footer-height router correctly measures
 * the expanded footer and allocates the necessary scrollback rows, preventing
 * overlap with the transcript.
 */
function FooterNotifications(input: {
  notifications: readonly CliShellNotification[];
  theme: SessionPalette;
}) {
  const [nowMs, setNowMs] = createSignal(Date.now());

  // Re-arm the expiry timer whenever the latest notification changes.
  createEffect(() => {
    const latest = input.notifications.at(-1);
    if (!latest) {
      return;
    }
    const now = Date.now();
    setNowMs(now);
    const remainingMs = FOOTER_NOTIFICATION_VISIBLE_MS - (now - latest.createdAt);
    if (remainingMs <= 0) {
      return;
    }
    // Timer.unref() is available in both Node.js (NodeJS.Timeout) and Bun
    // (bun-types Timer), so no cast is needed.
    const timer = setTimeout(() => setNowMs(Date.now()), remainingMs + 1);
    timer.unref?.();
    onCleanup(() => clearTimeout(timer));
  });

  const row = createMemo(() =>
    buildFooterNotificationRow(input.notifications, nowMs(), input.theme),
  );

  return (
    <Show when={row()}>
      <box width="100%" marginBottom={1}>
        <text fg={row()!.color} wrapMode="word" width="100%">
          {row()!.text}
        </text>
      </box>
    </Show>
  );
}

/**
 * Keymap-mode resolver for the footer shell. Resolution order: an active text
 * selection wins; then an active modal overlay routes to its keymap mode (pager
 * payloads use the "pager" layer, every other payload uses "overlay") so
 * Enter/Esc/arrows reach the modal and Esc closes it; then subagent-footer focus
 * routes to the "subagentFooter" layer (next/select/open/cancel) before
 * completion; then the completion popup; then the bare composer.
 *
 * Exported for isolated unit testing (no renderer mount required).
 */
export function resolveFooterKeymapMode(
  state: ReturnType<ShellRendererController["getViewState"]>,
  renderer: OpenTuiRenderer,
): ComposerKeymapMode {
  if (renderer.getSelection?.()) {
    return "selection";
  }
  const payload = state.overlay.active?.payload;
  if (payload?.kind === "pager") {
    return "pager";
  }
  if (payload) {
    return "overlay";
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
 * The Brewva OpenTUI interactive shell: renders ONLY the live footer (composer +
 * status labels). The settled transcript and the in-flight message's stable
 * blocks are committed to the renderer's native scrollback by
 * SplitFooterScrollbackWriter (driven from CliInteractiveOpenTuiShellRuntime),
 * so this component deliberately does NOT render the transcript — that is the
 * whole point of the split-footer renderer (no per-frame transcript repaint ->
 * no streaming flicker).
 *
 * Composer input is wired via the shared useComposerInputWiring hook (keymap,
 * keyboard/paste routing into runtime.handleInput, uncontrolled-textarea editor
 * sync, prompt-part extmarks).
 *
 * Footer surfaces:
 *   - footer-height router (dynamic footerHeight for the split renderer),
 *     CAPPED to terminalRows - FOOTER_OVERLAY_RESERVE_ROWS so a tall modal
 *     never consumes the whole terminal
 *   - Notifications (inline FooterNotifications, not position="absolute" ToastStrip,
 *     so the height router allocates the correct footer space)
 *   - ModalOverlay (tool approval, confirm, question, select, sessions, pager,
 *     inspect, tasks, input, …): rendered IN FLOW via DialogLayoutProvider
 *     "inline" (no position="absolute", which would float over the tiny footer
 *     region and be clipped). The footer grows to the modal's height (router),
 *     overflow scrolls within the modal surface, and resolveFooterKeymapMode
 *     routes keys to the modal (Esc closes). The composer is hidden while a
 *     modal is active.
 *   - CockpitDockSurface (cockpit projection / status dock): in-flow box, gated
 *     by an active projection, docked ABOVE the composer.
 *   - SubagentFooterPanel (subagent run footer + focus mode): in-flow box, gated
 *     by non-empty task runs, docked above the composer. focus.active ===
 *     "subagentFooter" routes input via resolveFooterKeymapMode's
 *     "subagentFooter" layer and blocks the composer (promptInputBlocked).
 *   - CompletionOverlay (slash/@ completion popup): rendered IN FLOW via the
 *     completion layout="inline" mode (no position="absolute") ABOVE the
 *     composer so the height router allocates rows for it; tall lists scroll in
 *     the popup's own scrollbox. resolveFooterKeymapMode's "completion" layer
 *     already routes arrows/Enter/Esc to it.
 */
export function BrewvaOpenTuiShell(input: {
  runtime: ShellRendererController;
  renderer?: OpenTuiRenderer;
  copyTextToClipboard?: ClipboardCopy;
}) {
  const wiring = useComposerInputWiring({
    runtime: input.runtime,
    renderer: input.renderer,
    copyTextToClipboard: input.copyTextToClipboard,
    keymapMode: resolveFooterKeymapMode,
  });
  const { state, dimensions, theme } = wiring;

  // Full terminal row count. NOT dimensions()/renderer.height — in split-footer
  // mode BOTH of those are the render REGION (the footer itself; they track
  // footerHeight), so any cap derived from them feeds back and collapses the
  // footer to 1 row. renderer.terminalHeight is the stable terminal height;
  // track it reactively (it changes on resize, not per frame).
  const [footerTerminalRows, setFooterTerminalRows] = createSignal(
    (input.renderer as SplitFooterRenderer | undefined)?.terminalHeight ?? dimensions().height,
  );
  createEffect(() => {
    const r = input.renderer as SplitFooterRenderer | undefined;
    if (!r) {
      return;
    }
    const update = (): void => {
      setFooterTerminalRows(r.terminalHeight ?? dimensions().height);
    };
    update();
    r.on("resize", update);
    onCleanup(() => r.off("resize", update));
  });

  // Footer-height router: the split renderer allocates a FIXED footerHeight, so
  // size it to the footer's actual laid-out content height (composer + status,
  // or an active modal overlay) and keep it in sync as content grows/shrinks.
  // Mirrors opencode's RunFooter.applyHeight: read the rendered footer height
  // each frame and push changes to renderer.footerHeight. Without this the
  // footer is stuck at its small initial height and the composer is clipped.
  //
  // The height is CAPPED to terminalRows - FOOTER_OVERLAY_RESERVE_ROWS: a tall
  // modal (e.g. a long sessions/select list) must not consume the whole
  // terminal. When the laid-out content exceeds the cap the footer is clamped
  // and the overflow scrolls within the modal surface (the overlay components
  // self-cap to the height they receive). The reserve keeps a sliver of native
  // scrollback visible behind the footer.
  const [footerBox, setFooterBox] = createSignal<BoxRenderable | null>(null);
  createEffect(() => {
    const box = footerBox();
    const renderer = input.renderer as SplitFooterRenderer | undefined;
    if (!box || !renderer) {
      return;
    }
    const syncFooterHeight = (): void => {
      // Cap against the FULL TERMINAL height (footerTerminalRows() ==
      // renderer.terminalHeight). renderer.height AND dimensions() are BOTH the
      // split-footer render region (== footerHeight), so capping against either
      // feeds back and collapses the footer to 1 row.
      const terminalRows = footerTerminalRows();
      const maxFooterRows =
        terminalRows > 0
          ? Math.max(1, terminalRows - FOOTER_OVERLAY_RESERVE_ROWS)
          : Number.POSITIVE_INFINITY;
      const height = Math.min(box.height, maxFooterRows);
      if (height > 0 && height !== renderer.footerHeight) {
        renderer.footerHeight = height;
      }
    };
    syncFooterHeight();
    renderer.on("frame", syncFooterHeight);
    onCleanup(() => renderer.off("frame", syncFooterHeight));
  });

  const shellRenderContext = {
    runtime: input.runtime,
    diffStyle: () => state.diff.style,
    diffWrapMode: () => state.diff.wrapMode,
    showThinking: () => state.view.showThinking,
    scrollAcceleration: createMemo(() =>
      createScrollAcceleration(input.runtime.getTuiConfig().scroll.acceleration),
    ),
  };

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
  // The active modal overlay (if any). Clone the payload so the overlay
  // components — some of which mutate draft slices locally — never write back
  // into the reducer-owned store snapshot.
  const modalOverlay = createMemo(() => {
    const active = state.overlay.active;
    if (!active?.payload) {
      return undefined;
    }
    return { ...active, payload: cloneOverlayPayload(active.payload) };
  });
  // Block the composer while a modal overlay is active (input routes to the
  // modal via resolveFooterKeymapMode), while the subagent footer holds focus
  // (input routes to the footer), or when a cockpit composer policy requests it.
  const promptInputBlocked = createMemo(
    () =>
      Boolean(state.overlay.active) ||
      state.focus.active === "subagentFooter" ||
      (state.cockpit.projection?.composerPolicy ?? "active") === "block",
  );

  // Subagent run footer view (tabs + optional inspect detail), built from the
  // operator task runs and the subagent-footer focus state; visible only when
  // there are task runs.
  const subagentFooterView = createMemo(() =>
    buildSubagentFooterView({
      runs: state.operator.taskRuns,
      state: state.subagentFooter,
      getSessionWireFrames: (sessionId) => input.runtime.getSessionWireFrames(sessionId),
    }),
  );

  // Anchor + container for the inline completion popup. The popup renders in
  // flow (layout="inline"), so it does not depend on the anchor's absolute
  // coordinates, but the component's prop contract still requires them.
  const [promptAnchor, setPromptAnchor] = createSignal<BoxRenderable | null>(null);
  const [completionContainer, setCompletionContainer] = createSignal<BoxRenderable | null>(null);

  // Height handed to the inline modal: the full terminal minus the reserve, so
  // the overlay components' proportional surface math (resolveDialogSurface
  // Dimensions, resolveHighDensityPickerRows) self-caps to a surface that fits
  // inside the capped footer. The height router clamps the footer to the same
  // bound, so a modal taller than this scrolls within its own surface.
  const modalHeight = createMemo(() =>
    Math.max(1, footerTerminalRows() - FOOTER_OVERLAY_RESERVE_ROWS),
  );

  // Combined cap for the stacked secondary surfaces (cockpit + subagent +
  // completion) so they reserve rows for the composer on a short terminal
  // (FIX C). Rendered into a maxHeight + overflow="hidden" container so a tall
  // stack clips instead of pushing the composer (last child) off-screen.
  // `undefined` means no cap (terminal height unknown) — leaves the normal
  // few-surfaces layout untouched.
  const stackedSurfaceMaxHeight = createMemo<number | undefined>(() => {
    const cap = resolveStackedSurfaceMaxHeight(footerTerminalRows());
    return Number.isFinite(cap) ? cap : undefined;
  });

  const footer = (
    <ShellRenderProvider value={shellRenderContext}>
      <box
        ref={(node: BoxRenderable) => {
          setFooterBox(node);
          setCompletionContainer(node);
        }}
        width="100%"
        flexShrink={0}
        flexDirection="column"
        paddingLeft={2}
        paddingRight={2}
        backgroundColor={theme().background}
      >
        <Show
          when={modalOverlay()}
          fallback={
            <>
              {/* Stacked secondary surfaces (cockpit dock + subagent footer +
                  inline completion) render IN FLOW above the composer, each gated
                  by its own visibility, so the height router allocates rows for
                  them. They share a combined max-height (FIX C): on a short
                  terminal a tall stack clips here (overflow="hidden") instead of
                  pushing the composer — the last child — off the bottom edge.
                  flexShrink={1} lets the container yield to the composer; the cap
                  is undefined (no constraint) when the terminal height is unknown,
                  so the normal few-surfaces layout is unchanged. */}
              <box
                flexDirection="column"
                width="100%"
                flexShrink={1}
                overflow="hidden"
                maxHeight={stackedSurfaceMaxHeight()}
              >
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
                {/* Inline completion popup: rendered ABOVE the composer (render
                    order) via layout="inline"; the "completion" keymap layer
                    routes arrows/Enter/Esc to it. */}
                <Show when={state.composer.completion && !state.overlay.active}>
                  <CompletionOverlay
                    runtime={input.runtime}
                    completion={state.composer.completion!}
                    anchor={promptAnchor}
                    container={completionContainer}
                    width={dimensions().width}
                    height={dimensions().height}
                    theme={theme()}
                    layout="inline"
                  />
                </Show>
              </box>
              <FooterNotifications notifications={state.notifications} theme={theme()} />
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
            </>
          }
        >
          {(overlay) => (
            <DialogLayoutProvider mode="inline">
              <ModalOverlay
                overlay={overlay()}
                width={dimensions().width}
                height={modalHeight()}
                theme={theme()}
              />
            </DialogLayoutProvider>
          )}
        </Show>
      </box>
    </ShellRenderProvider>
  );

  return wiring.keymapController ? (
    <BrewvaKeymapRoot controller={wiring.keymapController}>{footer}</BrewvaKeymapRoot>
  ) : (
    footer
  );
}
