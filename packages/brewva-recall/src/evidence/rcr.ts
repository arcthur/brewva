import {
  buildRcrReference,
  extractRcrContentPath,
  RCR_CONTENT_ABSENT,
  type RcrReference,
  type RcrResolutionOutcome,
  resolveRcrReferenceAgainst,
} from "@brewva/brewva-vocabulary/rcr";

/**
 * Minimal shape the RCR build/resolve helpers need from a committed tape event:
 * its canonical type (to project the model-visible field) and its payload. Both
 * helpers read from one source so a reference built at eviction time and resolved
 * later compare the same committed bytes.
 */
export interface RcrResolvableEvent {
  readonly type: string;
  readonly payload: unknown;
}

export interface RcrTapeEventSource {
  getTapeEvent(input: {
    sessionId: string;
    eventId: string;
  }): Promise<RcrResolvableEvent | undefined>;
}

/**
 * Canonical event types whose payload carries a model-visible content field, and
 * the path to that field. This deliberately projects only the span the model
 * actually saw — never the surrounding internal metadata (commitment ids, tool
 * call proposals, ledger ids, verdicts) that the model never had in context.
 *
 * Event types not listed here have no recoverable model-visible span, so no
 * reference is built and the eviction degrades to a plain (non-reversible) one.
 *
 * These literals track the runtime's canonical event vocabulary and committed
 * payload shapes; a shape change surfaces as a fail-closed digest mismatch, never
 * as widened visibility.
 */
const MODEL_VISIBLE_CONTENT_PATH_BY_TYPE: Readonly<Record<string, string>> = {
  "msg.committed": "text",
  "reason.committed": "text",
  "tool.committed": "result.content",
};

/**
 * Build reversible references for the given committed events, snapshotting only
 * the model-visible content field from tape truth. Events that cannot be loaded,
 * carry no model-visible field, or whose field is absent are skipped, so eviction
 * degrades gracefully.
 */
export async function buildRcrReferencesForEvents(
  source: RcrTapeEventSource,
  sessionId: string,
  eventIds: readonly string[],
): Promise<RcrReference[]> {
  const references: RcrReference[] = [];
  for (const eventId of eventIds) {
    const event = await source.getTapeEvent({ sessionId, eventId });
    if (event === undefined) continue;
    const contentPath = MODEL_VISIBLE_CONTENT_PATH_BY_TYPE[event.type];
    if (contentPath === undefined) continue;
    const located = extractRcrContentPath(event.payload, contentPath);
    if (located === RCR_CONTENT_ABSENT) continue;
    references.push(
      buildRcrReference({ eventRef: { sessionId, eventId }, contentPath, content: located }),
    );
  }
  return references;
}

/**
 * Resolve a reversible reference against committed tape truth. Loads the
 * referenced event, locates the model-visible content at the reference path, and
 * verifies it through the redaction-bounded vocabulary contract. Reproduces only
 * that projected field — never the raw payload or its internal metadata — and
 * fails closed when the event is gone, the path is unresolved, or the digest no
 * longer matches.
 */
export async function resolveRcrReference(
  reference: RcrReference,
  source: RcrTapeEventSource,
): Promise<RcrResolutionOutcome> {
  const event = await source.getTapeEvent({
    sessionId: reference.eventRef.sessionId,
    eventId: reference.eventRef.eventId,
  });
  if (event === undefined) {
    return { status: "unresolvable_reference", reason: "event_unavailable" };
  }
  const located = extractRcrContentPath(event.payload, reference.contentPath);
  return resolveRcrReferenceAgainst(reference, located);
}
