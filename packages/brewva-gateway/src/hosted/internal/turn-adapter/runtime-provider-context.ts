import type {
  Context as ProviderContext,
  Message as ProviderMessage,
  ToolCall as ProviderToolCall,
} from "@brewva/brewva-provider-core/contracts";
import type {
  PromptContent,
  PromptContentPart,
  PromptMessage,
  PromptToolCall,
  RuntimeProviderPort,
} from "@brewva/brewva-runtime";
import { redactedStableJsonSha256Hex } from "@brewva/brewva-std/hash";
import type {
  BrewvaAgentProtocolMessage,
  BrewvaAgentProtocolToolCall,
} from "@brewva/brewva-substrate/agent-protocol";
import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import {
  getHostedRuntimeTurnContext,
  type HostedRuntimeTurnContext,
} from "./runtime-turn-prelude.js";
import type { RuntimeAdapterSession } from "./runtime-turn-session.js";

export interface RuntimeProviderContextSummary {
  readonly systemPromptHash: string;
  readonly messageHashes: readonly string[];
  readonly activeToolNames: readonly string[];
  readonly toolSurfaceHash: string;
}

export function toProviderContext(
  session: RuntimeAdapterSession,
  input: Parameters<RuntimeProviderPort["stream"]>[0],
): ProviderContext {
  const toolContext = session.createRuntimeToolContext();
  const systemMessages = input.prompt.messages
    .filter((message) => message.role === "system")
    .map((message) => textFromPromptContent(message.content));
  const systemPrompt = [toolContext.getSystemPrompt(), ...systemMessages]
    .filter((message) => message.trim().length > 0)
    .join("\n\n");
  const messages: ProviderContext["messages"] = [];
  const hostedTurnContext = getHostedRuntimeTurnContext(session);
  if (hostedTurnContext) {
    // The hosted baseline owns restored history, the current user message, and
    // plugin transformations. Runtime materialization contributes only events
    // committed after that baseline cursor, such as tool continuation results.
    for (const message of hostedTurnContext.messages) {
      const providerMessage = providerMessageFromTurnLoop(message);
      if (providerMessage) {
        messages.push(providerMessage);
      }
    }
    appendRuntimeTurnDelta(messages, input.prompt, hostedTurnContext);
  } else {
    // Raw runtime path: history comes from the runtime tape materialization.
    for (const message of input.prompt.messages) {
      const providerMessage = providerMessageFromPromptMessage(message);
      if (providerMessage) {
        messages.push(providerMessage);
      }
    }
  }
  if (!hostedTurnContext && messages.length === 0) {
    messages.push({
      role: "user",
      content: userContentFromPromptContent(input.turn.prompt),
      timestamp: Date.now(),
    });
  }
  return {
    systemPrompt,
    messages,
    tools: toProviderTools(session.getRegisteredTools()),
  };
}

function appendRuntimeTurnDelta(
  target: ProviderContext["messages"],
  prompt: Parameters<RuntimeProviderPort["stream"]>[0]["prompt"],
  hostedContext: HostedRuntimeTurnContext,
): void {
  if (prompt.messageSourceEventIds.length !== prompt.messages.length) {
    throw new Error("runtime_prompt_message_provenance_mismatch");
  }
  const admittedEventIds = new Set(prompt.admittedBlocks.map((block) => block.id));
  if (prompt.messageSourceEventIds.some((eventId) => !admittedEventIds.has(eventId))) {
    throw new Error("runtime_prompt_message_provenance_mismatch");
  }
  const cursorIndex = hostedContext.runtimeEventCursor
    ? prompt.admittedBlocks.findIndex((block) => block.id === hostedContext.runtimeEventCursor)
    : -1;
  if (
    hostedContext.runtimeEventCursor &&
    cursorIndex < 0 &&
    !prompt.admittedBlocks.some((block) => block.kind === "checkpoint.committed")
  ) {
    throw new Error("hosted_runtime_event_cursor_missing");
  }
  const candidateBlocks =
    cursorIndex >= 0 ? prompt.admittedBlocks.slice(cursorIndex + 1) : prompt.admittedBlocks;
  const deltaEventIds = new Set(
    candidateBlocks
      .filter(
        (block) =>
          block.kind === "msg.committed" ||
          block.kind === "tool.committed" ||
          block.kind === "tool.aborted",
      )
      .map((block) => block.id),
  );
  for (const [index, message] of prompt.messages.entries()) {
    const sourceEventId = prompt.messageSourceEventIds[index];
    if (!sourceEventId || !deltaEventIds.has(sourceEventId)) {
      continue;
    }
    const providerMessage = providerMessageFromPromptMessage(message);
    if (providerMessage) {
      target.push(providerMessage);
    }
  }
}

export function summarizeProviderContext(context: ProviderContext): RuntimeProviderContextSummary {
  const tools = context.tools ?? [];
  return {
    systemPromptHash: hashJson(context.systemPrompt ?? ""),
    messageHashes: context.messages.map((message) => hashJson(redactProviderMessage(message))),
    activeToolNames: tools.map((tool) => tool.name).toSorted(),
    toolSurfaceHash: hashJson(
      tools.map((tool) => ({
        name: tool.name,
        descriptionHash: hashJson(tool.description),
        parametersHash: hashJson(tool.parameters),
      })),
    ),
  };
}

function toProviderTools(
  tools: readonly BrewvaToolDefinition[],
): NonNullable<ProviderContext["tools"]> {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

function providerToolCallFromTurnLoop(part: BrewvaAgentProtocolToolCall): ProviderToolCall {
  return {
    type: "toolCall",
    id: part.id,
    name: part.name,
    arguments: part.arguments,
    ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}),
  };
}

function providerMessageFromTurnLoop(message: BrewvaAgentProtocolMessage): ProviderMessage | null {
  if (message.excludeFromContext === true) {
    return null;
  }
  if (message.role === "user") {
    return {
      role: "user",
      content: message.content.map((part) => ({ ...part })),
      timestamp: message.timestamp,
    };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content.map((part) =>
        part.type === "toolCall" ? providerToolCallFromTurnLoop(part) : { ...part },
      ),
      api: message.api,
      provider: message.provider,
      model: message.model,
      ...(message.responseModel ? { responseModel: message.responseModel } : {}),
      ...(message.responseId ? { responseId: message.responseId } : {}),
      usage: {
        input: message.usage.input,
        output: message.usage.output,
        cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite,
        totalTokens: message.usage.totalTokens,
        cost: { ...message.usage.cost },
      },
      stopReason: message.stopReason,
      ...(message.errorMessage ? { errorMessage: message.errorMessage } : {}),
      timestamp: message.timestamp,
    };
  }
  if (message.role === "toolResult") {
    return {
      role: "toolResult",
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      content: message.content.map((part) => ({ ...part })),
      ...(message.details !== undefined ? { details: message.details } : {}),
      isError: message.isError,
      timestamp: message.timestamp,
    };
  }
  if (message.role === "custom") {
    const content =
      typeof message.content === "string"
        ? [{ type: "text" as const, text: message.content }]
        : message.content.map((part) => ({ ...part }));
    return {
      role: "user",
      content,
      timestamp: message.timestamp,
    };
  }
  if (message.role === "branchSummary") {
    return {
      role: "user",
      content: [{ type: "text", text: message.summary }],
      timestamp: message.timestamp,
    };
  }
  return {
    role: "user",
    content: [{ type: "text", text: message.summary }],
    timestamp: message.timestamp,
  };
}

function textFromPromptContent(content: PromptContent): string {
  if (typeof content === "string") {
    return content;
  }
  return content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "file") {
        return part.displayText ?? part.name ?? part.uri;
      }
      return "";
    })
    .join("");
}

function clonePromptContentPart(part: PromptContentPart): PromptContentPart {
  return { ...part };
}

function userContentFromPromptContent(
  content: PromptContent,
): Extract<ProviderMessage, { role: "user" }>["content"] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content.map((part) => clonePromptContentPart(part));
}

function toolResultContentFromPromptContent(
  content: PromptContent,
): Extract<ProviderMessage, { role: "toolResult" }>["content"] {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return content.map((part) => {
    if (part.type === "text") {
      return { type: "text" as const, text: part.text };
    }
    if (part.type === "image") {
      return { type: "image" as const, data: part.data, mimeType: part.mimeType };
    }
    if (part.type === "file") {
      return {
        type: "text" as const,
        text: part.displayText ?? part.name ?? part.uri,
      };
    }
    return part;
  });
}

function providerToolCallFromPromptToolCall(toolCall: PromptToolCall): ProviderToolCall {
  return {
    type: "toolCall",
    id: toolCall.toolCallId,
    name: toolCall.toolName,
    arguments: toolCall.args ? { ...toolCall.args } : {},
  };
}

function providerMessageFromPromptMessage(message: PromptMessage): ProviderMessage | null {
  if (message.role === "system") {
    return null;
  }
  if (message.role === "user") {
    return {
      role: "user",
      content: userContentFromPromptContent(message.content),
      timestamp: Date.now(),
    };
  }
  if (message.role === "assistant") {
    const text = textFromPromptContent(message.content);
    const toolCalls = message.toolCalls?.map(providerToolCallFromPromptToolCall) ?? [];
    const content: Extract<ProviderMessage, { role: "assistant" }>["content"] = [
      ...(text.length > 0 ? [{ type: "text" as const, text }] : []),
      ...toolCalls,
    ];
    if (content.length === 0) {
      return null;
    }
    return {
      role: "assistant",
      content,
      api: "faux",
      provider: "faux",
      model: "runtime-adapter-history",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
      timestamp: Date.now(),
    };
  }
  if (!message.toolCallId || !message.toolName) {
    return {
      role: "user",
      content: userContentFromPromptContent(message.content),
      timestamp: Date.now(),
    };
  }
  return {
    role: "toolResult",
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    content: toolResultContentFromPromptContent(message.content),
    isError: message.isError === true,
    timestamp: Date.now(),
  };
}

function redactProviderMessage(message: ProviderMessage): unknown {
  return {
    role: message.role,
    contentHash: hashJson("content" in message ? message.content : null),
    toolName: "toolName" in message ? message.toolName : undefined,
    toolCallId: "toolCallId" in message ? message.toolCallId : undefined,
    api: "api" in message ? message.api : undefined,
    provider: "provider" in message ? message.provider : undefined,
    model: "model" in message ? message.model : undefined,
    stopReason: "stopReason" in message ? message.stopReason : undefined,
    isError: "isError" in message ? message.isError : undefined,
  };
}

function hashJson(value: unknown): string {
  return redactedStableJsonSha256Hex(value);
}
