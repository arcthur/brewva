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
});
