export type ContextInjectionCategory = "narrative" | "constraint" | "diagnostic";
export type ContextInjectionBudgetClass = "core" | "working" | "recall";

const HISTORY_VIEW_BASELINE_RESERVED_BUDGET_RATIO = 0.3;

export const CONTEXT_SOURCES = {
  identity: "brewva.identity",
  agentConstitution: "brewva.agent-constitution",
  agentMemory: "brewva.agent-memory",
  narrativeMemory: "brewva.narrative-memory",
  deliberationMemory: "brewva.deliberation-memory",
  optimizationContinuity: "brewva.optimization-continuity",
  skillPromotionDrafts: "brewva.skill-promotion-drafts",
  skillRouting: "brewva.skill-routing",
  historyViewBaseline: "brewva.history-view-baseline",
  runtimeStatus: "brewva.runtime-status",
  taskState: "brewva.task-state",
  recoveryWorkingSet: "brewva.recovery-working-set",
  toolOutputsDistilled: "brewva.tool-outputs-distilled",
  projectionWorking: "brewva.projection-working",
} as const;

export type ContextSourceId = (typeof CONTEXT_SOURCES)[keyof typeof CONTEXT_SOURCES];

export const CONTEXT_SOURCE_CATEGORIES: Record<ContextSourceId, ContextInjectionCategory> = {
  [CONTEXT_SOURCES.identity]: "narrative",
  [CONTEXT_SOURCES.agentConstitution]: "narrative",
  [CONTEXT_SOURCES.agentMemory]: "narrative",
  [CONTEXT_SOURCES.narrativeMemory]: "narrative",
  [CONTEXT_SOURCES.deliberationMemory]: "narrative",
  [CONTEXT_SOURCES.optimizationContinuity]: "narrative",
  [CONTEXT_SOURCES.skillPromotionDrafts]: "narrative",
  [CONTEXT_SOURCES.skillRouting]: "narrative",
  [CONTEXT_SOURCES.historyViewBaseline]: "narrative",
  [CONTEXT_SOURCES.runtimeStatus]: "narrative",
  [CONTEXT_SOURCES.taskState]: "narrative",
  [CONTEXT_SOURCES.recoveryWorkingSet]: "constraint",
  [CONTEXT_SOURCES.toolOutputsDistilled]: "narrative",
  [CONTEXT_SOURCES.projectionWorking]: "narrative",
};

export const CONTEXT_SOURCE_BUDGET_CLASSES: Record<ContextSourceId, ContextInjectionBudgetClass> = {
  [CONTEXT_SOURCES.identity]: "core",
  [CONTEXT_SOURCES.agentConstitution]: "core",
  [CONTEXT_SOURCES.agentMemory]: "core",
  [CONTEXT_SOURCES.narrativeMemory]: "recall",
  [CONTEXT_SOURCES.deliberationMemory]: "recall",
  [CONTEXT_SOURCES.optimizationContinuity]: "recall",
  [CONTEXT_SOURCES.skillPromotionDrafts]: "recall",
  [CONTEXT_SOURCES.skillRouting]: "recall",
  [CONTEXT_SOURCES.historyViewBaseline]: "core",
  [CONTEXT_SOURCES.runtimeStatus]: "core",
  [CONTEXT_SOURCES.taskState]: "core",
  [CONTEXT_SOURCES.recoveryWorkingSet]: "working",
  [CONTEXT_SOURCES.toolOutputsDistilled]: "working",
  [CONTEXT_SOURCES.projectionWorking]: "working",
};

export const CONTEXT_SOURCE_RESERVED_BUDGET_RATIOS: Partial<Record<ContextSourceId, number>> = {
  [CONTEXT_SOURCES.historyViewBaseline]: HISTORY_VIEW_BASELINE_RESERVED_BUDGET_RATIO,
};

export const NON_TRUNCATABLE_CONTEXT_SOURCES = new Set<ContextSourceId>([
  CONTEXT_SOURCES.historyViewBaseline,
]);

export function getContextSourceReservedBudgetRatio(source: string): number | null {
  const ratio = CONTEXT_SOURCE_RESERVED_BUDGET_RATIOS[source as ContextSourceId] ?? null;
  if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) {
    return null;
  }
  return ratio;
}

export function resolveReservedContextSourceBudget(
  source: string,
  totalTokenBudget: number,
): number | null {
  const ratio = getContextSourceReservedBudgetRatio(source);
  if (ratio === null) {
    return null;
  }
  const total = Math.max(0, Math.floor(totalTokenBudget));
  if (total <= 0) {
    return 0;
  }
  return Math.max(1, Math.floor(total * ratio));
}

export function isNonTruncatableContextSource(source: string): boolean {
  return NON_TRUNCATABLE_CONTEXT_SOURCES.has(source as ContextSourceId);
}
