import type { ReasoningRevertTrigger } from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolOptions } from "./types.js";
import { failTextResult, textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

const REVERT_TRIGGERS = [
  "model_self_repair",
  "operator_request",
  "verification_failure",
  "hosted_recovery",
] as const satisfies readonly ReasoningRevertTrigger[];

function normalizeTrigger(value: unknown): ReasoningRevertTrigger {
  if (typeof value !== "string") {
    return "operator_request";
  }
  return REVERT_TRIGGERS.includes(value as never)
    ? (value as ReasoningRevertTrigger)
    : "operator_request";
}

function normalizeReceiptIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry, index, array) => entry.length > 0 && array.indexOf(entry) === index);
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim().length > 0) {
    return error.trim();
  }
  return "unknown_error";
}

export function createReasoningRevertTool(options: BrewvaBundledToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "reasoning_revert",
    label: "Reasoning Revert",
    description:
      "Revert the active reasoning branch to an earlier checkpoint and request hosted resume.",
    parameters: Type.Object({
      checkpoint_id: Type.String({ minLength: 1, maxLength: 120 }),
      continuity: Type.String({ minLength: 1, maxLength: 1_200 }),
      trigger: Type.Optional(Type.Union(REVERT_TRIGGERS.map((entry) => Type.Literal(entry)))),
      linked_rollback_receipt_ids: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const reasoningPort = options.runtime.authority.reasoning;
      if (!reasoningPort) {
        return failTextResult("Reasoning revert surface is unavailable in this runtime.", {
          ok: false,
          error: "reasoning_revert_unavailable",
        });
      }

      try {
        const revert = reasoningPort.revert(sessionId, {
          toCheckpointId: params.checkpoint_id,
          trigger: normalizeTrigger(params.trigger),
          continuity: params.continuity,
          linkedRollbackReceiptIds: normalizeReceiptIds(params.linked_rollback_receipt_ids),
        });
        ctx.abort();
        return textResult(
          `Reasoning revert scheduled to ${revert.toCheckpointId}; hosted resume will continue from branch ${revert.newBranchId}.`,
          {
            ok: true,
            revert_id: revert.revertId,
            checkpoint_id: revert.toCheckpointId,
            new_branch_id: revert.newBranchId,
            trigger: revert.trigger,
          },
        );
      } catch (error) {
        const message = normalizeErrorMessage(error);
        return failTextResult(`Reasoning revert failed (${message}).`, {
          ok: false,
          error: message,
        });
      }
    },
  });
}
