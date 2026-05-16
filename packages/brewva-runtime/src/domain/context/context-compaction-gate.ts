import type { BrewvaConfig } from "../../config/types.js";
import { CONTEXT_COMPACTION_REQUESTED_EVENT_TYPE } from "../../events/registry.js";
import type { BrewvaEventRecord } from "../../events/types.js";
import { normalizeToolName } from "../../utils/tool-name.js";
import type { ContextBudgetManager } from "./budget.js";
import { getContextCompactionGateStatus, getContextUsageRatio } from "./context-pressure.js";
import { resolveContextCompactionEligibility } from "./eligibility.js";
import type { ContextBudgetUsage, ContextCompactionReason } from "./types.js";

export type ContextEventRecorder = (input: {
  sessionId: string;
  type: string;
  turn?: number;
  payload?: object;
  timestamp?: number;
  skipTapeCheckpoint?: boolean;
}) => BrewvaEventRecord | undefined;

export function evaluateContextCompactionGate(input: {
  config: BrewvaConfig;
  contextBudget: ContextBudgetManager;
  sessionId: string;
  toolName: string;
  usage?: ContextBudgetUsage;
  getCurrentTurn: (sessionId: string) => number;
  recordEvent?: ContextEventRecorder;
}): { allowed: boolean; reason?: string } {
  const normalizedToolName = normalizeToolName(input.toolName);
  if (normalizedToolName === "workbench_compact") {
    return { allowed: true };
  }

  const gate = getContextCompactionGateStatus(input);
  const eligibility = resolveContextCompactionEligibility({
    enabled: input.config.infrastructure.contextBudget.enabled,
    status: gate.status,
    pendingReason: input.contextBudget.getPendingCompactionReason(input.sessionId),
    recentCompaction: gate.recentCompaction,
    hasUI: true,
    idle: true,
    recoveryPosture: "idle",
    autoCompactionInFlight: false,
    autoCompactionBreakerOpen: false,
    gateMode: "tool_gate",
  });
  if (eligibility.decision !== "gate_blocked") {
    return { allowed: true };
  }

  const usageRatio =
    typeof gate.status.usageRatio === "number"
      ? gate.status.usageRatio
      : gate.status.hardLimitRatio;
  const usagePercent = Math.max(0, Math.min(1, usageRatio)) * 100;
  const hardLimitPercent = Math.max(0, Math.min(1, gate.status.hardLimitRatio)) * 100;
  const reason = `Context usage is critical (${usagePercent.toFixed(1)}% >= hard limit ${hardLimitPercent.toFixed(1)}%). Call tool 'workbench_compact' first, then continue with other tools. Allowed during gate: workbench_compact.`;

  input.recordEvent?.({
    sessionId: input.sessionId,
    type: "context_compaction_gate_blocked_tool",
    turn: input.getCurrentTurn(input.sessionId),
    payload: {
      blockedTool: input.toolName,
      reason: "critical_context_pressure_without_compaction",
      usagePercent: gate.status.usageRatio,
      hardLimitPercent: gate.status.hardLimitRatio,
    },
  });

  return { allowed: false, reason };
}

export function requestContextCompaction(input: {
  contextBudget: ContextBudgetManager;
  sessionId: string;
  reason: ContextCompactionReason;
  usage?: ContextBudgetUsage;
  recordEvent: ContextEventRecorder;
}): void {
  const pendingReason = input.contextBudget.getPendingCompactionReason(input.sessionId);
  if (pendingReason === input.reason) {
    return;
  }
  input.contextBudget.requestCompaction(input.sessionId, input.reason);
  input.recordEvent({
    sessionId: input.sessionId,
    type: CONTEXT_COMPACTION_REQUESTED_EVENT_TYPE,
    payload: {
      reason: input.reason,
      usagePercent: getContextUsageRatio(input.usage),
      tokens: input.usage?.tokens ?? null,
    },
  });
}

export function checkAndRequestContextCompaction(input: {
  contextBudget: ContextBudgetManager;
  sessionId: string;
  usage?: ContextBudgetUsage;
  recordEvent: ContextEventRecorder;
}): boolean {
  const decision = input.contextBudget.shouldRequestCompaction(input.sessionId, input.usage);
  if (!decision.shouldCompact) return false;
  requestContextCompaction({
    contextBudget: input.contextBudget,
    sessionId: input.sessionId,
    reason: decision.reason ?? "usage_threshold",
    usage: decision.usage,
    recordEvent: input.recordEvent,
  });
  return true;
}
