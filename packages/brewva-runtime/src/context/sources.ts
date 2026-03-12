export type ContextInjectionCategory = "narrative" | "constraint" | "diagnostic";

export const CONTEXT_SOURCES = {
  identity: "brewva.identity",
  runtimeStatus: "brewva.runtime-status",
  skillCandidates: "brewva.skill-candidates",
  skillCascadeGate: "brewva.skill-cascade-gate",
  contextPackets: "brewva.context-packets",
  taskState: "brewva.task-state",
  toolOutputsDistilled: "brewva.tool-outputs-distilled",
  projectionWorking: "brewva.projection-working",
} as const;

export type ContextSourceId = (typeof CONTEXT_SOURCES)[keyof typeof CONTEXT_SOURCES];

export const CONTEXT_SOURCE_CATEGORIES: Record<ContextSourceId, ContextInjectionCategory> = {
  [CONTEXT_SOURCES.identity]: "narrative",
  [CONTEXT_SOURCES.runtimeStatus]: "narrative",
  [CONTEXT_SOURCES.skillCandidates]: "narrative",
  [CONTEXT_SOURCES.skillCascadeGate]: "constraint",
  [CONTEXT_SOURCES.contextPackets]: "narrative",
  [CONTEXT_SOURCES.taskState]: "narrative",
  [CONTEXT_SOURCES.toolOutputsDistilled]: "narrative",
  [CONTEXT_SOURCES.projectionWorking]: "narrative",
};
