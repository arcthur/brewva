export const TOOL_EXECUTION_PHASES = [
  "classify",
  "authorize",
  "prepare",
  "execute",
  "record",
  "cleanup",
] as const;

export type ToolExecutionPhase = (typeof TOOL_EXECUTION_PHASES)[number];

export function advanceToolExecutionPhase(current: ToolExecutionPhase): ToolExecutionPhase {
  const index = TOOL_EXECUTION_PHASES.indexOf(current);
  if (index === -1) {
    throw new Error(`unknown tool execution phase: ${current}`);
  }
  if (index === TOOL_EXECUTION_PHASES.length - 1) {
    throw new Error("tool execution is already terminal");
  }
  const next = TOOL_EXECUTION_PHASES[index + 1];
  if (!next) {
    throw new Error("tool execution is already terminal");
  }
  return next;
}

export function isToolExecutionPhaseTerminal(phase: ToolExecutionPhase): boolean {
  return phase === "cleanup";
}
