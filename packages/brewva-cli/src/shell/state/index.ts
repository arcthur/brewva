import { DEFAULT_TUI_THEME, type TuiTheme } from "@brewva/brewva-tui";
import { FocusManager, OverlayManager, type OverlayEntry } from "@brewva/brewva-tui";
import type { CliShellTranscriptMessage } from "../transcript.js";
import type { CliShellOverlayPayload, CliShellPromptPart } from "../types.js";

export type ShellFocusOwner =
  | "composer"
  | "transcript"
  | "completion"
  | "approvalOverlay"
  | "questionOverlay"
  | "inspectOverlay"
  | "taskBrowser"
  | "sessionSwitcher"
  | "notificationCenter"
  | "pager"
  | "dialog"
  | (string & {});

export interface CliShellNotification {
  id: string;
  level: "info" | "warning" | "error";
  message: string;
  createdAt: number;
}

export interface CliShellStatusState {
  entries: Record<string, string>;
  workingMessage?: string;
  hiddenThinkingLabel?: string;
  title?: string;
  headerLines: string[];
  footerLines: string[];
  widgets: Record<
    string,
    {
      lines: string[];
      placement?: string;
    }
  >;
  toolsExpanded: boolean;
}

export interface CliShellCompletionItem {
  label: string;
  value: string;
  insertText: string;
  description?: string;
  detail?: string;
  kind: "slash" | "path";
}

export interface CliShellCompletionState {
  kind: "slash" | "path";
  query: string;
  items: CliShellCompletionItem[];
  selectedIndex: number;
}

export interface CliShellOverlayState {
  active?: OverlayEntry & {
    focusOwner: ShellFocusOwner;
    title?: string;
    lines?: string[];
    payload?: CliShellOverlayPayload;
  };
  queue: Array<
    OverlayEntry & {
      focusOwner: ShellFocusOwner;
      title?: string;
      lines?: string[];
      payload?: CliShellOverlayPayload;
    }
  >;
}

export interface CliShellState {
  theme: TuiTheme;
  focus: {
    active: ShellFocusOwner;
    returnStack: ShellFocusOwner[];
  };
  overlay: CliShellOverlayState;
  transcript: {
    messages: CliShellTranscriptMessage[];
    followMode: "live" | "scrolled";
    scrollOffset: number;
    navigationRequest?:
      | {
          id: number;
          kind: "pageUp" | "pageDown" | "top" | "bottom";
        }
      | undefined;
  };
  composer: {
    text: string;
    cursor: number;
    parts: CliShellPromptPart[];
    completion?: CliShellCompletionState;
  };
  pager?: {
    title: string;
    lines: string[];
  };
  notifications: CliShellNotification[];
  status: CliShellStatusState;
}

export type CliShellAction =
  | {
      type: "theme.set";
      theme: TuiTheme;
    }
  | {
      type: "overlay.open";
      overlay: NonNullable<CliShellOverlayState["active"]>;
    }
  | {
      type: "overlay.replace";
      overlay: NonNullable<CliShellOverlayState["active"]>;
    }
  | {
      type: "overlay.close";
      id: string;
    }
  | {
      type: "transcript.setMessages";
      messages: CliShellTranscriptMessage[];
    }
  | {
      type: "transcript.setScrollState";
      followMode: "live" | "scrolled";
      scrollOffset: number;
    }
  | {
      type: "transcript.scroll";
      delta: number;
    }
  | {
      type: "transcript.followLive";
    }
  | {
      type: "transcript.requestNavigation";
      request: NonNullable<CliShellState["transcript"]["navigationRequest"]>;
    }
  | {
      type: "transcript.clearNavigation";
      id: number;
    }
  | {
      type: "composer.setText";
      text: string;
      cursor?: number;
    }
  | {
      type: "composer.setPromptState";
      text: string;
      cursor: number;
      parts: CliShellPromptPart[];
    }
  | {
      type: "completion.set";
      completion: CliShellCompletionState | undefined;
    }
  | {
      type: "notification.add";
      notification: CliShellNotification;
    }
  | {
      type: "notification.dismiss";
      id: string;
    }
  | {
      type: "notification.clear";
    }
  | {
      type: "status.set";
      key: string;
      text: string | undefined;
    }
  | {
      type: "status.working";
      text: string | undefined;
    }
  | {
      type: "status.hiddenThinking";
      text: string | undefined;
    }
  | {
      type: "status.title";
      title: string | undefined;
    }
  | {
      type: "status.header";
      lines: string[];
    }
  | {
      type: "status.footer";
      lines: string[];
    }
  | {
      type: "status.widget";
      id: string;
      lines: string[] | undefined;
      placement?: string;
    }
  | {
      type: "status.toolsExpanded";
      expanded: boolean;
    };

function snapshotOverlayState(overlays: OverlayManager): CliShellOverlayState {
  const active = overlays.getActive();
  return {
    active,
    queue: [...overlays.getQueued()],
  };
}

export function createCliShellState(): CliShellState {
  return {
    theme: DEFAULT_TUI_THEME,
    focus: {
      active: "composer",
      returnStack: [],
    },
    overlay: {
      active: undefined,
      queue: [],
    },
    transcript: {
      messages: [],
      followMode: "live",
      scrollOffset: 0,
      navigationRequest: undefined,
    },
    composer: {
      text: "",
      cursor: 0,
      parts: [],
    },
    notifications: [],
    status: {
      entries: {},
      headerLines: [],
      footerLines: [],
      widgets: {},
      toolsExpanded: true,
    },
  };
}

export function reduceCliShellState(state: CliShellState, action: CliShellAction): CliShellState {
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
    case "status.title":
      return {
        ...state,
        status: {
          ...state.status,
          title: action.title,
        },
      };
    case "status.header":
      return {
        ...state,
        status: {
          ...state.status,
          headerLines: [...action.lines],
        },
      };
    case "status.footer":
      return {
        ...state,
        status: {
          ...state.status,
          footerLines: [...action.lines],
        },
      };
    case "status.widget": {
      const nextWidgets = { ...state.status.widgets };
      if (action.lines && action.lines.length > 0) {
        nextWidgets[action.id] = {
          lines: [...action.lines],
          placement: action.placement,
        };
      } else {
        delete nextWidgets[action.id];
      }
      return {
        ...state,
        status: {
          ...state.status,
          widgets: nextWidgets,
        },
      };
    }
    case "status.toolsExpanded":
      return {
        ...state,
        status: {
          ...state.status,
          toolsExpanded: action.expanded,
        },
      };
  }
  return state;
}
