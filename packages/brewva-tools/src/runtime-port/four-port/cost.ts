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

function readSelectionId(payload: ProtocolRecord): string {
  return typeof payload.selectionId === "string" ? payload.selectionId.trim() : "";
}

function readSelectionSkillNames(payload: ProtocolRecord): readonly string[] {
  const rendered = Array.isArray(payload.renderedSkillReasons) ? payload.renderedSkillReasons : [];
  const names = new Set<string>();
  for (const entry of rendered) {
    const record = readRecord(entry);
    // Each entry is a RenderedSkillReason; the skill name lives on `name`
    // (matching the skill-adoption consumer), not `skillName`.
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (name) {
      names.add(name);
    }
  }
  return [...names];
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
  options: { readonly includeAttribution?: boolean } = {},
): SessionCostSummary {
  // Per-tool/skill attribution is only read by `summary.get`. `posture.get` and
  // `recordAssistant` read session totals only, so they skip the extra tape scans and
  // the attribution walk on their hotter paths.
  const includeAttribution = options.includeAttribution !== false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  const models: Record<string, CostModelRow> = {};
  const costEvents: Array<{
    readonly timestamp: number;
    readonly costUsd: number;
    readonly totalTokens: number;
    readonly cacheReadTokens: number;
  }> = [];
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
    if (includeAttribution) {
      costEvents.push({
        timestamp: event.timestamp,
        costUsd: eventCostUsd,
        totalTokens: eventTotalTokens,
        cacheReadTokens: eventCacheReadTokens,
      });
    }
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

  // Per-tool allocation + per-skill attribution — computed only when a caller reads
  // the breakdown (summary.get). callCount is measured; tokens + USD are estimated (a
  // proportional split of the session cost pool; there is no provider per-tool/skill
  // cost, and openai-codex reports cost=0).
  const tools: Record<
    string,
    { callCount: number; allocatedTokens: number; allocatedCostUsd: number }
  > = {};
  const skills: SessionCostSummary["skills"] = {};
  if (includeAttribution) {
    for (const event of listFourPortRuntimeEvents(runtime, sessionId, {
      type: "tool.result.recorded",
    })) {
      const payload = readRecord(event.payload);
      const toolName = typeof payload.toolName === "string" ? payload.toolName.trim() : "";
      if (!toolName) {
        continue;
      }
      const estimate = Math.max(0, readNumber(payload, "resultTokenEstimate"));
      const previous = tools[toolName] ?? { callCount: 0, allocatedTokens: 0, allocatedCostUsd: 0 };
      tools[toolName] = {
        callCount: previous.callCount + 1,
        allocatedTokens: previous.allocatedTokens + estimate,
        allocatedCostUsd: 0,
      };
    }
    const toolTokenTotal = Object.values(tools).reduce((sum, row) => sum + row.allocatedTokens, 0);
    if (toolTokenTotal > 0 && totalCostUsd > 0) {
      for (const name of Object.keys(tools)) {
        const row = tools[name];
        if (row) {
          tools[name] = {
            ...row,
            allocatedCostUsd: roundCost(totalCostUsd * (row.allocatedTokens / toolTokenTotal)),
          };
        }
      }
    }

    // Attribute each per-turn cost.observed to the skills surfaced by the most recent
    // skill.selection.recorded at or before it, split equally across those skills.
    // NOTE: this is a DIFFERENT estimate basis than the per-tool split above (which
    // divides the pool by result-token share). Both are graded `estimated` and are not
    // reconcilable — do not sum tool rows and skill rows into a single total.
    // Both lists arrive timestamp-sorted, so one forward cursor is O(costs + selections).
    const selections = listFourPortRuntimeEvents(runtime, sessionId, {
      type: "skill.selection.recorded",
    })
      .map((event) => ({
        timestamp: event.timestamp,
        selectionId: readSelectionId(readRecord(event.payload)),
        names: readSelectionSkillNames(readRecord(event.payload)),
      }))
      .filter((selection) => selection.names.length > 0);
    const skillAccumulators: Record<
      string,
      {
        totalCostUsd: number;
        totalTokens: number;
        cacheReadTokens: number;
        usageCount: number;
        turnIds: Set<string>;
      }
    > = {};
    let selectionCursor = 0;
    let active: (typeof selections)[number] | undefined;
    for (const cost of costEvents) {
      while (
        selectionCursor < selections.length &&
        (selections[selectionCursor]?.timestamp ?? 0) <= cost.timestamp
      ) {
        active = selections[selectionCursor];
        selectionCursor += 1;
      }
      if (!active) {
        continue;
      }
      const share = 1 / active.names.length;
      for (const name of active.names) {
        const previous = skillAccumulators[name] ?? {
          totalCostUsd: 0,
          totalTokens: 0,
          cacheReadTokens: 0,
          usageCount: 0,
          turnIds: new Set<string>(),
        };
        previous.totalCostUsd += cost.costUsd * share;
        previous.totalTokens += cost.totalTokens * share;
        previous.cacheReadTokens += cost.cacheReadTokens * share;
        previous.usageCount += 1;
        if (active.selectionId) {
          previous.turnIds.add(active.selectionId);
        }
        skillAccumulators[name] = previous;
      }
    }
    for (const [name, row] of Object.entries(skillAccumulators)) {
      skills[name] = {
        totalCostUsd: roundCost(row.totalCostUsd),
        totalTokens: Math.round(row.totalTokens),
        cacheReadTokens: Math.round(row.cacheReadTokens),
        usageCount: row.usageCount,
        turns: row.turnIds.size,
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
    tools,
    skills,
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
          costSummaryFromEvents(context.runtime, sessionId, { includeAttribution: false }),
        ),
    },
    summary: {
      get: (sessionId, options) => costSummaryFromEvents(context.runtime, sessionId, options),
    },
    usage: {
      recordAssistant(inputValue: unknown) {
        const { sessionId, payload } = assistantCostPayload(inputValue);
        recordFourPortRuntimeOpsEvent(context, {
          sessionId,
          kind: "cost.observed",
          payload,
        });
        return costSummaryFromEvents(context.runtime, sessionId, { includeAttribution: false });
      },
    },
  };
}
