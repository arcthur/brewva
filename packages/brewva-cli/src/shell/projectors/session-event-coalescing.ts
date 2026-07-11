import { isRecord } from "@brewva/brewva-std/unknown";
import type { BrewvaPromptSessionEvent } from "@brewva/brewva-substrate/session";
import { readAssistantTextAppendDelta } from "../../io/message-content.js";

interface PureTextDelta {
  readonly event: Extract<BrewvaPromptSessionEvent, { type: "message_update" }>;
  readonly delta: string;
  readonly contentIndex: unknown;
}

interface ToolUpdate {
  readonly event: BrewvaPromptSessionEvent;
  readonly toolCallId: string;
}

const CUMULATIVE_TOOL_UPDATE_FIELDS = ["toolName", "args", "partialResult"] as const;

function isMessageUpdateShape(
  event: BrewvaPromptSessionEvent,
): event is Extract<BrewvaPromptSessionEvent, { type: "message_update" }> {
  return event.type === "message_update";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

/**
 * A message_update the projector consumes as a pure text append (shared
 * definition: readAssistantTextAppendDelta), narrowed further to explicit
 * text_delta payloads. The extra narrowing keeps merging conservative —
 * anything richer replaces transcript state wholesale and must keep its
 * own event.
 */
function readPureTextDelta(candidate: BrewvaPromptSessionEvent): PureTextDelta | undefined {
  if (!isMessageUpdateShape(candidate)) {
    return undefined;
  }
  const assistantEvent = asRecord(candidate.assistantMessageEvent);
  if (!assistantEvent || assistantEvent.type !== "text_delta") {
    return undefined;
  }
  const delta = readAssistantTextAppendDelta(candidate);
  if (delta === undefined) {
    return undefined;
  }
  return { event: candidate, delta, contentIndex: assistantEvent.contentIndex };
}

function readToolUpdate(event: BrewvaPromptSessionEvent): ToolUpdate | undefined {
  if (event.type !== "tool_execution_update") {
    return undefined;
  }
  const toolCallId = asRecord(event)?.toolCallId;
  if (typeof toolCallId !== "string" || toolCallId.length === 0) {
    return undefined;
  }
  return { event, toolCallId };
}

function mergeTextDeltaRun(run: readonly PureTextDelta[]): BrewvaPromptSessionEvent {
  const last = run.at(-1);
  if (!last) {
    throw new Error("Cannot merge an empty text delta run.");
  }
  if (run.length === 1) {
    return last.event;
  }
  const joined = run.map((entry) => entry.delta).join("");
  return {
    ...last.event,
    assistantMessageEvent: {
      ...asRecord(last.event.assistantMessageEvent),
      delta: joined,
    },
  };
}

/**
 * Updates within one flush are cumulative views of the same execution:
 * keep the freshest defined value per field so dropping earlier events
 * loses nothing.
 */
function mergeToolUpdateRun(run: readonly BrewvaPromptSessionEvent[]): BrewvaPromptSessionEvent {
  const last = run.at(-1);
  if (!last) {
    throw new Error("Cannot merge an empty tool update run.");
  }
  if (run.length === 1) {
    return last;
  }
  const merged: Record<string, unknown> = { ...asRecord(last) };
  for (const field of CUMULATIVE_TOOL_UPDATE_FIELDS) {
    if (merged[field] !== undefined) {
      continue;
    }
    for (let index = run.length - 2; index >= 0; index -= 1) {
      const value = asRecord(run[index])?.[field];
      if (value !== undefined) {
        merged[field] = value;
        break;
      }
    }
  }
  return merged as unknown as BrewvaPromptSessionEvent;
}

/**
 * Coalesce one flush window of queued high-frequency session events so the
 * projector pays per distinct stream, not per raw event.
 *
 * Only adjacent runs merge, so the relative order of every surviving event
 * is exactly the arrival order — the projector observes an equivalent but
 * shorter sequence:
 * - adjacent pure text deltas concatenate into one delta
 * - adjacent tool_execution_update events for one toolCallId keep the
 *   freshest cumulative view
 */
export function coalesceSessionProgressEvents(
  events: readonly BrewvaPromptSessionEvent[],
): BrewvaPromptSessionEvent[] {
  if (events.length < 2) {
    return [...events];
  }
  const result: BrewvaPromptSessionEvent[] = [];
  let index = 0;
  while (index < events.length) {
    const event = events[index] as BrewvaPromptSessionEvent;

    const textDelta = readPureTextDelta(event);
    if (textDelta) {
      const run = [textDelta];
      let cursor = index + 1;
      for (; cursor < events.length; cursor += 1) {
        const next = readPureTextDelta(events[cursor] as BrewvaPromptSessionEvent);
        if (!next || next.contentIndex !== textDelta.contentIndex) {
          break;
        }
        run.push(next);
      }
      result.push(mergeTextDeltaRun(run));
      index = cursor;
      continue;
    }

    const toolUpdate = readToolUpdate(event);
    if (toolUpdate) {
      const run = [toolUpdate.event];
      let cursor = index + 1;
      for (; cursor < events.length; cursor += 1) {
        const next = readToolUpdate(events[cursor] as BrewvaPromptSessionEvent);
        if (!next || next.toolCallId !== toolUpdate.toolCallId) {
          break;
        }
        run.push(next.event);
      }
      result.push(mergeToolUpdateRun(run));
      index = cursor;
      continue;
    }

    result.push(event);
    index += 1;
  }
  return result;
}
