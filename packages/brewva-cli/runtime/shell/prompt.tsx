/** @jsxImportSource @opentui/solid */

import { For, Show, createEffect, createMemo } from "solid-js";
import { truncateToWidth, visibleWidth } from "../../src/internal/tui/index.js";
import {
  cloneCliShellPromptParts,
  rebasePromptPartsAfterTextReplace,
} from "../../src/shell/domain/prompt-parts.js";
import type { ShellRendererController } from "../../src/shell/domain/renderer-contract.js";
import type { ShellViewModel } from "../../src/shell/domain/view-model.js";
import type { OpenTuiTextareaHandle } from "../internal-opentui-runtime.js";
import {
  SyntaxStyle,
  decodePasteBytes,
  type BoxRenderable,
  type PasteEvent,
} from "../opentui/index.js";
import { SPLIT_BORDER_CHARS, type SessionPalette } from "./palette.js";
import {
  completionItemAuxText,
  completionKindLabel,
  textOffsetFromLogicalCursor,
} from "./utils.js";

interface TextareaKeyDownEvent {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  preventDefault(): void;
  stopPropagation?(): void;
}

export function createPromptPartStyle(theme: SessionPalette): SyntaxStyle {
  return SyntaxStyle.fromTheme([
    {
      scope: ["extmark.file"],
      style: {
        foreground: theme.accent,
        underline: true,
      },
    },
    {
      scope: ["extmark.text"],
      style: {
        foreground: theme.warning,
      },
    },
    {
      scope: ["extmark.agent"],
      style: {
        foreground: theme.accentSoft,
        underline: true,
      },
    },
  ]);
}

export function summarizePastedText(text: string): string {
  const lineCount = (text.match(/\n/gu)?.length ?? 0) + 1;
  return lineCount >= 2 ? `[Pasted ~${lineCount} lines]` : "[Pasted text]";
}

export function createPromptPartTokenId(prefix: "agent" | "file" | "text"): string {
  return `${prefix}-part:${Date.now()}:${Math.random().toString(16).slice(2, 10)}`;
}

function summarizeQueuedPrompt(text: string, width: number): string {
  const firstLine = text.split(/\r?\n/u)[0]?.trim() || "(empty prompt)";
  const pendingSuffix = " (pending)";
  const promptStripGutterWidth = 3;
  const availableWidth = Math.max(12, width - visibleWidth(pendingSuffix) - promptStripGutterWidth);
  if (visibleWidth(firstLine) <= availableWidth) {
    return firstLine;
  }
  if (availableWidth <= 1) {
    return "…";
  }
  return `${truncateToWidth(firstLine, availableWidth - 1)}…`;
}

export function PromptPanel(input: {
  runtime: ShellRendererController;
  composer: ShellViewModel["composer"];
  queue: ShellViewModel["queue"];
  status: ShellViewModel["status"];
  overlayActive: boolean;
  theme: SessionPalette;
  width: number;
  modelLabel: string;
  thinkingLevel: string;
  lineageLabel: string;
  setAnchor(node: BoxRenderable): void;
  setTextarea(node: OpenTuiTextareaHandle): void;
}) {
  let textarea: OpenTuiTextareaHandle | null = null;
  const narrow = createMemo(() => input.width < 96);
  const stackedFooter = createMemo(
    () => narrow() || Boolean(input.composer.completion) || input.width < 128,
  );
  const promptPartStyle = createMemo(() => createPromptPartStyle(input.theme));
  const promptStatus = createMemo((): string | undefined => {
    if (input.status.workingMessage) {
      return input.status.workingMessage;
    }
    if (input.status.hiddenThinkingLabel) {
      return input.status.hiddenThinkingLabel;
    }
    const trust = input.status.trust;
    if (trust?.statusText && trust.source !== "idle") {
      return trust.statusText;
    }
    const phase = input.status.entries.phase;
    const pressure = input.status.entries.pressure;
    const correction = input.status.entries.correction;
    if (!phase && !pressure && !correction) {
      return undefined;
    }
    let baseStatus = "";
    if (phase && pressure) {
      baseStatus = `${phase} · pressure=${pressure}`;
    } else if (phase) {
      baseStatus = phase;
    } else if (pressure) {
      baseStatus = `pressure=${pressure}`;
    }
    return correction ? (baseStatus ? `${baseStatus} · ${correction}` : correction) : baseStatus;
  });
  const operatorCounts = createMemo(() => {
    const approvals = input.status.entries.approvals ?? "0";
    const questions = input.status.entries.questions ?? "0";
    const tasks = input.status.entries.tasks ?? "0";
    return `approvals=${approvals} · questions=${questions} · tasks=${tasks}`;
  });
  const selectedCompletion = createMemo(() => {
    const completion = input.composer.completion;
    if (!completion || input.overlayActive) {
      return undefined;
    }
    return completion.items[completion.selectedIndex];
  });
  const selectedCompletionLabel = createMemo(() => {
    const completion = input.composer.completion;
    const selected = selectedCompletion();
    if (!completion || !selected) {
      return undefined;
    }
    return `${completionKindLabel(completion.trigger)} ${selected.label}`;
  });
  const footerStatus = createMemo(() => {
    const completion = input.composer.completion;
    const selected = selectedCompletion();
    const auxText = completion && selected ? completionItemAuxText(selected) : undefined;
    return auxText ?? promptStatus();
  });
  const showFooterStatus = createMemo(
    () => (!input.composer.completion || input.overlayActive) && Boolean(footerStatus()),
  );
  const completionHints = createMemo(() =>
    input.composer.completion
      ? input.composer.completion.trigger === "/"
        ? "enter run · tab complete · esc close"
        : selectedCompletion()?.kind === "directory"
          ? "tab expand · enter accept · esc close"
          : "tab insert · enter accept · esc close"
      : undefined,
  );
  const promptAccent = createMemo(() =>
    input.overlayActive
      ? input.theme.border
      : input.composer.completion
        ? input.theme.accent
        : input.theme.borderActive,
  );
  const promptHints = createMemo(() =>
    [
      "enter send",
      "ctrl+k commands",
      "/help",
      "/ slash",
      "ctrl+b queue",
      "ctrl+o questions",
      "ctrl+s stash",
      completionHints(),
    ]
      .filter(Boolean)
      .join(" · "),
  );
  createEffect(() => {
    const node = textarea;
    if (!node || node.isDestroyed) {
      return;
    }
    if (input.overlayActive) {
      node.blur();
      return;
    }
    node.focus();
  });
  const handleTextareaKeyDown = (event: TextareaKeyDownEvent) => {
    const key = event.name?.toLowerCase();
    if (key !== "escape" && key !== "esc") {
      return;
    }
    const shellInput = {
      key: event.name ?? "escape",
      ctrl: event.ctrl === true,
      meta: event.meta === true,
      shift: event.shift === true,
    };
    event.preventDefault();
    event.stopPropagation?.();
    if (!input.runtime.wantsInput(shellInput)) {
      return;
    }
    void input.runtime.handleInput(shellInput);
  };

  return (
    <box flexShrink={0} flexDirection="column" gap={1}>
      <box
        ref={(node: BoxRenderable) => input.setAnchor(node)}
        width="100%"
        border={["left"]}
        customBorderChars={{
          ...SPLIT_BORDER_CHARS,
          bottomLeft: "╹",
        }}
        borderColor={promptAccent()}
        backgroundColor={input.theme.backgroundPanel}
      >
        <box
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          paddingBottom={1}
          backgroundColor={input.theme.backgroundElement}
          flexDirection="column"
        >
          <textarea
            ref={(node: OpenTuiTextareaHandle) => {
              textarea = node;
              input.setTextarea(node);
            }}
            focused={!input.overlayActive}
            onMouseDown={(event: { target: { focus?: () => void } | null }) => {
              event.target?.focus?.();
            }}
            onKeyDown={handleTextareaKeyDown}
            initialValue={input.composer.text}
            onSubmit={() => {
              void input.runtime.handleInput({
                key: "enter",
                ctrl: false,
                meta: false,
                shift: false,
              });
            }}
            onPaste={(event: PasteEvent) => {
              const node = textarea;
              if (!node || node.isDestroyed) {
                return;
              }
              const pastedText = decodePasteBytes(event.bytes)
                .replace(/\r\n/gu, "\n")
                .replace(/\r/gu, "\n");
              const trimmed = pastedText.trim();
              if (trimmed.length === 0) {
                return;
              }
              const lineCount = (trimmed.match(/\n/gu)?.length ?? 0) + 1;
              if (lineCount < 3 && trimmed.length <= 150) {
                return;
              }
              event.preventDefault();
              const tokenText = summarizePastedText(trimmed);
              const insertion = `${tokenText} `;
              const start = textOffsetFromLogicalCursor(node.plainText, node.logicalCursor);
              node.insertText(insertion);
              const nextParts = rebasePromptPartsAfterTextReplace(
                cloneCliShellPromptParts(input.composer.parts),
                {
                  start,
                  end: start,
                  replacementText: insertion,
                },
                {
                  id: createPromptPartTokenId("text"),
                  type: "text",
                  text: trimmed,
                  source: {
                    text: {
                      start,
                      end: start + tokenText.length,
                      value: tokenText,
                    },
                  },
                },
              );
              void input.runtime.handleInput({
                type: "composer.editorSync",
                text: node.plainText,
                cursor: textOffsetFromLogicalCursor(node.plainText, node.logicalCursor),
                parts: nextParts,
              });
            }}
            placeholder="Ask Brewva or type / for commands"
            minHeight={1}
            maxHeight={6}
            backgroundColor={input.theme.backgroundElement}
            textColor={input.theme.text}
            focusedBackgroundColor={input.theme.backgroundElement}
            focusedTextColor={input.theme.text}
            placeholderColor={input.theme.textDim}
            syntaxStyle={promptPartStyle()}
          />
          <Show when={input.queue.length > 0}>
            <box paddingTop={1} flexDirection="column">
              <For each={input.queue.slice(0, 3)}>
                {(entry) => (
                  <text fg={input.theme.textMuted} wrapMode="none">
                    {`${summarizeQueuedPrompt(entry.text, input.width)} (pending)`}
                  </text>
                )}
              </For>
              <Show when={input.queue.length > 3}>
                <text fg={input.theme.textDim} wrapMode="none">
                  {`+${input.queue.length - 3} more · Ctrl+B to manage`}
                </text>
              </Show>
            </box>
          </Show>
          <box
            paddingTop={1}
            flexDirection={narrow() ? "column" : "row"}
            justifyContent={narrow() ? "flex-start" : "space-between"}
            alignItems={narrow() ? "flex-start" : "center"}
            gap={1}
          >
            <box flexDirection={narrow() ? "column" : "row"} gap={1} flexShrink={0}>
              <text fg={promptAccent()} wrapMode="none">
                Brewva
              </text>
              <text fg={input.theme.text} wrapMode="none">
                {input.modelLabel}
              </text>
              <text fg={input.theme.textMuted} wrapMode="none">
                think {input.thinkingLevel}
              </text>
              <Show when={input.lineageLabel}>
                <text fg={input.theme.textMuted} wrapMode="none">
                  branch {input.lineageLabel}
                </text>
              </Show>
            </box>
            <Show when={selectedCompletionLabel()}>
              <text fg={input.theme.accentSoft} wrapMode="none">
                {selectedCompletionLabel()}
              </text>
            </Show>
            <Show when={!selectedCompletionLabel()}>
              <text fg={input.theme.textMuted} wrapMode="none">
                {operatorCounts()}
              </text>
            </Show>
          </box>
        </box>
      </box>
      <box
        paddingLeft={2}
        paddingRight={1}
        flexDirection={stackedFooter() ? "column" : "row"}
        justifyContent={stackedFooter() ? "flex-start" : "space-between"}
        alignItems={stackedFooter() ? "flex-start" : "center"}
        gap={1}
      >
        <Show when={showFooterStatus()}>
          <text fg={input.theme.textMuted} wrapMode="none">
            {footerStatus()}
          </text>
        </Show>
        <text fg={input.theme.textMuted} wrapMode="none">
          {promptHints()}
        </text>
      </box>
    </box>
  );
}
