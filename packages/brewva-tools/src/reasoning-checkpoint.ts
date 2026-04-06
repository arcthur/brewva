import type { ReasoningCheckpointBoundary } from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolOptions } from "./types.js";
import { failTextResult, textResult } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

const CHECKPOINT_BOUNDARIES = [
  "turn_start",
  "tool_boundary",
  "verification_boundary",
  "compaction_boundary",
  "operator_marker",
] as const satisfies readonly ReasoningCheckpointBoundary[];

function normalizeBoundary(value: unknown): ReasoningCheckpointBoundary {
  if (typeof value !== "string") {
    return "operator_marker";
  }
  return CHECKPOINT_BOUNDARIES.includes(value as never)
    ? (value as ReasoningCheckpointBoundary)
    : "operator_marker";
}

export function createReasoningCheckpointTool(options: BrewvaBundledToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "reasoning_checkpoint",
    label: "Reasoning Checkpoint",
    description: "Record a durable reasoning checkpoint for the current session.",
    parameters: Type.Object({
      boundary: Type.Optional(
        Type.Union(CHECKPOINT_BOUNDARIES.map((entry) => Type.Literal(entry))),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const checkpointPort = options.runtime.authority.reasoning;
      if (!checkpointPort) {
        return failTextResult("Reasoning checkpoint surface is unavailable in this runtime.", {
          ok: false,
          error: "reasoning_checkpoint_unavailable",
        });
      }
      const checkpoint = checkpointPort.recordCheckpoint(sessionId, {
        boundary: normalizeBoundary(params.boundary),
        leafEntryId: ctx.sessionManager.getLeafId(),
      });
      return textResult(
        `Recorded reasoning checkpoint ${checkpoint.checkpointId} on branch ${checkpoint.branchId}.`,
        {
          ok: true,
          checkpoint_id: checkpoint.checkpointId,
          branch_id: checkpoint.branchId,
          boundary: checkpoint.boundary,
        },
      );
    },
  });
}
