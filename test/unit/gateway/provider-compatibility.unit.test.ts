import { describe, expect, test } from "bun:test";
import {
  createModelCapabilityRegistry,
  normalizeAssistantMessageToolCalls,
} from "../../../packages/brewva-gateway/src/runtime-plugins/provider-compatibility.js";

function createAssistantMessage(
  content: NormalizeInput["message"]["content"],
  overrides: Partial<NormalizeInput["message"]> = {},
): NormalizeInput["message"] {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.4",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    },
    stopReason: "toolUse",
    timestamp: 1_000,
    content,
    ...overrides,
  };
}

type NormalizeInput = Parameters<typeof normalizeAssistantMessageToolCalls>[0];
type ToolLike = NonNullable<NormalizeInput["tools"]>[number];
type ModelLike = Parameters<ReturnType<typeof createModelCapabilityRegistry>["patchRequest"]>[0];

function createSingleStringFieldTool(name: string, fieldName: string): ToolLike {
  return {
    name,
    description: "Test tool",
    parameters: {
      type: "object",
      properties: {
        [fieldName]: {
          type: "string",
        },
      },
      required: [fieldName],
      additionalProperties: false,
    },
  } as unknown as ToolLike;
}

describe("provider compatibility", () => {
  test("normalizes an embedded single-call JSON payload into a structured tool call", () => {
    const tools: ToolLike[] = [createSingleStringFieldTool("read_file", "path")];

    const result = normalizeAssistantMessageToolCalls({
      tools,
      message: createAssistantMessage([
        {
          type: "text",
          text: '{"toolName":"read_file","arguments":"README.md"}',
        },
      ]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    const toolCall = result.message.content[0];
    expect(toolCall?.type).toBe("toolCall");
    if (!toolCall || toolCall.type !== "toolCall") return;
    expect(toolCall.name).toBe("read_file");
    expect(toolCall.arguments).toEqual({ path: "README.md" });
    expect(result.records[0]?.repairKinds).toEqual([
      "content_embedded_single_call",
      "primitive_to_object_coercion",
    ]);
  });

  test("repairs double-stringified and provider-wrapped tool arguments", () => {
    const tools: ToolLike[] = [createSingleStringFieldTool("read_file", "path")];

    const result = normalizeAssistantMessageToolCalls({
      tools,
      message: createAssistantMessage([
        {
          type: "toolCall",
          id: "tc-1",
          name: "read_file",
          arguments: '{"input":{"path":"README.md"}}',
        } as unknown as NormalizeInput["message"]["content"][number],
      ]),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    const toolCall = result.message.content[0];
    expect(toolCall?.type).toBe("toolCall");
    if (!toolCall || toolCall.type !== "toolCall") return;
    expect(toolCall.arguments).toEqual({ path: "README.md" });
    expect(result.records[0]?.repairKinds).toEqual([
      "double_stringified_arguments",
      "provider_wrapper_unwrapped",
    ]);
  });

  test("fails fast when an embedded tool call references an unknown tool", () => {
    const result = normalizeAssistantMessageToolCalls({
      tools: [createSingleStringFieldTool("read_file", "path")],
      message: createAssistantMessage([
        {
          type: "text",
          text: '{"toolName":"missing_tool","arguments":{"path":"README.md"}}',
        },
      ]),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failure.reason).toBe("unknown_tool");
    expect(result.failure.candidateToolName).toBe("missing_tool");
  });

  test("patches Anthropic named tool choice into provider-native format", () => {
    const registry = createModelCapabilityRegistry();
    const model = {
      id: "claude-sonnet-4",
      api: "anthropic-messages",
      provider: "anthropic",
    } as unknown as ModelLike;

    const result = registry.patchRequest(model, {
      tool_choice: {
        type: "function",
        function: {
          name: "browser_click",
        },
      },
    });

    expect(result.profileId).toBe("anthropic-default");
    expect(result.changed).toBe(true);
    expect(result.patchKinds).toEqual(["anthropic_named_tool_choice_wrapper_fixed"]);
    expect(result.payload).toEqual({
      tool_choice: {
        type: "tool",
        name: "browser_click",
      },
    });
  });

  test("defaults Codex tool orchestration when tools are present", () => {
    const registry = createModelCapabilityRegistry();
    const model = {
      id: "codex-mini-latest",
      api: "openai-codex-responses",
      provider: "openai-codex",
    } as unknown as ModelLike;

    const result = registry.patchRequest(model, {
      tools: [
        {
          type: "function",
          name: "read_file",
        },
      ],
    });

    expect(result.profileId).toBe("openai-codex-default");
    expect(result.changed).toBe(true);
    expect(result.patchKinds).toEqual([
      "codex_parallel_tool_calls_defaulted",
      "codex_tool_choice_defaulted",
    ]);
    expect(result.payload).toEqual({
      tools: [
        {
          type: "function",
          name: "read_file",
        },
      ],
      parallel_tool_calls: true,
      tool_choice: "auto",
    });
  });
});
