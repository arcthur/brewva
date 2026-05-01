export type ContextInjectionCategory = "narrative" | "constraint" | "diagnostic";
export type ContextInjectionBudgetClass = "core" | "working" | "recall";

export const CONTEXT_SOURCES = {
  identity: "brewva.identity",
  agentConstitution: "brewva.agent-constitution",
  agentMemory: "brewva.agent-memory",
  recallBroker: "brewva.recall-broker",
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
