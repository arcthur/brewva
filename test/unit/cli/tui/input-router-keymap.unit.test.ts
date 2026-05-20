import { describe, expect, test } from "bun:test";
import { routeShellInput } from "../../../../packages/brewva-cli/src/shell/domain/input-router.js";

const key = (
  value: string,
  input: Partial<{ ctrl: boolean; meta: boolean; shift: boolean }> = {},
) => ({
  key: value,
  ctrl: input.ctrl === true,
  meta: input.meta === true,
  shift: input.shift === true,
});

describe("shell input router after keymap ownership", () => {
  test("routes picker and modal text input while leaving normal shortcuts to keymap", () => {
    expect(
      routeShellInput({
        input: key("k", { ctrl: true }),
        state: {
          hasCompletion: false,
          isStreaming: false,
          canNavigatePromptHistoryPrevious: false,
          canNavigatePromptHistoryNext: false,
        },
      }),
    ).toEqual({ handled: false });

    expect(
      routeShellInput({
        input: { ...key("x"), text: "x" },
        state: {
          activeOverlayKind: "commandPalette",
          hasCompletion: false,
          isStreaming: false,
          canNavigatePromptHistoryPrevious: false,
          canNavigatePromptHistoryNext: false,
        },
      }),
    ).toEqual({
      handled: true,
      intent: { type: "picker.input", input: { ...key("x"), text: "x" } },
    });
  });

  test("keeps streaming escape abort as non-keymap fallback behavior", () => {
    expect(
      routeShellInput({
        input: key("escape"),
        state: {
          hasCompletion: false,
          isStreaming: true,
          canNavigatePromptHistoryPrevious: false,
          canNavigatePromptHistoryNext: false,
        },
      }),
    ).toEqual({
      handled: true,
      intent: {
        type: "effect.dispatch",
        effect: { type: "session.abort", notification: "Aborted the current turn." },
      },
    });
  });
});
