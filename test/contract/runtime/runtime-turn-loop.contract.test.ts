import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { RuntimeProviderPort, RuntimeToolExecutorPort } from "@brewva/brewva-runtime";

const NOOP_TOOL_EXECUTOR: RuntimeToolExecutorPort = {
  async execute() {
    return { ok: true, content: "" };
  },
};

describe("runtime turn loop", () => {
  test("owns the default turn lifecycle and commits canonical events", async () => {
    const provider: RuntimeProviderPort = {
      async *stream() {},
    };
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-")),
      physics: { mode: "real", provider, toolExecutor: NOOP_TOOL_EXECUTOR },
    });

    const frames = await Array.fromAsync(
      runtime.turn({
        sessionId: "s1",
        prompt: "hello",
      }),
    );

    expect(frames.map((frame) => frame.type)).toEqual(["runtime.event", "runtime.event"]);
    expect(runtime.tape.list("s1").map((event) => event.type)).toEqual([
      "turn.started",
      "turn.ended",
    ]);
    expect(runtime.tape.project("s1", "turn_state")).toMatchObject({
      sessionId: "s1",
      active: false,
      lastCause: "terminal_commit",
    });
  });

  test("streams provider text through runtime.turn and commits one assistant message", async () => {
    const provider: RuntimeProviderPort = {
      async *stream() {
        yield { type: "text", delta: "hello" };
        yield { type: "text", delta: " world" };
      },
    };
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-provider-")),
      physics: {
        mode: "real",
        provider,
        toolExecutor: NOOP_TOOL_EXECUTOR,
      },
    });

    const frames = await Array.fromAsync(
      runtime.turn({
        sessionId: "s1",
        prompt: "hello",
      }),
    );

    expect(frames.map((frame) => frame.type)).toEqual([
      "runtime.event",
      "text",
      "text",
      "runtime.event",
      "runtime.event",
    ]);
    expect(runtime.tape.list("s1").map((event) => event.type)).toEqual([
      "turn.started",
      "msg.committed",
      "turn.ended",
    ]);
    expect(runtime.tape.list("s1", { type: "msg.committed" })[0]?.payload).toEqual({
      text: "hello world",
    });
  });

  test("preserves structured user prompt content in tape and model materialization", async () => {
    let observedContent: unknown;
    const provider: RuntimeProviderPort = {
      async *stream(input) {
        observedContent = input.prompt.messages.find((message) => message.role === "user")?.content;
        yield { type: "text", delta: "received" };
      },
    };
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-structured-prompt-")),
      physics: {
        mode: "real",
        provider,
        toolExecutor: NOOP_TOOL_EXECUTOR,
      },
    });
    const prompt = [
      { type: "text" as const, text: "inspect " },
      { type: "image" as const, data: "base64-image", mimeType: "image/png" },
      {
        type: "file" as const,
        uri: "file:///workspace/spec.md",
        name: "spec.md",
        mimeType: "text/markdown",
        displayText: "spec file",
      },
    ];

    await Array.fromAsync(
      runtime.turn({
        sessionId: "s1",
        prompt,
      }),
    );

    expect(observedContent).toEqual(prompt);
    expect(runtime.tape.list("s1", { type: "turn.started" })[0]?.payload).toEqual({
      prompt: "inspect spec file",
      content: prompt,
    });
  });

  test("streams provider reasoning through runtime.turn and commits one reasoning message", async () => {
    const provider: RuntimeProviderPort = {
      async *stream() {
        yield { type: "reason", delta: "think" };
        yield { type: "reason", delta: "ing" };
        yield { type: "text", delta: "done" };
      },
    };
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-reason-")),
      physics: {
        mode: "real",
        provider,
        toolExecutor: NOOP_TOOL_EXECUTOR,
      },
    });

    const frames = await Array.fromAsync(
      runtime.turn({
        sessionId: "s1",
        prompt: "hello",
      }),
    );

    expect(frames.map((frame) => frame.type)).toEqual([
      "runtime.event",
      "reason",
      "reason",
      "text",
      "runtime.event",
      "runtime.event",
      "runtime.event",
    ]);
    expect(runtime.tape.list("s1").map((event) => event.type)).toEqual([
      "turn.started",
      "reason.committed",
      "msg.committed",
      "turn.ended",
    ]);
    expect(runtime.tape.list("s1", { type: "reason.committed" })[0]?.payload).toEqual({
      text: "thinking",
    });
  });

  test("continues provider generation after committed tool results", async () => {
    let calls = 0;
    const observedMessageRoles: string[][] = [];
    const provider: RuntimeProviderPort = {
      async *stream(input) {
        calls += 1;
        observedMessageRoles.push(input.prompt.messages.map((message) => message.role));
        if (calls === 2) {
          expect(input.prompt.messages).toEqual([
            { role: "user", content: "read" },
            {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  toolCallId: "call-1",
                  toolName: "read_file",
                  args: { path: "README.md" },
                },
              ],
            },
            {
              role: "tool",
              content: "executed:read_file:call-1",
              toolCallId: "call-1",
              toolName: "read_file",
              isError: false,
            },
          ]);
          yield { type: "text", delta: "read complete" };
          return;
        }
        yield {
          type: "tool",
          call: {
            toolCallId: "call-1",
            toolName: "read_file",
            args: { path: "README.md" },
          },
        };
      },
    };
    const toolExecutor: RuntimeToolExecutorPort = {
      async execute(commitment, input) {
        await input.onProgress?.({
          ok: true,
          content: [{ type: "text", text: "starting tool" }],
          metadata: { verdict: "inconclusive" },
        });
        await input.onProgress?.({
          ok: true,
          content: [{ type: "text", text: "reading README.md" }],
          metadata: { verdict: "inconclusive" },
        });
        return {
          ok: true,
          content: `executed:${commitment.call.toolName}:${commitment.call.toolCallId}`,
        };
      },
    };
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-tool-")),
      physics: {
        mode: "real",
        provider,
        toolExecutor,
      },
    });

    const frames = await Array.fromAsync(
      runtime.turn({
        sessionId: "s1",
        prompt: "read",
      }),
    );

    expect(frames.map((frame) => frame.type)).toEqual([
      "runtime.event",
      "runtime.event",
      "tool.progress",
      "tool.progress",
      "runtime.event",
      "text",
      "runtime.event",
      "runtime.event",
    ]);
    expect(calls).toBe(2);
    expect(observedMessageRoles).toEqual([["user"], ["user", "assistant", "tool"]]);
    expect(runtime.tape.list("s1").map((event) => event.type)).toEqual([
      "turn.started",
      "tool.proposed",
      "tool.committed",
      "msg.committed",
      "turn.ended",
    ]);
    expect(runtime.tape.list("s1", { type: "tool.committed" })[0]?.payload).toMatchObject({
      commitmentId: expect.stringMatching(/^tool:s1:turn_[^:]+:call-1$/u),
      result: { ok: true, content: "executed:read_file:call-1" },
    });
    expect(runtime.tape.list("s1", { type: "msg.committed" })[0]?.payload).toEqual({
      text: "read complete",
    });
  });

  test("does not treat pre-tool assistant text as the terminal answer", async () => {
    let calls = 0;
    const provider: RuntimeProviderPort = {
      async *stream() {
        calls += 1;
        if (calls === 2) {
          yield { type: "text", delta: "Architecture docs live under docs/architecture." };
          return;
        }
        yield { type: "text", delta: "Let me search first." };
        yield {
          type: "tool",
          call: {
            toolCallId: "call-arch",
            toolName: "grep",
            args: { query: "architecture" },
          },
        };
      },
    };
    const toolExecutor: RuntimeToolExecutorPort = {
      async execute() {
        return {
          ok: true,
          content: "docs/architecture/system-architecture.md",
        };
      },
    };
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-pre-tool-text-")),
      physics: {
        mode: "real",
        provider,
        toolExecutor,
      },
    });

    await Array.fromAsync(
      runtime.turn({
        sessionId: "s1",
        prompt: "show architecture docs",
      }),
    );

    expect(calls).toBe(2);
    expect(runtime.tape.list("s1").map((event) => event.type)).toEqual([
      "turn.started",
      "msg.committed",
      "tool.proposed",
      "tool.committed",
      "msg.committed",
      "turn.ended",
    ]);
    expect(
      runtime.tape.list("s1", { type: "msg.committed" }).map((event) => event.payload),
    ).toEqual([
      { text: "Let me search first." },
      { text: "Architecture docs live under docs/architecture." },
    ]);
  });

  test("commits post-tool assistant text before continuing provider generation", async () => {
    let calls = 0;
    const provider: RuntimeProviderPort = {
      async *stream() {
        calls += 1;
        if (calls === 2) {
          yield { type: "text", delta: "Final answer." };
          return;
        }
        yield {
          type: "tool",
          call: {
            toolCallId: "call-post-tool",
            toolName: "grep",
            args: { query: "runtime" },
          },
        };
        yield { type: "text", delta: "Tool result is available." };
      },
    };
    const toolExecutor: RuntimeToolExecutorPort = {
      async execute() {
        return {
          ok: true,
          content: "packages/brewva-runtime/src/runtime/turn/impl.ts",
        };
      },
    };
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-post-tool-text-")),
      physics: {
        mode: "real",
        provider,
        toolExecutor,
      },
    });

    await Array.fromAsync(
      runtime.turn({
        sessionId: "s1",
        prompt: "inspect runtime",
      }),
    );

    expect(calls).toBe(2);
    expect(runtime.tape.list("s1").map((event) => event.type)).toEqual([
      "turn.started",
      "tool.proposed",
      "tool.committed",
      "msg.committed",
      "msg.committed",
      "turn.ended",
    ]);
    expect(
      runtime.tape.list("s1", { type: "msg.committed" }).map((event) => event.payload),
    ).toEqual([{ text: "Tool result is available." }, { text: "Final answer." }]);
  });

  test("suspends approval-required tool calls after recording the proposed call", async () => {
    const provider: RuntimeProviderPort = {
      async *stream() {
        yield {
          type: "tool",
          call: {
            toolCallId: "call-approval",
            toolName: "write_file",
            approval: {
              required: true,
              reason: "requires_operator_approval",
            },
          },
        };
      },
    };
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-approval-")),
      physics: {
        mode: "real",
        provider,
        toolExecutor: NOOP_TOOL_EXECUTOR,
      },
    });

    const frames = await Array.fromAsync(
      runtime.turn({
        sessionId: "s1",
        prompt: "write",
      }),
    );

    expect(frames.map((frame) => frame.type)).toEqual([
      "runtime.event",
      "runtime.event",
      "runtime.event",
      "runtime.event",
      "runtime.suspended",
    ]);
    expect(runtime.tape.list("s1").map((event) => event.type)).toEqual([
      "turn.started",
      "tool.proposed",
      "approval.requested",
      "runtime.suspended",
    ]);
    expect(runtime.tape.project("s1", "recovery_history")).toMatchObject({
      causes: ["approval_pending"],
    });
  });

  test("suspends policy-gated tool calls before the executor can run", async () => {
    let executed = false;
    const provider: RuntimeProviderPort = {
      async *stream() {
        yield {
          type: "tool",
          call: {
            toolCallId: "call-policy",
            toolName: "exec",
            args: { command: "echo unsafe" },
          },
        };
      },
    };
    const toolExecutor: RuntimeToolExecutorPort = {
      async execute() {
        executed = true;
        return { ok: true, content: "should not execute" };
      },
    };
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-policy-")),
      physics: {
        mode: "real",
        provider,
        toolExecutor,
      },
    });

    const frames = await Array.fromAsync(
      runtime.turn({
        sessionId: "s1",
        prompt: "run command",
      }),
    );

    expect(executed).toBe(false);
    expect(frames.map((frame) => frame.type)).toEqual([
      "runtime.event",
      "runtime.event",
      "runtime.event",
      "runtime.event",
      "runtime.suspended",
    ]);
    expect(runtime.tape.list("s1").map((event) => event.type)).toEqual([
      "turn.started",
      "tool.proposed",
      "approval.requested",
      "runtime.suspended",
    ]);
    expect(runtime.tape.list("s1", { type: "approval.requested" })[0]?.payload).toMatchObject({
      reason: "tool_action_policy_requires_operator_approval",
      authority: {
        normalizedToolName: "exec",
        effectiveAdmission: "ask",
      },
    });
  });

  test("records and retries an empty provider failure once", async () => {
    let calls = 0;
    const provider: RuntimeProviderPort = {
      async *stream() {
        calls += 1;
        if (calls === 1) {
          throw new Error("temporary_provider_failure");
        }
        yield { type: "text", delta: "recovered" };
      },
    };
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-provider-retry-")),
      physics: {
        mode: "real",
        provider,
        toolExecutor: NOOP_TOOL_EXECUTOR,
      },
    });

    const frames = await Array.fromAsync(
      runtime.turn({
        sessionId: "s1",
        prompt: "hello",
      }),
    );

    expect(frames.map((frame) => frame.type)).toEqual([
      "runtime.event",
      "runtime.event",
      "text",
      "runtime.event",
      "runtime.event",
    ]);
    expect(calls).toBe(2);
    expect(runtime.tape.list("s1").map((event) => event.type)).toEqual([
      "turn.started",
      "runtime.suspended",
      "msg.committed",
      "turn.ended",
    ]);
    expect(runtime.tape.project("s1", "recovery_history")).toMatchObject({
      causes: ["provider_retry", "terminal_commit"],
    });
  });

  test("does not provider-retry after a tool side effect has been committed", async () => {
    let calls = 0;
    const provider: RuntimeProviderPort = {
      async *stream() {
        calls += 1;
        yield {
          type: "tool",
          call: {
            toolCallId: "call-side-effect",
            toolName: "read_file",
            args: { path: "README.md" },
          },
        };
        throw new Error("provider_failed_after_tool");
      },
    };
    const toolExecutor: RuntimeToolExecutorPort = {
      async execute(commitment) {
        return {
          ok: true,
          content: `executed:${commitment.call.toolName}:${commitment.call.toolCallId}`,
        };
      },
    };
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-no-retry-after-tool-")),
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
          prompt: "read",
        }),
      );
      expect.unreachable("expected provider failure after a committed tool");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("provider_failed_after_tool");
    }

    expect(calls).toBe(1);
    expect(runtime.tape.list("s1").map((event) => event.type)).toEqual([
      "turn.started",
      "tool.proposed",
      "tool.committed",
      "turn.ended",
    ]);
    expect(runtime.tape.list("s1", { type: "turn.ended" })[0]?.payload).toEqual({
      cause: "terminal_commit",
      status: "failed",
      error: "provider_failed_after_tool",
    });
  });

  test("does not provider-retry a failed continuation after a committed tool", async () => {
    let calls = 0;
    const provider: RuntimeProviderPort = {
      async *stream() {
        calls += 1;
        if (calls === 2) {
          throw new Error("continuation_failed_after_tool");
        }
        yield {
          type: "tool",
          call: {
            toolCallId: "call-side-effect",
            toolName: "read_file",
            args: { path: "README.md" },
          },
        };
      },
    };
    const toolExecutor: RuntimeToolExecutorPort = {
      async execute(commitment) {
        return {
          ok: true,
          content: `executed:${commitment.call.toolName}:${commitment.call.toolCallId}`,
        };
      },
    };
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-no-retry-continuation-")),
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
          prompt: "read",
        }),
      );
      expect.unreachable("expected provider failure on tool continuation");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("continuation_failed_after_tool");
    }

    expect(calls).toBe(2);
    expect(runtime.tape.list("s1").map((event) => event.type)).toEqual([
      "turn.started",
      "tool.proposed",
      "tool.committed",
      "turn.ended",
    ]);
    expect(runtime.tape.list("s1", { type: "turn.ended" })[0]?.payload).toEqual({
      cause: "terminal_commit",
      status: "failed",
      error: "continuation_failed_after_tool",
    });
  });

  test("commits a failed terminal receipt when provider tool continuations exceed the turn limit", async () => {
    let calls = 0;
    let executedTools = 0;
    const provider: RuntimeProviderPort = {
      async *stream() {
        calls += 1;
        yield {
          type: "tool",
          call: {
            toolCallId: `call-loop-${calls}`,
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
          ok: true,
          content: `executed:${commitment.call.toolCallId}`,
        };
      },
    };
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-tool-limit-")),
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
      expect((error as Error).message).toContain("provider_tool_continuation_limit_exceeded");
    }

    expect(calls).toBe(17);
    expect(executedTools).toBe(16);
    expect(
      runtime.tape
        .list("s1")
        .map((event) => event.type)
        .at(-1),
    ).toBe("turn.ended");
    expect(runtime.tape.list("s1", { type: "turn.ended" })[0]?.payload).toEqual({
      cause: "terminal_commit",
      status: "failed",
      error: "provider_tool_continuation_limit_exceeded",
    });
    expect(runtime.tape.project("s1", "turn_state")).toMatchObject({
      active: false,
      lastCause: "terminal_commit",
    });
  });

  test("checkpoints and retries materialization when context is over budget", async () => {
    const provider: RuntimeProviderPort = {
      async *stream() {},
    };
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-compaction-")),
      physics: { mode: "real", provider, toolExecutor: NOOP_TOOL_EXECUTOR },
    });
    await runtime.kernel.beginToolCall({
      sessionId: "s1",
      toolCallId: "large-call",
      toolName: "read",
      args: { content: "x".repeat(2_000) },
    });

    await Array.fromAsync(
      runtime.turn({
        sessionId: "s1",
        prompt: "hello",
        budget: { maxInputTokens: 500 },
      }),
    );

    expect(runtime.tape.list("s1").map((event) => event.type)).toContain("checkpoint.committed");
    expect(runtime.tape.project("s1", "recovery_history")).toMatchObject({
      causes: ["compaction_required", "terminal_commit"],
    });
    expect(
      await runtime.model.materialize({
        sessionId: "s1",
        budget: { maxInputTokens: 500 },
      }),
    ).toMatchObject({
      status: "ready",
    });
    const prompt = await runtime.model.materialize({
      sessionId: "s1",
      budget: { maxInputTokens: 100_000 },
    });
    expect(prompt.messages[0]).toMatchObject({
      role: "system",
      content: expect.stringContaining("user: hello"),
    });
  });

  test("records interrupt suspension without committing terminal output", async () => {
    const provider: RuntimeProviderPort = {
      async *stream() {},
    };
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-interrupt-")),
      physics: { mode: "real", provider, toolExecutor: NOOP_TOOL_EXECUTOR },
    });
    const controller = new AbortController();
    controller.abort();

    const frames = await Array.fromAsync(
      runtime.turn({
        sessionId: "s1",
        prompt: "hello",
        signal: controller.signal,
      }),
    );

    expect(frames.map((frame) => frame.type)).toEqual([
      "runtime.event",
      "runtime.event",
      "runtime.suspended",
    ]);
    expect(runtime.tape.list("s1").map((event) => event.type)).toEqual([
      "turn.started",
      "runtime.suspended",
    ]);
  });
});
