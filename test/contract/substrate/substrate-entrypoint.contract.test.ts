import { describe, expect, test } from "bun:test";

describe("substrate entrypoint surface", () => {
  test("exports contract-first C2 substrate primitives from the root entrypoint", async () => {
    const substrate = await import("@brewva/brewva-substrate");

    expect(substrate.SESSION_PHASE_KINDS).toContain("model_streaming");
    expect(substrate.SESSION_CRASH_POINTS).toContain("tool_executing");
    expect(substrate.SESSION_TERMINATION_REASONS).toContain("host_closed");
    expect(typeof substrate.isSessionPhaseActive).toBe("function");
    expect(typeof substrate.canResumeSessionPhase).toBe("function");
    expect(typeof substrate.resolveShellConfig).toBe("function");
    expect(typeof substrate.createInMemorySessionHost).toBe("function");
    expect(substrate.DEFAULT_CONTEXT_STATE.budgetPressure).toBe("none");
    expect(typeof substrate.createBrewvaHostPluginRunner).toBe("function");
  });
});
