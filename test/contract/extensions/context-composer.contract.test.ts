import { describe, expect, test } from "bun:test";
import {
  composeContextBlocks,
  type ContextComposerInput,
} from "@brewva/brewva-gateway/runtime-plugins";
import { CONTEXT_SOURCES, type ContextInjectionEntry } from "@brewva/brewva-runtime";

function makeEntry(
  source: string,
  id: string,
  content: string,
  estimatedTokens = 8,
  category: ContextInjectionEntry["category"] = "narrative",
): ContextInjectionEntry {
  return {
    category,
    source,
    id,
    content,
    estimatedTokens,
    timestamp: 1,
    oncePerSession: false,
    truncated: false,
  };
}

function createComposerRuntime(
  tapePressure: "low" | "medium" | "high",
  entriesSinceAnchor: number,
): ContextComposerInput["runtime"] {
  return {
    events: {
      getTapeStatus: () => ({
        tapePressure,
        totalEntries: 32,
        entriesSinceAnchor,
        entriesSinceCheckpoint: 7,
        lastAnchor: tapePressure === "low" ? null : { id: "a-1", name: "handoff" },
      }),
    },
  } as ContextComposerInput["runtime"];
}

describe("context composer", () => {
  test("orders admitted context as narrative first and constraints second", () => {
    const result = composeContextBlocks({
      runtime: createComposerRuntime("low", 1),
      sessionId: "compose-1",
      gateStatus: {
        required: false,
        reason: null,
        pressure: {
          level: "low",
          usageRatio: 0.2,
          hardLimitRatio: 0.95,
          compactionThresholdRatio: 0.8,
        },
        recentCompaction: false,
        lastCompactionTurn: null,
        turnsSinceCompaction: null,
        windowTurns: 4,
      },
      pendingCompactionReason: null,
      capabilityView: {
        block: "[CapabilityView]\nvisible_now: $skill_load",
        requested: [],
        expanded: [],
        missing: [],
      },
      injectionAccepted: true,
      admittedEntries: [
        makeEntry(
          CONTEXT_SOURCES.skillCascadeGate,
          "skill-cascade-gate",
          "[SkillCascadeGate]\nstatus: pending",
          8,
          "constraint",
        ),
        makeEntry(CONTEXT_SOURCES.taskState, "task-state", "[TaskState]\nstatus: active"),
        makeEntry(
          CONTEXT_SOURCES.projectionWorking,
          "projection",
          "[WorkingProjection]\nstep: patch",
        ),
      ],
    });

    expect(result.blocks.map((block) => block.category)).toEqual([
      "narrative",
      "narrative",
      "constraint",
      "constraint",
    ]);
    expect(result.content.indexOf("[TaskState]")).toBeLessThan(
      result.content.indexOf("[SkillCascadeGate]"),
    );
    expect(result.metrics.narrativeRatio).toBeGreaterThan(0.4);
  });

  test("adds compact operational diagnostics only on anomaly or explicit diagnostic request", () => {
    const result = composeContextBlocks({
      runtime: createComposerRuntime("high", 18),
      sessionId: "compose-2",
      gateStatus: {
        required: true,
        reason: "hard_limit",
        pressure: {
          level: "critical",
          usageRatio: 0.97,
          hardLimitRatio: 0.98,
          compactionThresholdRatio: 0.8,
        },
        recentCompaction: false,
        lastCompactionTurn: null,
        turnsSinceCompaction: 9,
        windowTurns: 4,
      },
      pendingCompactionReason: "usage_threshold",
      capabilityView: {
        block: "[CapabilityView]\nvisible_now: $session_compact",
        requested: [],
        expanded: [],
        missing: [],
      },
      injectionAccepted: false,
      admittedEntries: [],
    });

    expect(result.content).toContain("[OperationalDiagnostics]");
    expect(result.content).toContain("[ContextCompactionGate]");
    expect(result.content).not.toContain("tape_pressure:");
    expect(result.content).not.toContain("tape_entries_since_anchor:");
    expect(result.metrics.diagnosticTokens).toBeGreaterThan(0);
  });

  test("includes tape telemetry only when diagnostics are explicitly requested", () => {
    const result = composeContextBlocks({
      runtime: createComposerRuntime("high", 18),
      sessionId: "compose-3",
      gateStatus: {
        required: false,
        reason: null,
        pressure: {
          level: "medium",
          usageRatio: 0.62,
          hardLimitRatio: 0.98,
          compactionThresholdRatio: 0.8,
        },
        recentCompaction: false,
        lastCompactionTurn: null,
        turnsSinceCompaction: 2,
        windowTurns: 4,
      },
      pendingCompactionReason: null,
      capabilityView: {
        block: "[CapabilityView]\nvisible_now: $obs_query",
        requested: ["obs_query"],
        expanded: ["obs_query"],
        missing: [],
      },
      injectionAccepted: false,
      admittedEntries: [],
    });

    expect(result.content).toContain("[OperationalDiagnostics]");
    expect(result.content).toContain("requested_by: $obs_query");
    expect(result.content).toContain("tape_pressure: high");
    expect(result.content).toContain("tape_entries_since_anchor: 18");
  });
});
