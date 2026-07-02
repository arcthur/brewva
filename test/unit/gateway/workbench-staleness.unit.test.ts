import { describe, expect, test } from "bun:test";
import { buildRcrReference } from "@brewva/brewva-vocabulary/rcr";
import {
  aggregateWorkbenchEntryStaleness,
  listActiveWorkbenchEntriesForSession,
  resolveWorkbenchEntryStaleness,
  selectStaleAwareWorkbenchEntries,
} from "../../../packages/brewva-gateway/src/hosted/internal/context/workbench-staleness.js";
import type { HostedRuntimeAdapterPort } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";

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

  test("attention_pin entries survive the cap even when they are the oldest", () => {
    const out = selectStaleAwareWorkbenchEntries(
      [
        { id: "pin", retentionHint: "attention_pin" },
        { id: "a", rcr: [liveRef] },
        { id: "b", rcr: [liveRef] },
        { id: "c", rcr: [liveRef] },
      ],
      findEventPayload,
      2,
    );
    expect(out.map((item) => item.entry.id)).toEqual(["pin", "c"]);
  });

  test("attention_pin entries survive even when stale, consuming the budget first", () => {
    const out = selectStaleAwareWorkbenchEntries(
      [
        { id: "pin", retentionHint: "attention_pin", rcr: [deadRef] },
        { id: "a", rcr: [liveRef] },
        { id: "b", rcr: [liveRef] },
      ],
      findEventPayload,
      1,
    );
    expect(out.map((item) => [item.entry.id, item.stale])).toEqual([["pin", true]]);
  });

  test("pins beyond the cap are all kept; unpinned entries drop first", () => {
    const out = selectStaleAwareWorkbenchEntries(
      [
        { id: "p1", retentionHint: "attention_pin" },
        { id: "a", rcr: [liveRef] },
        { id: "p2", retentionHint: "attention_pin" },
        { id: "p3", retentionHint: "attention_pin" },
      ],
      findEventPayload,
      2,
    );
    expect(out.map((item) => item.entry.id)).toEqual(["p1", "p2", "p3"]);
  });

  test("non-contract retention hints get no survival guarantee", () => {
    const out = selectStaleAwareWorkbenchEntries(
      [
        { id: "hinted", retentionHint: "session" },
        { id: "a", rcr: [liveRef] },
        { id: "b", rcr: [liveRef] },
      ],
      findEventPayload,
      2,
    );
    expect(out.map((item) => item.entry.id)).toEqual(["a", "b"]);
  });
});

describe("listActiveWorkbenchEntriesForSession", () => {
  function runtimeWith(input: {
    entries: readonly Record<string, unknown>[];
    events?: readonly Record<string, unknown>[];
  }): HostedRuntimeAdapterPort {
    return {
      ops: {
        workbench: { list: () => input.entries },
        events: { records: { query: () => input.events ?? [] } },
      },
    } as unknown as HostedRuntimeAdapterPort;
  }

  const pinnedNote = {
    id: "pin-1",
    kind: "note",
    digest: "d1",
    reason: "attention_pin",
    retentionHint: "attention_pin",
    sourceRefs: [],
  };

  test("an explicit entry-targeted eviction removes the note — the pin release path", () => {
    const entries = listActiveWorkbenchEntriesForSession(
      runtimeWith({
        entries: [
          pinnedNote,
          {
            id: "evict-1",
            kind: "eviction",
            digest: "d2",
            reason: "release pin",
            sourceRefs: ["entry:pin-1"],
          },
        ],
      }),
      "sess",
    );
    expect(entries.map((entry) => entry.id)).toEqual(["evict-1"]);
  });

  test("an undone eviction restores the note", () => {
    const entries = listActiveWorkbenchEntriesForSession(
      runtimeWith({
        entries: [
          pinnedNote,
          {
            id: "evict-1",
            kind: "eviction",
            digest: "d2",
            reason: "release pin",
            sourceRefs: ["entry:pin-1"],
          },
        ],
        events: [
          {
            id: "ev-undo",
            type: "workbench.eviction.undone",
            payload: { entryId: "evict-1", undone: true },
          },
        ],
      }),
      "sess",
    );
    expect(entries.map((entry) => entry.id)).toEqual(["pin-1", "evict-1"]);
  });

  test("evicting an eviction entry never removes it (message-hiding refs stay in force)", () => {
    const result = listActiveWorkbenchEntriesForSession(
      runtimeWith({
        entries: [
          {
            id: "evict-1",
            kind: "eviction",
            digest: "d1",
            reason: "trim history",
            sourceRefs: ["turn:3"],
          },
          {
            id: "evict-2",
            kind: "eviction",
            digest: "d2",
            reason: "clean up eviction record",
            sourceRefs: ["entry:evict-1"],
          },
        ],
      }),
      "sess",
    );
    expect(result.map((entry) => entry.id)).toEqual(["evict-1", "evict-2"]);
  });

  test("span evictions (turn/message refs) do not remove notes", () => {
    const entries = listActiveWorkbenchEntriesForSession(
      runtimeWith({
        entries: [
          pinnedNote,
          {
            id: "evict-1",
            kind: "eviction",
            digest: "d2",
            reason: "trim history",
            sourceRefs: ["turn:3", "message:7"],
          },
        ],
      }),
      "sess",
    );
    expect(entries.map((entry) => entry.id)).toEqual(["pin-1", "evict-1"]);
  });
});
