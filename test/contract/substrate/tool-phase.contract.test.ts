import { describe, expect, test } from "bun:test";
import {
  TOOL_EXECUTION_PHASES,
  advanceToolExecutionPhase,
  isToolExecutionPhaseTerminal,
  type ToolExecutionPhase,
} from "@brewva/brewva-substrate";

describe("substrate tool execution phase contract", () => {
  test("encodes the fixed C2 execution phase order", () => {
    expect(TOOL_EXECUTION_PHASES).toEqual([
      "classify",
      "authorize",
      "prepare",
      "execute",
      "record",
      "cleanup",
    ]);
  });

  test("advances through the fixed phase order and terminates after cleanup", () => {
    let phase: ToolExecutionPhase = TOOL_EXECUTION_PHASES[0];
    for (const next of TOOL_EXECUTION_PHASES.slice(1)) {
      phase = advanceToolExecutionPhase(phase);
      expect(phase).toBe(next);
    }

    expect(isToolExecutionPhaseTerminal(phase)).toBe(true);
    expect(() => advanceToolExecutionPhase(phase)).toThrow("tool execution is already terminal");
  });
});
