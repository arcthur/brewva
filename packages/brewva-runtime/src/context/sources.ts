export const CONTEXT_SOURCES = {
  identity: "brewva.identity",
  truthStatic: "brewva.truth-static",
  truthFacts: "brewva.truth-facts",
  skillCandidates: "brewva.skill-candidates",
  skillDispatchGate: "brewva.skill-dispatch-gate",
  skillCascadeGate: "brewva.skill-cascade-gate",
  taskState: "brewva.task-state",
  toolFailures: "brewva.tool-failures",
  toolOutputsDistilled: "brewva.tool-outputs-distilled",
  memoryWorking: "brewva.memory-working",
} as const;

export type ContextSourceId = (typeof CONTEXT_SOURCES)[keyof typeof CONTEXT_SOURCES];
