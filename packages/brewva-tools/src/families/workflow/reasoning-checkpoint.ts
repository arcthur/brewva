import type { ReasoningCheckpointBoundary } from "@brewva/brewva-runtime/reasoning";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolOptions } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { readLiteral } from "../../utils/literal.js";
import { failTextResult, textResult } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";

const CHECKPOINT_BOUNDARIES = [
  "turn_start",
  "tool_boundary",
  "verification_boundary",
  "compaction_boundary",
  "operator_marker",
] as const satisfies readonly ReasoningCheckpointBoundary[];

function normalizeBoundary(value: unknown): ReasoningCheckpointBoundary {
  return readLiteral(value, CHECKPOINT_BOUNDARIES) ?? "operator_marker";
}

export function createReasoningCheckpointTool(options: BrewvaBundledToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "reasoning_checkpoint",
  );
  return define(
    {
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
        const checkpointPort = runtime.authority.reasoning?.checkpoints;
        if (!checkpointPort) {
          return failTextResult("Reasoning checkpoint surface is unavailable in this runtime.", {
            ok: false,
            error: "reasoning_checkpoint_unavailable",
          });
        }
        const checkpoint = checkpointPort.record(sessionId, {
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
    },
    {},
  );
}
