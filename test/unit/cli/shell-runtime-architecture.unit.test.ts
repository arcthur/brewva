import { describe, expect, test } from "bun:test";
import type { ShellAction } from "../../../packages/brewva-cli/src/shell/domain/actions.js";
import { routeShellInput } from "../../../packages/brewva-cli/src/shell/domain/input-router.js";
import { normalizeShellInputTrigger } from "../../../packages/brewva-cli/src/shell/domain/keymap.js";
import {
  updateShellIntent,
  type ShellUpdateContext,
} from "../../../packages/brewva-cli/src/shell/domain/reducer.js";
import {
  createShellRuntimeState,
  reduceShellRuntimeAction,
} from "../../../packages/brewva-cli/src/shell/domain/runtime-state.js";
import type { CliShellViewState } from "../../../packages/brewva-cli/src/shell/domain/state.js";
import { BREWVA_BUILT_IN_KEYMAP_BINDINGS } from "../../../packages/brewva-cli/src/shell/keymap/keymap-bindings.js";

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
  test("built-in keymap bindings carry typed shell effects", () => {
    expect(BREWVA_BUILT_IN_KEYMAP_BINDINGS).toContainEqual(
      expect.objectContaining({
        id: "composer.submit",
        shortcuts: ["return"],
        effect: { type: "composer.submit" },
      }),
    );
  });

  test("modified key names normalize into keybinding triggers", () => {
    expect(
      normalizeShellInputTrigger({
        key: "ctrl+c",
        ctrl: false,
        meta: false,
        shift: false,
      }),
    ).toEqual({
      key: "c",
      ctrl: true,
      meta: false,
      shift: false,
    });
    expect(
      normalizeShellInputTrigger({
        key: "control+esc",
        ctrl: false,
        meta: false,
        shift: false,
      }),
    ).toEqual({
      key: "escape",
      ctrl: true,
      meta: false,
      shift: false,
    });
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

  test("input router leaves ordinary shortcuts to the renderer keymap", () => {
    expect(
      routeShellInput({
        input: { key: "enter", ctrl: false, meta: false, shift: false },
        state: {
          hasCompletion: false,
          isStreaming: false,
          canNavigatePromptHistoryPrevious: false,
          canNavigatePromptHistoryNext: false,
        },
      }),
    ).toEqual({ handled: false });
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

  test("shell update routes handoff commands to a replayable tape anchor effect", () => {
    expect(
      updateShellIntent(createUpdateContext(), {
        type: "command.invoke",
        commandId: "session.handoff",
        args: "ready for review",
        source: "slash",
      }),
    ).toEqual({
      handled: true,
      actions: [],
      effects: [{ type: "session.handoff", handoff: { summary: "ready for review" } }],
    });
    expect(
      updateShellIntent(createUpdateContext(), {
        type: "command.invoke",
        commandId: "session.handoff",
        args: "Implementation handoff :: ready for review :: run inspect tests",
        source: "slash",
      }),
    ).toEqual({
      handled: true,
      actions: [],
      effects: [
        {
          type: "session.handoff",
          handoff: {
            name: "Implementation handoff",
            summary: "ready for review",
            nextSteps: "run inspect tests",
          },
        },
      ],
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
          isStreaming: false,
          canNavigatePromptHistoryPrevious: true,
          canNavigatePromptHistoryNext: false,
        },
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
          isStreaming: false,
          canNavigatePromptHistoryPrevious: true,
          canNavigatePromptHistoryNext: false,
        },
      }),
    ).toEqual({
      handled: true,
      intent: { type: "promptHistory.navigate", direction: -1 },
    });
  });
});
