import type { RuntimeToolExecutorPort, ToolExecutionResult } from "@brewva/brewva-runtime";
import { toJsonValue, type JsonValue } from "@brewva/brewva-std/json";
import type { BrewvaToolResult } from "@brewva/brewva-substrate/tools";
import {
  resolveToolDisplay,
  resolveToolDisplayVerdict,
} from "../session/tools/tool-output-display.js";
import type { CollectSessionPromptOutputSession } from "./collect-output.js";
import { isRuntimeAdapterSession } from "./runtime-turn-session.js";

function textFromToolResultContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }
  const textParts = content.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }
    const type = (item as { type?: unknown }).type;
    if (type !== "text") {
      return [];
    }
    const text = (item as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  });
  return textParts.join("\n");
}

function toolExecutionResultFromHostedResult(result: BrewvaToolResult): ToolExecutionResult {
  const metadata: Record<string, JsonValue> = {};
  if (result.details !== undefined) {
    metadata.details = toJsonValue(result.details);
  }
  if (result.display !== undefined) {
    metadata.display = toJsonValue(result.display);
  }
  return {
    ok: result.isError !== true,
    content: result.content,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

function toolExecutionResultFromHostedUpdate(
  toolName: string,
  update: BrewvaToolResult,
): ToolExecutionResult {
  const display = resolveToolDisplay({
    toolName,
    isError: update.isError === true,
    result: update,
  });
  return {
    ok: update.isError !== true,
    content: update.content,
    metadata: {
      verdict: resolveToolDisplayVerdict({
        isError: update.isError === true,
        result: update,
      }),
      ...(display.display ? { display: toJsonValue(display.display) } : {}),
    },
  };
}

export function createHostedRuntimeToolExecutorPort(
  session: CollectSessionPromptOutputSession,
): RuntimeToolExecutorPort {
  if (!isRuntimeAdapterSession(session)) {
    throw new Error("hosted_runtime_tool_executor_session_incompatible");
  }
  return {
    async execute(commitment, input): Promise<ToolExecutionResult> {
      const tool = session
        .getRegisteredTools()
        .find((candidate) => candidate.name === commitment.call.toolName);
      if (!tool) {
        throw new Error(`hosted_runtime_tool_not_found:${commitment.call.toolName}`);
      }
      const rawArgs = commitment.call.args ?? {};
      const preparedArgs = tool.prepareArguments ? tool.prepareArguments(rawArgs) : rawArgs;
      const result = await tool.execute(
        commitment.call.toolCallId,
        preparedArgs,
        input.signal,
        input.onProgress
          ? async (update) => {
              await input.onProgress?.(
                toolExecutionResultFromHostedUpdate(commitment.call.toolName, update),
              );
            }
          : undefined,
        session.createRuntimeToolContext(),
      );
      return toolExecutionResultFromHostedResult(result);
    },
  };
}

export function summarizeRuntimeToolResultContent(content: unknown): string {
  return textFromToolResultContent(content);
}
