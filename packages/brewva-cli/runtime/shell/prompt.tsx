/** @jsxImportSource @opentui/solid */

import type { OpenTuiTextareaHandle } from "@brewva/brewva-tui/internal-opentui-runtime";
import { SyntaxStyle, decodePasteBytes, type BoxRenderable, type PasteEvent } from "@opentui/core";
import { Show, createMemo } from "solid-js";
import type { CliShellController } from "../../src/shell/controller.js";
import {
  cloneCliShellPromptParts,
  rebasePromptPartsAfterTextReplace,
} from "../../src/shell/prompt-parts.js";
import type { CliShellState } from "../../src/shell/state/index.js";
import { SPLIT_BORDER_CHARS, type SessionPalette } from "./palette.js";
import {
  completionItemAuxText,
  completionKindLabel,
  textOffsetFromLogicalCursor,
} from "./utils.js";

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
  ]);
}

export function summarizePastedText(text: string): string {
  const lineCount = (text.match(/\n/gu)?.length ?? 0) + 1;
  return lineCount >= 2 ? `[Pasted ~${lineCount} lines]` : "[Pasted text]";
}

export function createPromptPartTokenId(prefix: "file" | "text"): string {
  return `${prefix}-part:${Date.now()}:${Math.random().toString(16).slice(2, 10)}`;
}

export function PromptPanel(input: {
  controller: CliShellController;
  composer: CliShellState["composer"];
  status: CliShellState["status"];
  overlayActive: boolean;
  theme: SessionPalette;
  width: number;
  modelLabel: string;
  thinkingLevel: string;
  setAnchor(node: BoxRenderable): void;
  setTextarea(node: OpenTuiTextareaHandle): void;
}) {
  let textarea: OpenTuiTextareaHandle | null = null;
  const narrow = createMemo(() => input.width < 96);
  const stackedFooter = createMemo(
    () => narrow() || Boolean(input.composer.completion) || input.width < 128,
  );
  const promptPartStyle = createMemo(() => createPromptPartStyle(input.theme));
  const promptStatus = createMemo(() => {
    if (input.status.workingMessage) {
      return input.status.workingMessage;
    }
    if (input.status.hiddenThinkingLabel) {
      return input.status.hiddenThinkingLabel;
    }
    const phase = input.status.entries.phase;
    const pressure = input.status.entries.pressure;
    if (phase && pressure) {
      return `${phase} · pressure=${pressure}`;
    }
    if (phase) {
      return phase;
    }
    if (pressure) {
      return `pressure=${pressure}`;
    }
    return "idle";
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
    return `${completionKindLabel(completion.kind)} ${selected.label}`;
  });
  const footerStatus = createMemo(() => {
    const selected = selectedCompletion();
    const auxText = selected ? completionItemAuxText(selected) : undefined;
    return auxText ?? promptStatus();
  });
  const completionHints = createMemo(() =>
    input.composer.completion
      ? input.composer.completion.kind === "slash"
        ? "tab accept · esc close"
        : selectedCompletion()?.detail === "directory"
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
      "/ commands",
      "ctrl+a approvals",
      "ctrl+o questions",
      "ctrl+s stash",
      "ctrl+y restore",
      completionHints(),
    ]
      .filter(Boolean)
      .join(" · "),
  );
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
            initialValue={input.composer.text}
            onSubmit={() => {
              void input.controller.handleSemanticInput({
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
              input.controller.syncComposerFromEditor(
                node.plainText,
                textOffsetFromLogicalCursor(node.plainText, node.logicalCursor),
                nextParts,
              );
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
        <text fg={input.theme.textMuted} wrapMode="none">
          {footerStatus()}
        </text>
        <text fg={input.theme.textMuted} wrapMode="none">
          {promptHints()}
        </text>
      </box>
    </box>
  );
}
