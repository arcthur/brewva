import {
  detectTerminalCapabilities,
  type TerminalCapabilityDetectionInput,
} from "@brewva/brewva-tui";

export type CliResolvedMode = "interactive" | "print-text" | "print-json";

export const INTERACTIVE_SHELL_UNSUPPORTED_TERMINAL_MESSAGE =
  "Error: interactive shell requires a full-screen terminal (stdin/stdout must be TTY and TERM must not be dumb). Use --print or --mode json.";

interface ResolveEffectiveCliModeInput {
  requestedMode: CliResolvedMode;
  modeExplicit: boolean;
  initialMessage?: string;
  capabilitiesInput?: TerminalCapabilityDetectionInput;
}

export function resolveEffectiveCliMode(
  input: ResolveEffectiveCliModeInput,
): { mode: CliResolvedMode } | { error: string } {
  if (input.requestedMode !== "interactive") {
    return { mode: input.requestedMode };
  }

  const ttyAttached =
    input.capabilitiesInput?.stdin?.isTTY === true &&
    input.capabilitiesInput?.stdout?.isTTY === true;
  const capabilities = detectTerminalCapabilities(input.capabilitiesInput);
  if (capabilities.fullScreen) {
    return { mode: "interactive" };
  }

  if (!ttyAttached) {
    if (input.modeExplicit) {
      return {
        error: "Error: interactive mode requires a TTY terminal.",
      };
    }
    return { mode: "print-text" };
  }

  const hasInitialMessage =
    typeof input.initialMessage === "string" && input.initialMessage.trim().length > 0;
  if (!input.modeExplicit && hasInitialMessage) {
    return { mode: "print-text" };
  }

  return {
    error: INTERACTIVE_SHELL_UNSUPPORTED_TERMINAL_MESSAGE,
  };
}
