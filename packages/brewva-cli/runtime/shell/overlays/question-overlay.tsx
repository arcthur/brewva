/** @jsxImportSource @opentui/solid */

import { For, Show, createMemo } from "solid-js";
import type { CliQuestionOverlayPayload } from "../../../src/shell/domain/overlays/payloads.js";
import {
  projectQuestionOverlay,
  type QuestionOverlayOptionProjection,
} from "../../../src/shell/domain/question-utils.js";
import { TextAttributes } from "../../opentui/index.js";
import type { SessionPalette } from "../palette.js";
import { OverlaySurface } from "./frame.js";

function optionPrefix(option: QuestionOverlayOptionProjection, multiple: boolean): string {
  const caret = option.selected ? "▸" : " ";
  if (multiple) {
    return `${caret} ${option.checked ? "[x]" : "[ ]"}`;
  }
  if (option.isCustom) {
    return `${caret} +`;
  }
  return `${caret} ${option.index + 1}.`;
}

export function QuestionOverlay(input: {
  payload: CliQuestionOverlayPayload;
  width: number;
  height: number;
  theme: SessionPalette;
  onSelectOption?: (optionIndex: number) => void;
}) {
  const view = createMemo(() => projectQuestionOverlay(input.payload));
  const title = createMemo(() => input.payload.requestTitle ?? "Review");

  return (
    <OverlaySurface
      title={title()}
      width={input.width}
      height={input.height}
      theme={input.theme}
      footer="↑↓ or click select · enter confirm · esc close"
    >
      <Show
        when={view()}
        fallback={
          <box flexDirection="column" gap={1}>
            <text fg={input.theme.textMuted}>No pending operator input.</text>
            <text fg={input.theme.textMuted}>
              Brewva will show pending input requests and follow-up questions here.
            </text>
            <text fg={input.theme.textMuted}>Answer when Brewva needs your input.</text>
          </box>
        }
      >
        {(resolved) => (
          <box flexDirection="column" gap={1}>
            <text fg={input.theme.accent} attributes={TextAttributes.BOLD}>
              {resolved().header}
            </text>
            <text fg={input.theme.text} wrapMode="word">
              {resolved().questionText}
            </text>
            <For each={resolved().options}>
              {(option) => (
                <box
                  flexDirection="column"
                  backgroundColor={option.selected ? input.theme.primary : undefined}
                  onMouseUp={() => input.onSelectOption?.(option.index)}
                >
                  <text fg={option.selected ? input.theme.background : input.theme.text}>
                    {optionPrefix(option, resolved().multiple)} {option.label}
                  </text>
                  <Show when={option.description}>
                    <text fg={option.selected ? input.theme.background : input.theme.textMuted}>
                      {"    "}
                      {option.description}
                    </text>
                  </Show>
                </box>
              )}
            </For>
          </box>
        )}
      </Show>
    </OverlaySurface>
  );
}
