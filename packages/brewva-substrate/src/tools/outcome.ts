import { toJsonValue, type JsonValue } from "@brewva/brewva-std/json";
export {
  assertSupportedToolOutcomeVersion,
  DEFAULT_TOOL_OUTCOME_VERSION,
  SUPPORTED_TOOL_OUTCOME_VERSIONS,
  isSupportedToolOutcomeVersion,
  type SupportedToolOutcomeVersion,
} from "@brewva/brewva-std/tool-outcome-version";
import type { BrewvaOutcome, OutcomeVerdict } from "@brewva/brewva-vocabulary/outcome";
import { outcomeIsError, outcomeVerdict } from "@brewva/brewva-vocabulary/outcome";
import { Type, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const ToolJsonValueSchema = Type.Recursive((Self) =>
  Type.Union([
    Type.Null(),
    Type.Boolean(),
    Type.Number(),
    Type.String(),
    Type.Array(Self),
    Type.Record(Type.String(), Self),
  ]),
);

export const ToolJsonRecordSchema = Type.Record(Type.String(), ToolJsonValueSchema);

export const ToolErrorRecordSchema = Type.Record(Type.String(), ToolJsonValueSchema);

export function normalizeOutcomeJson(value: unknown): JsonValue {
  return toJsonValue(value);
}

export function outcomePayload(outcome: BrewvaOutcome): JsonValue {
  if (outcome.kind === "ok") {
    return normalizeOutcomeJson(outcome.value);
  }
  if (outcome.kind === "err") {
    return normalizeOutcomeJson(outcome.error);
  }
  return normalizeOutcomeJson(outcome.value ?? {});
}

export function outcomeIsWireError(outcome: BrewvaOutcome): boolean {
  return outcomeIsError(outcome);
}

export function outcomeDisplayVerdict(outcome: BrewvaOutcome): OutcomeVerdict {
  return outcomeVerdict(outcome);
}

export function validateOutcomeAgainstSchemas(input: {
  readonly outputSchema: TSchema;
  readonly errorSchema: TSchema;
  readonly outcome: BrewvaOutcome;
}): boolean {
  if (input.outcome.kind === "err") {
    return Value.Check(input.errorSchema, input.outcome.error);
  }
  if (input.outcome.kind === "ok") {
    return Value.Check(input.outputSchema, input.outcome.value);
  }
  return input.outcome.value === undefined || Value.Check(input.outputSchema, input.outcome.value);
}
