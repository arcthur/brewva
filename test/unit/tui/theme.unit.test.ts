import { describe, expect, test } from "bun:test";
import {
  DEFAULT_TUI_THEME,
  getTuiTheme,
  listTuiThemes,
  resolveAutomaticTuiTheme,
  resolveTuiTheme,
} from "../../../packages/brewva-tui/src/theme.js";

describe("tui theme", () => {
  test("exposes a semantic shell theme instead of legacy foreground/background tokens", () => {
    expect(DEFAULT_TUI_THEME).toEqual({
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
    });
  });

  test("provides a named theme registry and resolves both names and descriptors", () => {
    expect(listTuiThemes()).toEqual([{ name: "graphite" }, { name: "paper" }]);
    expect(getTuiTheme("graphite")).toEqual(DEFAULT_TUI_THEME);
    expect(getTuiTheme("paper")).toEqual({
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
    });

    const customTheme = {
      ...DEFAULT_TUI_THEME,
      name: "custom",
      accent: "#7dd3fc",
      borderActive: "#7dd3fc",
    };
    expect(resolveTuiTheme("graphite")).toEqual(DEFAULT_TUI_THEME);
    expect(resolveTuiTheme(customTheme)).toEqual(customTheme);
    expect(resolveTuiTheme("missing-theme")).toBe(undefined);
  });

  test("selects an automatic theme from the terminal background mode", () => {
    const paperTheme = getTuiTheme("paper");

    if (!paperTheme) {
      throw new Error("paper theme should exist");
    }
    expect(resolveAutomaticTuiTheme("dark")).toEqual(DEFAULT_TUI_THEME);
    expect(resolveAutomaticTuiTheme("light")).toEqual(paperTheme);
  });
});
