import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Model, ToolCall } from "@brewva/brewva-provider-core/contracts";
import { transformMessages } from "../../../packages/brewva-provider-core/src/providers/_shared/transform-messages.js";

// WS4 Item 2 (signature threading): opaque provider state (thinking/thought
// signatures, redacted reasoning) round-trips losslessly for the SAME provider, and
// is stripped on a cross-provider handoff so a foreign signature is never shipped to
// the wrong provider. The behavior already exists in transform-messages; this is the
// missing coverage.

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const MODEL_A: Model<"anthropic-messages"> = {
  id: "claude-x",
  name: "Claude X",
  api: "anthropic-messages",
  provider: "anthropic",
  baseUrl: "https://example",
  reasoning: true,
  input: ["text"],
  cost: ZERO_COST,
  contextWindow: 1000,
  maxTokens: 100,
};

const MODEL_B: Model<"openai-responses"> = {
  ...MODEL_A,
  id: "gpt-x",
  api: "openai-responses",
  provider: "openai",
} as Model<"openai-responses">;

function assistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "reasoning", thinkingSignature: "sig-think" },
      { type: "thinking", thinking: "", redacted: true },
      {
        type: "toolCall",
        id: "call_1",
        name: "search",
        arguments: {},
        thoughtSignature: "sig-thought",
      },
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-x",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { ...ZERO_COST, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  };
}

function thoughtSignatureOf(message: AssistantMessage): string | undefined {
  const toolCall = message.content.find((block): block is ToolCall => block.type === "toolCall");
  return toolCall?.thoughtSignature;
}

describe("signature threading — cross-provider handoff (WS4 Item 2)", () => {
  test("same provider keeps thinking + thought signatures and redacted reasoning", () => {
    const [out] = transformMessages([assistantMessage()], MODEL_A) as [AssistantMessage];
    expect(
      out.content.some((b) => b.type === "thinking" && b.thinkingSignature === "sig-think"),
    ).toBe(true);
    expect(out.content.some((b) => b.type === "thinking" && b.redacted === true)).toBe(true);
    expect(thoughtSignatureOf(out)).toBe("sig-thought");
  });

  test("cross provider strips thoughtSignature, drops redacted, downgrades thinking to text", () => {
    const [out] = transformMessages([assistantMessage()], MODEL_B) as [AssistantMessage];
    expect(thoughtSignatureOf(out) ?? "<stripped>").toBe("<stripped>");
    expect(out.content.some((b) => b.type === "thinking" && b.redacted === true)).toBe(false);
    expect(out.content.some((b) => b.type === "text" && b.text === "reasoning")).toBe(true);
  });
});
