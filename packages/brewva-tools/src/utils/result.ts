import { toJsonValue, type JsonValue } from "@brewva/brewva-std/json";
import {
  ToolErrorRecordSchema,
  ToolJsonRecordSchema,
  ToolJsonValueSchema,
  type BrewvaToolResult as AgentToolResult,
  type BrewvaToolResultDisplay,
} from "@brewva/brewva-substrate/tools";

export type ToolTextOutcomeKind = "ok" | "err" | "inconclusive";
export { ToolErrorRecordSchema, ToolJsonRecordSchema, ToolJsonValueSchema };

export type ToolJsonRecord = Record<string, JsonValue>;

function jsonRecord(value: Record<string, unknown>): ToolJsonRecord {
  const normalized = toJsonValue(value);
  return normalized && typeof normalized === "object" && !Array.isArray(normalized)
    ? normalized
    : {};
}

export function toolOutcomeRecord(payload: object): ToolJsonRecord {
  return jsonRecord(Object.fromEntries(Object.entries(payload as Record<string, unknown>)));
}

export function okTextResult(
  text: string,
  payload: Record<string, unknown> = {},
  display?: BrewvaToolResultDisplay,
): AgentToolResult<ToolJsonRecord, ToolJsonRecord> {
  const normalized = jsonRecord(payload);
  return {
    content: [{ type: "text", text }],
    outcome: { kind: "ok", value: normalized },
    ...(display ? { display } : {}),
  };
}

export function withDisplay<TOutput, TError>(
  result: AgentToolResult<TOutput, TError>,
  display: BrewvaToolResultDisplay,
): AgentToolResult<TOutput, TError> {
  return {
    ...result,
    display,
  };
}

export function errTextResult(
  text: string,
  payload: Record<string, unknown> = {},
  display?: BrewvaToolResultDisplay,
): AgentToolResult<ToolJsonRecord, ToolJsonRecord> {
  const error = jsonRecord({ message: text, ...payload });
  return {
    content: [{ type: "text", text }],
    outcome: { kind: "err", error },
    ...(display ? { display } : {}),
  };
}

export function inconclusiveTextResult(
  text: string,
  payload: Record<string, unknown> = {},
  display?: BrewvaToolResultDisplay,
): AgentToolResult<ToolJsonRecord, ToolJsonRecord> {
  const normalized = jsonRecord(payload);
  return {
    content: [{ type: "text", text }],
    outcome: {
      kind: "inconclusive",
      reason: text,
      value: normalized,
    },
    ...(display ? { display } : {}),
  };
}

export function textResultForOutcome(
  kind: ToolTextOutcomeKind,
  text: string,
  payload: Record<string, unknown> = {},
  display?: BrewvaToolResultDisplay,
): AgentToolResult<ToolJsonRecord, ToolJsonRecord> {
  if (kind === "err") {
    return errTextResult(text, payload, display);
  }
  if (kind === "inconclusive") {
    return inconclusiveTextResult(text, payload, display);
  }
  return okTextResult(text, payload, display);
}

export function toolResultData(result: AgentToolResult): JsonValue {
  if (result.outcome.kind === "ok") {
    return toJsonValue(result.outcome.value);
  }
  if (result.outcome.kind === "err") {
    return toJsonValue(result.outcome.error);
  }
  return toJsonValue(result.outcome.value ?? {});
}
