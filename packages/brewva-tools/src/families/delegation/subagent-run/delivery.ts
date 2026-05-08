import type {
  BrewvaToolOptions,
  SubagentOutcome,
  SubagentReturnMode,
} from "../../../contracts/index.js";
import { includesSupplementalReturn } from "./packet-builder.js";

export function deliverSubagentOutcome(input: {
  runtime: BrewvaToolOptions["runtime"];
  sessionId: string;
  delegate: string;
  mode: string;
  outcomes: SubagentOutcome[];
  returnMode: SubagentReturnMode;
  returnLabel?: string;
  returnScopeId?: string;
}): {
  supplemental?: {
    attempted: boolean;
    accepted: boolean;
    truncated?: boolean;
    finalTokens?: number;
    droppedReason?: "hard_limit" | "budget_exhausted";
  };
} {
  const delivery: {
    supplemental?: {
      attempted: boolean;
      accepted: boolean;
      truncated?: boolean;
      finalTokens?: number;
      droppedReason?: "hard_limit" | "budget_exhausted";
    };
  } = {};

  if (includesSupplementalReturn(input.returnMode)) {
    delivery.supplemental = {
      attempted: true,
      accepted: false,
    };
  }

  return delivery;
}

export function validateDeliveryConfiguration(
  runtime: BrewvaToolOptions["runtime"],
  returnMode: SubagentReturnMode,
): { ok: true } | { ok: false; message: string } {
  void runtime;
  void returnMode;
  return { ok: true };
}
