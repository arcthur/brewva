import { describe, expect, test } from "bun:test";
import { asBrewvaSessionId } from "@brewva/brewva-runtime";
import {
  buildSessionsOverlayPayload,
  mergeSessionsOverlayRows,
  orderSessionsByStableIds,
  reconcileSessionsOverlayStableIds,
} from "../../../packages/brewva-cli/src/shell/overlay-view.js";
import type { OperatorSurfaceSnapshot } from "../../../packages/brewva-cli/src/shell/types.js";

describe("buildSessionsOverlayPayload session ordering", () => {
  test("preserves snapshot order; current session is not moved to index 0", () => {
    const snapshot: OperatorSurfaceSnapshot = {
      approvals: [],
      questions: [],
      taskRuns: [],
      sessions: [
        { sessionId: asBrewvaSessionId("session-a"), eventCount: 1, lastEventAt: 1 },
        { sessionId: asBrewvaSessionId("session-b"), eventCount: 2, lastEventAt: 2 },
        { sessionId: asBrewvaSessionId("session-c"), eventCount: 3, lastEventAt: 3 },
      ],
    };

    const payload = buildSessionsOverlayPayload({
      snapshot,
      currentSessionId: "session-b",
      draftsBySessionId: new Map(),
      currentComposerText: "",
    });

    expect(payload.sessions.map((s) => s.sessionId)).toEqual([
      asBrewvaSessionId("session-a"),
      asBrewvaSessionId("session-b"),
      asBrewvaSessionId("session-c"),
    ]);
    expect(payload.currentSessionId).toBe("session-b");
    expect(payload.selectedIndex).toBe(1);
  });

  test("prepends placeholder when current session id is absent from snapshot", () => {
    const snapshot: OperatorSurfaceSnapshot = {
      approvals: [],
      questions: [],
      taskRuns: [],
      sessions: [{ sessionId: asBrewvaSessionId("session-a"), eventCount: 1, lastEventAt: 1 }],
    };

    const payload = buildSessionsOverlayPayload({
      snapshot,
      currentSessionId: "session-new",
      draftsBySessionId: new Map(),
      currentComposerText: "",
    });

    expect(payload.sessions.map((s) => s.sessionId)).toEqual([
      asBrewvaSessionId("session-new"),
      asBrewvaSessionId("session-a"),
    ]);
    expect(payload.sessions[0]?.eventCount).toBe(0);
    expect(payload.selectedIndex).toBe(0);
  });

  test("preserves keyboard selection across rebuild via session id", () => {
    const snapshot: OperatorSurfaceSnapshot = {
      approvals: [],
      questions: [],
      taskRuns: [],
      sessions: [
        { sessionId: asBrewvaSessionId("session-a"), eventCount: 1, lastEventAt: 1 },
        { sessionId: asBrewvaSessionId("session-b"), eventCount: 2, lastEventAt: 2 },
      ],
    };

    const payload = buildSessionsOverlayPayload({
      snapshot,
      currentSessionId: "session-a",
      draftsBySessionId: new Map(),
      currentComposerText: "",
      selection: { sessionId: "session-b", index: 999 },
    });

    expect(payload.selectedIndex).toBe(1);
  });

  test("replaySessionsForOverlay overrides snapshot ordering", () => {
    const snapshot: OperatorSurfaceSnapshot = {
      approvals: [],
      questions: [],
      taskRuns: [],
      sessions: [
        { sessionId: asBrewvaSessionId("session-a"), eventCount: 1, lastEventAt: 1 },
        { sessionId: asBrewvaSessionId("session-b"), eventCount: 2, lastEventAt: 2 },
      ],
    };
    const reordered = [
      { sessionId: asBrewvaSessionId("session-b"), eventCount: 2, lastEventAt: 2 },
      { sessionId: asBrewvaSessionId("session-a"), eventCount: 1, lastEventAt: 1 },
    ];

    const payload = buildSessionsOverlayPayload({
      snapshot,
      currentSessionId: "session-a",
      draftsBySessionId: new Map(),
      currentComposerText: "",
      replaySessionsForOverlay: reordered,
    });

    expect(payload.sessions.map((s) => s.sessionId)).toEqual([
      asBrewvaSessionId("session-b"),
      asBrewvaSessionId("session-a"),
    ]);
    expect(payload.selectedIndex).toBe(1);
  });
});

describe("reconcileSessionsOverlayStableIds", () => {
  test("anchors to merged order on first call (stableOrderIds undefined)", () => {
    const merged = [
      { sessionId: asBrewvaSessionId("x"), eventCount: 9, lastEventAt: 1 },
      { sessionId: asBrewvaSessionId("y"), eventCount: 1, lastEventAt: 2 },
    ];
    const counts = new Map<string, number>([["y", 0]]);
    expect(
      reconcileSessionsOverlayStableIds({
        mergedSessions: merged,
        currentSessionId: "y",
        stableOrderIds: undefined,
        lastEventCounts: counts,
        userPromptReorderGeneration: 99,
        lastAppliedUserPromptReorderGeneration: 0,
      }).stableOrderIds,
    ).toEqual(["x", "y"]);
  });

  test("snapshot order may shuffle but stable ids unchanged without reorder gate", () => {
    const merged = [
      { sessionId: asBrewvaSessionId("b"), eventCount: 9, lastEventAt: 30 },
      { sessionId: asBrewvaSessionId("a"), eventCount: 2, lastEventAt: 20 },
      { sessionId: asBrewvaSessionId("c"), eventCount: 1, lastEventAt: 10 },
    ];
    const counts = new Map<string, number>([
      ["a", 2],
      ["b", 8],
      ["c", 1],
    ]);
    expect(
      reconcileSessionsOverlayStableIds({
        mergedSessions: merged,
        currentSessionId: "a",
        stableOrderIds: ["a", "c", "b"],
        lastEventCounts: counts,
        userPromptReorderGeneration: 0,
        lastAppliedUserPromptReorderGeneration: 0,
      }).stableOrderIds,
    ).toEqual(["a", "c", "b"]);
  });

  test("promotes current to front when reorder generation advanced and eventCount grew", () => {
    const merged = [
      { sessionId: asBrewvaSessionId("c"), eventCount: 1, lastEventAt: 1 },
      { sessionId: asBrewvaSessionId("b"), eventCount: 4, lastEventAt: 2 },
      { sessionId: asBrewvaSessionId("a"), eventCount: 3, lastEventAt: 3 },
    ];
    const counts = new Map<string, number>([
      ["a", 2],
      ["b", 4],
      ["c", 1],
    ]);
    const result = reconcileSessionsOverlayStableIds({
      mergedSessions: merged,
      currentSessionId: "a",
      stableOrderIds: ["c", "b", "a"],
      lastEventCounts: counts,
      userPromptReorderGeneration: 1,
      lastAppliedUserPromptReorderGeneration: 0,
    });
    expect(result.stableOrderIds).toEqual(["a", "c", "b"]);
    expect(result.lastAppliedUserPromptReorderGeneration).toBe(1);
  });
});

describe("sessions overlay replay row helpers", () => {
  test("orderSessionsByStableIds prefers stable ids and appends unseen rows", () => {
    const sessions = [
      { sessionId: asBrewvaSessionId("a"), eventCount: 1, lastEventAt: 1 },
      { sessionId: asBrewvaSessionId("b"), eventCount: 2, lastEventAt: 2 },
      { sessionId: asBrewvaSessionId("c"), eventCount: 3, lastEventAt: 3 },
    ];
    expect(orderSessionsByStableIds(sessions, ["c", "a"]).map((s) => s.sessionId)).toEqual([
      asBrewvaSessionId("c"),
      asBrewvaSessionId("a"),
      asBrewvaSessionId("b"),
    ]);
  });

  test("mergeSessionsOverlayRows prepends placeholder when current missing", () => {
    const existing = {
      sessionId: asBrewvaSessionId("session-a"),
      eventCount: 1,
      lastEventAt: 1,
    };
    const snapshot: OperatorSurfaceSnapshot = {
      approvals: [],
      questions: [],
      taskRuns: [],
      sessions: [existing],
    };
    expect(mergeSessionsOverlayRows(snapshot, "session-new")).toEqual([
      {
        sessionId: asBrewvaSessionId("session-new"),
        eventCount: 0,
        lastEventAt: 0,
      },
      existing,
    ]);
  });
});
