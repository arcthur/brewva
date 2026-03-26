import { randomUUID } from "node:crypto";
import {
  validateToolArguments,
  type AssistantMessage,
  type Tool,
  type ToolCall,
} from "@mariozechner/pi-ai";
import type {
  ToolCallNormalizationFailure,
  ToolCallNormalizationKind,
  ToolCallNormalizationRecord,
  ToolCallNormalizationResult,
} from "./contracts.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced?.[1]?.trim() ?? trimmed;
}

function parseJsonValue(text: string): unknown {
  return JSON.parse(text) as unknown;
}

function closeTruncatedJson(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return null;
  }

  const stack: string[] = [];
  let inString = false;
  let escaping = false;

  for (const char of trimmed) {
    if (escaping) {
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack[stack.length - 1] === expected) {
        stack.pop();
        continue;
      }
      return null;
    }
  }

  if (inString || stack.length === 0) {
    return null;
  }

  const suffix = stack
    .toReversed()
    .map((entry) => (entry === "{" ? "}" : "]"))
    .join("");
  return `${trimmed}${suffix}`;
}

export function createEmptyUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function normalizeToolName(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function getSingleFieldName(tool: Tool): string | undefined {
  if (!isRecord(tool.parameters)) return undefined;
  if (tool.parameters.type !== "object") return undefined;
  const properties = isRecord(tool.parameters.properties) ? tool.parameters.properties : undefined;
  if (!properties) return undefined;
  const keys = Object.keys(properties);
  return keys.length === 1 ? keys[0] : undefined;
}

function unwrapProviderWrapperArguments(value: Record<string, unknown>): {
  changed: boolean;
  args: unknown;
} {
  const wrapperKeys = ["input", "arguments", "args", "parameters", "tool_input"] as const;
  const present = wrapperKeys.filter((key) => key in value);
  const wrapperKey = present[0];
  if (present.length !== 1 || !wrapperKey) {
    return { changed: false, args: value };
  }
  const wrappedValue = value[wrapperKey];
  if (wrappedValue === undefined) {
    return { changed: false, args: value };
  }
  return { changed: true, args: wrappedValue };
}

function normalizeArgumentsValue(
  tool: Tool,
  toolCall: ToolCall,
):
  | {
      ok: true;
      args: Record<string, unknown>;
      repairKinds: ToolCallNormalizationKind[];
    }
  | {
      ok: false;
      failure: ToolCallNormalizationFailure;
    } {
  let candidate: unknown = toolCall.arguments;
  const repairKinds: ToolCallNormalizationKind[] = [];

  if (typeof candidate === "string") {
    const trimmed = candidate.trim();
    if (trimmed.length > 0) {
      try {
        candidate = parseJsonValue(trimmed);
        repairKinds.push("double_stringified_arguments");
      } catch {
        const recovered = closeTruncatedJson(trimmed);
        if (recovered) {
          try {
            candidate = parseJsonValue(recovered);
            repairKinds.push("double_stringified_arguments", "truncated_json_closed");
          } catch {
            candidate = toolCall.arguments;
          }
        } else {
          candidate = toolCall.arguments;
        }
      }
    }
  }

  if (isRecord(candidate)) {
    const unwrapped = unwrapProviderWrapperArguments(candidate);
    if (unwrapped.changed) {
      candidate = unwrapped.args;
      repairKinds.push("provider_wrapper_unwrapped");
    }
  }

  if (!isRecord(candidate)) {
    const singleFieldName = getSingleFieldName(tool);
    if (!singleFieldName) {
      return {
        ok: false,
        failure: {
          reason: "invalid_arguments",
          candidateToolName: toolCall.name,
          diagnostics: {
            stage: "primitive_to_object",
          },
        },
      };
    }
    candidate = { [singleFieldName]: candidate };
    repairKinds.push("primitive_to_object_coercion");
  }

  try {
    const validatedArgs = validateToolArguments(tool, {
      ...toolCall,
      arguments: candidate as Record<string, unknown>,
    }) as Record<string, unknown>;
    return {
      ok: true,
      args: validatedArgs,
      repairKinds,
    };
  } catch (error) {
    return {
      ok: false,
      failure: {
        reason: "invalid_arguments",
        candidateToolName: toolCall.name,
        diagnostics: {
          stage: "validate_arguments",
          error:
            error instanceof Error
              ? {
                  name: error.name,
                  message: error.message,
                }
              : { message: String(error) },
        },
      },
    };
  }
}

function parseEmbeddedSingleCall(text: string):
  | {
      ok: true;
      toolName: string;
      args: unknown;
    }
  | {
      ok: false;
      failure?: ToolCallNormalizationFailure;
    } {
  const trimmed = stripCodeFence(text);
  if (!trimmed) {
    return { ok: false };
  }

  let parsed: unknown;
  try {
    parsed = parseJsonValue(trimmed);
  } catch {
    return { ok: false };
  }

  if (Array.isArray(parsed)) {
    return {
      ok: false,
      failure: {
        reason: "ambiguous_multiple_calls",
        diagnostics: {
          stage: "parse_embedded_single_call",
          kind: "array_root",
        },
      },
    };
  }

  if (!isRecord(parsed)) {
    return { ok: false };
  }

  const directToolName =
    normalizeToolName(parsed.toolName) ??
    normalizeToolName(parsed.tool_name) ??
    normalizeToolName(parsed.name);
  const directArgs = parsed.args ?? parsed.arguments ?? parsed.input ?? parsed.parameters;
  if (directToolName) {
    return {
      ok: true,
      toolName: directToolName,
      args: directArgs ?? {},
    };
  }

  if (isRecord(parsed.tool)) {
    const nestedToolName =
      normalizeToolName(parsed.tool.name) ??
      normalizeToolName(parsed.tool.toolName) ??
      normalizeToolName(parsed.tool.tool_name);
    if (!nestedToolName) {
      return { ok: false };
    }
    return {
      ok: true,
      toolName: nestedToolName,
      args:
        parsed.tool.args ??
        parsed.tool.arguments ??
        parsed.tool.input ??
        parsed.tool.parameters ??
        {},
    };
  }

  return { ok: false };
}

function normalizeParsedToolCall(
  toolCall: ToolCall,
  toolByName: ReadonlyMap<string, Tool>,
  source: ToolCallNormalizationRecord["source"],
):
  | {
      ok: true;
      changed: boolean;
      toolCall: ToolCall;
      record?: ToolCallNormalizationRecord;
    }
  | {
      ok: false;
      failure: ToolCallNormalizationFailure;
    } {
  const tool = toolByName.get(toolCall.name);
  if (!tool) {
    return {
      ok: false,
      failure: {
        reason: "unknown_tool",
        candidateToolName: toolCall.name,
      },
    };
  }

  const normalizedArguments = normalizeArgumentsValue(tool, toolCall);
  if (!normalizedArguments.ok) {
    return normalizedArguments;
  }

  const changed =
    normalizedArguments.repairKinds.length > 0 ||
    JSON.stringify(normalizedArguments.args) !== JSON.stringify(toolCall.arguments);
  const normalizedToolCall: ToolCall = changed
    ? {
        ...toolCall,
        arguments: normalizedArguments.args,
      }
    : toolCall;

  return {
    ok: true,
    changed,
    toolCall: normalizedToolCall,
    record: changed
      ? {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          source,
          repairKinds: normalizedArguments.repairKinds,
          beforeArguments: toolCall.arguments,
          afterArguments: normalizedArguments.args,
        }
      : undefined,
  };
}

export function createNormalizationFailureMessage(
  message: AssistantMessage,
  failure: ToolCallNormalizationFailure,
): AssistantMessage {
  const details = failure.candidateToolName
    ? `${failure.reason}:${failure.candidateToolName}`
    : failure.reason;
  return {
    role: "assistant",
    api: message.api,
    provider: message.provider,
    model: message.model,
    usage: message.usage ?? createEmptyUsage(),
    stopReason: "error",
    errorMessage: `tool_call_normalization_failed:${details}`,
    timestamp: Date.now(),
    content: [
      {
        type: "text",
        text: `Tool call normalization failed: ${details}`,
      },
    ],
  };
}

function normalizeExistingToolCalls(
  message: AssistantMessage,
  toolByName: ReadonlyMap<string, Tool>,
): ToolCallNormalizationResult {
  const nextContent: AssistantMessage["content"] = [];
  const records: ToolCallNormalizationRecord[] = [];
  let changed = false;

  for (const block of message.content) {
    if (block.type !== "toolCall") {
      nextContent.push(block);
      continue;
    }

    const normalized = normalizeParsedToolCall(block, toolByName, "tool_call");
    if (!normalized.ok) {
      return {
        ok: false,
        failure: normalized.failure,
      };
    }

    nextContent.push(normalized.toolCall);
    if (normalized.changed) {
      changed = true;
      if (normalized.record) {
        records.push(normalized.record);
      }
    }
  }

  return {
    ok: true,
    changed,
    message: changed ? { ...message, content: nextContent } : message,
    records,
  };
}

function normalizeEmbeddedToolCall(
  message: AssistantMessage,
  toolByName: ReadonlyMap<string, Tool>,
): ToolCallNormalizationResult | null {
  const textIndexes = message.content
    .map((block, index) => ({ block, index }))
    .filter((entry) => entry.block.type === "text");
  const toolCallCount = message.content.filter((block) => block.type === "toolCall").length;

  if (toolCallCount > 0 || textIndexes.length !== 1) {
    return null;
  }

  const textBlock = textIndexes[0]?.block;
  if (!textBlock || textBlock.type !== "text") {
    return null;
  }

  const parsed = parseEmbeddedSingleCall(textBlock.text);
  if (!parsed.ok) {
    if (parsed.failure) {
      return {
        ok: false,
        failure: parsed.failure,
      };
    }
    return null;
  }

  const tool = toolByName.get(parsed.toolName);
  if (!tool) {
    return {
      ok: false,
      failure: {
        reason: "unknown_tool",
        candidateToolName: parsed.toolName,
      },
    };
  }

  const syntheticToolCall: ToolCall = {
    type: "toolCall",
    id: `brewva_norm_${randomUUID().replaceAll("-", "")}`,
    name: parsed.toolName,
    arguments: parsed.args as Record<string, unknown>,
  };
  const normalized = normalizeArgumentsValue(tool, syntheticToolCall);
  if (!normalized.ok) {
    return {
      ok: false,
      failure: normalized.failure,
    };
  }

  const nextContent = message.content
    .map((block) =>
      block === textBlock
        ? ({
            type: "toolCall",
            id: syntheticToolCall.id,
            name: parsed.toolName,
            arguments: normalized.args,
          } satisfies ToolCall)
        : block,
    )
    .filter((block) => !(block.type === "text" && block.text.trim().length === 0));

  return {
    ok: true,
    changed: true,
    message: {
      ...message,
      stopReason: "toolUse",
      content: nextContent,
    },
    records: [
      {
        toolCallId: syntheticToolCall.id,
        toolName: parsed.toolName,
        source: "assistant_text",
        repairKinds: ["content_embedded_single_call", ...normalized.repairKinds],
        afterArguments: normalized.args,
      },
    ],
  };
}

export function normalizeAssistantMessageToolCalls(input: {
  message: AssistantMessage;
  tools?: readonly Tool[];
}): ToolCallNormalizationResult {
  const tools = input.tools ?? [];
  if (tools.length === 0) {
    return {
      ok: true,
      changed: false,
      message: input.message,
      records: [],
    };
  }

  const toolByName = new Map(tools.map((tool) => [tool.name, tool] as const));
  const embeddedNormalized = normalizeEmbeddedToolCall(input.message, toolByName);
  if (embeddedNormalized) {
    return embeddedNormalized;
  }
  return normalizeExistingToolCalls(input.message, toolByName);
}
