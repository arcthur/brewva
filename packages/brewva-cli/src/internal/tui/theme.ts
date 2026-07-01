export interface TuiTheme {
  name: string;
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
}

export interface TuiThemeEntry {
  name: string;
}

export type TuiThemeAppearance = "dark" | "light";

function freezeTheme(theme: TuiTheme): Readonly<TuiTheme> {
  return Object.freeze({ ...theme });
}

const TUI_THEME_REGISTRY = {
  graphite: freezeTheme({
    name: "graphite",
    backgroundApp: "#0b1020",
    backgroundPanel: "#11182b",
    backgroundElement: "#182235",
    backgroundOverlay: "#0d1424",
    text: "#e5edf7",
    textMuted: "#93a4bc",
    textDim: "#64748b",
    accent: "#5bc0eb",
    accentSoft: "#1f4b63",
    warning: "#f6ad55",
    error: "#f87171",
    success: "#4ade80",
    border: "#31415f",
    borderActive: "#5bc0eb",
    borderSubtle: "#22304a",
    selectionBg: "#5bc0eb",
    selectionText: "#08111f",
  }),
  paper: freezeTheme({
    name: "paper",
    backgroundApp: "#f4f1e8",
    backgroundPanel: "#fbf8ef",
    backgroundElement: "#ffffff",
    backgroundOverlay: "#efe7d6",
    text: "#1f2937",
    textMuted: "#526072",
    textDim: "#7b8697",
    accent: "#0f766e",
    accentSoft: "#d7eeeb",
    warning: "#b45309",
    error: "#b91c1c",
    success: "#15803d",
    border: "#b8c3cf",
    borderActive: "#0f766e",
    borderSubtle: "#d9dee5",
    selectionBg: "#0f766e",
    selectionText: "#f8fafc",
  }),
} as const satisfies Record<string, Readonly<TuiTheme>>;

const TUI_THEME_KEYS = [
  "name",
  "backgroundApp",
  "backgroundPanel",
  "backgroundElement",
  "backgroundOverlay",
  "text",
  "textMuted",
  "textDim",
  "accent",
  "accentSoft",
  "warning",
  "error",
  "success",
  "border",
  "borderActive",
  "borderSubtle",
  "selectionBg",
  "selectionText",
] as const satisfies readonly (keyof TuiTheme)[];

function isTuiThemeDescriptor(value: unknown): value is TuiTheme {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  return TUI_THEME_KEYS.every((key) => typeof (value as Record<string, unknown>)[key] === "string");
}

export type TuiThemeName = keyof typeof TUI_THEME_REGISTRY;

export const DEFAULT_TUI_THEME = TUI_THEME_REGISTRY.graphite;

export function getTuiTheme(name: string): Readonly<TuiTheme> | undefined {
  return TUI_THEME_REGISTRY[name as TuiThemeName];
}

export function resolveAutomaticTuiTheme(appearance: TuiThemeAppearance): Readonly<TuiTheme> {
  return appearance === "light" ? TUI_THEME_REGISTRY.paper : DEFAULT_TUI_THEME;
}

export function listTuiThemes(): TuiThemeEntry[] {
  return Object.keys(TUI_THEME_REGISTRY)
    .toSorted((left, right) => left.localeCompare(right))
    .map((name) => ({ name }));
}

export function resolveTuiTheme(theme: string | TuiTheme): TuiTheme | undefined {
  if (typeof theme === "string") {
    return getTuiTheme(theme);
  }
  if (!isTuiThemeDescriptor(theme)) {
    return undefined;
  }
  return { ...theme };
}

/**
 * Resolve the theme to apply at boot. A persisted user selection wins over the
 * config-driven / auto-resolved boot theme; `"default"` (or an unresolvable
 * name) yields `undefined` so the caller falls back to {@link DEFAULT_TUI_THEME}.
 * Kept pure so the precedence is unit-testable without a renderer, and so the
 * boot application stays persist-free (unlike the user-initiated setter).
 */
export function resolveBootTheme(input: {
  persistedName: string | undefined;
  bootName: string | undefined;
}): TuiTheme | undefined {
  // A persisted "auto" is not a concrete theme — fall through to the boot name
  // (the renderer already auto-detected a concrete light/dark theme) so it keeps
  // tracking the terminal rather than freezing on DEFAULT.
  const effectiveName =
    input.persistedName && input.persistedName !== "auto" ? input.persistedName : input.bootName;
  if (!effectiveName || effectiveName === "default") {
    return undefined;
  }
  return resolveTuiTheme(effectiveName);
}
