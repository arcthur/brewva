import { describe, expect, test } from "bun:test";
import {
  INTERACTIVE_SHELL_UNSUPPORTED_TERMINAL_MESSAGE,
  resolveEffectiveCliMode,
} from "../../../packages/brewva-cli/src/interactive-mode.js";

describe("cli interactive mode resolution", () => {
  test("falls back to print-text when interactive mode is implicit and stdin/stdout are not TTYs", () => {
    const result = resolveEffectiveCliMode({
      requestedMode: "interactive",
      modeExplicit: false,
      capabilitiesInput: {
        env: { TERM: "xterm-256color" },
        stdin: { isTTY: false },
        stdout: { isTTY: false },
      },
    });

    expect(result).toEqual({ mode: "print-text" });
  });

  test("rejects explicit interactive mode when stdin/stdout are not TTYs", () => {
    const result = resolveEffectiveCliMode({
      requestedMode: "interactive",
      modeExplicit: true,
      capabilitiesInput: {
        env: { TERM: "xterm-256color" },
        stdin: { isTTY: false },
        stdout: { isTTY: false },
      },
    });

    expect(result).toEqual({
      error: "Error: interactive mode requires a TTY terminal.",
    });
  });

  test("falls back to print-text for low-capability terminals when a prompt is available", () => {
    const result = resolveEffectiveCliMode({
      requestedMode: "interactive",
      modeExplicit: false,
      initialMessage: "summarize this diff",
      capabilitiesInput: {
        env: { TERM: "dumb" },
        stdin: { isTTY: true },
        stdout: { isTTY: true, columns: 120, rows: 40, getColorDepth: () => 24 },
      },
    });

    expect(result).toEqual({ mode: "print-text" });
  });

  test("rejects implicit interactive mode on low-capability terminals when no print fallback input exists", () => {
    const result = resolveEffectiveCliMode({
      requestedMode: "interactive",
      modeExplicit: false,
      capabilitiesInput: {
        env: { TERM: "dumb" },
        stdin: { isTTY: true },
        stdout: { isTTY: true, columns: 120, rows: 40, getColorDepth: () => 24 },
      },
    });

    expect(result).toEqual({
      error: INTERACTIVE_SHELL_UNSUPPORTED_TERMINAL_MESSAGE,
    });
  });

  test("keeps interactive mode for full-screen capable terminals", () => {
    const result = resolveEffectiveCliMode({
      requestedMode: "interactive",
      modeExplicit: false,
      capabilitiesInput: {
        env: { TERM: "xterm-256color" },
        stdin: { isTTY: true },
        stdout: { isTTY: true, columns: 120, rows: 40, getColorDepth: () => 24 },
      },
    });

    expect(result).toEqual({ mode: "interactive" });
  });
});
