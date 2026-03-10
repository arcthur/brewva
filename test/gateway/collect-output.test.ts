import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import {
  collectSessionPromptOutput,
  type SessionStreamChunk,
} from "../../packages/brewva-gateway/src/session/collect-output.js";

type SessionLike = {
  subscribe: (listener: (event: AgentSessionEvent) => void) => () => void;
  sendUserMessage: (content: string) => Promise<void>;
  agent: {
    waitForIdle: () => Promise<void>;
  };
};

function createSessionMock(eventsToEmit: AgentSessionEvent[]): SessionLike {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  return {
    subscribe(next) {
      listener = next;
      return () => {
        listener = undefined;
      };
    },
    async sendUserMessage(_content: string): Promise<void> {
      for (const event of eventsToEmit) {
        listener?.(event);
      }
    },
    agent: {
      async waitForIdle(): Promise<void> {
        return;
      },
    },
  };
}

describe("gateway collect output", () => {
  test("given high-volume exec result, when collecting output, then tool output is distilled", async () => {
    const noisyOutput = Array.from({ length: 240 }, (_value, index) =>
      index % 31 === 0 ? `error at step ${index}: timeout` : `line ${index}: working`,
    ).join("\n");
    const session = createSessionMock([
      {
        type: "tool_execution_end",
        toolCallId: "tc-gw-exec",
        toolName: "exec",
        result: noisyOutput,
        isError: true,
      } as AgentSessionEvent,
    ]);

    const output = await collectSessionPromptOutput(
      session as unknown as Parameters<typeof collectSessionPromptOutput>[0],
      "hello",
    );

    expect(output.toolOutputs).toHaveLength(1);
    const text = output.toolOutputs[0]?.text ?? "";
    expect(text).toContain("[ExecDistilled]");
    expect(text).toContain("status: failed");
    expect(text.length).toBeLessThan(noisyOutput.length);
  });

  test("given tool execution updates, when collecting output, then streamed chunk uses distilled text", async () => {
    const noisyPartial = Array.from({ length: 200 }, (_value, index) =>
      index % 22 === 0 ? `error at step ${index}: timeout` : `line ${index}: running`,
    ).join("\n");
    const session = createSessionMock([
      {
        type: "tool_execution_update",
        toolCallId: "tc-gw-update",
        toolName: "exec",
        partialResult: noisyPartial,
      } as AgentSessionEvent,
      {
        type: "tool_execution_end",
        toolCallId: "tc-gw-update",
        toolName: "exec",
        result: "done",
        isError: false,
      } as AgentSessionEvent,
    ]);

    const chunks: SessionStreamChunk[] = [];
    await collectSessionPromptOutput(
      session as unknown as Parameters<typeof collectSessionPromptOutput>[0],
      "hello",
      {
        onChunk: (chunk) => {
          chunks.push(chunk);
        },
      },
    );

    const toolUpdateChunk = chunks.find((chunk) => chunk.kind === "tool_update");
    expect(toolUpdateChunk).toBeDefined();
    if (!toolUpdateChunk || toolUpdateChunk.kind !== "tool_update") {
      return;
    }
    expect(toolUpdateChunk.text).toContain("[ExecDistilled]");
  });

  test("given explicit fail verdict with successful tool channel, when collecting output, then gateway preserves the verdict", async () => {
    const noisyOutput = Array.from({ length: 180 }, (_value, index) =>
      index % 25 === 0 ? `error at step ${index}: timeout` : `line ${index}: working`,
    ).join("\n");
    const session = createSessionMock([
      {
        type: "tool_execution_end",
        toolCallId: "tc-gw-fail-verdict",
        toolName: "exec",
        result: {
          content: [{ type: "text", text: noisyOutput }],
          details: { verdict: "fail" },
        },
        isError: false,
      } as AgentSessionEvent,
    ]);

    const output = await collectSessionPromptOutput(
      session as unknown as Parameters<typeof collectSessionPromptOutput>[0],
      "hello",
    );

    expect(output.toolOutputs).toHaveLength(1);
    expect(output.toolOutputs[0]?.verdict).toBe("fail");
    expect(output.toolOutputs[0]?.text).toContain("status: failed");
  });
});
