import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolOptions } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import {
  recordToolRuntimeEvent,
  resolveToolRuntimeContextPort,
} from "../../runtime-port/extensions.js";
import { failTextResult, textResult } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";

function normalizeReason(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const value = input.trim();
  return value.length > 0 ? value : undefined;
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message.trim();
  if (typeof error === "string" && error.trim().length > 0) return error.trim();
  return "unknown_error";
}

export function createWorkbenchCompactTool(options: BrewvaBundledToolOptions): ToolDefinition {
  const workbenchCompactTool = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "workbench_compact",
  );
  return workbenchCompactTool.define({
    name: "workbench_compact",
    label: "Workbench Compact",
    description: "Compact LLM message history into the current workbench baseline.",
    parameters: Type.Object({
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const reason = normalizeReason(params.reason);
      const usage = ctx.getContextUsage();
      const contextPort = resolveToolRuntimeContextPort(workbenchCompactTool.runtime);
      const usagePercent =
        contextPort?.getUsageRatio?.(usage) ??
        (typeof usage?.percent === "number"
          ? usage.percent > 1
            ? usage.percent / 100
            : usage.percent
          : null);
      const customInstructions = contextPort?.getCompactionInstructions?.() ?? "";
      let compactError: string | undefined;

      try {
        ctx.compact({
          customInstructions,
          onError: (error) => {
            compactError = normalizeErrorMessage(error);
            recordToolRuntimeEvent(workbenchCompactTool.runtime, {
              sessionId,
              type: "session_compact_failed",
              payload: {
                reason: reason ?? null,
                error: compactError,
              },
            });
          },
        });
        if (compactError) {
          return failTextResult(`Session compaction request failed (${compactError}).`, {
            ok: false,
            error: compactError,
          });
        }
        recordToolRuntimeEvent(workbenchCompactTool.runtime, {
          sessionId,
          type: "session_compact_requested",
          payload: {
            reason: reason ?? null,
            usageTokens: usage?.tokens ?? null,
            usagePercent,
          },
        });
      } catch (error) {
        const errorMessage = normalizeErrorMessage(error);
        recordToolRuntimeEvent(workbenchCompactTool.runtime, {
          sessionId,
          type: "session_compact_request_failed",
          payload: {
            reason: reason ?? null,
            error: errorMessage,
          },
        });
        return failTextResult(`Session compaction request failed (${errorMessage}).`, {
          ok: false,
          error: errorMessage,
        });
      }

      return textResult(
        "Workbench compaction requested; the gateway will resume the interrupted turn after compaction.",
        {
          ok: true,
          reason: reason ?? null,
          usageTokens: usage?.tokens ?? null,
          usagePercent,
        },
      );
    },
  });
}
