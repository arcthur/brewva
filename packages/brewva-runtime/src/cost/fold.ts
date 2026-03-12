import type { BrewvaConfig, SessionCostSummary, SessionCostTotals } from "../types.js";

export interface CostUsageInput {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface CostUsageContext {
  turn: number;
  skill?: string;
}

export type CostAlert = SessionCostSummary["alerts"][number];

interface SkillCostState {
  totals: SessionCostTotals;
  usageCount: number;
  turnCount: number;
  lastTurnSeen: number;
}

interface ToolCostState {
  callCount: number;
  allocatedTokens: number;
  allocatedCostUsd: number;
}

export interface CostFoldState {
  totals: SessionCostTotals;
  models: Record<string, SessionCostTotals>;
  skills: Record<string, SkillCostState>;
  tools: Record<string, ToolCostState>;
  turnToolCalls: Map<number, Map<string, number>>;
  alerts: CostAlert[];
  sessionThresholdAlerted: boolean;
  sessionCapAlerted: boolean;
  skillLastTurnByName: Record<string, number>;
  updatedAt: number | null;
  budget: SessionCostSummary["budget"];
}

interface CostBudgetStatus {
  action: "warn" | "block_tools";
  sessionExceeded: boolean;
  blocked: boolean;
}

function emptyTotals(): SessionCostTotals {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
  };
}

function cloneTotals(input: SessionCostTotals): SessionCostTotals {
  return {
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
    cacheReadTokens: input.cacheReadTokens,
    cacheWriteTokens: input.cacheWriteTokens,
    totalTokens: input.totalTokens,
    totalCostUsd: input.totalCostUsd,
  };
}

function addTotals(target: SessionCostTotals, usage: CostUsageInput): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.cacheReadTokens += usage.cacheReadTokens;
  target.cacheWriteTokens += usage.cacheWriteTokens;
  target.totalTokens += usage.totalTokens;
  target.totalCostUsd += usage.costUsd;
}

export function normalizeCostTurn(turn: number): number {
  if (!Number.isFinite(turn)) return 0;
  return Math.max(0, Math.trunc(turn));
}

function normalizeNonNegativeNumber(value: unknown, fallback = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, value);
}

function cloneAlert(alert: CostAlert): CostAlert {
  return {
    timestamp: alert.timestamp,
    kind: alert.kind,
    scope: alert.scope,
    costUsd: alert.costUsd,
    thresholdUsd: alert.thresholdUsd,
  };
}

function cloneBudget(input: SessionCostSummary["budget"]): SessionCostSummary["budget"] {
  return {
    action: input.action,
    sessionExceeded: input.sessionExceeded,
    blocked: input.blocked,
  };
}

function computeBudgetStatus(
  state: CostFoldState,
  config: BrewvaConfig["infrastructure"]["costTracking"],
): CostBudgetStatus {
  if (!config.enabled) {
    return {
      action: config.actionOnExceed,
      sessionExceeded: false,
      blocked: false,
    };
  }

  const sessionExceeded =
    config.maxCostUsdPerSession > 0 && state.totals.totalCostUsd >= config.maxCostUsdPerSession;
  const blocked = config.actionOnExceed === "block_tools" && sessionExceeded;
  return {
    action: config.actionOnExceed,
    sessionExceeded,
    blocked,
  };
}

function allocateUsageToTools(state: CostFoldState, turn: number, usage: CostUsageInput): void {
  const callsForTurn = state.turnToolCalls.get(turn);
  const weightedTools =
    callsForTurn && callsForTurn.size > 0 ? callsForTurn : new Map<string, number>([["llm", 1]]);
  const totalWeight = [...weightedTools.values()].reduce((sum, value) => sum + value, 0);
  if (totalWeight <= 0) return;

  for (const [toolName, weight] of weightedTools.entries()) {
    const ratio = weight / totalWeight;
    const toolState = state.tools[toolName] ?? {
      callCount: 0,
      allocatedTokens: 0,
      allocatedCostUsd: 0,
    };
    toolState.allocatedTokens += usage.totalTokens * ratio;
    toolState.allocatedCostUsd += usage.costUsd * ratio;
    state.tools[toolName] = toolState;
  }
}

function applyUsage(state: CostFoldState, usage: CostUsageInput, context: CostUsageContext): void {
  addTotals(state.totals, usage);
  const modelTotals = state.models[usage.model] ?? emptyTotals();
  addTotals(modelTotals, usage);
  state.models[usage.model] = modelTotals;

  const skillName = context.skill?.trim() || "(none)";
  const turn = normalizeCostTurn(context.turn);
  const skillState = state.skills[skillName] ?? {
    totals: emptyTotals(),
    usageCount: 0,
    turnCount: 0,
    lastTurnSeen: -1,
  };
  addTotals(skillState.totals, usage);
  skillState.usageCount += 1;
  if (turn > 0 && turn !== skillState.lastTurnSeen) {
    skillState.turnCount += 1;
    skillState.lastTurnSeen = turn;
  }
  state.skills[skillName] = skillState;

  if (turn > 0) {
    state.skillLastTurnByName[skillName] = turn;
  }

  allocateUsageToTools(state, turn, usage);
}

function collectAlerts(
  state: CostFoldState,
  config: BrewvaConfig["infrastructure"]["costTracking"],
  timestamp: number,
): CostAlert[] {
  if (!config.enabled) return [];

  const newAlerts: CostAlert[] = [];
  const maxSession = config.maxCostUsdPerSession;
  if (maxSession <= 0) {
    return newAlerts;
  }

  const threshold = maxSession * config.alertThresholdRatio;
  if (!state.sessionThresholdAlerted && threshold > 0 && state.totals.totalCostUsd >= threshold) {
    const alert: CostAlert = {
      timestamp,
      kind: "session_threshold",
      scope: "session",
      costUsd: state.totals.totalCostUsd,
      thresholdUsd: threshold,
    };
    state.alerts.push(alert);
    newAlerts.push(alert);
    state.sessionThresholdAlerted = true;
  }

  if (!state.sessionCapAlerted && state.totals.totalCostUsd >= maxSession) {
    const alert: CostAlert = {
      timestamp,
      kind: "session_cap",
      scope: "session",
      costUsd: state.totals.totalCostUsd,
      thresholdUsd: maxSession,
    };
    state.alerts.push(alert);
    newAlerts.push(alert);
    state.sessionCapAlerted = true;
  }

  return newAlerts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBudget(
  value: unknown,
  fallback: SessionCostSummary["budget"],
): SessionCostSummary["budget"] {
  if (!isRecord(value)) return cloneBudget(fallback);
  const action =
    value.action === "warn" || value.action === "block_tools" ? value.action : fallback.action;
  return {
    action,
    sessionExceeded: value.sessionExceeded === true,
    blocked: value.blocked === true,
  };
}

function coerceCostUpdatePayload(
  payload: unknown,
  eventTurn: number,
): {
  usage: CostUsageInput;
  context: CostUsageContext;
  budget?: SessionCostSummary["budget"];
} | null {
  if (!isRecord(payload)) return null;
  const model = typeof payload.model === "string" ? payload.model.trim() : "";
  if (!model) return null;

  const inputTokens = normalizeNonNegativeNumber(payload.inputTokens, -1);
  const outputTokens = normalizeNonNegativeNumber(payload.outputTokens, -1);
  const cacheReadTokens = normalizeNonNegativeNumber(payload.cacheReadTokens, -1);
  const cacheWriteTokens = normalizeNonNegativeNumber(payload.cacheWriteTokens, -1);
  const totalTokens = normalizeNonNegativeNumber(payload.totalTokens, -1);
  const costUsd = normalizeNonNegativeNumber(payload.costUsd, -1);
  if (
    inputTokens < 0 ||
    outputTokens < 0 ||
    cacheReadTokens < 0 ||
    cacheWriteTokens < 0 ||
    totalTokens < 0 ||
    costUsd < 0
  ) {
    return null;
  }

  const skill =
    typeof payload.skill === "string" && payload.skill.trim().length > 0
      ? payload.skill.trim()
      : undefined;
  return {
    usage: {
      model,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens,
      costUsd,
    },
    context: {
      turn: eventTurn,
      skill,
    },
    budget: isRecord(payload.budget)
      ? parseBudget(payload.budget, createEmptyBudget("warn"))
      : undefined,
  };
}

function createEmptyBudget(action: "warn" | "block_tools"): SessionCostSummary["budget"] {
  return {
    action,
    sessionExceeded: false,
    blocked: false,
  };
}

export function createEmptyCostFoldState(
  initialAction: "warn" | "block_tools" = "warn",
): CostFoldState {
  return {
    totals: emptyTotals(),
    models: {},
    skills: {},
    tools: {},
    turnToolCalls: new Map<number, Map<string, number>>(),
    alerts: [],
    sessionThresholdAlerted: false,
    sessionCapAlerted: false,
    skillLastTurnByName: {},
    updatedAt: null,
    budget: createEmptyBudget(initialAction),
  };
}

export function cloneCostFoldState(state: CostFoldState): CostFoldState {
  return {
    totals: cloneTotals(state.totals),
    models: Object.fromEntries(
      Object.entries(state.models).map(([name, totals]) => [name, cloneTotals(totals)]),
    ),
    skills: Object.fromEntries(
      Object.entries(state.skills).map(([name, skillState]) => [
        name,
        {
          totals: cloneTotals(skillState.totals),
          usageCount: skillState.usageCount,
          turnCount: skillState.turnCount,
          lastTurnSeen: skillState.lastTurnSeen,
        },
      ]),
    ),
    tools: Object.fromEntries(
      Object.entries(state.tools).map(([name, toolState]) => [
        name,
        {
          callCount: toolState.callCount,
          allocatedTokens: toolState.allocatedTokens,
          allocatedCostUsd: toolState.allocatedCostUsd,
        },
      ]),
    ),
    turnToolCalls: new Map(
      [...state.turnToolCalls.entries()].map(([turn, toolCalls]) => [turn, new Map(toolCalls)]),
    ),
    alerts: state.alerts.map((alert) => cloneAlert(alert)),
    sessionThresholdAlerted: state.sessionThresholdAlerted,
    sessionCapAlerted: state.sessionCapAlerted,
    skillLastTurnByName: cloneCostSkillLastTurnByName(state.skillLastTurnByName),
    updatedAt: state.updatedAt,
    budget: cloneBudget(state.budget),
  };
}

export function cloneCostSummary(summary: SessionCostSummary): SessionCostSummary {
  return {
    inputTokens: summary.inputTokens,
    outputTokens: summary.outputTokens,
    cacheReadTokens: summary.cacheReadTokens,
    cacheWriteTokens: summary.cacheWriteTokens,
    totalTokens: summary.totalTokens,
    totalCostUsd: summary.totalCostUsd,
    models: Object.fromEntries(
      Object.entries(summary.models).map(([name, totals]) => [name, cloneTotals(totals)]),
    ),
    skills: Object.fromEntries(
      Object.entries(summary.skills).map(([name, skillState]) => [
        name,
        {
          ...cloneTotals(skillState),
          usageCount: skillState.usageCount,
          turns: skillState.turns,
        },
      ]),
    ),
    tools: Object.fromEntries(
      Object.entries(summary.tools).map(([name, tool]) => [
        name,
        {
          callCount: tool.callCount,
          allocatedTokens: tool.allocatedTokens,
          allocatedCostUsd: tool.allocatedCostUsd,
        },
      ]),
    ),
    alerts: summary.alerts.map((alert) => cloneAlert(alert)),
    budget: cloneBudget(summary.budget),
  };
}

export function cloneCostSkillLastTurnByName(
  input: Record<string, number>,
): Record<string, number> {
  return { ...input };
}

export function restoreCostFoldStateFromSummary(
  summary: SessionCostSummary,
  skillLastTurnByName: Record<string, number> = {},
  options: {
    sessionThresholdAlerted?: boolean;
    sessionCapAlerted?: boolean;
  } = {},
): CostFoldState {
  const state = createEmptyCostFoldState(summary.budget.action);
  state.totals = cloneTotals(summary);
  state.models = Object.fromEntries(
    Object.entries(summary.models).map(([name, totals]) => [name, cloneTotals(totals)]),
  );
  state.skills = Object.fromEntries(
    Object.entries(summary.skills).map(([name, skillState]) => {
      const rawLastTurn = skillLastTurnByName[name];
      const lastTurnSeen =
        typeof rawLastTurn === "number" && Number.isFinite(rawLastTurn)
          ? normalizeCostTurn(rawLastTurn)
          : -1;
      return [
        name,
        {
          totals: cloneTotals(skillState),
          usageCount: Math.max(0, Math.trunc(skillState.usageCount)),
          turnCount: Math.max(0, Math.trunc(skillState.turns)),
          lastTurnSeen: lastTurnSeen > 0 ? lastTurnSeen : -1,
        },
      ];
    }),
  );
  state.tools = Object.fromEntries(
    Object.entries(summary.tools).map(([name, tool]) => [
      name,
      {
        callCount: Math.max(0, Math.trunc(tool.callCount)),
        allocatedTokens: tool.allocatedTokens,
        allocatedCostUsd: tool.allocatedCostUsd,
      },
    ]),
  );
  state.alerts = summary.alerts.map((alert) => cloneAlert(alert));
  state.budget = cloneBudget(summary.budget);
  state.skillLastTurnByName = cloneCostSkillLastTurnByName(skillLastTurnByName);
  state.sessionThresholdAlerted =
    options.sessionThresholdAlerted ??
    summary.alerts.some((alert) => alert.kind === "session_threshold");
  state.sessionCapAlerted =
    options.sessionCapAlerted ?? summary.alerts.some((alert) => alert.kind === "session_cap");
  return state;
}

export function recordCostToolCall(
  state: CostFoldState,
  input: { toolName: string; turn: number },
  options: { incrementCallCount?: boolean } = {},
): void {
  const turn = normalizeCostTurn(input.turn);
  const toolName = input.toolName.trim() || "unknown_tool";
  if (options.incrementCallCount !== false) {
    const toolState = state.tools[toolName] ?? {
      callCount: 0,
      allocatedTokens: 0,
      allocatedCostUsd: 0,
    };
    toolState.callCount += 1;
    state.tools[toolName] = toolState;
  }

  const callsForTurn = state.turnToolCalls.get(turn) ?? new Map<string, number>();
  callsForTurn.set(toolName, (callsForTurn.get(toolName) ?? 0) + 1);
  state.turnToolCalls.set(turn, callsForTurn);

  if (state.turnToolCalls.size > 64) {
    const keepAfter = Math.max(0, turn - 4);
    for (const key of state.turnToolCalls.keys()) {
      if (key < keepAfter) {
        state.turnToolCalls.delete(key);
      }
    }
  }
}

export function recordCostUsage(
  state: CostFoldState,
  usage: CostUsageInput,
  context: CostUsageContext,
  config: BrewvaConfig["infrastructure"]["costTracking"],
  options: { timestamp?: number } = {},
): CostAlert[] {
  applyUsage(state, usage, context);
  const budget = computeBudgetStatus(state, config);
  state.budget = {
    action: budget.action,
    sessionExceeded: budget.sessionExceeded,
    blocked: budget.blocked,
  };
  const timestamp =
    typeof options.timestamp === "number" && Number.isFinite(options.timestamp)
      ? options.timestamp
      : Date.now();
  state.updatedAt = Math.max(state.updatedAt ?? 0, timestamp);
  return collectAlerts(state, config, timestamp);
}

export function applyCostUpdatePayload(
  state: CostFoldState,
  payload: unknown,
  timestamp: number,
  eventTurn: number,
): boolean {
  const parsed = coerceCostUpdatePayload(payload, eventTurn);
  if (!parsed) return false;
  applyUsage(state, parsed.usage, parsed.context);
  if (parsed.budget) {
    state.budget = parsed.budget;
  }
  state.updatedAt = Math.max(state.updatedAt ?? 0, timestamp);
  return true;
}

export function applyBudgetAlertPayload(
  state: CostFoldState,
  payload: unknown,
  timestamp: number,
): boolean {
  if (!isRecord(payload)) return false;
  const kind =
    payload.kind === "session_threshold" || payload.kind === "session_cap" ? payload.kind : null;
  const scope = payload.scope === "session" ? payload.scope : null;
  if (!kind || !scope) return false;

  const costUsd = normalizeNonNegativeNumber(payload.costUsd, -1);
  const thresholdUsd = normalizeNonNegativeNumber(payload.thresholdUsd, -1);
  if (costUsd < 0 || thresholdUsd < 0) return false;

  state.alerts.push({
    timestamp,
    kind,
    scope,
    costUsd,
    thresholdUsd,
  });

  const nextBudget = parseBudget(payload.budget, state.budget);
  const action =
    payload.action === "warn" || payload.action === "block_tools"
      ? payload.action
      : nextBudget.action;
  state.budget = {
    action,
    sessionExceeded: kind === "session_cap" ? true : nextBudget.sessionExceeded,
    blocked:
      action === "block_tools" && (kind === "session_cap" ? true : nextBudget.sessionExceeded),
  };
  state.updatedAt = Math.max(state.updatedAt ?? 0, timestamp);
  return true;
}

export function buildCostSummary(
  state: CostFoldState,
  options: {
    config?: BrewvaConfig["infrastructure"]["costTracking"];
  } = {},
): SessionCostSummary {
  const budget = options.config
    ? (() => {
        const status = computeBudgetStatus(state, options.config);
        return {
          action: status.action,
          sessionExceeded: status.sessionExceeded,
          blocked: status.blocked,
        };
      })()
    : cloneBudget(state.budget);

  return {
    ...cloneTotals(state.totals),
    models: Object.fromEntries(
      Object.entries(state.models).map(([name, totals]) => [name, cloneTotals(totals)]),
    ),
    skills: Object.fromEntries(
      Object.entries(state.skills).map(([name, skillState]) => [
        name,
        {
          ...cloneTotals(skillState.totals),
          usageCount: skillState.usageCount,
          turns: skillState.turnCount,
        },
      ]),
    ),
    tools: Object.fromEntries(
      Object.entries(state.tools).map(([name, tool]) => [
        name,
        {
          callCount: tool.callCount,
          allocatedTokens: Number(tool.allocatedTokens.toFixed(3)),
          allocatedCostUsd: Number(tool.allocatedCostUsd.toFixed(6)),
        },
      ]),
    ),
    alerts:
      options.config && !options.config.enabled
        ? []
        : state.alerts.map((alert) => cloneAlert(alert)),
    budget,
  };
}

export function getCostSkillTotalTokens(state: CostFoldState, skillName: string): number {
  const normalized = skillName.trim() || "(none)";
  const total = state.skills[normalized]?.totals.totalTokens ?? 0;
  return Number.isFinite(total) ? total : 0;
}

export function getCostBudgetStatus(
  state: CostFoldState,
  config: BrewvaConfig["infrastructure"]["costTracking"],
): CostBudgetStatus & { reason?: string } {
  const status = computeBudgetStatus(state, config);
  let reason: string | undefined;
  if (status.blocked && config.maxCostUsdPerSession > 0) {
    reason = `Session cost exceeded ${config.maxCostUsdPerSession.toFixed(4)} USD.`;
  }
  return {
    ...status,
    reason,
  };
}
