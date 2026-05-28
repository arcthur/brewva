/** @jsxImportSource @opentui/solid */

import { For, Show, createMemo } from "solid-js";
import type { CliQuestionOverlayPayload } from "../../../src/shell/domain/overlays/payloads.js";
import { TextAttributes } from "../../opentui/index.js";
import type { SessionPalette } from "../palette.js";
import { OverlaySurface } from "./frame.js";

export function QuestionOverlay(input: {
  payload: CliQuestionOverlayPayload;
  width: number;
  height: number;
  theme: SessionPalette;
}) {
  const question = createMemo(() => input.payload.snapshot.questions[input.payload.selectedIndex]);
  const title = createMemo(() => input.payload.requestTitle ?? "Review");
  const options = createMemo(() => question()?.options ?? []);
  const showCustom = createMemo(() => question() && question()?.custom !== false);

  return (
    <OverlaySurface
      title={title()}
      width={input.width}
      height={input.height}
      theme={input.theme}
      footer="enter confirm | esc close"
    >
      <Show
        when={question()}
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
        <box flexDirection="column" gap={1}>
          <text fg={input.theme.accent} attributes={TextAttributes.BOLD}>
            {question()!.header ?? "Question"}
          </text>
          <text fg={input.theme.text} wrapMode="word">
            {question()!.questionText}
          </text>
          <For each={options()}>
            {(option, index) => (
              <box flexDirection="column">
                <text fg={input.theme.text}>
                  {index() + 1}. {option.label}
                </text>
                <Show when={option.description}>
                  <text fg={input.theme.textMuted}>{option.description}</text>
                </Show>
              </box>
            )}
          </For>
          <Show when={showCustom()}>
            <text fg={input.theme.textMuted}>Custom</text>
          </Show>
        </box>
      </Show>
    </OverlaySurface>
  );
}
