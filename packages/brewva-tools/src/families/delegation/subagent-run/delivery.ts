import type {
  BrewvaToolOptions,
  SubagentDelegationMode,
  SubagentOutcome,
  SubagentReturnMode,
} from "../../../contracts/index.js";
import {
  appendToolRuntimeGuardedSupplementalBlocks,
  canAppendToolRuntimeGuardedSupplementalBlocks,
} from "../../../runtime-port/extensions.js";
import { includesSupplementalReturn } from "./packet-builder.js";

function summarizeOutcomeForDelivery(outcome: SubagentOutcome): string {
  if (!outcome.ok) {
    return `- ${outcome.label ?? outcome.runId}: ${outcome.status} (${outcome.error})`;
  }
  const parts = [
    outcome.kind,
    outcome.workerSessionId ? `worker=${outcome.workerSessionId}` : null,
    typeof outcome.metrics.totalTokens === "number"
      ? `tokens=${outcome.metrics.totalTokens}`
      : null,
    typeof outcome.metrics.costUsd === "number"
      ? `cost=$${outcome.metrics.costUsd.toFixed(4)}`
      : null,
  ].filter(Boolean);
  return `- ${outcome.label ?? outcome.runId}: ${parts.join(" ")}\n  ${outcome.summary}`;
}

function buildDeliveryContent(input: {
  delegate: string;
  mode: SubagentDelegationMode;
  outcomes: SubagentOutcome[];
}): string {
  const lines = [
    `Delegation outcome for delegate=${input.delegate}`,
    `Mode: ${input.mode}`,
    ...input.outcomes.slice(0, 8).map((outcome) => summarizeOutcomeForDelivery(outcome)),
  ];
  if (input.outcomes.length > 8) {
    lines.push(`- ${input.outcomes.length - 8} additional delegated outcomes omitted`);
  }
  return lines.join("\n").trim();
}

export function deliverSubagentOutcome(input: {
  runtime: BrewvaToolOptions["runtime"];
  sessionId: string;
  delegate: string;
  mode: SubagentDelegationMode;
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
  const content = buildDeliveryContent({
    delegate: input.delegate,
    mode: input.mode,
    outcomes: input.outcomes,
  });
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
    const decision = appendToolRuntimeGuardedSupplementalBlocks(
      input.runtime,
      input.sessionId,
      [
        {
          familyId: "subagent-outcome",
          content,
        },
      ],
      input.returnScopeId ?? `subagent:${input.delegate}`,
    );
    delivery.supplemental = {
      attempted: true,
      accepted: decision?.[0]?.accepted ?? false,
      truncated: decision?.[0]?.truncated,
      finalTokens: decision?.[0]?.finalTokens,
      droppedReason: decision?.[0]?.droppedReason,
    };
  }

  return delivery;
}

export function validateDeliveryConfiguration(
  runtime: BrewvaToolOptions["runtime"],
  returnMode: SubagentReturnMode,
): { ok: true } | { ok: false; message: string } {
  if (
    includesSupplementalReturn(returnMode) &&
    !canAppendToolRuntimeGuardedSupplementalBlocks(runtime)
  ) {
    return {
      ok: false,
      message:
        "Error: runtime supplemental context delivery is unavailable for supplemental returnMode.",
    };
  }
  return { ok: true };
}
