import { describe, expect, test } from "bun:test";

describe("tui entrypoint surface", () => {
  test("exports terminal substrate primitives without Brewva session semantics", async () => {
    const tui = await import("../../../../packages/brewva-cli/src/internal/tui/index.js");

    expect(typeof tui.detectTerminalCapabilities).toBe("function");
    expect(typeof tui.FrameScheduler).toBe("function");
    expect(typeof tui.FocusManager).toBe("function");
    expect(typeof tui.OverlayManager).toBe("function");
    expect(typeof tui.createKeybindingResolver).toBe("function");
    expect(typeof tui.createHeadlessTerminalHarness).toBe("function");
    expect("createHostedSession" in tui).toBe(false);
    expect("createBrewvaSession" in tui).toBe(false);
  });
});
