import { describe, expect, test } from "bun:test";
import {
  CLEARED_TOOL_RESULT_PLACEHOLDER,
  MIN_CLEARABLE_TOOL_RESULT_CHARS,
  applyTransientOutboundReductionToPayload,
} from "../../../packages/brewva-gateway/src/hosted/internal/provider/request/provider-request-reduction-walker.js";

const LARGE_TOOL_RESULT = "x".repeat(MIN_CLEARABLE_TOOL_RESULT_CHARS);

function buildToolMessages(count: number): Array<Record<string, unknown>> {
  return Array.from({ length: count }, (_, index) => ({
    role: "tool",
    tool_call_id: `call-${index + 1}`,
    name: "read",
    content: `${LARGE_TOOL_RESULT}:${index + 1}`,
  }));
}

describe("provider request reduction walker", () => {
  test("clears an oversized recent tool result before it can overflow the provider request", () => {
    const oversized = "x".repeat(80_000);
    const payload = {
      input: [
        { type: "function_call", call_id: "call-1", name: "grep" },
        { type: "function_call_output", call_id: "call-1", output: oversized },
      ],
    };

    const result = applyTransientOutboundReductionToPayload(payload, undefined, {
      tailProtectTokens: 1_000,
    });

    expect(result.status).toBe("completed");
    expect(result.eligibleToolResults).toBe(1);
    expect(result.clearedToolResults).toBe(1);
    expect(result.estimatedTokenSavings).toBe(
      Math.trunc(oversized.length / 4) - Math.trunc(CLEARED_TOOL_RESULT_PLACEHOLDER.length / 4),
    );
    const reduced = result.payload as {
      input: Array<{ type: string; output?: string }>;
    };
    expect(reduced.input[1]?.output).toBe(CLEARED_TOOL_RESULT_PLACEHOLDER);
    expect((payload.input[1] as { output: string }).output).toBe(oversized);
  });

  test("clears older unprotected tool results and preserves the recent tail", () => {
    const payload = {
      messages: buildToolMessages(6),
    };

    const result = applyTransientOutboundReductionToPayload(payload, undefined, {
      tailProtectTokens: 0,
    });

    expect(result.status).toBe("completed");
    expect(result.eligibleToolResults).toBe(6);
    expect(result.clearedToolResults).toBe(2);
    const reduced = result.payload as { messages: Array<{ content: string }> };
    expect(reduced.messages[0]?.content).toBe(CLEARED_TOOL_RESULT_PLACEHOLDER);
    expect(reduced.messages[1]?.content).toBe(CLEARED_TOOL_RESULT_PLACEHOLDER);
    expect(reduced.messages[2]?.content).toContain(":3");
    expect(reduced.messages.at(-1)?.content).toContain(":6");
    expect(payload.messages[0]?.content).toContain(":1");
  });

  test("does not clear protected tool results", () => {
    const messages = buildToolMessages(6);
    messages.forEach((message, index) => {
      message.name = index < 2 ? "workbench_note" : "read";
    });
    const payload = {
      messages,
    };

    const result = applyTransientOutboundReductionToPayload(payload, undefined, {
      tailProtectTokens: 0,
    });

    expect(result.status).toBe("skipped");
    expect(result.clearedToolResults).toBe(0);
    expect(result.eligibleToolResults).toBe(4);
  });

  test("clears individually oversized protected tool results as a last-resort guard", () => {
    const oversized = "x".repeat(80_000);
    const payload = {
      messages: [
        {
          role: "tool",
          tool_call_id: "call-1",
          name: "workbench_note",
          content: oversized,
        },
      ],
    };

    const result = applyTransientOutboundReductionToPayload(payload, undefined, {
      tailProtectTokens: 1_000,
    });

    expect(result.status).toBe("completed");
    expect(result.eligibleToolResults).toBe(1);
    expect(result.clearedToolResults).toBe(1);
    const reduced = result.payload as { messages: Array<{ content: string }> };
    expect(reduced.messages[0]?.content).toBe(CLEARED_TOOL_RESULT_PLACEHOLDER);
    expect(payload.messages[0]?.content).toBe(oversized);
  });
});
