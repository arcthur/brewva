import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { ProtocolRecord } from "@brewva/brewva-vocabulary/events";
import type { SessionCostSummary } from "@brewva/brewva-vocabulary/session";
import type { BrewvaToolRuntimeCapabilitiesPort } from "../../contracts/index.js";
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

function costSummaryFromEvents(
  runtime: Pick<BrewvaRuntime, "tape">,
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
  return {
    ...emptyCostSummary(),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    totalCostUsd,
    models,
  };
}

export function createFourPortCostRuntimeOps(
  context: FourPortRuntimeCapabilityContext,
): BrewvaToolRuntimeCapabilitiesPort["cost"] {
  return {
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
