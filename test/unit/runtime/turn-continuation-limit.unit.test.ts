import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { RuntimeProviderPort, RuntimeToolExecutorPort } from "@brewva/brewva-runtime";

describe("runtime turn provider tool continuation limit", () => {
  test("allows the final answer pass after the maximum tool continuation passes", async () => {
    let providerCalls = 0;
    let executedTools = 0;
    const provider: RuntimeProviderPort = {
      async *stream() {
        providerCalls += 1;
        if (providerCalls <= 16) {
          yield {
            type: "tool",
            call: {
              toolCallId: `call-${providerCalls}`,
              toolName: "read_file",
              args: { path: "README.md" },
            },
          };
          return;
        }
        yield { type: "text", delta: "done" };
      },
    };
    const toolExecutor: RuntimeToolExecutorPort = {
      async execute(commitment) {
        executedTools += 1;
        return {
          outcome: { kind: "ok", value: {} },
          content: `executed:${commitment.call.toolCallId}`,
        };
      },
    };
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-limit-final-answer-")),
      physics: {
        mode: "real",
        provider,
        toolExecutor,
      },
    });

    const frames = await Array.fromAsync(
      runtime.turn({
        sessionId: "s1",
        prompt: "use tools then answer",
      }),
    );

    expect(providerCalls).toBe(17);
    expect(executedTools).toBe(16);
    expect(frames).toContainEqual({ type: "text", delta: "done" });
    expect(runtime.tape.list("s1", { type: "tool.committed" })).toHaveLength(16);
    expect(runtime.tape.list("s1", { type: "turn.ended" }).at(-1)?.payload).toEqual({
      cause: "terminal_commit",
    });
  });

  test("rejects the next tool request after the maximum continuation passes", async () => {
    let providerCalls = 0;
    let executedTools = 0;
    const provider: RuntimeProviderPort = {
      async *stream() {
        providerCalls += 1;
        yield {
          type: "tool",
          call: {
            toolCallId: `call-${providerCalls}`,
            toolName: "read_file",
            args: { path: "README.md" },
          },
        };
      },
    };
    const toolExecutor: RuntimeToolExecutorPort = {
      async execute(commitment) {
        executedTools += 1;
        return {
          outcome: { kind: "ok", value: {} },
          content: `executed:${commitment.call.toolCallId}`,
        };
      },
    };
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-limit-reject-")),
      physics: {
        mode: "real",
        provider,
        toolExecutor,
      },
    });

    try {
      await Array.fromAsync(
        runtime.turn({
          sessionId: "s1",
          prompt: "loop forever",
        }),
      );
      expect.unreachable("expected provider continuation limit failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("provider_tool_continuation_limit_exceeded");
    }

    expect(providerCalls).toBe(17);
    expect(executedTools).toBe(16);
    expect(runtime.tape.list("s1", { type: "turn.ended" }).at(-1)?.payload).toEqual({
      cause: "terminal_commit",
      status: "failed",
      error: "provider_tool_continuation_limit_exceeded",
    });
  });
});
