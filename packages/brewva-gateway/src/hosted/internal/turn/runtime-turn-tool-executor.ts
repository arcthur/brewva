import type { RuntimeToolExecutorPort, ToolExecutionResult } from "@brewva/brewva-runtime";
import { toJsonValue, type JsonValue } from "@brewva/brewva-std/json";
import type { BrewvaToolDefinition, BrewvaToolResult } from "@brewva/brewva-substrate/tools";
import {
  assertSupportedToolOutcomeVersion,
  DEFAULT_TOOL_OUTCOME_VERSION,
  outcomeDisplayVerdict,
  outcomeIsWireError,
  ToolErrorRecordSchema,
  ToolJsonRecordSchema,
  validateOutcomeAgainstSchemas,
} from "@brewva/brewva-substrate/tools";
import { resolveToolDisplay } from "../session/tools/tool-output-display.js";
import type { CollectSessionPromptOutputSession } from "./collect-output.js";
import { isRuntimeToolSession } from "./runtime-turn-session.js";

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

function assertToolOutcomeMatchesSchema(
  tool: BrewvaToolDefinition,
  result: BrewvaToolResult,
): void {
  if (
    !validateOutcomeAgainstSchemas({
      outputSchema: tool.outputSchema ?? ToolJsonRecordSchema,
      errorSchema: tool.errorSchema ?? ToolErrorRecordSchema,
      outcome: result.outcome,
    })
  ) {
    throw new Error(`tool_outcome_schema_mismatch:${tool.name}:${result.outcome.kind}`);
  }
}

function toolExecutionResultFromHostedResult(
  tool: BrewvaToolDefinition,
  result: BrewvaToolResult,
): ToolExecutionResult {
  assertToolOutcomeMatchesSchema(tool, result);
  const outcomeVersion = assertSupportedToolOutcomeVersion(
    tool.outcomeVersion ?? DEFAULT_TOOL_OUTCOME_VERSION,
  );
  const metadata: Record<string, JsonValue> = { outcomeVersion };
  if (result.display !== undefined) {
    metadata.display = toJsonValue(result.display);
  }
  return {
    outcome: result.outcome,
    content: result.content,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

function toolExecutionResultFromHostedUpdate(
  tool: BrewvaToolDefinition,
  update: BrewvaToolResult,
): ToolExecutionResult {
  assertToolOutcomeMatchesSchema(tool, update);
  const outcomeVersion = assertSupportedToolOutcomeVersion(
    tool.outcomeVersion ?? DEFAULT_TOOL_OUTCOME_VERSION,
  );
  const display = resolveToolDisplay({
    toolName: tool.name,
    isError: outcomeIsWireError(update.outcome),
    result: update,
  });
  return {
    outcome: update.outcome,
    content: update.content,
    metadata: {
      outcomeVersion,
      verdict: outcomeDisplayVerdict(update.outcome),
      ...(display.display ? { display: toJsonValue(display.display) } : {}),
    },
  };
}

function toolIdentity(tool: BrewvaToolDefinition): string {
  return JSON.stringify(tool.parameters ?? null);
}

export function createHostedRuntimeToolExecutorPort(
  session: CollectSessionPromptOutputSession,
): RuntimeToolExecutorPort {
  if (!isRuntimeToolSession(session)) {
    throw new Error("hosted_runtime_tool_executor_session_incompatible");
  }
  // Snapshot each registered tool's identity once when the executor is built. The
  // registered tool surface is stable for a session — refreshTools rebuilds the
  // index without changing identity, and setActiveTools only narrows the visible
  // subset — so this snapshot is the identity the model was offered. At execution
  // a tool whose identity drifted from it fails closed, so a tool_call cannot
  // silently run a different tool than the one proposed; a name absent from the
  // snapshot (a tool registered later) is allowed (RFC: Checked Invariants And
  // Disciplined Peer Borrowing, item C).
  const proposalIdentities = new Map<string, string>(
    session.getRegisteredTools().map((tool) => [tool.name, toolIdentity(tool)]),
  );
  return {
    async execute(commitment, input): Promise<ToolExecutionResult> {
      const tool = session
        .getRegisteredTools()
        .find((candidate) => candidate.name === commitment.call.toolName);
      if (!tool) {
        throw new Error(`hosted_runtime_tool_not_found:${commitment.call.toolName}`);
      }
      const proposalIdentity = proposalIdentities.get(commitment.call.toolName);
      if (proposalIdentity !== undefined && proposalIdentity !== toolIdentity(tool)) {
        throw new Error(`hosted_runtime_tool_identity_drift:${commitment.call.toolName}`);
      }
      const rawArgs = commitment.call.args ?? {};
      const preparedArgs = tool.prepareArguments ? tool.prepareArguments(rawArgs) : rawArgs;
      const result = await tool.execute(
        commitment.call.toolCallId,
        preparedArgs,
        input.signal,
        input.onProgress
          ? async (update) => {
              await input.onProgress?.(toolExecutionResultFromHostedUpdate(tool, update));
            }
          : undefined,
        session.createRuntimeToolContext(),
      );
      return toolExecutionResultFromHostedResult(tool, result);
    },
  };
}

export function summarizeRuntimeToolResultContent(content: unknown): string {
  return textFromToolResultContent(content);
}
