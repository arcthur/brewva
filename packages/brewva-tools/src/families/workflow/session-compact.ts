import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import {
  SESSION_COMPACT_FAILED_EVENT_TYPE,
  SESSION_COMPACT_REQUEST_FAILED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/session";
import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolOptions } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import {
  recordToolRuntimeEvent,
  resolveToolRuntimeContextPort,
} from "../../runtime-port/extensions.js";
import { errTextResult, okTextResult } from "../../utils/result.js";
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
        contextPort?.usage?.getRatio?.(usage) ??
        (typeof usage?.percent === "number"
          ? usage.percent > 1
            ? usage.percent / 100
            : usage.percent
          : null);
      const customInstructions = contextPort?.compaction?.getInstructions?.() ?? "";
      let compactError: string | undefined;

      try {
        ctx.compact({
          customInstructions,
          onError: (error) => {
            compactError = normalizeErrorMessage(error);
            recordToolRuntimeEvent(workbenchCompactTool.runtime, {
              sessionId,
              type: SESSION_COMPACT_FAILED_EVENT_TYPE,
              payload: {
                reason: reason ?? null,
                error: compactError,
              },
            });
          },
        });
        if (compactError) {
          return errTextResult(`Session compaction request failed (${compactError}).`, {
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
          type: SESSION_COMPACT_REQUEST_FAILED_EVENT_TYPE,
          payload: {
            reason: reason ?? null,
            error: errorMessage,
          },
        });
        return errTextResult(`Session compaction request failed (${errorMessage}).`, {
          ok: false,
          error: errorMessage,
        });
      }

      return okTextResult(
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
