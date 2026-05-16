import { describe, expect, test } from "bun:test";
import {
  asBrewvaSessionId,
  asBrewvaToolCallId,
  asBrewvaToolName,
} from "@brewva/brewva-runtime/core";
import type { BrewvaReplaySession } from "@brewva/brewva-runtime/events";
import type { SessionLineageTree } from "@brewva/brewva-runtime/session";
import type { OperatorSurfaceSnapshot } from "../../../packages/brewva-cli/src/shell/domain/operator-snapshot.js";
import {
  buildAuthorityOverlayPayload,
  buildContextOverlayPayload,
  buildLineageOverlayPayload,
  buildOverlayView,
  buildSessionsOverlayPayload,
  buildSessionsOverlayRows,
  buildSkillsOverlayPayload,
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

describe("interactive command overlays", () => {
  test("context overlay renders pressure, compaction, prompt, cache, and visible-read posture", () => {
    const payload = buildContextOverlayPayload({
      sessionId: "session-context",
      usage: { tokens: 42_000, contextWindow: 100_000, percent: 0.42, maxOutputTokens: 16_000 },
      status: {
        tokensUsed: 42_000,
        tokensTotal: 100_000,
        effectiveTokensTotal: 96_000,
        tokensRemaining: 58_000,
        autoCompactLimitTokens: 65_000,
        controllableBaselineTokens: 2_000,
        controllableTokensUsed: 40_000,
        controllableTokensTotal: 94_000,
        controllableTokensRemaining: 54_000,
        controllableContextRemainingRatio: 54_000 / 94_000,
        tokensUntilForcedCompact: 18_000,
        predictedTurnGrowthTokens: 4_000,
        tokensUntilPredictedOverflow: 54_000,
        predictedOverflow: false,
        usageRatio: 0.42,
        hardLimitRatio: 0.8,
        compactionThresholdRatio: 0.65,
        compactionAdvised: true,
        forcedCompaction: false,
      },
      pendingCompactionReason: "usage_threshold",
      gateStatus: {
        required: true,
        reason: "hard_limit",
        status: {
          tokensUsed: 42_000,
          tokensTotal: 100_000,
          effectiveTokensTotal: 96_000,
          tokensRemaining: 58_000,
          autoCompactLimitTokens: 65_000,
          controllableBaselineTokens: 2_000,
          controllableTokensUsed: 40_000,
          controllableTokensTotal: 94_000,
          controllableTokensRemaining: 54_000,
          controllableContextRemainingRatio: 54_000 / 94_000,
          tokensUntilForcedCompact: 18_000,
          predictedTurnGrowthTokens: 4_000,
          tokensUntilPredictedOverflow: 54_000,
          predictedOverflow: false,
          usageRatio: 0.42,
          hardLimitRatio: 0.8,
          compactionThresholdRatio: 0.65,
          compactionAdvised: true,
          forcedCompaction: false,
        },
        recentCompaction: false,
        windowTurns: 3,
        lastCompactionTurn: null,
        turnsSinceCompaction: null,
      },
      promptStability: {
        turn: 4,
        updatedAt: 1,
        scopeKey: "session-context",
        stablePrefixHash: "abc123def456",
        dynamicTailHash: "def456abc123",
        stablePrefix: true,
        stableTail: false,
      },
      transientReduction: {
        turn: 4,
        updatedAt: 2,
        status: "completed",
        reason: null,
        eligibleToolResults: 3,
        clearedToolResults: 2,
        clearedChars: 1_024,
        estimatedTokenSavings: 512,
        compactionAdvised: true,
        forcedCompaction: false,
        classification: "prefixPreserving",
        expectedCacheBreak: false,
      },
      providerCache: {
        turn: 4,
        updatedAt: 3,
        source: "provider",
        fingerprint: {
          bucketKey: "bucket",
          provider: "google",
          api: "responses",
          model: "gemini",
          cachePolicyHash: "a".repeat(64),
          toolSchemaSnapshotHash: "b".repeat(64),
          toolSchemaOverlayHash: "c".repeat(64),
          perToolHashes: {},
          stablePrefixHash: "d".repeat(64),
          dynamicTailHash: "e".repeat(64),
          requestHash: "f".repeat(64),
          channelContextHash: "1".repeat(64),
          renderedCacheHash: "2".repeat(64),
          cacheCapabilityHash: "3".repeat(64),
          stickyLatchHash: "4".repeat(64),
          reasoningHash: "5".repeat(64),
          thinkingBudgetHash: "6".repeat(64),
          cacheRelevantHeadersHash: "7".repeat(64),
          extraBodyHash: "8".repeat(64),
          visibleHistoryReductionHash: "9".repeat(64),
          workbenchContextHash: "0".repeat(64),
          providerFallbackHash: "a".repeat(64),
        },
        render: {
          status: "rendered",
          reason: "ok",
          renderedRetention: "short",
          bucketKey: "bucket",
        },
        breakObservation: {
          status: "warm",
          classification: "prefixPreserving",
          expected: false,
          reason: null,
          previousCacheReadTokens: 1,
          cacheReadTokens: 2,
          cacheWriteTokens: 3,
          cacheMissTokens: 4,
          thresholdTokens: 5,
          relativeDropThreshold: 0.5,
          changedFields: ["tools"],
        },
      },
      visibleReadEpoch: 7,
      historyViewBaseline: {
        compactId: "compact-1",
        sanitizedSummary: "summary",
        summaryDigest: "abc123def456",
        sourceTurn: 2,
        leafEntryId: null,
        referenceContextDigest: null,
        fromTokens: 90_000,
        toTokens: 20_000,
        origin: "exact_history",
        eventId: "event-1",
        timestamp: 4,
        rebuildSource: "exact_history",
        diagnostics: [],
      },
    });

    const view = buildOverlayView(payload);

    expect(view.title).toBe("Context");
    expect(view.lines.join("\n")).toContain("ratio=42.0%");
    expect(view.lines.join("\n")).toContain("advised=true");
    expect(view.lines.join("\n")).toContain("pending=usage_threshold");
    expect(view.lines.join("\n")).toContain("required=true");
    expect(view.lines.join("\n")).toContain("stablePrefixHash=abc123");
    expect(view.lines.join("\n")).toContain("provider=google");
    expect(view.lines.join("\n")).toContain("visibleReadEpoch=7");
    expect(view.lines.join("\n")).toContain("Request compaction");
  });

  test("authority overlay renders approvals, capabilities, tool access, and explicit unknown scope", () => {
    const payload = buildAuthorityOverlayPayload({
      snapshot: {
        approvals: [
          {
            requestId: "approval-1",
            proposalId: "proposal-1",
            toolName: asBrewvaToolName("exec"),
            toolCallId: asBrewvaToolCallId("tool-call-1"),
            subject: "run tests",
            boundary: "effectful",
            effects: ["workspace_write"],
            argsDigest: "digest",
            evidenceRefs: [],
            turn: 1,
            createdAt: 1,
          },
        ],
        questions: [],
        taskRuns: [],
        sessions: [],
      },
      capabilitySummary: {
        managedTools: 3,
        capabilityScopedTools: 1,
        requiredCapabilities: ["authority.tools.invocation.start"],
        selectedCapabilities: ["github-read"],
        conflicts: 0,
      },
      toolAccess: [
        {
          toolName: "exec",
          allowed: true,
          warning: "write requires approval",
        },
      ],
    });

    const view = buildOverlayView(payload);

    expect(view.title).toBe("Authority");
    expect(view.lines.join("\n")).toContain("Pending approvals: 1");
    expect(view.lines.join("\n")).toContain("managedTools=3");
    expect(view.lines.join("\n")).toContain("capabilityScopedTools=1");
    expect(view.lines.join("\n")).toContain("selected=github-read");
    expect(view.lines.join("\n")).toContain("required=authority.tools.invocation.start");
    expect(view.lines.join("\n")).toContain("Tool access: checked=1 warnings=1 blocked=0");
    expect(view.lines.join("\n")).toContain("exec allowed=true warning=write requires approval");
    expect(view.lines.join("\n")).toContain("network=not surfaced");
    expect(view.lines.join("\n")).toContain("gateway=not surfaced");
  });

  test("skills overlay renders skill and producer catalog entries", () => {
    const payload = buildSkillsOverlayPayload({
      loadReport: {
        roots: [],
        loadedSkills: ["review"],
        selectableSkills: ["review"],
        overlaySkills: [],
        projectGuidance: [],
        categories: {},
      },
      skills: [
        {
          name: "review",
          category: "core",
          description: "Review code changes",
          filePath: "/tmp/SKILL.md",
          baseDir: "/tmp",
          markdown: "# review",
          authoredMarkdown: "# review",
          inheritedMarkdown: "",
          card: {
            name: "review",
            category: "core",
            description: "Review code changes",
            selection: { triggers: ["review"] },
          },
          resources: { references: [], scripts: [], invariants: [] },
          authoredResources: { references: [], scripts: [], invariants: [] },
          inheritedResources: { references: [], scripts: [], invariants: [] },
          projectGuidance: [],
          overlayFiles: [],
        },
      ],
      producers: [
        {
          producer: "review",
          outputs: ["review_report"],
          outputContracts: {},
          semanticBindings: {},
          filePath: "/tmp/review.producer.json",
          source: "project_root",
          rootDir: "/tmp",
        },
      ],
    });

    const view = buildOverlayView(payload);

    expect(view.title).toBe("Skills");
    expect(view.lines.join("\n")).toContain("loaded=1");
    expect(view.lines.join("\n")).toContain("skill=review category=core");
    expect(view.lines.join("\n")).toContain(
      "producer=review source=project_root outputs=review_report",
    );
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
