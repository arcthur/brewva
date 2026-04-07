export type ContextInjectionCategory = "narrative" | "constraint" | "diagnostic";
export type ContextInjectionBudgetClass = "core" | "working" | "recall";

export const CONTEXT_SOURCES = {
  identity: "brewva.identity",
  agentConstitution: "brewva.agent-constitution",
  agentMemory: "brewva.agent-memory",
  narrativeMemory: "brewva.narrative-memory",
  deliberationMemory: "brewva.deliberation-memory",
  optimizationContinuity: "brewva.optimization-continuity",
  skillPromotionDrafts: "brewva.skill-promotion-drafts",
  skillRouting: "brewva.skill-routing",
  runtimeStatus: "brewva.runtime-status",
  taskState: "brewva.task-state",
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
  [CONTEXT_SOURCES.runtimeStatus]: "narrative",
  [CONTEXT_SOURCES.taskState]: "narrative",
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
  [CONTEXT_SOURCES.runtimeStatus]: "core",
  [CONTEXT_SOURCES.taskState]: "core",
  [CONTEXT_SOURCES.toolOutputsDistilled]: "working",
  [CONTEXT_SOURCES.projectionWorking]: "working",
};
