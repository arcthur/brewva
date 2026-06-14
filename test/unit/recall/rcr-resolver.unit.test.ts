import { describe, expect, test } from "bun:test";
import {
  buildRcrReferencesForEvents,
  type RcrTapeEventSource,
  resolveRcrReference,
} from "@brewva/brewva-recall/evidence";
import type { SessionIndexTapeEvidence } from "@brewva/brewva-session-index";
import { buildRcrReference } from "@brewva/brewva-vocabulary/rcr";

function evidence(
  sessionId: string,
  eventId: string,
  payload: Record<string, unknown>,
): SessionIndexTapeEvidence {
  return {
    eventId,
    sessionId,
    timestamp: 0,
    type: "tool.committed",
    payload,
    searchText: "",
    sourceUri: "tape://test",
    sourceSequence: 0,
    tokenScore: 0,
  };
}

function source(events: readonly SessionIndexTapeEvidence[]): RcrTapeEventSource {
  return {
    async getTapeEvent({ sessionId, eventId }) {
      return events.find((event) => event.sessionId === sessionId && event.eventId === eventId);
    },
  };
}

describe("resolveRcrReference", () => {
  test("reproduces the model-visible span from the tape event payload", async () => {
    const payload = { tool: "bash", result: { output: "done", code: 0 } };
    const reference = buildRcrReference({
      eventRef: { sessionId: "s1", eventId: "e1" },
      contentPath: "result",
      content: payload.result,
    });

    const outcome = await resolveRcrReference(reference, source([evidence("s1", "e1", payload)]));

    expect(outcome.status).toBe("resolved");
    if (outcome.status === "resolved") {
      expect(outcome.content).toContain("done");
    }
  });

  test("fails closed with event_unavailable when the event is gone", async () => {
    const reference = buildRcrReference({
      eventRef: { sessionId: "s1", eventId: "missing" },
      contentPath: "result",
      content: { output: "done" },
    });

    const outcome = await resolveRcrReference(reference, source([]));

    expect(outcome).toEqual({ status: "unresolvable_reference", reason: "event_unavailable" });
  });

  test("fails closed with digest_mismatch when the event payload changed", async () => {
    const reference = buildRcrReference({
      eventRef: { sessionId: "s1", eventId: "e1" },
      contentPath: "result",
      content: { output: "original" },
    });
    const tampered = { tool: "bash", result: { output: "tampered" } };

    const outcome = await resolveRcrReference(reference, source([evidence("s1", "e1", tampered)]));

    expect(outcome).toEqual({ status: "unresolvable_reference", reason: "digest_mismatch" });
  });
});

describe("buildRcrReferencesForEvents", () => {
  test("builds references that resolve back to the same event content", async () => {
    const src = source([evidence("s1", "e1", { result: { content: "hi" } })]);

    const references = await buildRcrReferencesForEvents(src, "s1", ["e1"]);

    expect(references).toHaveLength(1);
    expect(references[0]?.eventRef).toEqual({ sessionId: "s1", eventId: "e1" });
    const outcome = await resolveRcrReference(references[0]!, src);
    expect(outcome.status).toBe("resolved");
  });

  test("skips events that cannot be loaded so eviction degrades gracefully", async () => {
    const references = await buildRcrReferencesForEvents(source([]), "s1", ["missing"]);

    expect(references).toEqual([]);
  });
});
