import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { RuntimeProviderPort, RuntimeToolExecutorPort } from "@brewva/brewva-runtime";

function createToolThenAnswerProvider(): { provider: RuntimeProviderPort; calls: () => number } {
  let providerCalls = 0;
  const provider: RuntimeProviderPort = {
    async *stream() {
      providerCalls += 1;
      if (providerCalls === 1) {
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
  return { provider, calls: () => providerCalls };
}

const toolExecutor: RuntimeToolExecutorPort = {
  async execute(commitment) {
    return {
      outcome: { kind: "ok", value: {} },
      content: `executed:${commitment.call.toolCallId}`,
    };
  },
};

describe("runtime turn compaction soft cut", () => {
  test("suspends at the complete tool-result boundary when softCut requests it", async () => {
    const { provider, calls } = createToolThenAnswerProvider();
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-soft-cut-")),
      physics: {
        mode: "real",
        provider,
        toolExecutor,
      },
    });

    let softCutPolls = 0;
    const frames = await Array.fromAsync(
      runtime.turn({
        sessionId: "s1",
        prompt: "use a tool",
        softCut: {
          afterToolResult: () => {
            softCutPolls += 1;
            return true;
          },
        },
      }),
    );

    expect(softCutPolls).toBe(1);
    expect(calls()).toBe(1);
    expect(frames).toContainEqual({ type: "runtime.suspended", cause: "compaction_required" });
    expect(runtime.tape.list("s1", { type: "tool.committed" })).toHaveLength(1);
    expect(runtime.tape.list("s1", { type: "turn.ended" })).toHaveLength(0);
    const suspended = runtime.tape.list("s1", { type: "runtime.suspended" }).at(-1);
    expect(suspended?.payload).toEqual({ cause: "compaction_required" });
  });

  test("resume continues the suspended turn without a second turn.started", async () => {
    const { provider, calls } = createToolThenAnswerProvider();
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-soft-cut-resume-")),
      physics: {
        mode: "real",
        provider,
        toolExecutor,
      },
    });

    let cutOnce = false;
    await Array.fromAsync(
      runtime.turn({
        sessionId: "s1",
        prompt: "use a tool",
        softCut: {
          afterToolResult: () => {
            if (cutOnce) {
              return false;
            }
            cutOnce = true;
            return true;
          },
        },
      }),
    );
    const startedEvents = runtime.tape.list("s1", { type: "turn.started" });
    expect(startedEvents).toHaveLength(1);
    const turnId = startedEvents.at(0)?.turnId;
    expect(typeof turnId).toBe("string");

    const resumeFrames = await Array.fromAsync(
      runtime.turn({
        sessionId: "s1",
        prompt: [],
        resume: { kind: "compaction", turnId: turnId as string },
        softCut: {
          afterToolResult: () => false,
        },
      }),
    );

    expect(calls()).toBe(2);
    expect(resumeFrames).toContainEqual({ type: "text", delta: "done" });
    expect(runtime.tape.list("s1", { type: "turn.started" })).toHaveLength(1);
    expect(runtime.tape.list("s1", { type: "turn.ended" }).at(-1)?.payload).toEqual({
      cause: "terminal_commit",
    });
  });

  test("rejects resume without a suspended compaction turn", async () => {
    const { provider } = createToolThenAnswerProvider();
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-soft-cut-orphan-")),
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
          prompt: [],
          resume: { kind: "compaction", turnId: "turn-without-suspension" },
        }),
      );
      expect.unreachable("expected compaction resume validation failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("compaction_resume_requires_suspended_compaction_turn");
    }
    expect(runtime.tape.list("s1", { type: "turn.started" })).toHaveLength(0);
  });

  test("rejects resume with an empty turn id", async () => {
    const { provider } = createToolThenAnswerProvider();
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-soft-cut-empty-id-")),
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
          prompt: [],
          resume: { kind: "compaction", turnId: "  " },
        }),
      );
      expect.unreachable("expected compaction resume turn-id failure");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("compaction_resume_requires_turn_id");
    }
  });

  test("does not suspend when softCut declines the boundary", async () => {
    const { provider, calls } = createToolThenAnswerProvider();
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-runtime-turn-soft-cut-decline-")),
      physics: {
        mode: "real",
        provider,
        toolExecutor,
      },
    });

    const frames = await Array.fromAsync(
      runtime.turn({
        sessionId: "s1",
        prompt: "use a tool",
        softCut: {
          afterToolResult: () => false,
        },
      }),
    );

    expect(calls()).toBe(2);
    expect(frames).toContainEqual({ type: "text", delta: "done" });
    expect(runtime.tape.list("s1", { type: "turn.ended" })).toHaveLength(1);
  });
});
