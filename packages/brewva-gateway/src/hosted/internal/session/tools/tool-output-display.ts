import {
  outcomeIsError,
  outcomeVerdict,
  type BrewvaOutcome,
} from "@brewva/brewva-vocabulary/outcome";
import type { ToolOutputDisplayView } from "@brewva/brewva-vocabulary/wire";
import { distillToolOutput } from "./tool-output-distiller.js";

export type ToolDisplayVerdict = "pass" | "fail" | "inconclusive";

export interface ResolveToolDisplayTextInput {
  toolName: string;
  isError: boolean;
  result: unknown;
}

export interface ResolvedToolDisplay {
  text: string;
  display?: ToolOutputDisplayView;
}

const SUMMARY_CHAR_LIMIT = 1_200;

function extractResultOutcome(result: unknown): BrewvaOutcome | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const outcome = (result as { outcome?: unknown }).outcome;
  if (!outcome || typeof outcome !== "object" || Array.isArray(outcome)) {
    return undefined;
  }
  const record = outcome as Record<string, unknown>;
  if (record.kind === "ok") {
    return { kind: "ok", value: record.value ?? null };
  }
  if (record.kind === "err") {
    return { kind: "err", error: record.error ?? null };
  }
  if (record.kind === "inconclusive") {
    return {
      kind: "inconclusive",
      ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
      ...(record.value !== undefined ? { value: record.value } : {}),
    };
  }
  return undefined;
}

function extractExplicitDisplay(result: unknown): ToolOutputDisplayView | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return undefined;
  }
  const display = (result as { display?: unknown }).display;
  if (!display || typeof display !== "object" || Array.isArray(display)) {
    return undefined;
  }
  const record = display as Record<string, unknown>;
  const summaryText =
    typeof record.summaryText === "string" && record.summaryText.trim().length > 0
      ? record.summaryText
      : undefined;
  const detailsText =
    typeof record.detailsText === "string" && record.detailsText.trim().length > 0
      ? record.detailsText
      : undefined;
  const rawText =
    typeof record.rawText === "string" && record.rawText.trim().length > 0
      ? record.rawText
      : undefined;
  const normalized: ToolOutputDisplayView = {};
  if (summaryText) {
    normalized.summaryText = summaryText;
  }
  if (detailsText) {
    normalized.detailsText = detailsText;
  }
  if (rawText) {
    normalized.rawText = rawText;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function readShortRawSummary(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return "";
  }
  const lines = trimmed.split(/\r?\n/u);
  if (lines.length > 4 || trimmed.length > SUMMARY_CHAR_LIMIT) {
    return "";
  }
  return trimmed;
}

export function resolveToolDisplayVerdict(input: {
  isError: boolean;
  result: unknown;
}): ToolDisplayVerdict {
  const outcome = extractResultOutcome(input.result);
  if (outcome) return outcomeVerdict(outcome);
  return input.isError ? "fail" : "pass";
}

export function resolveToolDisplayStatus(input: {
  isError: boolean;
  result: unknown;
}): "completed" | "failed" | "inconclusive" {
  const verdict = resolveToolDisplayVerdict(input);
  if (verdict === "fail") return "failed";
  if (verdict === "inconclusive") return "inconclusive";
  return "completed";
}

export function extractToolResultText(result: unknown): string {
  if (typeof result === "string") {
    return result.trim();
  }
  if (!result || typeof result !== "object") {
    return "";
  }

  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const text = (item as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) {
        texts.push(text.trim());
      }
    }
    if (texts.length > 0) {
      return texts.join("\n");
    }
  }

  try {
    const serialized = JSON.stringify(result);
    return serialized && serialized !== "{}" ? serialized : "";
  } catch {
    return "";
  }
}

export function resolveToolDisplay(input: ResolveToolDisplayTextInput): ResolvedToolDisplay {
  const rawText = extractToolResultText(input.result);
  const outcome = extractResultOutcome(input.result);
  const isError = outcome ? outcomeIsError(outcome) : input.isError;
  const verdict = resolveToolDisplayVerdict({
    isError,
    result: input.result,
  });
  const distillation = distillToolOutput({
    toolName: input.toolName,
    isError,
    verdict,
    outputText: rawText,
  });
  const explicitDisplay = extractExplicitDisplay(input.result);
  const distilledSummary =
    distillation.distillationApplied && distillation.summaryText.trim()
      ? distillation.summaryText.trim()
      : undefined;
  const text = distilledSummary ?? rawText;
  const summaryText =
    explicitDisplay?.summaryText ?? distilledSummary ?? readShortRawSummary(rawText);
  const detailsText = explicitDisplay?.detailsText ?? rawText;
  const rawDisplayText = explicitDisplay?.rawText ?? rawText;
  const display: ToolOutputDisplayView = {};
  if (summaryText.trim().length > 0) {
    display.summaryText = summaryText;
  }
  if (detailsText.trim().length > 0) {
    display.detailsText = detailsText;
  }
  if (rawDisplayText.trim().length > 0) {
    display.rawText = rawDisplayText;
  }
  return {
    text,
    ...(Object.keys(display).length > 0 ? { display } : {}),
  };
}
