import {
  MAX_AGGREGATED_OUTPUT_CHARS,
  TAIL_CHARS,
  type ManagedExecOutputChannel,
  type ManagedExecOutputEvent,
  type ManagedOutputSession,
} from "../types.js";
import { resolveBackend } from "./state.js";

export type ManagedOutputSubscriber = (
  event: ManagedExecOutputEvent,
) => void | boolean | Promise<void | boolean>;

const outputSubscribers = new Map<string, Set<ManagedOutputSubscriber>>();

export async function publishOutputEvent(event: ManagedExecOutputEvent): Promise<void> {
  const subscribers = outputSubscribers.get(event.sessionId);
  if (!subscribers || subscribers.size === 0) {
    return;
  }
  await Promise.all(
    [...subscribers].map(async (subscriber) => {
      try {
        const keep = await subscriber(event);
        if (keep === false) {
          subscribers.delete(subscriber);
        }
      } catch {
        subscribers.delete(subscriber);
      }
    }),
  );
  if (subscribers.size === 0) {
    outputSubscribers.delete(event.sessionId);
  }
}

export function subscribeManagedSessionOutput(
  sessionId: string,
  subscriber: ManagedOutputSubscriber,
): () => void {
  const subscribers = outputSubscribers.get(sessionId) ?? new Set();
  subscribers.add(subscriber);
  outputSubscribers.set(sessionId, subscribers);
  return () => {
    subscribers.delete(subscriber);
    if (subscribers.size === 0) {
      outputSubscribers.delete(sessionId);
    }
  };
}

export function appendOutputToSession(
  session: ManagedOutputSession,
  chunk: Buffer | string,
  channel: ManagedExecOutputChannel = "system",
): ManagedExecOutputEvent | undefined {
  if (session.removed) return undefined;
  const text = String(chunk);
  if (!text) return undefined;

  session.aggregated += text;
  if (session.aggregated.length > MAX_AGGREGATED_OUTPUT_CHARS) {
    const overflow = session.aggregated.length - MAX_AGGREGATED_OUTPUT_CHARS;
    session.aggregated = session.aggregated.slice(overflow);
    session.drainCursor = Math.max(0, session.drainCursor - overflow);
    session.truncated = true;
  }

  if (session.drainCursor > session.aggregated.length) {
    session.drainCursor = session.aggregated.length;
  }
  session.tail = session.aggregated.slice(-TAIL_CHARS);
  return {
    type: "output",
    sessionId: session.id,
    ownerSessionId: session.ownerSessionId,
    backend: resolveBackend(session),
    channel,
    chunk: text,
    aggregateChars: session.aggregated.length,
    truncated: session.truncated,
    emittedAt: Date.now(),
  };
}

export function appendOutput(
  session: ManagedOutputSession,
  chunk: Buffer | string,
  channel: ManagedExecOutputChannel = "system",
): void {
  const event = appendOutputToSession(session, chunk, channel);
  if (!event) {
    return;
  }
  void publishOutputEvent(event);
}

export async function appendOutputWithBackpressure(
  session: ManagedOutputSession,
  chunk: Buffer | string,
  channel: ManagedExecOutputChannel = "system",
): Promise<void> {
  const event = appendOutputToSession(session, chunk, channel);
  if (!event) {
    return;
  }
  await publishOutputEvent(event);
}

export function sliceUtf8FromByteOffset(text: string, offset: number): string {
  if (offset <= 0) return text;
  const bytes = Buffer.from(text, "utf8");
  if (offset >= bytes.length) return "";
  return bytes.subarray(offset).toString("utf8");
}
