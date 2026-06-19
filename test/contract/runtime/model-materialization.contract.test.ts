import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBrewvaRuntime,
  type RuntimeProviderPort,
  type RuntimeToolExecutorPort,
} from "@brewva/brewva-runtime";

const SILENT_PROVIDER: RuntimeProviderPort = {
  async *stream() {},
};

const NOOP_TOOL_EXECUTOR: RuntimeToolExecutorPort = {
  async execute() {
    return { outcome: { kind: "ok", value: {} }, content: "" };
  },
};

describe("model materialization", () => {
  test("materializes prompt state from tape and budget", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-model-materialization-")),
      physics: { mode: "noop" },
    });
    await runtime.kernel.beginToolCall({
      sessionId: "s1",
      toolCallId: "call-1",
      toolName: "read_file",
      args: { path: "README.md" },
    });

    const ready = await runtime.model.materialize({
      sessionId: "s1",
      budget: { maxInputTokens: 100_000 },
    });
    expect(ready.status).toBe("ready");
    expect(ready.admittedBlocks.map((block) => block.kind)).toEqual(["tool.proposed"]);
    expect(ready.messages).toEqual([]);

    const overWindow = await runtime.model.materialize({
      sessionId: "s1",
      budget: { maxInputTokens: 1 },
    });
    expect(overWindow.status).toBe("over_window");
  });

  test("records materialization observation evidence without changing prompt ownership", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-model-materialization-observation-")),
      physics: { mode: "noop" },
    });
    await runtime.kernel.beginToolCall({
      sessionId: "s1",
      toolCallId: "call-1",
      toolName: "read_file",
      args: { path: "README.md" },
    });

    expect(runtime.model.observe.materialization.list()).toEqual([]);
    const prompt = await runtime.model.materialize({
      sessionId: "s1",
      budget: { maxInputTokens: 100_000 },
    });

    const observations = runtime.model.observe.materialization.list({ sessionId: "s1" });
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      sequence: 0,
      sessionId: "s1",
      status: "ready",
      sourceEventIds: prompt.admittedBlocks.map((block) => block.id),
      admittedBlockIds: prompt.admittedBlocks.map((block) => block.id),
      droppedAdvisoryBlockIds: [],
      tokenEstimate: prompt.tokenEstimate,
      cache: prompt.cache,
      budget: { maxInputTokens: 100_000 },
    });
    expect(runtime.model.observe.materialization.list({ sessionId: "missing" })).toEqual([]);
  });

  test("proposes checkpoint candidates without committing them", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-model-checkpoint-")),
      physics: { mode: "real", provider: SILENT_PROVIDER, toolExecutor: NOOP_TOOL_EXECUTOR },
    });
    await Array.fromAsync(
      runtime.turn({
        sessionId: "s1",
        prompt: "hello",
      }),
    );

    const candidate = await runtime.model.proposeCheckpoint({
      sessionId: "s1",
      reason: "compaction_required",
    });

    expect(candidate).toMatchObject({
      eventCount: 2,
    });
    expect(candidate.sourceEventIds).toHaveLength(2);
    expect(runtime.tape.list("s1", { type: "checkpoint.committed" })).toEqual([]);
  });

  test("derives conversational prompt messages from committed tape facts", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-model-materialization-messages-")),
      physics: { mode: "real", provider: SILENT_PROVIDER, toolExecutor: NOOP_TOOL_EXECUTOR },
    });

    await Array.fromAsync(
      runtime.turn({
        sessionId: "s1",
        prompt: "hello there",
      }),
    );
    const commitment = await runtime.kernel.beginToolCall({
      sessionId: "s1",
      toolCallId: "call-1",
      toolName: "read_file",
      args: { path: "README.md" },
    });
    if (commitment.kind !== "allow") {
      throw new Error("expected_tool_allow");
    }
    await runtime.kernel.commitToolResult({
      commitmentId: commitment.commitment.id,
      result: {
        outcome: { kind: "ok", value: {} },
        content: [{ type: "text", text: "tool-result" }],
      },
    });

    const prompt = await runtime.model.materialize({
      sessionId: "s1",
      budget: { maxInputTokens: 100_000 },
    });

    expect(prompt.messages).toEqual([
      { role: "user", content: "hello there" },
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
        content: "tool-result",
        toolCallId: "call-1",
        toolName: "read_file",
        isError: false,
      },
    ]);
    const turnStartedEvent = runtime.tape.list("s1", { type: "turn.started" })[0];
    const toolCommittedEvent = runtime.tape.list("s1", { type: "tool.committed" })[0];
    if (!turnStartedEvent || !toolCommittedEvent) {
      throw new Error("expected_materialized_source_events");
    }
    expect(prompt.messageSourceEventIds).toEqual([
      turnStartedEvent.id,
      toolCommittedEvent.id,
      toolCommittedEvent.id,
    ]);
  });

  test("derives provider isError from typed outcome kind", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-model-outcome-error-projection-")),
      physics: { mode: "real", provider: SILENT_PROVIDER, toolExecutor: NOOP_TOOL_EXECUTOR },
    });

    await Array.fromAsync(
      runtime.turn({
        sessionId: "s1",
        prompt: "run tools",
      }),
    );

    const errorCommitment = await runtime.kernel.beginToolCall({
      sessionId: "s1",
      toolCallId: "call-error",
      toolName: "read_file",
      args: { path: "missing.md" },
    });
    if (errorCommitment.kind !== "allow") {
      throw new Error("expected_tool_allow");
    }
    await runtime.kernel.commitToolResult({
      commitmentId: errorCommitment.commitment.id,
      result: {
        outcome: { kind: "err", error: { message: "missing" } },
        content: "missing",
      },
    });

    const inconclusiveCommitment = await runtime.kernel.beginToolCall({
      sessionId: "s1",
      toolCallId: "call-inconclusive",
      toolName: "grep",
      args: { query: "TODO" },
    });
    if (inconclusiveCommitment.kind !== "allow") {
      throw new Error("expected_tool_allow");
    }
    await runtime.kernel.commitToolResult({
      commitmentId: inconclusiveCommitment.commitment.id,
      result: {
        outcome: { kind: "inconclusive", value: { reason: "partial" } },
        content: "partial",
      },
    });

    const prompt = await runtime.model.materialize({
      sessionId: "s1",
      budget: { maxInputTokens: 100_000 },
    });

    const toolMessages = prompt.messages.filter((message) => message.role === "tool");
    expect(toolMessages).toContainEqual({
      role: "tool",
      content: "missing",
      toolCallId: "call-error",
      toolName: "read_file",
      isError: true,
    });
    expect(toolMessages).toContainEqual({
      role: "tool",
      content: "partial",
      toolCallId: "call-inconclusive",
      toolName: "grep",
      isError: false,
    });
  });

  test("materializes empty tool results when call metadata is present", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-model-empty-tool-result-")),
      physics: { mode: "real", provider: SILENT_PROVIDER, toolExecutor: NOOP_TOOL_EXECUTOR },
    });

    await Array.fromAsync(
      runtime.turn({
        sessionId: "s1",
        prompt: "run empty tool",
      }),
    );
    const commitment = await runtime.kernel.beginToolCall({
      sessionId: "s1",
      toolCallId: "call-empty",
      toolName: "read_file",
      args: { path: "EMPTY.md" },
    });
    if (commitment.kind !== "allow") {
      throw new Error("expected_tool_allow");
    }
    await runtime.kernel.commitToolResult({
      commitmentId: commitment.commitment.id,
      result: { outcome: { kind: "ok", value: {} }, content: "" },
    });

    const prompt = await runtime.model.materialize({
      sessionId: "s1",
      budget: { maxInputTokens: 100_000 },
    });

    expect(prompt.messages).toEqual([
      { role: "user", content: "run empty tool" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            toolCallId: "call-empty",
            toolName: "read_file",
            args: { path: "EMPTY.md" },
          },
        ],
      },
      {
        role: "tool",
        content: "",
        toolCallId: "call-empty",
        toolName: "read_file",
        isError: false,
      },
    ]);
  });

  test("does not materialize orphan tool result messages without call metadata", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-model-orphan-tool-messages-"));
    const sessionId = "s1";
    const tapeDir = join(cwd, ".brewva", "tape");
    mkdirSync(tapeDir, { recursive: true });
    writeFileSync(
      join(tapeDir, `${encodeURIComponent(sessionId)}.jsonl`),
      [
        {
          id: "evt-user",
          sessionId,
          type: "turn.started",
          timestamp: 1,
          payload: { prompt: "hello" },
        },
        {
          id: "evt-orphan-tool-result",
          sessionId,
          type: "tool.committed",
          timestamp: 2,
          payload: {
            commitmentId: "commitment-orphan",
            result: { outcome: { kind: "ok", value: {} }, content: "orphan result" },
          },
        },
        {
          id: "evt-orphan-tool-abort",
          sessionId,
          type: "tool.aborted",
          timestamp: 3,
          payload: {
            commitmentId: "commitment-aborted",
            reason: "orphan abort",
          },
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n") + "\n",
    );

    const runtime = createBrewvaRuntime({ cwd, physics: { mode: "noop" } });
    await runtime.start();

    const prompt = await runtime.model.materialize({
      sessionId,
      budget: { maxInputTokens: 100_000 },
    });

    expect(prompt.messages).toEqual([{ role: "user", content: "hello" }]);

    await runtime.close();
  });
});
