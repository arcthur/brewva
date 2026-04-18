import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate";
import { Type } from "@sinclair/typebox";
import { recordToolRuntimeEvent, resolveToolRuntimeContextPort } from "./runtime-internal.js";
import type { BrewvaBundledToolOptions } from "./types.js";
import { failTextResult, textResult } from "./utils/result.js";
import { createRuntimeBoundBrewvaToolFactory } from "./utils/runtime-bound-tool.js";
import { getSessionId } from "./utils/session.js";

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

export function createSessionCompactTool(options: BrewvaBundledToolOptions): ToolDefinition {
  const sessionCompactTool = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "session_compact",
  );
  return sessionCompactTool.define({
    name: "session_compact",
    label: "Session Compact",
    description: "Compact LLM message history for the current session.",
    parameters: Type.Object({
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const reason = normalizeReason(params.reason);
      const usage = ctx.getContextUsage();
      const contextPort = resolveToolRuntimeContextPort(sessionCompactTool.runtime);
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
            recordToolRuntimeEvent(sessionCompactTool.runtime, {
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
        recordToolRuntimeEvent(sessionCompactTool.runtime, {
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
        recordToolRuntimeEvent(sessionCompactTool.runtime, {
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
        "Session compaction requested; the gateway will resume the interrupted turn after compaction.",
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
