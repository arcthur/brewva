import { buildStringEnumSchema } from "../../../registry/string-enum-contract.js";

const BROWSER_LOAD_STATE_VALUES = ["domcontentloaded", "load", "networkidle"] as const;
const BROWSER_GET_FIELD_VALUES = ["title", "url", "text"] as const;

export const BrowserLoadStateSchema = buildStringEnumSchema(BROWSER_LOAD_STATE_VALUES, {
  recommendedValue: "networkidle",
  guidance:
    "Use networkidle by default. Use load or domcontentloaded only when the page keeps long-lived connections open.",
});

export const BrowserGetFieldSchema = buildStringEnumSchema(BROWSER_GET_FIELD_VALUES, {
  recommendedValue: "text",
  guidance:
    "Use title or url for compact page identity checks. Use text only when you need rendered content from a specific selector.",
});

type BrowserLoadState = (typeof BROWSER_LOAD_STATE_VALUES)[number];
export type BrowserGetField = (typeof BROWSER_GET_FIELD_VALUES)[number];

export function normalizeBrowserLoadState(value: unknown): BrowserLoadState | undefined {
  return value === "domcontentloaded" || value === "load" || value === "networkidle"
    ? value
    : undefined;
}

export function normalizeBrowserGetField(value: unknown): BrowserGetField {
  return value === "title" || value === "url" || value === "text" ? value : "text";
}
