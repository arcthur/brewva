export const CONTEXT_SOURCES = {
  identity: "brewva.identity",
  truthStatic: "brewva.truth-static",
  truthFacts: "brewva.truth-facts",
  skillCandidates: "brewva.skill-candidates",
  skillDispatchGate: "brewva.skill-dispatch-gate",
  taskState: "brewva.task-state",
  toolFailures: "brewva.tool-failures",
  memoryWorking: "brewva.memory-working",
  memoryRecall: "brewva.memory-recall",
  ragExternal: "brewva.rag-external",
} as const;

export type ContextSourceId = (typeof CONTEXT_SOURCES)[keyof typeof CONTEXT_SOURCES];

export const DROP_RECALL_DEGRADABLE_SOURCES = [
  CONTEXT_SOURCES.memoryRecall,
  CONTEXT_SOURCES.ragExternal,
] as const;
