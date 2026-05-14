import type { BrewvaEventStore } from "../../events/store.js";
import type { BrewvaEventRecord } from "../../events/types.js";
import { readSessionTitleRecordedEventPayload } from "./event-descriptors.js";
import type { RuntimeRecordEvent } from "./event-pipeline.js";
import { SESSION_TITLE_RECORDED_EVENT_TYPE } from "./events.js";
import type {
  RecordGeneratedSessionTitleInput,
  SessionTitleRecordedPayload,
  SessionTitleView,
} from "./types.js";

export const DEFAULT_SESSION_TITLE = "New session";
export const SESSION_TITLE_MAX_CHARS = 100;

export interface SessionReplayMetadata {
  title: string;
}

export interface SessionTitleServiceOptions {
  eventStore: BrewvaEventStore;
  recordEvent: RuntimeRecordEvent;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export function normalizeSessionTitleForStorage(title: string): string {
  const normalized = collapseWhitespace(title);
  if (normalized.length <= SESSION_TITLE_MAX_CHARS) {
    return normalized;
  }
  return normalized.slice(0, SESSION_TITLE_MAX_CHARS).trim();
}

function latestSessionTitleView(
  sessionId: string,
  events: readonly BrewvaEventRecord[],
): SessionTitleView | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== SESSION_TITLE_RECORDED_EVENT_TYPE) {
      continue;
    }
    const payload = readSessionTitleRecordedEventPayload(event);
    if (!payload) {
      continue;
    }
    return {
      sessionId,
      eventId: event.id,
      timestamp: event.timestamp,
      ...payload,
    };
  }
  return undefined;
}

export function projectSessionReplayMetadata(
  events: readonly BrewvaEventRecord[],
): SessionReplayMetadata {
  let title = DEFAULT_SESSION_TITLE;

  for (const event of events) {
    if (event.type === SESSION_TITLE_RECORDED_EVENT_TYPE) {
      const payload = readSessionTitleRecordedEventPayload(event);
      if (payload) {
        title = payload.title;
      }
    }
  }

  return { title };
}

export class SessionTitleService {
  readonly #eventStore: BrewvaEventStore;
  readonly #recordEvent: RuntimeRecordEvent;

  constructor(options: SessionTitleServiceOptions) {
    this.#eventStore = options.eventStore;
    this.#recordEvent = options.recordEvent;
  }

  recordGeneratedTitle(
    sessionId: string,
    input: RecordGeneratedSessionTitleInput,
  ): BrewvaEventRecord {
    const title = normalizeSessionTitleForStorage(input.title);
    if (!title) {
      throw new Error("session_title_empty");
    }
    const payload: SessionTitleRecordedPayload = {
      title,
      source: "llm",
      turnId: input.turnId,
      promptEventId: input.promptEventId,
      model: input.model,
      generatedAt: input.generatedAt ?? Date.now(),
    };
    const event = this.#recordEvent({
      sessionId,
      type: SESSION_TITLE_RECORDED_EVENT_TYPE,
      payload,
    });
    if (!event) {
      throw new Error("session_title_not_recorded");
    }
    return event;
  }

  getTitle(sessionId: string): SessionTitleView | undefined {
    return latestSessionTitleView(sessionId, this.#eventStore.list(sessionId));
  }
}
