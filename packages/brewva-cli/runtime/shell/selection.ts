import type { ClipboardOsc52Writer } from "./clipboard.js";
import { copyTextToClipboard } from "./clipboard.js";

type NotificationLevel = "info" | "warning" | "error";

export interface OpenTuiSelection {
  getSelectedText(): string;
}

export interface OpenTuiSelectionRenderer extends ClipboardOsc52Writer {
  getSelection?(): OpenTuiSelection | null;
  clearSelection?(): void;
}

/**
 * True only when the renderer selection covers actual TEXT. A bare left-click
 * on selectable content already creates a Selection object (anchor == focus,
 * empty text) that lingers until cleared — gating keymap behavior on the
 * OBJECT would flip the shell into selection mode, silently disabling the
 * composer's editing keys, every time the operator clicks the terminal (e.g.
 * refocusing it after a browser OAuth approval). Matches opencode's
 * `getSelection()?.getSelectedText()` guard.
 */
export function hasOpenTuiSelectedText(renderer: {
  getSelection?(): OpenTuiSelection | null;
}): boolean {
  const selection = renderer.getSelection?.();
  return Boolean(selection && selection.getSelectedText().length > 0);
}

export interface CopySelectionNotifier {
  notify(message: string, level?: NotificationLevel): void;
}

export type ClipboardCopy = (text: string) => Promise<void>;

function formatClipboardError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return `Failed to copy selection: ${error.message}`;
  }
  return "Failed to copy selection.";
}

export async function copyTextWithShellFeedback(input: {
  text: string;
  renderer?: OpenTuiSelectionRenderer;
  copyText?: ClipboardCopy;
  notifier: CopySelectionNotifier;
}): Promise<boolean> {
  if (!input.text) {
    return false;
  }
  try {
    const copyText =
      input.copyText ?? ((text: string) => copyTextToClipboard(text, { renderer: input.renderer }));
    await copyText(input.text);
    input.notifier.notify("Copied to clipboard.", "info");
    return true;
  } catch (error) {
    input.notifier.notify(formatClipboardError(error), "error");
    return false;
  } finally {
    input.renderer?.clearSelection?.();
  }
}

export async function copyOpenTuiSelection(input: {
  renderer?: OpenTuiSelectionRenderer;
  copyText?: ClipboardCopy;
  notifier: CopySelectionNotifier;
}): Promise<boolean> {
  const text = input.renderer?.getSelection?.()?.getSelectedText() ?? "";
  return await copyTextWithShellFeedback({
    text,
    renderer: input.renderer,
    copyText: input.copyText,
    notifier: input.notifier,
  });
}
