import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import type { ContextBudgetUsage, ContextStatus } from "@brewva/brewva-vocabulary/context";
import type { ActiveReasoningBranchState } from "@brewva/brewva-vocabulary/iteration";
import type { TapeSearchScope, TapeStatusState } from "@brewva/brewva-vocabulary/session";
import { Type } from "@sinclair/typebox";
import { formatISO } from "date-fns";
import type { BrewvaToolOptions } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { buildStringEnumSchema } from "../../registry/string-enum-contract.js";
import {
  getActiveReasoningState,
  getContextStatus,
  getContextUsage,
  getTapeStatus,
  recordTapeHandoff,
  searchTape,
} from "../../runtime-port/tape.js";
import { errTextResult, okTextResult } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";

const TAPE_SEARCH_SCOPE_VALUES = ["current_phase", "all_phases", "anchors_only"] as const;
const TapeSearchScopeSchema = buildStringEnumSchema(TAPE_SEARCH_SCOPE_VALUES, {
  recommendedValue: "current_phase",
  guidance:
    "Use current_phase by default. Use all_phases for a full-history scan and anchors_only when you only need phase handoff or checkpoint anchors.",
});

function normalizeQuery(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeUsage(value: unknown): ContextBudgetUsage | undefined {
  const usage = value as
    | { tokens: number | null; contextWindow: number; percent: number | null }
    | undefined;
  if (!usage || typeof usage.contextWindow !== "number" || usage.contextWindow <= 0) {
    return undefined;
  }
  return {
    tokens: typeof usage.tokens === "number" ? usage.tokens : null,
    contextWindow: usage.contextWindow,
    percent: typeof usage.percent === "number" ? usage.percent : null,
  };
}

function formatPercent(ratio: number | null): string {
  if (ratio === null) return "unknown";
  return `${(ratio * 100).toFixed(1)}%`;
}

function resolveContextAction(status: ContextStatus): string {
  if (status.forcedCompaction) return "workbench_compact_now";
  if (status.compactionAdvised || status.predictedOverflow) return "workbench_compact_soon";
  return "none";
}

function formatTapeInfoBlock(input: {
  tape: TapeStatusState;
  contextStatus: ContextStatus;
  reasoning: ActiveReasoningBranchState;
}): string {
  const lines = [
    "[TapeInfo]",
    `tape_pressure: ${input.tape.tapePressure}`,
    `tape_entries_total: ${input.tape.totalEntries}`,
    `tape_entries_since_anchor: ${input.tape.entriesSinceAnchor}`,
    `tape_entries_since_checkpoint: ${input.tape.entriesSinceCheckpoint}`,
    `tape_threshold_low: ${input.tape.thresholds.low}`,
    `tape_threshold_medium: ${input.tape.thresholds.medium}`,
    `tape_threshold_high: ${input.tape.thresholds.high}`,
    `last_anchor_name: ${input.tape.lastAnchor?.name ?? "none"}`,
    `last_anchor_id: ${input.tape.lastAnchor?.id ?? "none"}`,
    `last_checkpoint_id: ${input.tape.lastCheckpointId ?? "none"}`,
    `context_usage: ${formatPercent(input.contextStatus.usageRatio ?? null)}`,
    `context_hard_limit: ${formatPercent(input.contextStatus.hardLimitRatio ?? null)}`,
    `context_compaction_advised: ${input.contextStatus.compactionAdvised ? "yes" : "no"}`,
    `context_forced_compaction: ${input.contextStatus.forcedCompaction ? "yes" : "no"}`,
    `tokens_until_forced_compact: ${input.contextStatus.tokensUntilForcedCompact ?? "unknown"}`,
    `predicted_turn_growth_tokens: ${input.contextStatus.predictedTurnGrowthTokens}`,
    `tokens_until_predicted_overflow: ${input.contextStatus.tokensUntilPredictedOverflow ?? "unknown"}`,
    `predicted_overflow: ${input.contextStatus.predictedOverflow ? "yes" : "no"}`,
    `required_action: ${resolveContextAction(input.contextStatus)}`,
    `reasoning_active_branch: ${input.reasoning.activeBranchId}`,
    `reasoning_active_checkpoint: ${input.reasoning.activeCheckpointId ?? "none"}`,
    `reasoning_active_lineage_depth: ${input.reasoning.activeLineageCheckpointIds.length}`,
  ];

  const recentCheckpoints = input.reasoning.checkpoints.slice(-5);
  if (recentCheckpoints.length > 0) {
    lines.push("reasoning_recent_checkpoints:");
    for (const checkpoint of recentCheckpoints) {
      lines.push(
        `- ${checkpoint.checkpointId} branch=${checkpoint.branchId} boundary=${checkpoint.boundary} leaf=${checkpoint.leafEntryId ?? "root"} revertable=${input.reasoning.activeLineageCheckpointIds.includes(checkpoint.checkpointId) ? "yes" : "no"}`,
      );
    }
  }

  const recentReverts = input.reasoning.reverts.slice(-3);
  if (recentReverts.length > 0) {
    lines.push("reasoning_recent_reverts:");
    for (const revert of recentReverts) {
      lines.push(
        `- ${revert.revertId} to=${revert.toCheckpointId} from=${revert.fromCheckpointId ?? "none"} trigger=${revert.trigger} branch=${revert.newBranchId}`,
      );
    }
  }

  const outputSearch = input.tape.outputSearch;
  if (outputSearch) {
    lines.push(
      `output_search_recent_calls: ${outputSearch.recentCalls}`,
      `output_search_single_calls: ${outputSearch.singleQueryCalls}`,
      `output_search_batched_calls: ${outputSearch.batchedCalls}`,
      `output_search_throttled_calls: ${outputSearch.throttledCalls}`,
      `output_search_blocked_calls: ${outputSearch.blockedCalls}`,
      `output_search_last_throttle: ${outputSearch.lastThrottleLevel}`,
      `output_search_total_queries: ${outputSearch.totalQueries}`,
      `output_search_total_results: ${outputSearch.totalResults}`,
      `output_search_avg_results_per_query: ${
        outputSearch.averageResultsPerQuery === null
          ? "unknown"
          : outputSearch.averageResultsPerQuery.toFixed(2)
      }`,
      `output_search_cache_hit_rate: ${formatPercent(outputSearch.cacheHitRate)}`,
      `output_search_match_layers: exact=${outputSearch.matchLayers.exact} partial=${outputSearch.matchLayers.partial} fuzzy=${outputSearch.matchLayers.fuzzy} none=${outputSearch.matchLayers.none}`,
      `output_search_last_at: ${
        typeof outputSearch.lastTimestamp === "number"
          ? formatISO(outputSearch.lastTimestamp)
          : "none"
      }`,
    );
  }

  return lines.join("\n");
}

function resolveToolContextUsage(ctx: unknown): ContextBudgetUsage | undefined {
  const usage = (ctx as { getContextUsage?: (() => unknown) | undefined }).getContextUsage?.();
  return normalizeUsage(usage);
}

function toSafeScope(value: unknown): TapeSearchScope {
  if (value === "all_phases" || value === "anchors_only") return value;
  return "current_phase";
}

export function createTapeTools(options: BrewvaToolOptions): ToolDefinition[] {
  const tapeHandoffTool = createRuntimeBoundBrewvaToolFactory(options.runtime, "tape_handoff");
  const tapeInfoTool = createRuntimeBoundBrewvaToolFactory(options.runtime, "tape_info");
  const tapeSearchTool = createRuntimeBoundBrewvaToolFactory(options.runtime, "tape_search");

  const tapeHandoff = tapeHandoffTool.define(
    {
      name: "tape_handoff",
      label: "Tape Handoff",
      description:
        "Create a tape anchor for semantic phase handoff. This does not compact message history.",
      parameters: Type.Object({
        name: Type.String({ minLength: 1, maxLength: 120 }),
        summary: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
        next_steps: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const sessionId = getSessionId(ctx);
        const handoff = recordTapeHandoff(tapeHandoffTool.runtime, sessionId, {
          name: params.name,
          summary: params.summary,
          nextSteps: params.next_steps,
        });
        if (!handoff.ok) {
          return errTextResult(
            `Tape handoff rejected (${handoff.reason ?? "unknown_error"}).`,
            handoff,
          );
        }

        const status = handoff.tapeStatus ?? getTapeStatus(tapeHandoffTool.runtime, sessionId);
        const text = [
          "Tape handoff recorded.",
          `name: ${params.name}`,
          `anchor_id: ${handoff.eventId ?? "unknown"}`,
          `tape_pressure: ${status.tapePressure}`,
          `entries_since_anchor: ${status.entriesSinceAnchor}`,
          `total_entries: ${status.totalEntries}`,
        ].join("\n");
        return okTextResult(text, {
          ok: true,
          anchorId: handoff.eventId ?? null,
          createdAt: handoff.createdAt ?? null,
          tapePressure: status.tapePressure,
          entriesSinceAnchor: status.entriesSinceAnchor,
          totalEntries: status.totalEntries,
        });
      },
    },
    {},
  );

  const tapeInfo = tapeInfoTool.define({
    name: "tape_info",
    label: "Tape Info",
    description: "Show tape status and numeric context budget state for the current session.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const tape = getTapeStatus(tapeInfoTool.runtime, sessionId);
      const usage =
        resolveToolContextUsage(ctx) ?? getContextUsage(tapeInfoTool.runtime, sessionId);
      const contextStatus = getContextStatus(tapeInfoTool.runtime, sessionId, usage);
      const reasoning = getActiveReasoningState(tapeInfoTool.runtime, sessionId);

      return okTextResult(
        formatTapeInfoBlock({
          tape,
          contextStatus,
          reasoning,
        }),
        {
          ok: true,
          tape,
          reasoning,
          context: {
            compactionAdvised: contextStatus.compactionAdvised,
            forcedCompaction: contextStatus.forcedCompaction,
            usageTokens: usage?.tokens ?? null,
            usagePercent: contextStatus.usageRatio,
            tokensUntilForcedCompact: contextStatus.tokensUntilForcedCompact,
            predictedTurnGrowthTokens: contextStatus.predictedTurnGrowthTokens,
            tokensUntilPredictedOverflow: contextStatus.tokensUntilPredictedOverflow,
            predictedOverflow: contextStatus.predictedOverflow,
          },
        },
      );
    },
  });

  const tapeSearch = tapeSearchTool.define({
    name: "tape_search",
    label: "Tape Search",
    description: "Search historical tape entries by text query.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, maxLength: 400 }),
      scope: Type.Optional(TapeSearchScopeSchema),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const query = normalizeQuery(params.query);
      if (!query) {
        return errTextResult("Tape search rejected (missing_query).", {
          ok: false,
          error: "missing_query",
        });
      }

      const scope = toSafeScope(params.scope);
      const result = searchTape(tapeSearchTool.runtime, sessionId, {
        query,
        scope,
        limit: params.limit,
      });

      if (result.matches.length === 0) {
        return okTextResult(
          [
            "[TapeSearch]",
            `query: ${query}`,
            `scope: ${scope}`,
            `scanned_events: ${result.scannedEvents}`,
            "matches: 0",
          ].join("\n"),
          {
            ok: true,
            ...result,
          },
        );
      }

      const lines = [
        "[TapeSearch]",
        `query: ${query}`,
        `scope: ${scope}`,
        `scanned_events: ${result.scannedEvents}`,
        `matches: ${result.matches.length}`,
      ];
      for (let index = 0; index < result.matches.length; index += 1) {
        const match = result.matches[index];
        if (!match) continue;
        lines.push(
          `${index + 1}. [${match.type}] id=${match.eventId} turn=${match.turn ?? "n/a"} ts=${formatISO(match.timestamp)}`,
        );
        lines.push(`   ${match.excerpt}`);
      }

      return okTextResult(lines.join("\n"), {
        ok: true,
        ...result,
      });
    },
  });

  return [tapeHandoff, tapeInfo, tapeSearch];
}
