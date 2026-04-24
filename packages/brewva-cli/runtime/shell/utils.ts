import { visibleWidth, visualColumnToTextOffset } from "@brewva/brewva-tui";
import type {
  OpenTuiKeyEvent,
  OpenTuiScrollBoxHandle,
} from "@brewva/brewva-tui/internal-opentui-runtime";
import { onCleanup } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { CliShellController, CliShellSemanticInput } from "../../src/shell/controller.js";
import type {
  CliShellCompletionItem,
  CliShellNotification,
  CliShellState,
} from "../../src/shell/state/index.js";
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
} from "../../src/shell/types.js";

export function useShellState(controller: CliShellController): CliShellState {
  const [state, setState] = createStore(controller.getState());
  const unsubscribe = controller.subscribe(() => {
    setState(reconcile(controller.getState()));
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
      return {
        ...payload,
        lines: [...payload.lines],
      };
    case "oauthWait":
      return {
        ...payload,
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
  kind: NonNullable<CliShellState["composer"]["completion"]>["kind"],
): string {
  return kind === "slash" ? "command" : "path";
}

export function completionItemAuxText(item: CliShellCompletionItem): string | undefined {
  return item.description ?? item.detail;
}

export function toSemanticInput(event: OpenTuiKeyEvent): CliShellSemanticInput {
  const normalizedKey =
    event.name.length === 1 && !event.ctrl && !event.meta ? "character" : event.name;
  return {
    key: normalizedKey,
    text:
      normalizedKey === "character"
        ? event.sequence.length > 0
          ? event.sequence
          : event.name
        : undefined,
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

export function readTranscriptScrollMetrics(scrollbox: OpenTuiScrollBoxHandle): {
  maxScrollTop: number;
  currentOffset: number;
} {
  const maxScrollTop = Math.max(0, scrollbox.scrollHeight - scrollbox.viewport.height);
  return {
    maxScrollTop,
    currentOffset: Math.max(0, maxScrollTop - scrollbox.scrollTop),
  };
}

export function syncTranscriptStateFromScrollbox(
  controller: CliShellController,
  scrollbox: OpenTuiScrollBoxHandle,
): void {
  const { maxScrollTop, currentOffset } = readTranscriptScrollMetrics(scrollbox);
  if (currentOffset <= 1 || maxScrollTop === 0) {
    controller.syncTranscriptScrollState("live", 0);
    return;
  }
  controller.syncTranscriptScrollState("scrolled", currentOffset);
}

export function applyTranscriptNavigationRequest(input: {
  controller: CliShellController;
  scrollbox: OpenTuiScrollBoxHandle;
  request: NonNullable<CliShellState["transcript"]["navigationRequest"]>;
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

  syncTranscriptStateFromScrollbox(input.controller, input.scrollbox);
  input.controller.acknowledgeTranscriptNavigation(input.request.id);
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
  CliShellCompletionItem,
};
