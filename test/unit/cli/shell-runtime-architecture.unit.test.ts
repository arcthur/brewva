import { describe, expect, test } from "bun:test";
import type { KeybindingResolver } from "../../../packages/brewva-cli/src/internal/tui/index.js";
import type { ShellAction } from "../../../packages/brewva-cli/src/shell/domain/actions.js";
import { routeShellInput } from "../../../packages/brewva-cli/src/shell/domain/input-router.js";
import {
  decodeShellKeybindingEffect,
  shellBuiltInKeybindings,
} from "../../../packages/brewva-cli/src/shell/domain/keymap.js";
import {
  updateShellIntent,
  type ShellUpdateContext,
} from "../../../packages/brewva-cli/src/shell/domain/reducer.js";
import {
  createShellRuntimeState,
  reduceShellRuntimeAction,
} from "../../../packages/brewva-cli/src/shell/domain/runtime-state.js";
import type { CliShellViewState } from "../../../packages/brewva-cli/src/shell/domain/state.js";

function containsFunction(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === "function") {
    return true;
  }
  if (!value || typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  return Object.values(value).some((entry) => containsFunction(entry, seen));
}

function createStaticKeybindingResolver(action?: string): KeybindingResolver {
  return {
    resolve() {
      return action
        ? {
            id: "test.binding",
            context: "global",
            trigger: { key: "enter", ctrl: false, meta: false, shift: false },
            action,
          }
        : undefined;
    },
    list() {
      return [];
    },
  };
}

function createUpdateContext(input: Partial<ShellUpdateContext> = {}): ShellUpdateContext {
  const state = createShellRuntimeState();
  return {
    view: state.view,
    sessionGeneration: 7,
    isStreaming: false,
    operatorSnapshot: {
      approvals: [],
      questions: [],
      taskRuns: [],
      sessions: [],
    },
    ...input,
  };
}

describe("shell runtime architecture", () => {
  test("built-in keybindings decode directly to typed shell effects", () => {
    expect(shellBuiltInKeybindings).toContainEqual(
      expect.objectContaining({
        id: "composer.submit",
        action: "shell:composer.submit",
      }),
    );

    expect(decodeShellKeybindingEffect("shell:composer.submit")).toEqual({
      type: "composer.submit",
    });
    expect(decodeShellKeybindingEffect("submit")).toEqual(undefined);
  });

  test("view overlay payloads are data-only", () => {
    const state = createShellRuntimeState();
    const action: ShellAction = {
      type: "overlay.openData",
      id: "dialog:1",
      payload: {
        kind: "input",
        dialogId: "name",
        title: "Name",
        value: "",
      },
    };

    const next = reduceShellRuntimeAction(state, action).view;
    expect(containsFunction(next.overlay.active?.payload)).toBe(false);
  });

  test("renderer state is exposed as a dedicated view state", () => {
    const state = createShellRuntimeState();
    const viewState: CliShellViewState = state.view;
    expect(viewState.composer.text).toBe("");
  });

  test("input router emits semantic intents without executing shell work", () => {
    expect(
      routeShellInput({
        input: { key: "enter", ctrl: false, meta: false, shift: false },
        state: {
          hasCompletion: false,
          canNavigatePromptHistoryPrevious: false,
          canNavigatePromptHistoryNext: false,
        },
        keybindings: createStaticKeybindingResolver("shell:composer.submit"),
      }),
    ).toEqual({
      handled: true,
      intent: {
        type: "effect.dispatch",
        effect: { type: "composer.submit" },
      },
    });
  });

  test("shell update dispatches routed keybinding effects without a second mapping layer", () => {
    expect(
      updateShellIntent(createUpdateContext(), {
        type: "effect.dispatch",
        effect: { type: "composer.submit" },
      }),
    ).toEqual({
      handled: true,
      actions: [],
      effects: [{ type: "composer.submit" }],
    });
  });

  test("shell update maps preset cycling commands to a model preset effect", () => {
    expect(
      updateShellIntent(createUpdateContext(), {
        type: "command.invoke",
        commandId: "agent.preset.next",
        args: "",
        source: "keybinding",
      }),
    ).toEqual({
      handled: true,
      actions: [],
      effects: [{ type: "modelPreset.cycleNext" }],
    });
  });

  test("shell update routes transcript snapshot commands to the transcript pager effect", () => {
    expect(
      updateShellIntent(createUpdateContext(), {
        type: "command.invoke",
        commandId: "session.transcript",
        args: "",
        source: "slash",
      }),
    ).toEqual({
      handled: true,
      actions: [],
      effects: [{ type: "transcript.externalPager" }],
    });
  });

  test("shell update opens operator overlays through data actions", () => {
    const context = createUpdateContext({
      operatorSnapshot: {
        approvals: [],
        questions: [],
        taskRuns: [],
        sessions: [],
      },
    });

    expect(
      updateShellIntent(context, {
        type: "command.invoke",
        commandId: "operator.approvals",
        args: "",
        source: "slash",
      }),
    ).toEqual({
      handled: true,
      actions: [
        {
          type: "overlay.openData",
          payload: {
            kind: "approval",
            selectedIndex: 0,
            snapshot: context.operatorSnapshot,
          },
        },
      ],
      effects: [],
    });
  });

  test("shell update carries session generation into async effects", () => {
    expect(
      updateShellIntent(createUpdateContext({ sessionGeneration: 42 }), {
        type: "command.invoke",
        commandId: "operator.answer",
        args: "question-1 yes",
        source: "slash",
      }),
    ).toEqual({
      handled: true,
      actions: [],
      effects: [
        {
          type: "operator.answerQuestion",
          questionId: "question-1",
          answerText: "yes",
        },
        {
          type: "operator.refresh",
          sessionGeneration: 42,
        },
      ],
    });
  });

  test("input router preserves overlay and prompt-history priority", () => {
    expect(
      routeShellInput({
        input: { key: "x", text: "x", ctrl: false, meta: false, shift: false },
        state: {
          activeOverlayKind: "commandPalette",
          hasCompletion: false,
          canNavigatePromptHistoryPrevious: true,
          canNavigatePromptHistoryNext: false,
        },
        keybindings: createStaticKeybindingResolver(),
      }),
    ).toEqual({
      handled: true,
      intent: {
        type: "picker.input",
        input: { key: "x", text: "x", ctrl: false, meta: false, shift: false },
      },
    });

    expect(
      routeShellInput({
        input: { key: "up", ctrl: false, meta: false, shift: false },
        state: {
          hasCompletion: false,
          canNavigatePromptHistoryPrevious: true,
          canNavigatePromptHistoryNext: false,
        },
        keybindings: createStaticKeybindingResolver(),
      }),
    ).toEqual({
      handled: true,
      intent: { type: "promptHistory.navigate", direction: -1 },
    });
  });
});
