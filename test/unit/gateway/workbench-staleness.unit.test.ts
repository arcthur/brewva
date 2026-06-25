import { describe, expect, test } from "bun:test";
import { buildRcrReference } from "@brewva/brewva-vocabulary/rcr";
import {
  aggregateWorkbenchEntryStaleness,
  resolveWorkbenchEntryStaleness,
  selectStaleAwareWorkbenchEntries,
} from "../../../packages/brewva-gateway/src/hosted/internal/context/workbench-staleness.js";

describe("aggregateWorkbenchEntryStaleness", () => {
  test("one resolved anchor keeps the whole entry fresh", () => {
    expect(aggregateWorkbenchEntryStaleness(["broken", "resolved"])).toBe("fresh");
  });

  test("every anchor broken makes the entry stale", () => {
    expect(aggregateWorkbenchEntryStaleness(["broken", "broken"])).toBe("stale");
  });

  test("no verifiable anchor is unverifiable, never a false fresh", () => {
    expect(aggregateWorkbenchEntryStaleness([])).toBe("unverifiable");
    expect(aggregateWorkbenchEntryStaleness(["unverifiable"])).toBe("unverifiable");
  });

  test("a broken anchor dominates an unverifiable one when none resolve", () => {
    expect(aggregateWorkbenchEntryStaleness(["unverifiable", "broken"])).toBe("stale");
  });
});

describe("resolveWorkbenchEntryStaleness", () => {
  const eventRef = { sessionId: "s1", eventId: "e1" };
  const ref = buildRcrReference({ eventRef, contentPath: "content", content: "hello" });

  test("an entry with no rcr anchors is unverifiable", () => {
    expect(resolveWorkbenchEntryStaleness({ findEventPayload: () => undefined })).toBe(
      "unverifiable",
    );
  });

  test("a live, digest-matching anchor is fresh", () => {
    expect(
      resolveWorkbenchEntryStaleness({
        rcr: [ref],
        findEventPayload: () => ({ content: "hello" }),
      }),
    ).toBe("fresh");
  });

  test("a missing event is stale (event_unavailable)", () => {
    expect(resolveWorkbenchEntryStaleness({ rcr: [ref], findEventPayload: () => undefined })).toBe(
      "stale",
    );
  });

  test("a drifted digest is stale (digest_mismatch)", () => {
    expect(
      resolveWorkbenchEntryStaleness({
        rcr: [ref],
        findEventPayload: () => ({ content: "changed" }),
      }),
    ).toBe("stale");
  });
});

describe("selectStaleAwareWorkbenchEntries", () => {
  const liveRef = buildRcrReference({
    eventRef: { sessionId: "s", eventId: "live" },
    contentPath: "content",
    content: "x",
  });
  const deadRef = buildRcrReference({
    eventRef: { sessionId: "s", eventId: "dead" },
    contentPath: "content",
    content: "y",
  });
  const findEventPayload = (eventRef: { eventId: string }): unknown =>
    eventRef.eventId === "live" ? { content: "x" } : undefined;

  test("annotates entries whose anchors are all broken as stale", () => {
    const out = selectStaleAwareWorkbenchEntries(
      [
        { id: "a", rcr: [liveRef] },
        { id: "b", rcr: [deadRef] },
      ],
      findEventPayload,
      12,
    );
    expect(out.map((item) => [item.entry.id, item.stale])).toEqual([
      ["a", false],
      ["b", true],
    ]);
  });

  test("drops stale entries before live ones over the cap, preserving order", () => {
    const out = selectStaleAwareWorkbenchEntries(
      [
        { id: "a", rcr: [liveRef] },
        { id: "b", rcr: [deadRef] },
        { id: "c", rcr: [liveRef] },
      ],
      findEventPayload,
      2,
    );
    expect(out.map((item) => item.entry.id)).toEqual(["a", "c"]);
  });

  test("keeps the most recent stale entries to fill the cap when live notes are too few", () => {
    const out = selectStaleAwareWorkbenchEntries(
      [
        { id: "b", rcr: [deadRef] },
        { id: "c", rcr: [deadRef] },
        { id: "d", rcr: [liveRef] },
      ],
      findEventPayload,
      2,
    );
    expect(out.map((item) => item.entry.id)).toEqual(["c", "d"]);
  });
});
