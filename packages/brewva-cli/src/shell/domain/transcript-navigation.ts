import type { OpenTuiScrollBoxHandle } from "../../internal/tui/internal-opentui-runtime.js";
import type { CliShellTranscriptMessage } from "./transcript.js";

export type TranscriptNavDirection = "next" | "previous" | "first" | "last";

/**
 * Keymap command id -> navigation direction. The `transcript` keymap layer is
 * handled renderer-locally (like `selection`), so the command ids never reach a
 * reducer/effect; this map is the single source that ties a binding to a walk.
 */
export const TRANSCRIPT_NAV_DIRECTION_BY_COMMAND_ID: Readonly<
  Record<string, TranscriptNavDirection>
> = {
  "transcript.message.next": "next",
  "transcript.message.previous": "previous",
  "transcript.message.first": "first",
  "transcript.message.last": "last",
};

const TRANSCRIPT_ROW_ID_PREFIX = "transcript-row:";
// Ignore rows within this many rows of the current anchor so the row already at
// the top edge is not re-selected as the next/previous target.
const NAV_ANCHOR_EPSILON = 10;

function messageHasVisibleText(message: CliShellTranscriptMessage | undefined): boolean {
  if (!message) {
    return false;
  }
  return message.parts.some((part) => part.type === "text" && part.text.trim().length > 0);
}

/**
 * Keyboard message-boundary navigation for the live transcript scrollbox. Walks
 * the scrollbox children (per-message wrapper boxes keyed `transcript-row:<id>`),
 * skips rows whose message has no visible text, and scrolls the nearest boundary
 * in `direction` to the top — falling back to a page scroll when none exists.
 * `first`/`last` jump to the ends.
 */
export function navigateTranscriptMessage(
  scroll: OpenTuiScrollBoxHandle,
  messages: readonly CliShellTranscriptMessage[],
  direction: TranscriptNavDirection,
): void {
  if (scroll.isDestroyed) {
    return;
  }
  if (direction === "first") {
    scroll.scrollTo(0);
    return;
  }
  if (direction === "last") {
    scroll.scrollTo(scroll.scrollHeight);
    return;
  }

  const messageById = new Map(messages.map((message) => [message.id, message] as const));
  const rows = scroll
    .getChildren()
    .filter((child) => {
      if (typeof child.id !== "string" || !child.id.startsWith(TRANSCRIPT_ROW_ID_PREFIX)) {
        return false;
      }
      const messageId = child.id.slice(TRANSCRIPT_ROW_ID_PREFIX.length);
      return messageHasVisibleText(messageById.get(messageId));
    })
    .toSorted((left, right) => left.y - right.y);

  if (rows.length === 0) {
    scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height);
    return;
  }

  const anchor = scroll.y;
  const target =
    direction === "next"
      ? rows.find((row) => row.y > anchor + NAV_ANCHOR_EPSILON)
      : rows.findLast((row) => row.y < anchor - NAV_ANCHOR_EPSILON);

  if (!target) {
    scroll.scrollBy(direction === "next" ? scroll.height : -scroll.height);
    return;
  }
  scroll.scrollBy(target.y - scroll.y - 1);
}
