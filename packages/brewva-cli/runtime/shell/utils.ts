import { onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { visibleWidth, visualColumnToTextOffset } from "../../src/internal/tui/index.js";
import type { ShellCompletionCandidate } from "../../src/shell/domain/completion-provider.js";
import type { CliShellInput } from "../../src/shell/domain/input.js";
import type {
  CliApprovalOverlayPayload,
  CliConfirmOverlayPayload,
  CliInputOverlayPayload,
  CliInspectOverlayPayload,
  CliNotificationsOverlayPayload,
  CliPagerOverlayPayload,
  CliQuestionOverlayPayload,
  CliSelectOverlayPayload,
  CliSessionsOverlayPayload,
  CliShellOverlayPayload,
  CliTasksOverlayPayload,
} from "../../src/shell/domain/overlays/payloads.js";
import type { ShellRendererController } from "../../src/shell/domain/renderer-contract.js";
import type { CliShellNotification, ShellViewModel } from "../../src/shell/domain/view-model.js";
import type { OpenTuiKeyEvent, OpenTuiScrollBoxHandle } from "../internal-opentui-runtime.js";

export function useShellState(runtime: ShellRendererController): ShellViewModel {
  const [state, setState] = createStore(runtime.getViewState());
  const unsubscribe = runtime.subscribe(() => {
    setState(reconcile(runtime.getViewState()));
  });
  onCleanup(unsubscribe);
  return state;
}

export function windowSelection<T>(
  items: readonly T[],
  selectedIndex: number,
  maxVisible: number,
): {
  items: T[];
  startIndex: number;
} {
  if (items.length <= maxVisible) {
    return {
      items: [...items],
      startIndex: 0,
    };
  }
  const visibleCount = Math.max(1, maxVisible);
  const start = Math.max(
    0,
    Math.min(items.length - visibleCount, selectedIndex - Math.floor(visibleCount / 2)),
  );
  return {
    items: items.slice(start, start + visibleCount),
    startIndex: start,
  };
}

export function visibleLineWindow(
  lines: readonly string[],
  requestedOffset: number,
  maxVisible: number,
) {
  const visibleCount = Math.max(1, maxVisible);
  const maxOffset = Math.max(0, lines.length - visibleCount);
  const offset = Math.max(0, Math.min(requestedOffset, maxOffset));
  return {
    offset,
    start: lines.length === 0 ? 0 : offset + 1,
    end: Math.min(lines.length, offset + visibleCount),
    visibleLines: lines.slice(offset, offset + visibleCount),
  };
}

export function cloneOverlayPayload(payload: CliShellOverlayPayload): CliShellOverlayPayload {
  switch (payload.kind) {
    case "approval":
    case "tasks":
      return {
        ...payload,
        snapshot: payload.snapshot,
      };
    case "question":
      return {
        ...payload,
        snapshot: payload.snapshot,
        draftsByRequestId: payload.draftsByRequestId
          ? Object.fromEntries(
              Object.entries(payload.draftsByRequestId).map(([requestId, draft]) => [
                requestId,
                {
                  activeTabIndex: draft.activeTabIndex,
                  selectedOptionIndex: draft.selectedOptionIndex,
                  editingCustom: draft.editingCustom,
                  answers: draft.answers.map((answer) => [...answer]),
                  customAnswers: [...draft.customAnswers],
                },
              ]),
            )
          : undefined,
      };
    case "inspect":
      return {
        ...payload,
        lines: [...payload.lines],
        sections: [...payload.sections],
        scrollOffsets: [...payload.scrollOffsets],
      };
    case "notifications":
      return {
        ...payload,
        notifications: [...payload.notifications],
      };
    case "pager":
      return {
        ...payload,
        lines: [...payload.lines],
      };
    case "sessions":
      return {
        ...payload,
        sessions: [...payload.sessions],
        draftStateBySessionId: { ...payload.draftStateBySessionId },
      };
    case "lineage":
      return {
        ...payload,
        nodes: [...payload.nodes],
      };
    case "tree":
      return {
        ...payload,
        collapsedEntryIds: [...payload.collapsedEntryIds],
        nodes: [...payload.nodes],
      };
    case "confirm":
      return {
        ...payload,
      };
    case "input":
      return {
        ...payload,
      };
    case "select":
      return {
        ...payload,
        options: [...payload.options],
      };
    case "modelPicker":
      return {
        ...payload,
        items: [...payload.items],
      };
    case "providerPicker":
      return {
        ...payload,
        providers: [...payload.providers],
        items: [...payload.items],
      };
    case "thinkingPicker":
      return {
        ...payload,
        items: [...payload.items],
      };
    case "authMethodPicker":
      return {
        ...payload,
        items: [...payload.items],
      };
    case "commandPalette":
      return {
        ...payload,
        items: [...payload.items],
      };
    case "helpHub":
    case "context":
    case "authority":
    case "cockpitAttention":
      return {
        ...payload,
        lines: [...payload.lines],
      };
    case "cockpitArchive":
      return {
        ...payload,
        items: payload.items.map((item) => ({
          ...item,
          detailLines: [...item.detailLines],
        })),
        scrollOffsets: [...payload.scrollOffsets],
      };
    case "skills":
      return {
        ...payload,
        items: [...payload.items],
      };
    case "inbox":
      return {
        ...payload,
        items: [...payload.items],
      };
    case "queue":
      return {
        ...payload,
        items: [...payload.items],
      };
    case "oauthWait":
      return {
        ...payload,
      };
    case "shortcutOverlay":
      return {
        ...payload,
        lines: [...payload.lines],
      };
    default: {
      const exhaustiveCheck: never = payload;
      return exhaustiveCheck;
    }
  }
}

export function renderNotificationSummary(notification: CliShellNotification): string {
  const [firstLine = ""] = notification.message.split(/\r?\n/u);
  return `[${notification.level}] ${firstLine}`;
}

export function completionKindLabel(
  trigger: NonNullable<ShellViewModel["composer"]["completion"]>["trigger"],
): string {
  return trigger === "/" ? "command" : "reference";
}

export function completionItemAuxText(item: ShellCompletionCandidate): string | undefined {
  return item.description ?? item.detail;
}

function isPrintableKeySequence(event: OpenTuiKeyEvent): boolean {
  if (event.ctrl || event.meta || event.sequence.length === 0) {
    return false;
  }
  const firstCodePoint = event.sequence.codePointAt(0);
  return firstCodePoint !== undefined && firstCodePoint >= 32 && firstCodePoint !== 127;
}

export function toSemanticInput(event: OpenTuiKeyEvent): CliShellInput {
  const isPrintableText = isPrintableKeySequence(event);
  const normalizedKey = isPrintableText ? "character" : event.name;
  return {
    key: normalizedKey,
    text: isPrintableText ? event.sequence : undefined,
    ctrl: event.ctrl,
    meta: event.meta,
    shift: event.shift,
  };
}

export function textOffsetFromLogicalCursor(
  text: string,
  cursor: { row: number; col: number },
): number {
  const lines = text.split("\n");
  let offset = 0;
  for (let row = 0; row < lines.length; row += 1) {
    const line = lines[row] ?? "";
    if (row === cursor.row) {
      return offset + visualColumnToTextOffset(line, cursor.col);
    }
    offset += line.length + 1;
  }
  return text.length;
}

export function logicalCursorFromTextOffset(
  text: string,
  offset: number,
): { row: number; col: number } {
  const boundedOffset = Math.max(0, Math.min(text.length, offset));
  const before = text.slice(0, boundedOffset);
  const lines = before.split("\n");
  const lastLine = lines.at(-1) ?? "";
  return {
    row: Math.max(0, lines.length - 1),
    col: visibleWidth(lastLine),
  };
}

export function readSurfaceScrollMetrics(scrollbox: OpenTuiScrollBoxHandle): {
  maxScrollTop: number;
  currentOffset: number;
} {
  const maxScrollTop = Math.max(0, scrollbox.scrollHeight - scrollbox.viewport.height);
  return {
    maxScrollTop,
    currentOffset: Math.max(0, maxScrollTop - scrollbox.scrollTop),
  };
}

export function syncSurfaceStateFromScrollbox(
  runtime: ShellRendererController,
  scrollbox: OpenTuiScrollBoxHandle,
): void {
  const { maxScrollTop, currentOffset } = readSurfaceScrollMetrics(scrollbox);
  if (currentOffset <= 1 || maxScrollTop === 0) {
    void runtime.handleInput({
      type: "surface.scrollSync",
      followMode: "live",
      scrollOffset: 0,
    });
    return;
  }
  void runtime.handleInput({
    type: "surface.scrollSync",
    followMode: "scrolled",
    scrollOffset: currentOffset,
  });
}

export function applySurfaceNavigationRequest(input: {
  runtime: ShellRendererController;
  scrollbox: OpenTuiScrollBoxHandle;
  request: NonNullable<ShellViewModel["surface"]["navigationRequest"]>;
}): void {
  const pageStep = Math.max(1, Math.floor(Math.max(2, input.scrollbox.viewport.height) / 2));

  switch (input.request.kind) {
    case "pageUp":
      input.scrollbox.stickyScroll = false;
      input.scrollbox.scrollBy(-pageStep);
      break;
    case "pageDown":
      input.scrollbox.stickyScroll = false;
      input.scrollbox.scrollBy(pageStep);
      break;
    case "top":
      input.scrollbox.stickyScroll = false;
      input.scrollbox.scrollTo(0);
      break;
    case "bottom":
      input.scrollbox.stickyScroll = true;
      input.scrollbox.stickyStart = "bottom";
      input.scrollbox.scrollTo(input.scrollbox.scrollHeight);
      break;
    default: {
      const exhaustiveCheck: never = input.request.kind;
      void exhaustiveCheck;
    }
  }

  syncSurfaceStateFromScrollbox(input.runtime, input.scrollbox);
  void input.runtime.handleInput({
    type: "surface.navigationAck",
    requestId: input.request.id,
  });
}

export type {
  CliApprovalOverlayPayload,
  CliConfirmOverlayPayload,
  CliInputOverlayPayload,
  CliInspectOverlayPayload,
  CliNotificationsOverlayPayload,
  CliPagerOverlayPayload,
  CliQuestionOverlayPayload,
  CliSelectOverlayPayload,
  CliSessionsOverlayPayload,
  CliShellOverlayPayload,
  CliTasksOverlayPayload,
  CliShellNotification,
};
