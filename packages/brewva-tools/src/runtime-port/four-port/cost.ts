import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ProtocolRecord } from "@brewva/brewva-vocabulary/events";
import type { SessionCostSummary } from "@brewva/brewva-vocabulary/session";
import type {
  BrewvaToolRuntimeCapabilitiesPort,
  RuntimeCostPosture,
  RuntimeCostPostureAction,
  RuntimeCostPostureSalience,
  RuntimeCostPostureStatus,
} from "../../contracts/index.js";
import { recordFourPortRuntimeOpsEvent, listFourPortRuntimeEvents } from "./events.js";
import { readNumber, readRecord } from "./helpers.js";
import type { FourPortRuntimeCapabilityContext } from "./types.js";

type CostModelRow = {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly totalCostUsd: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
};

const EMPTY_COST_SUMMARY: SessionCostSummary = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 0,
  totalCostUsd: 0,
  models: {},
  skills: {},
  tools: {},
  alerts: [],
  budget: {
    action: "warn",
    sessionExceeded: false,
    blocked: false,
  },
});

function emptyCostSummary(): SessionCostSummary {
  return {
    ...EMPTY_COST_SUMMARY,
    budget: { ...EMPTY_COST_SUMMARY.budget },
    models: {},
    skills: {},
    tools: {},
    alerts: [],
  };
}

function readUsageNumber(record: ProtocolRecord, primaryKey: string, fallbackKey: string): number {
  const primary = record[primaryKey];
  if (typeof primary === "number" && Number.isFinite(primary)) {
    return primary;
  }
  return readNumber(record, fallbackKey);
}

function readCostUsd(record: ProtocolRecord): number {
  const nestedCost = readRecord(record.cost);
  return (
    readNumber(record, "costUsd") + readNumber(record, "amount") + readNumber(nestedCost, "total")
  );
}

function readTotalTokens(
  record: ProtocolRecord,
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): number {
  const explicitTotal = readNumber(record, "totalTokens");
  return explicitTotal > 0 ? explicitTotal : input + output + cacheRead + cacheWrite;
}

function assistantCostPayload(inputValue: unknown): {
  readonly sessionId: string;
  readonly payload: ProtocolRecord;
} {
  const input = readRecord(inputValue);
  const nestedPayload = readRecord(input.payload);
  const { sessionId: sessionIdValue, payload: _payload, ...flatPayload } = input;
  return {
    sessionId: typeof sessionIdValue === "string" ? sessionIdValue : "default",
    payload: {
      ...flatPayload,
      ...nestedPayload,
    },
  };
}

function roundCost(value: number): number {
  return Number(value.toFixed(6));
}

function formatCost(value: number): string {
  if (value >= 1) {
    return `$${value.toFixed(2)}`;
  }
  return `$${value.toFixed(4)}`;
}

function deriveBudgetFields(
  config: Pick<BrewvaRuntime, "config">["config"]["infrastructure"]["costTracking"],
  totalCostUsd: number,
): {
  readonly action: RuntimeCostPostureAction;
  readonly limitUsd: number | null;
  readonly remainingUsd: number | null;
  readonly usageRatio: number | null;
  readonly alertThresholdRatio: number | null;
  readonly alertThresholdReached: boolean;
  readonly sessionExceeded: boolean;
  readonly blocked: boolean;
} {
  if (!config.enabled || config.maxCostUsdPerSession <= 0) {
    return {
      action: "off",
      limitUsd: null,
      remainingUsd: null,
      usageRatio: null,
      alertThresholdRatio: null,
      alertThresholdReached: false,
      sessionExceeded: false,
      blocked: false,
    };
  }

  const limitUsd = config.maxCostUsdPerSession;
  const usageRatio = totalCostUsd / limitUsd;
  const sessionExceeded = totalCostUsd >= limitUsd;
  return {
    action: config.actionOnExceed,
    limitUsd,
    remainingUsd: roundCost(Math.max(0, limitUsd - totalCostUsd)),
    usageRatio,
    alertThresholdRatio: config.alertThresholdRatio,
    alertThresholdReached: usageRatio >= config.alertThresholdRatio,
    sessionExceeded,
    blocked: sessionExceeded && config.actionOnExceed === "block_tools",
  };
}

function deriveRuntimeCostPosture(
  config: Pick<BrewvaRuntime, "config">["config"]["infrastructure"]["costTracking"],
  summary: SessionCostSummary,
): RuntimeCostPosture {
  const totalCostUsd = roundCost(summary.totalCostUsd);
  const budget = deriveBudgetFields(config, totalCostUsd);
  let status: RuntimeCostPostureStatus = "ok";
  let salience: RuntimeCostPostureSalience = "default";
  let reason: RuntimeCostPosture["softGate"]["reason"] = null;

  if (!config.enabled) {
    status = "disabled";
    salience = "muted";
  } else if (budget.blocked) {
    status = "blocked";
    salience = "alert";
    reason = "budget_exceeded";
  } else if (budget.sessionExceeded || budget.alertThresholdReached) {
    status = "warn";
    salience = "elevated";
    reason = budget.sessionExceeded ? "budget_exceeded" : "alert_threshold";
  }

  const limitLabel = budget.limitUsd === null ? "" : `/${formatCost(budget.limitUsd)}`;
  const label =
    status === "disabled"
      ? `cost disabled ${formatCost(totalCostUsd)}`
      : `cost ${formatCost(totalCostUsd)}${limitLabel}`;

  return {
    status,
    salience,
    totalCostUsd,
    budgetLimitUsd: budget.limitUsd,
    budgetRemainingUsd: budget.remainingUsd,
    usageRatio: budget.usageRatio,
    alertThresholdRatio: budget.alertThresholdRatio,
    actionOnExceed: budget.action,
    softGate: {
      required: reason !== null,
      reason,
    },
    label,
    shortLabel: `${formatCost(totalCostUsd)}${limitLabel}`,
  };
}

function costSummaryFromEvents(
  runtime: Pick<BrewvaRuntime, "config" | "tape">,
  sessionId: string,
): SessionCostSummary {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  const models: Record<string, CostModelRow> = {};
  for (const event of listFourPortRuntimeEvents(runtime, sessionId, { type: "cost.observed" })) {
    const payload = readRecord(event.payload);
    const eventInputTokens = readUsageNumber(payload, "inputTokens", "input");
    const eventOutputTokens = readUsageNumber(payload, "outputTokens", "output");
    const eventCacheReadTokens = readUsageNumber(payload, "cacheReadTokens", "cacheRead");
    const eventCacheWriteTokens = readUsageNumber(payload, "cacheWriteTokens", "cacheWrite");
    const eventTotalTokens = readTotalTokens(
      payload,
      eventInputTokens,
      eventOutputTokens,
      eventCacheReadTokens,
      eventCacheWriteTokens,
    );
    const eventCostUsd = readCostUsd(payload);
    inputTokens += eventInputTokens;
    outputTokens += eventOutputTokens;
    cacheReadTokens += eventCacheReadTokens;
    cacheWriteTokens += eventCacheWriteTokens;
    totalTokens += eventTotalTokens;
    totalCostUsd += eventCostUsd;
    const model = typeof payload.model === "string" ? payload.model.trim() : "";
    if (model) {
      const previous = models[model] ?? {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      };
      models[model] = {
        inputTokens: (previous.inputTokens ?? 0) + eventInputTokens,
        outputTokens: (previous.outputTokens ?? 0) + eventOutputTokens,
        totalTokens: previous.totalTokens + eventTotalTokens,
        totalCostUsd: previous.totalCostUsd + eventCostUsd,
        cacheReadTokens: (previous.cacheReadTokens ?? 0) + eventCacheReadTokens,
        cacheWriteTokens: (previous.cacheWriteTokens ?? 0) + eventCacheWriteTokens,
      };
    }
  }
  const budget = deriveBudgetFields(runtime.config.infrastructure.costTracking, totalCostUsd);
  return {
    ...emptyCostSummary(),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    totalCostUsd,
    models,
    budget: {
      action: budget.action,
      sessionExceeded: budget.sessionExceeded,
      blocked: budget.blocked,
      limitUsd: budget.limitUsd,
      remainingUsd: budget.remainingUsd,
      usageRatio: budget.usageRatio,
      alertThresholdRatio: budget.alertThresholdRatio,
    },
  };
}

export function createFourPortCostRuntimeOps(
  context: FourPortRuntimeCapabilityContext,
): BrewvaToolRuntimeCapabilitiesPort["cost"] {
  return {
    posture: {
      get: (sessionId) =>
        deriveRuntimeCostPosture(
          context.runtime.config.infrastructure.costTracking,
          costSummaryFromEvents(context.runtime, sessionId),
        ),
    },
    summary: {
      get: (sessionId) => costSummaryFromEvents(context.runtime, sessionId),
    },
    usage: {
      recordAssistant(inputValue: unknown) {
        const { sessionId, payload } = assistantCostPayload(inputValue);
        recordFourPortRuntimeOpsEvent(context, {
          sessionId,
          kind: "cost.observed",
          payload,
        });
        return costSummaryFromEvents(context.runtime, sessionId);
      },
    },
  };
}
