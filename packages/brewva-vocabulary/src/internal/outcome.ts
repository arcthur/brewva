export const TOOL_OUTCOME_SCHEMA = "brewva.tool-outcome.v1" as const;

export type BrewvaOutcomeKind = "ok" | "err" | "inconclusive";

export type BrewvaOutcome<TOutput = unknown, TError = unknown> =
  | {
      readonly kind: "ok";
      readonly value: TOutput;
    }
  | {
      readonly kind: "err";
      readonly error: TError;
    }
  | {
      readonly kind: "inconclusive";
      readonly reason?: string;
      readonly value?: TOutput;
      readonly evidenceRefs?: readonly string[];
    };

export type ToolOutcomePayload<TOutput = unknown, TError = unknown> = {
  readonly schema: typeof TOOL_OUTCOME_SCHEMA;
  readonly version: string;
  readonly outcome: BrewvaOutcome<TOutput, TError>;
};

export function outcomeKind(outcome: BrewvaOutcome): BrewvaOutcomeKind {
  return outcome.kind;
}

export function outcomeIsError(outcome: BrewvaOutcome): boolean {
  return outcome.kind === "err";
}

export function outcomeVerdict(outcome: BrewvaOutcome): "pass" | "fail" | "inconclusive" {
  if (outcome.kind === "err") {
    return "fail";
  }
  if (outcome.kind === "inconclusive") {
    return "inconclusive";
  }
  return "pass";
}
