import type { RcrTapeEventSource } from "@brewva/brewva-recall/evidence";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import type { BrewvaToolRuntime } from "../contracts/index.js";

/**
 * Adapt the runtime event records into an RCR tape-event source. Both the
 * eviction reference builder and `recall_expand` read committed event payloads
 * through this one source, so a reference is built and resolved against the same
 * immutable tape bytes. Per-session list results are cached for the call.
 */
export function createRecordsRcrTapeEventSource(runtime: BrewvaToolRuntime): RcrTapeEventSource {
  const cache = new Map<string, BrewvaEventRecord[]>();
  return {
    getTapeEvent({ sessionId, eventId }) {
      let events = cache.get(sessionId);
      if (events === undefined) {
        events = runtime.capabilities.events.records.list(sessionId);
        cache.set(sessionId, events);
      }
      const found = events.find((event) => event.id === eventId);
      return Promise.resolve(
        found === undefined ? undefined : { type: found.type, payload: found.payload },
      );
    },
  };
}
