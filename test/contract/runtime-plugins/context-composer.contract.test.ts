import { describe, expect, test } from "bun:test";
import {
  buildCapabilityView,
  composeContextBlocks,
  type ContextComposerInput,
} from "@brewva/brewva-gateway/runtime-plugins";
import {
  CONTEXT_SOURCES,
  CONTEXT_SOURCE_BUDGET_CLASSES,
  type ContextInjectionBudgetClass,
  type ContextInjectionEntry,
} from "@brewva/brewva-runtime";

function resolveBudgetClass(source: string): ContextInjectionBudgetClass {
  return (
    (CONTEXT_SOURCE_BUDGET_CLASSES as Record<string, ContextInjectionBudgetClass>)[source] ?? "core"
  );
}

function makeEntry(
  source: string,
  id: string,
  content: string,
  estimatedTokens = 8,
  category: ContextInjectionEntry["category"] = "narrative",
): ContextInjectionEntry {
  return {
    category,
    budgetClass: resolveBudgetClass(source),
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
  options: {
    pendingDelegations?: Array<{ runId: string; delegate: string; status: "pending" | "running" }>;
    pendingDelegationOutcomes?: Array<{
      runId: string;
      delegate: string;
      status: "completed" | "failed" | "timeout" | "cancelled";
      summary?: string;
    }>;
  } = {},
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
      query: () => [],
    },
    delegation: {
      listRuns: (
        _sessionId: string,
        query: { statuses?: string[]; limit?: number } | undefined,
      ) => {
        const records = [
          ...(options.pendingDelegations ?? []).map((run, index) => ({
            runId: run.runId,
            delegate: run.delegate,
            parentSessionId: "compose-session",
            status: run.status,
            createdAt: index + 1,
            updatedAt: index + 1,
          })),
          ...(options.pendingDelegationOutcomes ?? []).map((run, index) => ({
            runId: run.runId,
            delegate: run.delegate,
            parentSessionId: "compose-session",
            status: run.status,
            createdAt: index + 11,
            updatedAt: index + 11,
            summary: run.summary,
            delivery: {
              mode: "text_only" as const,
              handoffState: "pending_parent_turn" as const,
              updatedAt: index + 11,
              readyAt: index + 11,
            },
          })),
        ];
        const filtered =
          query?.statuses && query.statuses.length > 0
            ? records.filter((run) =>
                (query.statuses as Array<string | undefined>).includes(run.status),
              )
            : records;
        return filtered.slice(0, query?.limit ?? filtered.length);
      },
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
      capabilityView: buildCapabilityView({
        prompt: "continue",
        allTools: [
          {
            name: "skill_load",
            description: "Load a skill.",
            parameters: { type: "object", properties: {} },
          },
        ],
        activeToolNames: ["skill_load"],
      }),
      injectionAccepted: true,
      admittedEntries: [
        makeEntry(
          "brewva.custom-constraint",
          "custom-constraint",
          "[CustomConstraint]\nstatus: pending",
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
      result.content.indexOf("[CustomConstraint]"),
    );
    expect(result.metrics.narrativeRatio).toBeGreaterThan(0.25);
  });

  test("keeps compaction constraints even when governance diagnostics are trimmed by the cap", () => {
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
      capabilityView: buildCapabilityView({
        prompt: "continue",
        allTools: [
          {
            name: "session_compact",
            description: "Compact session context.",
            parameters: { type: "object", properties: {} },
          },
        ],
        activeToolNames: ["session_compact"],
      }),
      injectionAccepted: false,
      admittedEntries: [],
    });

    expect(result.content).toContain("[ContextCompactionGate]");
    expect(result.content).not.toContain("[OperationalDiagnostics]");
    expect(result.content).not.toContain("tape_pressure:");
    expect(result.content).not.toContain("tape_entries_since_anchor:");
    expect(result.metrics.diagnosticTokens).toBe(0);
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
      capabilityView: buildCapabilityView({
        prompt: "inspect $obs_query",
        allTools: [
          {
            name: "obs_query",
            description: "Query runtime events.",
            parameters: { type: "object", properties: {} },
          },
        ],
        activeToolNames: ["obs_query"],
      }),
      injectionAccepted: false,
      admittedEntries: [],
    });

    expect(result.content).toContain("[OperationalDiagnostics]");
    expect(result.content).toContain("requested_by: $obs_query");
    expect(result.content).toContain("tape_pressure: high");
    expect(result.content).toContain("tape_entries_since_anchor: 18");
    expect(result.content).not.toContain("[CapabilityDetail:$obs_query]");
  });

  test("surfaces pending delegations in operational diagnostics", () => {
    const result = composeContextBlocks({
      runtime: createComposerRuntime("medium", 4, {
        pendingDelegations: [
          { runId: "run-a", delegate: "explore", status: "running" },
          { runId: "run-b", delegate: "review", status: "pending" },
        ],
      }),
      sessionId: "compose-pending-delegations",
      gateStatus: {
        required: false,
        reason: null,
        pressure: {
          level: "medium",
          usageRatio: 0.55,
          hardLimitRatio: 0.98,
          compactionThresholdRatio: 0.8,
        },
        recentCompaction: false,
        lastCompactionTurn: null,
        turnsSinceCompaction: 1,
        windowTurns: 4,
      },
      pendingCompactionReason: "usage_threshold",
      capabilityView: buildCapabilityView({
        prompt: "inspect $obs_query",
        allTools: [
          {
            name: "obs_query",
            description: "Query runtime events.",
            parameters: { type: "object", properties: {} },
          },
        ],
        activeToolNames: ["obs_query"],
      }),
      injectionAccepted: false,
      admittedEntries: [],
    });

    expect(result.content).toContain("pending_delegations: 2");
    expect(result.content).toContain("explore/run-a:running");
    expect(result.content).toContain("review/run-b:pending");
  });

  test("adds an explicit pending delegations section to compaction guidance", () => {
    const result = composeContextBlocks({
      runtime: createComposerRuntime("high", 9, {
        pendingDelegations: [
          { runId: "run-c", delegate: "explore", status: "running" },
          { runId: "run-d", delegate: "patch-worker", status: "pending" },
        ],
      }),
      sessionId: "compose-compaction-pending-delegations",
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
        turnsSinceCompaction: 7,
        windowTurns: 4,
      },
      pendingCompactionReason: "usage_threshold",
      capabilityView: buildCapabilityView({
        prompt: "continue",
        allTools: [
          {
            name: "session_compact",
            description: "Compact session context.",
            parameters: { type: "object", properties: {} },
          },
        ],
        activeToolNames: ["session_compact"],
      }),
      injectionAccepted: false,
      admittedEntries: [],
    });

    expect(result.content).toContain("[PendingDelegations]");
    expect(result.content).toContain("count: 2");
    expect(result.content).toContain("explore/run-c:running");
    expect(result.content).toContain("patch-worker/run-d:pending");
  });

  test("surfaces completed delegation outcomes for the next parent turn", () => {
    const result = composeContextBlocks({
      runtime: createComposerRuntime("low", 1, {
        pendingDelegationOutcomes: [
          {
            runId: "run-outcome-a",
            delegate: "review",
            status: "completed",
            summary: "Review completed with one medium finding.",
          },
        ],
      }),
      sessionId: "compose-completed-outcomes",
      gateStatus: {
        required: false,
        reason: null,
        pressure: {
          level: "low",
          usageRatio: 0.18,
          hardLimitRatio: 0.98,
          compactionThresholdRatio: 0.8,
        },
        recentCompaction: false,
        lastCompactionTurn: null,
        turnsSinceCompaction: 1,
        windowTurns: 4,
      },
      pendingCompactionReason: null,
      capabilityView: buildCapabilityView({
        prompt: "continue",
        allTools: [],
        activeToolNames: [],
      }),
      injectionAccepted: false,
      admittedEntries: [],
    });

    expect(result.content).toContain("[CompletedDelegationOutcomes]");
    expect(result.content).toContain("count: 1");
    expect(result.content).toContain(
      "- review/run-outcome-a: completed :: Review completed with one medium finding.",
    );
    expect(result.surfacedDelegationRunIds).toEqual(["run-outcome-a"]);
  });

  test("caps governance-heavy injections before they crowd out narrative blocks", () => {
    const result = composeContextBlocks({
      runtime: createComposerRuntime("medium", 6),
      sessionId: "compose-4",
      gateStatus: {
        required: false,
        reason: null,
        pressure: {
          level: "medium",
          usageRatio: 0.72,
          hardLimitRatio: 0.98,
          compactionThresholdRatio: 0.8,
        },
        recentCompaction: false,
        lastCompactionTurn: null,
        turnsSinceCompaction: 3,
        windowTurns: 4,
      },
      pendingCompactionReason: "usage_threshold",
      capabilityView: buildCapabilityView({
        prompt: "inspect $obs_query",
        allTools: [
          {
            name: "session_compact",
            description: "Compact session context.",
            parameters: { type: "object", properties: {} },
          },
          {
            name: "output_search",
            description: "Search persisted tool output.",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
          {
            name: "ledger_query",
            description: "Query session ledger.",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
          {
            name: "task_record_blocker",
            description: "Record a task blocker.",
            parameters: { type: "object", properties: { blocker: { type: "string" } } },
          },
          {
            name: "task_view_state",
            description: "View task state.",
            parameters: { type: "object", properties: {} },
          },
          {
            name: "obs_query",
            description: "Query runtime events.",
            parameters: { type: "object", properties: {} },
          },
          {
            name: "tape_search",
            description: "Search tape entries.",
            parameters: { type: "object", properties: { query: { type: "string" } } },
          },
          {
            name: "skill_load",
            description: "Load a skill.",
            parameters: { type: "object", properties: {} },
          },
        ],
        activeToolNames: [
          "session_compact",
          "output_search",
          "ledger_query",
          "task_record_blocker",
          "task_view_state",
          "obs_query",
          "tape_search",
          "skill_load",
        ],
      }),
      injectionAccepted: true,
      admittedEntries: [
        makeEntry(CONTEXT_SOURCES.taskState, "task-state", "[TaskState]\nstatus: active", 16),
        makeEntry(
          CONTEXT_SOURCES.projectionWorking,
          "projection",
          "[WorkingProjection]\nstep: patch\nstep: verify\nstep: summarize",
          18,
        ),
      ],
    });

    expect(result.content).toContain("[OperationalDiagnostics]");
    expect(result.content).toContain("[TaskState]");
    expect(result.metrics.narrativeRatio).toBeGreaterThan(0.15);
  });

  test("uses narrative ratio to compact capability sections before dropping explicit tool details", () => {
    const capabilityView = buildCapabilityView({
      prompt: "inspect $task_set_spec",
      allTools: [
        {
          name: "session_compact",
          description: "Compact session context.",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "task_set_spec",
          description: "Set the task specification.",
          parameters: { type: "object", properties: { goal: { type: "string" } } },
        },
        {
          name: "tape_search",
          description: "Search tape entries.",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
        {
          name: "obs_query",
          description: "Query runtime events.",
          parameters: { type: "object", properties: {} },
        },
      ],
      activeToolNames: ["session_compact"],
    });

    const result = composeContextBlocks({
      runtime: createComposerRuntime("low", 1),
      sessionId: "compose-6",
      gateStatus: {
        required: false,
        reason: null,
        pressure: {
          level: "low",
          usageRatio: 0.18,
          hardLimitRatio: 0.98,
          compactionThresholdRatio: 0.8,
        },
        recentCompaction: false,
        lastCompactionTurn: null,
        turnsSinceCompaction: 1,
        windowTurns: 4,
      },
      pendingCompactionReason: null,
      capabilityView,
      injectionAccepted: false,
      admittedEntries: [],
    });

    expect(result.content).toContain("[CapabilityView]");
    expect(result.content).toContain("[CapabilityDetail:$task_set_spec]");
    expect(result.content).toContain("boundary: effectful");
    expect(result.content).toContain("effects: memory_write");
    expect(result.content).not.toContain("description:");
    expect(result.content).not.toContain("surface_policy:");
    expect(result.content).not.toContain("boundary_policy:");
    expect(result.content).not.toContain("hidden_skill_count:");
    expect(result.content).not.toContain("operator_hint:");
  });

  test("uses caller-supplied supplemental blocks when default supplemental blocks are disabled", () => {
    const result = composeContextBlocks({
      runtime: createComposerRuntime("low", 1),
      sessionId: "compose-7",
      gateStatus: {
        required: false,
        reason: null,
        pressure: {
          level: "low",
          usageRatio: 0.18,
          hardLimitRatio: 0.98,
          compactionThresholdRatio: 0.8,
        },
        recentCompaction: false,
        lastCompactionTurn: null,
        turnsSinceCompaction: 1,
        windowTurns: 4,
      },
      pendingCompactionReason: null,
      capabilityView: buildCapabilityView({
        prompt: "continue",
        allTools: [],
        activeToolNames: [],
      }),
      injectionAccepted: false,
      admittedEntries: [],
      includeDefaultSupplementalBlocks: false,
      supplementalBlocks: [
        {
          id: "operational-diagnostics",
          category: "diagnostic",
          content: "[OperationalDiagnostics]\ncontext_pressure: low",
          estimatedTokens: 8,
        },
      ],
    });

    expect(result.content).toContain("[OperationalDiagnostics]");
  });
});
