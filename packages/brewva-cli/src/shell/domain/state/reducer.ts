import { FocusManager, OverlayManager } from "../../../internal/tui/index.js";
import {
  resolveRelativeSubagentFooterRunId,
  resolveSubagentFooterSelectedRunId,
} from "../subagent-footer.js";
import type { CliShellAction, CliShellOverlayState, CliShellViewState } from "./types.js";

function snapshotOverlayState(overlays: OverlayManager): CliShellOverlayState {
  const active = overlays.getActive();
  return {
    active,
    queue: [...overlays.getQueued()],
  };
}

function focusSubagentFooter(state: CliShellViewState): CliShellViewState["focus"] {
  if (state.focus.active === "subagentFooter") {
    return state.focus;
  }
  return {
    active: "subagentFooter",
    returnStack: [...state.focus.returnStack, state.focus.active],
  };
}

function restoreSubagentFooterFocus(state: CliShellViewState): CliShellViewState["focus"] {
  if (state.focus.active !== "subagentFooter") {
    return state.focus;
  }
  const returnStack = state.focus.returnStack.slice(0, -1);
  const restored = state.focus.returnStack.at(-1);
  return {
    active: restored && restored !== "subagentFooter" ? restored : "composer",
    returnStack,
  };
}

export function reduceCliShellState(
  state: CliShellViewState,
  action: CliShellAction,
): CliShellViewState {
  const focus = new FocusManager(state.focus.active);
  for (const owner of state.focus.returnStack) {
    focus.pushReturn(owner);
  }
  const overlays = new OverlayManager();
  if (state.overlay.active) {
    overlays.open(state.overlay.active);
  }
  for (const queued of state.overlay.queue) {
    overlays.open(queued);
  }

  switch (action.type) {
    case "theme.set":
      return {
        ...state,
        theme: action.theme,
      };
    case "overlay.open": {
      const previousActive = overlays.getActive();
      overlays.open(action.overlay);
      const nextActive = overlays.getActive();
      if (!nextActive || nextActive.id !== action.overlay.id) {
        return {
          ...state,
          overlay: snapshotOverlayState(overlays),
        };
      }
      if (!previousActive) {
        focus.pushReturn(state.focus.active);
      }
      focus.setActive(action.overlay.focusOwner);
      return {
        ...state,
        focus: {
          active: focus.getActive(),
          returnStack: previousActive
            ? [...state.focus.returnStack]
            : [...state.focus.returnStack, state.focus.active],
        },
        overlay: snapshotOverlayState(overlays),
      };
    }
    case "overlay.close": {
      overlays.close(action.id);
      const nextActive = overlays.getActive();
      if (nextActive) {
        focus.setActive(nextActive.focusOwner);
        return {
          ...state,
          focus: {
            active: focus.getActive(),
            returnStack: [...state.focus.returnStack],
          },
          overlay: snapshotOverlayState(overlays),
        };
      }
      focus.restore("composer");
      return {
        ...state,
        focus: {
          active: focus.getActive(),
          returnStack: state.focus.returnStack.slice(0, -1),
        },
        overlay: snapshotOverlayState(overlays),
      };
    }
    case "overlay.replace":
      return {
        ...state,
        overlay: {
          ...state.overlay,
          active: action.overlay,
        },
      };
    case "transcript.setMessages":
      return {
        ...state,
        transcript: {
          ...state.transcript,
          messages: action.messages,
        },
      };
    case "transcript.setScrollState":
      return {
        ...state,
        transcript: {
          ...state.transcript,
          followMode: action.followMode,
          scrollOffset: Math.max(0, action.scrollOffset),
        },
      };
    case "transcript.scroll":
      return {
        ...state,
        transcript: {
          ...state.transcript,
          followMode: action.delta === 0 ? state.transcript.followMode : "scrolled",
          scrollOffset: Math.max(0, state.transcript.scrollOffset + action.delta),
        },
      };
    case "transcript.followLive":
      return {
        ...state,
        transcript: {
          ...state.transcript,
          followMode: "live",
          scrollOffset: 0,
        },
      };
    case "transcript.requestNavigation":
      return {
        ...state,
        transcript: {
          ...state.transcript,
          navigationRequest: action.request,
        },
      };
    case "transcript.clearNavigation":
      if (state.transcript.navigationRequest?.id !== action.id) {
        return state;
      }
      return {
        ...state,
        transcript: {
          ...state.transcript,
          navigationRequest: undefined,
        },
      };
    case "composer.setText":
      return {
        ...state,
        composer: {
          ...state.composer,
          text: action.text,
          cursor:
            typeof action.cursor === "number"
              ? Math.max(0, Math.min(action.text.length, action.cursor))
              : Math.max(0, Math.min(action.text.length, state.composer.cursor)),
          parts: [],
        },
      };
    case "composer.setPromptState":
      return {
        ...state,
        composer: {
          ...state.composer,
          text: action.text,
          cursor: Math.max(0, Math.min(action.text.length, action.cursor)),
          parts: [...action.parts],
        },
      };
    case "completion.set":
      return {
        ...state,
        composer: {
          ...state.composer,
          completion: action.completion,
        },
      };
    case "notification.add":
      return {
        ...state,
        notifications: [...state.notifications, action.notification],
      };
    case "notification.dismiss":
      return {
        ...state,
        notifications: state.notifications.filter((notification) => notification.id !== action.id),
      };
    case "notification.clear":
      return {
        ...state,
        notifications: [],
      };
    case "queue.set":
      if (
        state.queue.length === action.items.length &&
        state.queue.every((item, index) => item.promptId === action.items[index]?.promptId)
      ) {
        return state;
      }
      return {
        ...state,
        queue: [...action.items],
      };
    case "operator.setTaskRuns": {
      const selectedRunId =
        state.subagentFooter.mode === "inspecting"
          ? resolveSubagentFooterSelectedRunId({
              runs: action.taskRuns,
              state: state.subagentFooter,
            })
          : state.subagentFooter.selectedRunId &&
              action.taskRuns.some((run) => run.runId === state.subagentFooter.selectedRunId)
            ? state.subagentFooter.selectedRunId
            : undefined;
      const mode =
        state.subagentFooter.mode === "inspecting" && !selectedRunId
          ? "collapsed"
          : state.subagentFooter.mode;
      return {
        ...state,
        focus:
          state.subagentFooter.mode === "inspecting" && !selectedRunId
            ? restoreSubagentFooterFocus(state)
            : state.focus,
        operator: {
          ...state.operator,
          taskRuns: [...action.taskRuns],
        },
        subagentFooter: {
          ...state.subagentFooter,
          mode,
          selectedRunId,
          scrollOffset:
            selectedRunId === state.subagentFooter.selectedRunId
              ? state.subagentFooter.scrollOffset
              : 0,
        },
      };
    }
    case "subagentFooter.open": {
      // Runtime command handlers avoid modal focus changes first; this keeps the state invariant
      // intact when actions are reduced directly.
      if (state.overlay.active) {
        return state;
      }
      const selectedRunId = resolveSubagentFooterSelectedRunId({
        runs: state.operator.taskRuns,
        state: state.subagentFooter,
        runId: action.runId,
      });
      if (!selectedRunId) {
        return {
          ...state,
          focus: restoreSubagentFooterFocus(state),
          subagentFooter: {
            ...state.subagentFooter,
            mode: "collapsed",
            selectedRunId: undefined,
            scrollOffset: 0,
          },
        };
      }
      return {
        ...state,
        focus: focusSubagentFooter(state),
        subagentFooter: {
          ...state.subagentFooter,
          mode: "inspecting",
          selectedRunId,
          scrollOffset:
            selectedRunId === state.subagentFooter.selectedRunId
              ? state.subagentFooter.scrollOffset
              : 0,
        },
      };
    }
    case "subagentFooter.close":
      return {
        ...state,
        focus: restoreSubagentFooterFocus(state),
        subagentFooter: {
          ...state.subagentFooter,
          mode: "collapsed",
        },
      };
    case "subagentFooter.toggle": {
      if (state.subagentFooter.mode === "inspecting") {
        return {
          ...state,
          focus: restoreSubagentFooterFocus(state),
          subagentFooter: {
            ...state.subagentFooter,
            mode: "collapsed",
          },
        };
      }
      if (state.overlay.active) {
        return state;
      }
      const selectedRunId = resolveSubagentFooterSelectedRunId({
        runs: state.operator.taskRuns,
        state: state.subagentFooter,
        runId: action.runId,
      });
      if (!selectedRunId) {
        return {
          ...state,
          focus: restoreSubagentFooterFocus(state),
          subagentFooter: {
            ...state.subagentFooter,
            mode: "collapsed",
            selectedRunId: undefined,
            scrollOffset: 0,
          },
        };
      }
      return {
        ...state,
        focus: focusSubagentFooter(state),
        subagentFooter: {
          ...state.subagentFooter,
          mode: "inspecting",
          selectedRunId,
          scrollOffset:
            selectedRunId === state.subagentFooter.selectedRunId
              ? state.subagentFooter.scrollOffset
              : 0,
        },
      };
    }
    case "subagentFooter.select": {
      if (!state.operator.taskRuns.some((run) => run.runId === action.runId)) {
        return state;
      }
      return {
        ...state,
        subagentFooter: {
          ...state.subagentFooter,
          selectedRunId: action.runId,
          scrollOffset: 0,
        },
      };
    }
    case "subagentFooter.selectRelative": {
      const selectedRunId = resolveRelativeSubagentFooterRunId({
        runs: state.operator.taskRuns,
        selectedRunId: state.subagentFooter.selectedRunId,
        delta: action.delta,
      });
      if (!selectedRunId) {
        return state;
      }
      return {
        ...state,
        subagentFooter: {
          ...state.subagentFooter,
          selectedRunId,
          scrollOffset: 0,
        },
      };
    }
    case "subagentFooter.scroll":
      return {
        ...state,
        subagentFooter: {
          ...state.subagentFooter,
          scrollOffset: Math.max(0, state.subagentFooter.scrollOffset + action.delta),
        },
      };
    case "status.set": {
      const nextEntries = { ...state.status.entries };
      if (typeof action.text === "string" && action.text.length > 0) {
        nextEntries[action.key] = action.text;
      } else {
        delete nextEntries[action.key];
      }
      return {
        ...state,
        status: {
          ...state.status,
          entries: nextEntries,
        },
      };
    }
    case "status.setSafety":
      return {
        ...state,
        status: {
          ...state.status,
          safety: action.safety,
        },
      };
    case "status.working":
      return {
        ...state,
        status: {
          ...state.status,
          workingMessage: action.text,
        },
      };
    case "status.hiddenThinking":
      return {
        ...state,
        status: {
          ...state.status,
          hiddenThinkingLabel: action.text,
        },
      };
    case "diff.setPreferences":
      return {
        ...state,
        diff: {
          style: action.preferences.style ?? state.diff.style,
          wrapMode: action.preferences.wrapMode ?? state.diff.wrapMode,
        },
      };
    case "view.setPreferences":
      return {
        ...state,
        view: {
          showThinking: action.preferences.showThinking ?? state.view.showThinking,
          toolDetails: action.preferences.toolDetails ?? state.view.toolDetails,
        },
      };
  }
  return state;
}
