import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { formatTaskVerificationLevelForSurface } from "@brewva/brewva-vocabulary/task";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../../registry/runtime-bound-tool.js";
import { readObservabilitySnapshotState } from "../../../runtime-port/observability.js";
import { okTextResult } from "../../../utils/result.js";
import { getSessionId } from "../../../utils/session.js";

function formatPercent(value: number | null): string {
  if (value === null) return "unknown";
  return `${(value * 100).toFixed(1)}%`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function createObsSnapshotTool(options: BrewvaToolOptions): ToolDefinition {
  const obsSnapshotTool = createRuntimeBoundBrewvaToolFactory(options.runtime, "obs_snapshot");
  return obsSnapshotTool.define({
    name: "obs_snapshot",
    label: "Observability Snapshot",
    description: "Show a compact health snapshot for the current session runtime state.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const {
        tape,
        usage,
        promptStability,
        transientReduction,
        contextStatus,
        cost,
        task,
        verificationEvent,
      } = readObservabilitySnapshotState(obsSnapshotTool.runtime, sessionId);
      const promptPrefixStable = readBoolean(promptStability?.stablePrefix);
      const promptTailStable = readBoolean(promptStability?.stableTail);
      const promptScopeKey = readString(promptStability?.scopeKey);
      const transientStatus = readString(transientReduction?.status);
      const transientReason = readString(transientReduction?.reason);
      const transientClearedToolResults = readNumber(transientReduction?.clearedToolResults) ?? 0;
      const transientEstimatedTokenSavings =
        readNumber(transientReduction?.estimatedTokenSavings) ?? 0;
      const verificationPayload =
        verificationEvent?.payload &&
        typeof verificationEvent.payload === "object" &&
        !Array.isArray(verificationEvent.payload)
          ? (verificationEvent.payload as Record<string, unknown>)
          : undefined;

      const lines = [
        "[ObsSnapshot]",
        `tape_pressure: ${tape.tapePressure}`,
        `tape_entries_total: ${tape.totalEntries}`,
        `context_usage: ${formatPercent(contextStatus.usageRatio ?? null)}`,
        `context_compaction_advised: ${contextStatus.compactionAdvised ? "yes" : "no"}`,
        `context_forced_compaction: ${contextStatus.forcedCompaction ? "yes" : "no"}`,
        `tokens_until_forced_compact: ${contextStatus.tokensUntilForcedCompact ?? "unknown"}`,
        `predicted_turn_growth_tokens: ${contextStatus.predictedTurnGrowthTokens}`,
        `tokens_until_predicted_overflow: ${contextStatus.tokensUntilPredictedOverflow ?? "unknown"}`,
        `predicted_overflow: ${contextStatus.predictedOverflow ? "yes" : "no"}`,
        `prompt_prefix_stable: ${promptPrefixStable ?? "unknown"}`,
        `dynamic_tail_stable: ${promptTailStable ?? "unknown"}`,
        `prompt_scope_key: ${promptScopeKey ?? "none"}`,
        `transient_reduction_status: ${transientStatus ?? "unknown"}`,
        `transient_reduction_reason: ${transientReason ?? "none"}`,
        `transient_reduction_cleared_tool_results: ${transientClearedToolResults}`,
        `transient_reduction_estimated_token_savings: ${transientEstimatedTokenSavings}`,
        `cost_total_usd: ${cost.totalCostUsd.toFixed(6)}`,
        `cache_read_tokens: ${cost.cacheReadTokens}`,
        `cache_write_tokens: ${cost.cacheWriteTokens}`,
        `budget_action: ${cost.budget.action}`,
        `task_phase: ${task.status?.phase ?? "none"}`,
        `task_blockers: ${task.blockers.length}`,
        `verification_outcome: ${
          typeof verificationPayload?.outcome === "string" ? verificationPayload.outcome : "none"
        }`,
        `verification_level: ${
          formatTaskVerificationLevelForSurface(
            typeof verificationPayload?.level === "string" ? verificationPayload.level : undefined,
          ) ?? "none"
        }`,
      ];
      if (
        typeof verificationPayload?.reason === "string" &&
        verificationPayload.reason.length > 0
      ) {
        lines.push(`verification_reason: ${verificationPayload.reason}`);
      }

      return okTextResult(lines.join("\n"), {
        ok: true,
        tape,
        context: {
          usage,
          status: contextStatus,
          promptStability: promptStability ?? null,
          transientReduction: transientReduction ?? null,
        },
        cost,
        task: {
          phase: task.status?.phase ?? null,
          blockers: task.blockers.length,
          items: task.items.length,
        },
        verification: verificationPayload ?? null,
      });
    },
  });
}
