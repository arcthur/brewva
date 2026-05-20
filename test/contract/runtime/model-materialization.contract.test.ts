import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
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
        role: "tool",
        content: "tool-result",
        toolCallId: "call-1",
        toolName: "read_file",
        isError: false,
      },
    ]);
  });
});
