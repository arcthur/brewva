import { describe, expect, test } from "bun:test";
import { detectTerminalCapabilities } from "@brewva/brewva-tui";

describe("tui capability detection", () => {
  test("downgrades dumb terminals away from full-screen rendering", () => {
    const capabilities = detectTerminalCapabilities({
      env: {
        TERM: "dumb",
      },
      stdout: {
        isTTY: false,
      },
      stdin: {
        isTTY: false,
      },
    });

    expect(capabilities.interactive).toBe(false);
    expect(capabilities.fullScreen).toBe(false);
    expect(capabilities.colorLevel).toBe("none");
    expect(capabilities.kittyGraphics).toBe(false);
    expect(capabilities.sixel).toBe(false);
  });

  test("enables full-screen features for interactive terminals", () => {
    const capabilities = detectTerminalCapabilities({
      env: {
        TERM: "xterm-256color",
      },
      stdout: {
        isTTY: true,
        columns: 120,
        rows: 40,
        getColorDepth: () => 24,
      },
      stdin: {
        isTTY: true,
      },
    });

    expect(capabilities.interactive).toBe(true);
    expect(capabilities.fullScreen).toBe(true);
    expect(capabilities.bracketedPaste).toBe(true);
    expect(capabilities.colorLevel).toBe("truecolor");
    expect(capabilities.kittyGraphics).toBe(false);
    expect(capabilities.sixel).toBe(false);
  });
});
