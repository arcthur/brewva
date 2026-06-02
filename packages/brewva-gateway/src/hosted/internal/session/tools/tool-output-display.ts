import { isRecord } from "@brewva/brewva-std/unknown";
import {
  outcomeIsError,
  outcomeVerdict,
  type BrewvaOutcome,
  type OutcomeVerdict,
} from "@brewva/brewva-vocabulary/outcome";
import type { ToolOutputDisplayView } from "@brewva/brewva-vocabulary/wire";
import { distillToolOutput } from "./tool-output-distiller.js";

export type ToolDisplayVerdict = OutcomeVerdict;

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
  if (!isRecord(result)) {
    return undefined;
  }
  const outcome = result.outcome;
  if (!isRecord(outcome)) {
    return undefined;
  }
  if (outcome.kind === "ok") {
    return { kind: "ok", value: outcome.value ?? null };
  }
  if (outcome.kind === "err") {
    return { kind: "err", error: outcome.error ?? null };
  }
  if (outcome.kind === "inconclusive") {
    return {
      kind: "inconclusive",
      ...(typeof outcome.reason === "string" ? { reason: outcome.reason } : {}),
      ...(outcome.value !== undefined ? { value: outcome.value } : {}),
    };
  }
  return undefined;
}

function extractExplicitDisplay(result: unknown): ToolOutputDisplayView | undefined {
  if (!isRecord(result)) {
    return undefined;
  }
  const display = result.display;
  if (!isRecord(display)) {
    return undefined;
  }
  const summaryText =
    typeof display.summaryText === "string" && display.summaryText.trim().length > 0
      ? display.summaryText
      : undefined;
  const detailsText =
    typeof display.detailsText === "string" && display.detailsText.trim().length > 0
      ? display.detailsText
      : undefined;
  const rawText =
    typeof display.rawText === "string" && display.rawText.trim().length > 0
      ? display.rawText
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
  if (!isRecord(result)) {
    return "";
  }

  const content = result.content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      if (!isRecord(item)) continue;
      const text = item.text;
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
