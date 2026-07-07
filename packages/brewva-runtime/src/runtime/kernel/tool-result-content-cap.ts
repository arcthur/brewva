import { isRecord } from "@brewva/brewva-std/unknown";
import type { ToolExecutionResult, ToolExecutionResultContent } from "./port.js";

export const MAX_CANONICAL_TOOL_RESULT_CONTENT_CHARS = 64_000;
const MAX_CANONICAL_TOOL_RESULT_SERIALIZED_CHARS = MAX_CANONICAL_TOOL_RESULT_CONTENT_CHARS * 2;

interface TruncationState {
  remainingChars: number;
  markerWritten: boolean;
}

function buildMarker(originalChars: number): string {
  return ` [tool_result_truncated_for_tape original_chars=${originalChars} max_chars=${MAX_CANONICAL_TOOL_RESULT_CONTENT_CHARS}]`;
}

function truncateString(text: string, state: TruncationState, marker: string): string {
  if (state.remainingChars <= 0) {
    if (state.markerWritten) {
      return "";
    }
    state.markerWritten = true;
    return marker;
  }
  if (text.length <= state.remainingChars) {
    state.remainingChars -= text.length;
    return text;
  }

  const limit = state.remainingChars;
  state.remainingChars = 0;
  state.markerWritten = true;
  if (limit <= marker.length) {
    return marker.slice(0, limit);
  }
  return `${text.slice(0, limit - marker.length)}${marker}`;
}

function stringifyContent(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

function countPromptTextChars(value: readonly unknown[]): number {
  let total = 0;
  for (const item of value) {
    if (isRecord(item) && typeof item.text === "string") {
      total += item.text.length;
    }
  }
  return total;
}

function truncatePromptTextParts(
  value: readonly unknown[],
  originalChars: number,
): readonly unknown[] {
  const state: TruncationState = {
    remainingChars: MAX_CANONICAL_TOOL_RESULT_CONTENT_CHARS,
    markerWritten: false,
  };
  const marker = buildMarker(originalChars);
  return value.map((item) => {
    if (!isRecord(item) || typeof item.text !== "string") {
      return item;
    }
    return {
      ...item,
      text: truncateString(item.text, state, marker),
    };
  });
}

function capContentForTape(content: ToolExecutionResultContent): {
  readonly content: ToolExecutionResultContent;
  readonly originalChars: number;
  readonly storedChars: number;
} | null {
  if (typeof content === "string") {
    const originalChars = content.length;
    if (originalChars <= MAX_CANONICAL_TOOL_RESULT_CONTENT_CHARS) {
      return null;
    }
    const marker = buildMarker(originalChars);
    const nextContent = truncateString(
      content,
      { remainingChars: MAX_CANONICAL_TOOL_RESULT_CONTENT_CHARS, markerWritten: false },
      marker,
    );
    return {
      content: nextContent,
      originalChars,
      storedChars: nextContent.length,
    };
  }

  if (Array.isArray(content)) {
    const originalChars = countPromptTextChars(content);
    if (originalChars > MAX_CANONICAL_TOOL_RESULT_CONTENT_CHARS) {
      const nextContent = truncatePromptTextParts(content, originalChars);
      const serialized = stringifyContent(nextContent);
      if (serialized === null || serialized.length <= MAX_CANONICAL_TOOL_RESULT_SERIALIZED_CHARS) {
        return {
          content: nextContent as ToolExecutionResultContent,
          originalChars,
          storedChars: countPromptTextChars(nextContent),
        };
      }
      const marker = buildMarker(serialized.length);
      return {
        content: marker,
        originalChars: serialized.length,
        storedChars: marker.length,
      };
    }
  }

  const serialized = stringifyContent(content);
  if (serialized === null || serialized.length <= MAX_CANONICAL_TOOL_RESULT_CONTENT_CHARS) {
    return null;
  }
  const marker = buildMarker(serialized.length);
  return {
    content: marker,
    originalChars: serialized.length,
    storedChars: marker.length,
  };
}

export function capToolResultContentForTape(result: ToolExecutionResult): ToolExecutionResult {
  const capped = capContentForTape(result.content);
  if (!capped) {
    return result;
  }

  return {
    ...result,
    content: capped.content,
    metadata: {
      ...result.metadata,
      toolResultContentTruncation: {
        applied: true,
        originalChars: capped.originalChars,
        storedChars: capped.storedChars,
        maxChars: MAX_CANONICAL_TOOL_RESULT_CONTENT_CHARS,
      },
    },
  };
}
