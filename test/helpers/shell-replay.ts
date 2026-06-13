import type { BrewvaPromptSessionEvent } from "@brewva/brewva-substrate/session";
import {
  createPromptMessageEndEvent,
  createPromptMessageUpdateEvent,
  createTextDeltaAssistantEvent,
} from "./prompt-session-events.js";
import type { ShellRuntimeFixture } from "./shell-fixture.js";

export interface AssistantStreamPlan {
  /** Full assistant text to stream. */
  text: string;
  /** Characters per delta event. Defaults to 4 (~one token). */
  chunkSize?: number;
  /** Simulated milliseconds between delta events. Defaults to 10. */
  intervalMs?: number;
  /** Emit a message_end with the full text after the last delta. */
  end?: boolean;
}

export interface AssistantStreamResult {
  /** Number of delta events emitted. */
  deltaCount: number;
  /** Total simulated time advanced across the stream, in milliseconds. */
  simulatedMs: number;
}

export function chunkText(text: string, chunkSize: number): string[] {
  const size = Math.max(1, Math.floor(chunkSize));
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += size) {
    chunks.push(text.slice(offset, offset + size));
  }
  return chunks;
}

function assistantMessage(text: string): unknown {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
  };
}

/**
 * Replay an assistant text stream through the fixture's session listener,
 * advancing the manual clock between deltas so the runtime's streaming
 * batcher behaves exactly as it would under real time.
 */
export function streamAssistantText(
  fixture: Pick<ShellRuntimeFixture, "emitSessionEvent" | "clock">,
  plan: AssistantStreamPlan,
): AssistantStreamResult {
  const intervalMs = plan.intervalMs ?? 10;
  const chunks = chunkText(plan.text, plan.chunkSize ?? 4);
  let accumulated = "";
  let simulatedMs = 0;
  for (const chunk of chunks) {
    accumulated += chunk;
    fixture.emitSessionEvent(
      createPromptMessageUpdateEvent({
        assistantMessageEvent: createTextDeltaAssistantEvent({
          delta: chunk,
          partial: undefined,
        }),
      }),
    );
    fixture.clock.advance(intervalMs);
    simulatedMs += intervalMs;
  }
  if (plan.end ?? true) {
    fixture.emitSessionEvent(createPromptMessageEndEvent(assistantMessage(accumulated)));
  }
  return { deltaCount: chunks.length, simulatedMs };
}

/** Emit a burst of events with no time passing between them. */
export function emitBurst(
  fixture: Pick<ShellRuntimeFixture, "emitSessionEvent">,
  events: readonly BrewvaPromptSessionEvent[],
): void {
  for (const event of events) {
    fixture.emitSessionEvent(event);
  }
}
