export type TerminalColorLevel = "none" | "ansi16" | "ansi256" | "truecolor";

export interface TerminalCapabilityProfile {
  interactive: boolean;
  fullScreen: boolean;
  alternateScreen: boolean;
  bracketedPaste: boolean;
  unicode: boolean;
  kittyGraphics: boolean;
  sixel: boolean;
  colorLevel: TerminalColorLevel;
  columns: number;
  rows: number;
}

export interface TerminalCapabilityDetectionInput {
  env?: NodeJS.ProcessEnv;
  stdin?: {
    isTTY?: boolean;
  };
  stdout?: {
    isTTY?: boolean;
    columns?: number;
    rows?: number;
    getColorDepth?: () => number;
  };
}

function detectColorLevel(depth: number | undefined): TerminalColorLevel {
  if (typeof depth !== "number" || !Number.isFinite(depth) || depth <= 1) {
    return "none";
  }
  if (depth >= 24) {
    return "truecolor";
  }
  if (depth >= 8) {
    return "ansi256";
  }
  return "ansi16";
}

export function detectTerminalCapabilities(
  input: TerminalCapabilityDetectionInput = {},
): TerminalCapabilityProfile {
  const env = input.env ?? process.env;
  const term = env.TERM?.trim().toLowerCase() ?? "";
  const stdout = input.stdout;
  const stdin = input.stdin;
  const stdoutIsTTY = stdout?.isTTY === true;
  const stdinIsTTY = stdin?.isTTY === true;
  const interactive = stdoutIsTTY && stdinIsTTY && term !== "dumb";

  return {
    interactive,
    fullScreen: interactive,
    alternateScreen: interactive,
    bracketedPaste: interactive,
    unicode: term.length > 0 && term !== "dumb",
    // TODO(answer-presentation-policy-and-tui-diagram-rendering): detect these
    // only through the @brewva/brewva-tui capability boundary before graphics.
    kittyGraphics: false,
    sixel: false,
    colorLevel: interactive ? detectColorLevel(stdout?.getColorDepth?.()) : "none",
    columns: stdout?.columns && stdout.columns > 0 ? stdout.columns : 80,
    rows: stdout?.rows && stdout.rows > 0 ? stdout.rows : 24,
  };
}
