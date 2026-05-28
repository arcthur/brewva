import type { BrewvaTuiScrollAcceleration } from "../../src/shell/domain/tui.js";
import { SyntaxStyle, type ScrollAcceleration } from "../opentui/index.js";

export const SPLIT_BORDER_CHARS = {
  topLeft: "",
  bottomLeft: "",
  vertical: "┃",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
} as const;

export class FixedScrollAcceleration implements ScrollAcceleration {
  constructor(private readonly speed: number) {}

  tick(): number {
    return this.speed;
  }

  reset(): void {}
}

class ExponentialScrollAcceleration implements ScrollAcceleration {
  #current: number;

  constructor(private readonly speed: number) {
    this.#current = speed;
  }

  tick(): number {
    const value = this.#current;
    this.#current = Math.min(this.speed * 8, this.#current * 1.35);
    return value;
  }

  reset(): void {
    this.#current = this.speed;
  }
}

export function createScrollAcceleration(
  config: BrewvaTuiScrollAcceleration | undefined,
): ScrollAcceleration {
  const speed = Math.max(1, config?.speed ?? 3);
  return config?.type === "exponential"
    ? new ExponentialScrollAcceleration(speed)
    : new FixedScrollAcceleration(speed);
}

export interface SessionPalette {
  readonly background: string;
  readonly backgroundPanel: string;
  readonly backgroundElement: string;
  readonly backgroundOverlay: string;
  readonly backgroundMenu: string;
  readonly text: string;
  readonly textMuted: string;
  readonly textDim: string;
  readonly accent: string;
  readonly accentSoft: string;
  readonly warning: string;
  readonly error: string;
  readonly success: string;
  readonly border: string;
  readonly borderActive: string;
  readonly borderSubtle: string;
  readonly selectionBg: string;
  readonly selectionText: string;
  readonly markdownText: string;
  readonly primary: string;
  readonly secondary: string;
  readonly diffAdded: string;
  readonly diffRemoved: string;
  readonly diffAddedBg: string;
  readonly diffRemovedBg: string;
  readonly diffContextBg: string;
  readonly diffHighlightAdded: string;
  readonly diffHighlightRemoved: string;
  readonly diffLineNumber: string;
  readonly diffAddedLineNumberBg: string;
  readonly diffRemovedLineNumberBg: string;
}

export function createPalette(theme: {
  backgroundApp: string;
  backgroundPanel: string;
  backgroundElement: string;
  backgroundOverlay: string;
  text: string;
  textMuted: string;
  textDim: string;
  accent: string;
  accentSoft: string;
  warning: string;
  error: string;
  success: string;
  border: string;
  borderActive: string;
  borderSubtle: string;
  selectionBg: string;
  selectionText: string;
}): SessionPalette {
  return {
    background: theme.backgroundApp,
    backgroundPanel: theme.backgroundPanel,
    backgroundElement: theme.backgroundElement,
    backgroundOverlay: theme.backgroundOverlay,
    backgroundMenu: theme.backgroundElement,
    text: theme.text,
    textMuted: theme.textMuted,
    textDim: theme.textDim,
    accent: theme.accent,
    accentSoft: theme.accentSoft,
    warning: theme.warning,
    error: theme.error,
    success: theme.success,
    border: theme.border,
    borderActive: theme.borderActive,
    borderSubtle: theme.borderSubtle,
    selectionBg: theme.selectionBg,
    selectionText: theme.selectionText,
    markdownText: theme.text,
    primary: theme.accent,
    secondary: theme.textMuted,
    diffAdded: theme.success,
    diffRemoved: theme.error,
    diffAddedBg: theme.accentSoft,
    diffRemovedBg: theme.backgroundOverlay,
    diffContextBg: theme.backgroundPanel,
    diffHighlightAdded: theme.success,
    diffHighlightRemoved: theme.error,
    diffLineNumber: theme.textMuted,
    diffAddedLineNumberBg: theme.accentSoft,
    diffRemovedLineNumberBg: theme.backgroundOverlay,
  };
}

export function getTranscriptSyntaxStyle(theme: SessionPalette): SyntaxStyle {
  return SyntaxStyle.fromTheme([
    { scope: ["default", "spell", "nospell"], style: { foreground: theme.text } },
    { scope: ["conceal"], style: { foreground: theme.textDim } },
    { scope: ["label"], style: { foreground: theme.textMuted } },
    { scope: ["comment", "markup.quote"], style: { foreground: theme.textDim, italic: true } },
    {
      scope: ["punctuation.special", "punctuation.delimiter"],
      style: { foreground: theme.textDim },
    },
    { scope: ["string", "markup.raw.inline"], style: { foreground: theme.success } },
    { scope: ["keyword", "storage.type"], style: { foreground: theme.accent } },
    { scope: ["markup.heading"], style: { foreground: theme.accent, bold: true } },
    { scope: ["markup.heading.1"], style: { foreground: theme.accent, bold: true } },
    { scope: ["markup.heading.2"], style: { foreground: theme.accent, bold: true } },
    { scope: ["markup.heading.3"], style: { foreground: theme.accent, bold: true } },
    { scope: ["markup.heading.4"], style: { foreground: theme.accent, bold: true } },
    { scope: ["markup.heading.5"], style: { foreground: theme.accent, bold: true } },
    { scope: ["markup.heading.6"], style: { foreground: theme.accent, bold: true } },
    { scope: ["markup.bold", "markup.strong"], style: { foreground: theme.text, bold: true } },
    { scope: ["markup.italic"], style: { foreground: theme.textMuted, italic: true } },
    { scope: ["markup.list"], style: { foreground: theme.accent } },
    { scope: ["markup.raw", "markup.raw.block"], style: { foreground: theme.success } },
    {
      scope: ["markup.link", "markup.link.label", "markup.link.url"],
      style: { foreground: theme.accent, underline: true },
    },
  ]);
}

export function getReasoningSyntaxStyle(theme: SessionPalette): SyntaxStyle {
  return SyntaxStyle.fromTheme([
    { scope: ["comment", "markup.quote"], style: { foreground: theme.textDim, italic: true } },
    { scope: ["string", "markup.raw.inline"], style: { foreground: theme.textMuted } },
    { scope: ["markup.bold"], style: { foreground: theme.textMuted, bold: true } },
  ]);
}
