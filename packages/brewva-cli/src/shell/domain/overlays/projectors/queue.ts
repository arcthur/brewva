import type { BrewvaQueuedPromptView } from "@brewva/brewva-substrate/session";
import { truncateToWidth, visibleWidth } from "../../../../internal/tui/index.js";
import type { CliQueueOverlayPayload } from "../payloads.js";

export function buildQueueOverlayPayload(input: {
  items: readonly BrewvaQueuedPromptView[];
  selection?: {
    promptId?: string;
    index?: number;
  };
}): CliQueueOverlayPayload {
  const selectedIndexById =
    typeof input.selection?.promptId === "string"
      ? input.items.findIndex((item) => item.promptId === input.selection?.promptId)
      : -1;
  return {
    kind: "queue",
    items: input.items,
    selectedIndex:
      selectedIndexById >= 0
        ? selectedIndexById
        : Math.max(0, Math.min(input.selection?.index ?? 0, Math.max(0, input.items.length - 1))),
  };
}

export function buildQueuePromptDetailLines(item: BrewvaQueuedPromptView): string[] {
  return [
    `promptId: ${item.promptId}`,
    `behavior: ${item.behavior}`,
    `submittedAt: ${new Date(item.submittedAt).toISOString()}`,
    "",
    ...item.text.split(/\r?\n/u),
  ];
}

export function renderQueuePromptSummary(text: string, maxWidth = 72): string {
  const normalized = text.split(/\r?\n/u).join(" ").trim();
  const summary = normalized || "(empty prompt)";
  if (visibleWidth(summary) <= maxWidth) {
    return summary;
  }
  if (maxWidth <= 1) {
    return "…";
  }
  return `${truncateToWidth(summary, maxWidth - 1)}…`;
}
