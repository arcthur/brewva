/** @jsxImportSource @opentui/solid */

import {
  type Accessor,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
} from "solid-js";
import {
  buildPromptPartSignature,
  cloneCliShellPromptParts,
} from "../../src/shell/domain/prompt-parts.js";
import type { CliShellPromptPart } from "../../src/shell/domain/prompt.js";
import type { ShellRendererController } from "../../src/shell/domain/renderer-contract.js";
import type { ShellViewModel } from "../../src/shell/domain/view-model.js";
import type {
  OpenTuiKeyEvent,
  OpenTuiRenderer,
  OpenTuiTextareaHandle,
} from "../internal-opentui-runtime.js";
import {
  decodePasteBytes,
  type PasteEvent,
  useKeyboard,
  usePaste,
  useRenderer,
  useTerminalDimensions,
} from "../opentui/index.js";
import { type BrewvaKeymapController, registerBrewvaKeymap } from "./keymap.js";
import { createPalette, type SessionPalette } from "./palette.js";
import { createPromptPartStyle } from "./prompt.js";
import {
  copyOpenTuiSelection,
  copyTextWithShellFeedback,
  type ClipboardCopy,
} from "./selection.js";
import {
  logicalCursorFromTextOffset,
  textOffsetFromLogicalCursor,
  toSemanticInput,
  useShellState,
} from "./utils.js";

const COMPOSER_EDITOR_SYNC_DEBOUNCE_MS = 80;

function supportsOpenTuiKeymap(renderer: OpenTuiRenderer): boolean {
  const candidate = renderer as unknown as {
    root?: unknown;
    keyInput?: unknown;
    currentFocusedRenderable?: unknown;
  };
  return Boolean(candidate.root && candidate.keyInput);
}

/**
 * The keymap mode (layer) the composer/input wiring should keep active.
 * Callers compute this from their own surface state (overlays, completion,
 * pager, subagentFooter, selection, or the bare composer).
 */
export type ComposerKeymapMode =
  | "composer"
  | "completion"
  | "selection"
  | "overlay"
  | "pager"
  | "subagentFooter";

export interface ComposerInputWiring {
  /** Live shell view model (reactive via the runtime store). */
  readonly state: ShellViewModel;
  /** Terminal dimensions accessor. */
  readonly dimensions: Accessor<{ width: number; height: number }>;
  /** Resolved palette for the current theme. */
  readonly theme: Accessor<SessionPalette>;
  /** The resolved OpenTUI renderer (explicit prop or context). */
  readonly renderer: OpenTuiRenderer;
  /** Register the composer textarea node (call from the PromptPanel ref). */
  setTextarea(this: void, node: OpenTuiTextareaHandle | null): void;
  /** Flush the textarea's latest content/cursor/parts into the runtime. */
  syncComposerFromEditor(this: void): Promise<void>;
  /** Copy the current renderer selection with shell feedback. */
  copySelection(this: void): Promise<boolean>;
  /** The active keymap controller, if the renderer supports keymaps. */
  readonly keymapController: BrewvaKeymapController | undefined;
}

export interface ComposerInputWiringInput {
  runtime: ShellRendererController;
  renderer?: OpenTuiRenderer;
  copyTextToClipboard?: ClipboardCopy;
  /**
   * Compute the keymap mode for the current surface state (overlay, pager,
   * subagentFooter, completion, selection, or the bare composer).
   */
  keymapMode(state: ShellViewModel, renderer: OpenTuiRenderer): ComposerKeymapMode;
}

/**
 * Shared composer + keyboard/keymap/paste wiring for the interactive shell.
 *
 * Owns the uncontrolled-textarea editor-sync loop, prompt-part extmark
 * lifecycle, keymap registration + mode tracking, the viewport-resize report,
 * and the keyboard/paste handlers that route into `runtime.handleInput(...)`.
 */
export function useComposerInputWiring(input: ComposerInputWiringInput): ComposerInputWiring {
  const state = useShellState(input.runtime);
  const dimensions = useTerminalDimensions();
  const renderer = (input.renderer ?? useRenderer()) as OpenTuiRenderer;
  const theme = createMemo(() => createPalette(state.theme));

  const [textarea, setTextarea] = createSignal<OpenTuiTextareaHandle | null>(null);

  const [promptPartTypeId, setPromptPartTypeId] = createSignal<number | null>(null);
  const [promptPartIdByExtmarkId, setPromptPartIdByExtmarkId] = createSignal(
    new Map<number, string>(),
  );
  const [appliedPromptPartSignature, setAppliedPromptPartSignature] = createSignal(
    buildPromptPartSignature(state.composer.parts),
  );
  const emptyPromptPartSignature = buildPromptPartSignature([]);

  // Prompt-part extmark styling: resolve the style ids from the shared
  // prompt-part SyntaxStyle so file/text/agent tokens are colored consistently
  // in the composer.
  const promptPartStyle = createMemo(() => createPromptPartStyle(theme()));
  const filePromptPartStyleId = createMemo(() => promptPartStyle().getStyleId("extmark.file"));
  const textPromptPartStyleId = createMemo(() => promptPartStyle().getStyleId("extmark.text"));
  const agentPromptPartStyleId = createMemo(() => promptPartStyle().getStyleId("extmark.agent"));

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

  const keymapMode = createMemo(() => input.keymapMode(state, renderer));
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

  // The textarea is uncontrolled while the user edits: editor-sourced sync
  // echoes keep `composer.revision` unchanged and are never written back, so a
  // stale echo cannot clobber keystrokes typed after it. Only external composer
  // changes (history navigation, completion accept, prefill, submit-clear) bump
  // the revision and reach the node. The guard is keyed to the node as well as
  // the revision: a recreated textarea must receive the current composer state
  // even though the revision has not moved.
  let appliedComposerWrite: { node: OpenTuiTextareaHandle; revision: number } | undefined;
  createEffect(() => {
    const node = textarea();
    const revision = state.composer.revision;
    if (
      !node ||
      node.isDestroyed ||
      (appliedComposerWrite?.node === node && appliedComposerWrite.revision === revision)
    ) {
      return;
    }
    appliedComposerWrite = { node, revision };
    const composer = untrack(() => ({ text: state.composer.text, cursor: state.composer.cursor }));
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

  return {
    state,
    dimensions,
    theme,
    renderer,
    setTextarea,
    syncComposerFromEditor,
    copySelection,
    keymapController,
  };
}
