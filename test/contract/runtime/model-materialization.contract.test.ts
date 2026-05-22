import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";

describe("model materialization", () => {
  test("materializes prompt state from tape and budget", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-model-materialization-")),
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

  test("proposes checkpoint candidates without committing them", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-model-checkpoint-")),
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
        ok: true,
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
  });

  test("materializes empty tool results when call metadata is present", async () => {
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-model-empty-tool-result-")),
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
      result: {
        ok: true,
        content: "",
      },
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
            result: { ok: true, content: "orphan result" },
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

    const runtime = createBrewvaRuntime({ cwd });
    await runtime.start();

    const prompt = await runtime.model.materialize({
      sessionId,
      budget: { maxInputTokens: 100_000 },
    });

    expect(prompt.messages).toEqual([{ role: "user", content: "hello" }]);

    await runtime.close();
  });
});
