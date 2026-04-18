import {
  formatTaskVerificationLevelForSurface,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-runtime";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../types.js";
import { textResult } from "../utils/result.js";
import { createRuntimeBoundBrewvaToolFactory } from "../utils/runtime-bound-tool.js";
import { getSessionId } from "../utils/session.js";

function formatPercent(value: number | null): string {
  if (value === null) return "unknown";
  return `${(value * 100).toFixed(1)}%`;
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
      const tape = obsSnapshotTool.runtime.inspect.events.getTapeStatus(sessionId);
      const usage = obsSnapshotTool.runtime.inspect.context.getUsage(sessionId);
      const promptStability = obsSnapshotTool.runtime.inspect.context.getPromptStability(sessionId);
      const transientReduction =
        obsSnapshotTool.runtime.inspect.context.getTransientReduction(sessionId);
      const pressure = obsSnapshotTool.runtime.inspect.context.getPressureStatus(sessionId, usage);
      const cost = obsSnapshotTool.runtime.inspect.cost.getSummary(sessionId);
      const task = obsSnapshotTool.runtime.inspect.task.getState(sessionId);
      const verificationEvent = obsSnapshotTool.runtime.inspect.events.list(sessionId, {
        type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
        last: 1,
      })[0];
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
        `context_pressure: ${pressure.level}`,
        `context_usage: ${formatPercent(pressure.usageRatio)}`,
        `prompt_prefix_stable: ${promptStability?.stablePrefix ?? "unknown"}`,
        `dynamic_tail_stable: ${promptStability?.stableTail ?? "unknown"}`,
        `prompt_scope_key: ${promptStability?.scopeKey ?? "none"}`,
        `transient_reduction_status: ${transientReduction?.status ?? "unknown"}`,
        `transient_reduction_reason: ${transientReduction?.reason ?? "none"}`,
        `transient_reduction_cleared_tool_results: ${transientReduction?.clearedToolResults ?? 0}`,
        `transient_reduction_estimated_token_savings: ${transientReduction?.estimatedTokenSavings ?? 0}`,
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

      return textResult(lines.join("\n"), {
        ok: true,
        tape,
        context: {
          usage,
          pressure,
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
