import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { RuntimeProviderPort, RuntimeToolExecutorPort } from "@brewva/brewva-runtime";

const LIMIT = 4;

describe("runtime turn provider tool continuation limit", () => {
  test("allows the final answer pass after the maximum tool continuation passes", async () => {
    let providerCalls = 0;
    let executedTools = 0;
    const provider: RuntimeProviderPort = {
      async *stream() {
        providerCalls += 1;
        if (providerCalls <= LIMIT) {
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
      maxProviderToolContinuationsPerTurn: LIMIT,
    });

    const frames = await Array.fromAsync(
      runtime.turn({
        sessionId: "s1",
        prompt: "use tools then answer",
      }),
    );

    expect(providerCalls).toBe(LIMIT + 1);
    expect(executedTools).toBe(LIMIT);
    expect(frames).toContainEqual({ type: "text", delta: "done" });
    expect(runtime.tape.list("s1", { type: "tool.committed" })).toHaveLength(LIMIT);
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
      maxProviderToolContinuationsPerTurn: LIMIT,
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

    expect(providerCalls).toBe(LIMIT + 1);
    expect(executedTools).toBe(LIMIT);
    expect(runtime.tape.list("s1", { type: "turn.ended" }).at(-1)?.payload).toEqual({
      cause: "terminal_commit",
      status: "failed",
      error: "provider_tool_continuation_limit_exceeded",
    });
  });
  test("the default limit is generous enough for long real turns", async () => {
    // Regression guard: the default backstop must not strangle realistic
    // multi-tool turns. A turn doing 30 tool rounds (well past the old cap
    // of 16) must reach its final answer rather than fail.
    const TOOL_ROUNDS = 30;
    let providerCalls = 0;
    const provider: RuntimeProviderPort = {
      async *stream() {
        providerCalls += 1;
        if (providerCalls <= TOOL_ROUNDS) {
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
        return {
          outcome: { kind: "ok", value: {} },
          content: `executed:${commitment.call.toolCallId}`,
        };
      },
    };
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-limit-default-")),
      physics: {
        mode: "real",
        provider,
        toolExecutor,
      },
    });

    const frames = await Array.fromAsync(
      runtime.turn({ sessionId: "s1", prompt: "use many tools then answer" }),
    );

    expect(providerCalls).toBe(TOOL_ROUNDS + 1);
    expect(frames).toContainEqual({ type: "text", delta: "done" });
    expect(runtime.tape.list("s1", { type: "turn.ended" }).at(-1)?.payload).toEqual({
      cause: "terminal_commit",
    });
  });
});
