import { describe, expect, test } from "bun:test";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
import type { BrewvaReplaySession } from "@brewva/brewva-runtime/events";
import type { SessionLineageTree } from "@brewva/brewva-runtime/session";
import type { OperatorSurfaceSnapshot } from "../../../packages/brewva-cli/src/shell/domain/operator-snapshot.js";
import {
  buildLineageOverlayPayload,
  buildOverlayView,
  buildSessionsOverlayPayload,
  buildSessionsOverlayRows,
  mergeSessionsOverlayRows,
  orderSessionsByStableIds,
  reconcileSessionsOverlayStableIds,
} from "../../../packages/brewva-cli/src/shell/domain/overlays/projectors/index.js";

function replaySession(
  sessionId: string,
  eventCount: number,
  lastEventAt: number,
  title = sessionId,
): BrewvaReplaySession {
  return {
    sessionId: asBrewvaSessionId(sessionId),
    eventCount,
    lastEventAt,
    title,
  };
}

describe("buildSessionsOverlayPayload session ordering", () => {
  test("preserves snapshot order; current session is not moved to index 0", () => {
    const snapshot: OperatorSurfaceSnapshot = {
      approvals: [],
      questions: [],
      taskRuns: [],
      sessions: [
        replaySession("session-a", 1, 1),
        replaySession("session-b", 2, 2),
        replaySession("session-c", 3, 3),
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
      sessions: [replaySession("session-a", 1, 1)],
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
      sessions: [replaySession("session-a", 1, 1), replaySession("session-b", 2, 2)],
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
      sessions: [replaySession("session-a", 1, 1), replaySession("session-b", 2, 2)],
    };
    const reordered = [replaySession("session-b", 2, 2), replaySession("session-a", 1, 1)];

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

  test("filters sessions by search query", () => {
    const snapshot: OperatorSurfaceSnapshot = {
      approvals: [],
      questions: [],
      taskRuns: [],
      sessions: [
        replaySession("session-runtime", 2, 2, "Runtime projection cleanup"),
        replaySession("session-cli", 1, 1, "CLI command palette"),
      ],
    };

    const payload = buildSessionsOverlayPayload({
      snapshot,
      currentSessionId: "session-cli",
      draftsBySessionId: new Map(),
      currentComposerText: "",
      query: "runtime",
    });

    expect(payload.query).toBe("runtime");
    expect(payload.sessions.map((session) => session.title)).toEqual([
      "Runtime projection cleanup",
    ]);
    expect(payload.selectedIndex).toBe(0);
  });

  test("text fallback renders sessions search and grouped names", () => {
    const snapshot: OperatorSurfaceSnapshot = {
      approvals: [],
      questions: [],
      taskRuns: [],
      sessions: [replaySession("session-cli", 1, 1, "CLI command palette")],
    };

    const view = buildOverlayView(
      buildSessionsOverlayPayload({
        snapshot,
        currentSessionId: "session-cli",
        draftsBySessionId: new Map(),
        currentComposerText: "",
        query: "cli",
      }),
    );

    expect(view.lines).toContain("Search: cli");
    expect(view.lines.some((line) => line.includes("CLI command palette"))).toBe(true);
    expect(view.lines.join("\n")).not.toContain("session-cli");
  });
});

describe("buildLineageOverlayPayload", () => {
  test("renders lineage nodes in tree order and preserves selected node by id", () => {
    const tree = {
      sessionId: "lineage-overlay-session",
      rootNodeId: "lineage:main",
      nodes: [
        {
          lineageNodeId: "lineage:main",
          parentLineageNodeId: null,
          kind: "main",
          forkPoint: { kind: "session_root" },
          title: "Main task",
          summaries: [],
          outcomes: [],
          adoptedOutcomes: [],
        },
        {
          lineageNodeId: "lineage:review",
          parentLineageNodeId: "lineage:main",
          kind: "review",
          forkPoint: { kind: "context_entry", lineageNodeId: "lineage:main", entryId: "entry-1" },
          title: "Review branch",
          summaries: [],
          outcomes: [],
          adoptedOutcomes: [],
        },
        {
          lineageNodeId: "lineage:experiment",
          parentLineageNodeId: "lineage:main",
          kind: "experiment",
          forkPoint: { kind: "context_entry", lineageNodeId: "lineage:main", entryId: "entry-2" },
          title: "Experiment",
          summaries: [],
          outcomes: [],
          adoptedOutcomes: [],
        },
        {
          lineageNodeId: "lineage:recovery",
          parentLineageNodeId: "lineage:experiment",
          kind: "recovery",
          forkPoint: {
            kind: "context_entry",
            lineageNodeId: "lineage:experiment",
            entryId: "entry-3",
          },
          title: "Recovery",
          summaries: [],
          outcomes: [],
          adoptedOutcomes: [],
        },
      ],
      edges: [
        { parentLineageNodeId: "lineage:main", childLineageNodeId: "lineage:review" },
        { parentLineageNodeId: "lineage:main", childLineageNodeId: "lineage:experiment" },
        {
          parentLineageNodeId: "lineage:experiment",
          childLineageNodeId: "lineage:recovery",
        },
      ],
      selectedByChannel: {},
    } as unknown as SessionLineageTree;

    const payload = buildLineageOverlayPayload({
      tree,
      currentLineageNodeId: "lineage:experiment",
      selection: { lineageNodeId: "lineage:recovery" },
      leafEntryIdsByLineageNodeId: new Map([
        ["lineage:main", "entry-2"],
        ["lineage:review", "entry-review"],
        ["lineage:experiment", "entry-3"],
        ["lineage:recovery", "entry-4"],
      ]),
    } as Parameters<typeof buildLineageOverlayPayload>[0] & {
      leafEntryIdsByLineageNodeId: ReadonlyMap<string, string | null>;
    });

    expect(
      payload.nodes.map((node) => ({
        id: node.lineageNodeId,
        depth: node.depth,
        current: node.current,
        leafEntryId: node.leafEntryId,
      })),
    ).toEqual([
      { id: "lineage:main", depth: 0, current: false, leafEntryId: "entry-2" },
      { id: "lineage:review", depth: 1, current: false, leafEntryId: "entry-review" },
      { id: "lineage:experiment", depth: 1, current: true, leafEntryId: "entry-3" },
      { id: "lineage:recovery", depth: 2, current: false, leafEntryId: "entry-4" },
    ]);
    expect(payload.selectedIndex).toBe(3);
    expect(buildOverlayView(payload).lines).toEqual(
      expect.arrayContaining([
        expect.stringContaining("lineage:recovery"),
        expect.stringContaining("leaf=entry-4"),
        expect.stringContaining("Experiment"),
      ]),
    );
  });
});

describe("reconcileSessionsOverlayStableIds", () => {
  test("anchors to merged order on first call (stableOrderIds undefined)", () => {
    const merged = [replaySession("x", 9, 1), replaySession("y", 1, 2)];
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
      replaySession("b", 9, 30),
      replaySession("a", 2, 20),
      replaySession("c", 1, 10),
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
    const merged = [replaySession("c", 1, 1), replaySession("b", 4, 2), replaySession("a", 3, 3)];
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
    const sessions = [replaySession("a", 1, 1), replaySession("b", 2, 2), replaySession("c", 3, 3)];
    expect(orderSessionsByStableIds(sessions, ["c", "a"]).map((s) => s.sessionId)).toEqual([
      asBrewvaSessionId("c"),
      asBrewvaSessionId("a"),
      asBrewvaSessionId("b"),
    ]);
  });

  test("mergeSessionsOverlayRows prepends placeholder when current missing", () => {
    const existing = replaySession("session-a", 1, 1);
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
        title: "New session",
      },
      existing,
    ]);
  });

  test("buildSessionsOverlayRows groups sessions by opencode-style update date", () => {
    const now = new Date(2026, 4, 14, 12, 0, 0).getTime();
    const yesterday = new Date(2026, 4, 13, 9, 0, 0).getTime();
    const rows = buildSessionsOverlayRows(
      [
        {
          sessionId: asBrewvaSessionId("session-today"),
          eventCount: 2,
          lastEventAt: new Date(2026, 4, 14, 10, 0, 0).getTime(),
          title: "Today title",
        },
        {
          sessionId: asBrewvaSessionId("session-yesterday"),
          eventCount: 1,
          lastEventAt: yesterday,
          title: "Yesterday title",
        },
      ],
      now,
    );

    expect(rows.map((row) => (row.kind === "group" ? row.label : row.session.title))).toEqual([
      "Today",
      "Today title",
      new Date(yesterday).toDateString(),
      "Yesterday title",
    ]);
  });
});
