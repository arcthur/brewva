import type { ShellAction } from "./actions.js";
import { resolveOverlayFocusOwner } from "./overlays/focus.js";
import { buildOverlayView } from "./overlays/projectors/text-view.js";
import { createCliShellState, reduceCliShellState, type CliShellViewState } from "./state.js";

export interface CliShellDomainState {
  sessionGeneration: number;
}

export interface CliShellRuntimeState {
  view: CliShellViewState;
  domain: CliShellDomainState;
}

export function createShellRuntimeState(input?: {
  view?: CliShellViewState;
  sessionGeneration?: number;
}): CliShellRuntimeState {
  return {
    view: input?.view ?? createCliShellState(),
    domain: {
      sessionGeneration: input?.sessionGeneration ?? 0,
    },
  };
}

export function reduceShellRuntimeAction(
  state: CliShellRuntimeState,
  action: ShellAction,
): CliShellRuntimeState {
  if (action.type === "domain.sessionGeneration.increment") {
    return {
      ...state,
      domain: {
        ...state.domain,
        sessionGeneration: state.domain.sessionGeneration + 1,
      },
    };
  }
  if (action.type === "domain.sessionGeneration.set") {
    return {
      ...state,
      domain: {
        ...state.domain,
        sessionGeneration: action.sessionGeneration,
      },
    };
  }
  if (action.type === "overlay.openData") {
    const view = buildOverlayView(action.payload);
    const activeOverlay = state.view.overlay.active;
    return {
      ...state,
      view: reduceCliShellState(state.view, {
        type: "overlay.open",
        overlay: {
          id: action.id ?? `${action.payload.kind}:${Date.now()}`,
          kind: action.payload.kind,
          focusOwner: resolveOverlayFocusOwner(action.payload),
          priority: action.priority ?? "normal",
          suspendFocusOwner: action.suspendCurrent ? activeOverlay?.focusOwner : undefined,
          title: view.title,
          lines: view.lines,
          payload: action.payload,
        },
      }),
    };
  }
  if (action.type === "overlay.replaceData") {
    const active = state.view.overlay.active;
    if (!active) {
      return state;
    }
    const view = buildOverlayView(action.payload);
    return {
      ...state,
      view: reduceCliShellState(state.view, {
        type: "overlay.replace",
        overlay: {
          ...active,
          title: view.title,
          lines: view.lines,
          payload: action.payload,
        },
      }),
    };
  }
  return {
    ...state,
    view: reduceCliShellState(state.view, action),
  };
}
