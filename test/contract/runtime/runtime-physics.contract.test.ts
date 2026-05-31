import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type {
  BrewvaRuntimeOptions,
  CanonicalEvent,
  RuntimePhysicsDeclaration,
  RuntimeProviderPort,
  RuntimeToolExecutorPort,
} from "@brewva/brewva-runtime";

function tempCwd(label: string): string {
  return mkdtempSync(join(tmpdir(), `${label}-`));
}

function runtimeOptions(input: {
  readonly cwd: string;
  readonly physics: unknown;
}): BrewvaRuntimeOptions {
  return input as unknown as BrewvaRuntimeOptions;
}

function sourceEvents(): CanonicalEvent[] {
  return [
    {
      id: "evt-source-start",
      sessionId: "source-session",
      type: "turn.started",
      timestamp: 1,
      payload: {
        prompt: "recorded prompt",
        content: [{ type: "text", text: "recorded prompt" }],
      },
    },
    {
      id: "evt-source-msg",
      sessionId: "source-session",
      type: "msg.committed",
      timestamp: 2,
      payload: { text: "recorded answer" },
    },
  ];
}

const NOOP_TOOL_EXECUTOR: RuntimeToolExecutorPort = {
  async execute() {
    return { outcome: { kind: "ok", value: {} }, content: "" };
  },
};

describe("runtime physics declaration", () => {
  test("fails fast when runtime options are absent", () => {
    expect(() => createBrewvaRuntime(undefined as unknown as BrewvaRuntimeOptions)).toThrow(
      "runtime_options_required",
    );
  });

  test("fails fast when real physics has no provider", () => {
    expect(() =>
      createBrewvaRuntime(
        runtimeOptions({
          cwd: tempCwd("runtime-physics-real-missing-provider"),
          physics: { mode: "real" },
        }),
      ),
    ).toThrow("runtime_physics_real_requires_provider");
  });

  test("fails fast when real physics has no tool executor", () => {
    const provider: RuntimeProviderPort = {
      async *stream() {},
    };

    expect(() =>
      createBrewvaRuntime(
        runtimeOptions({
          cwd: tempCwd("runtime-physics-real-missing-tool-executor"),
          physics: { mode: "real", provider },
        }),
      ),
    ).toThrow("runtime_physics_real_requires_tool_executor");
  });

  test("keeps noop physics local and disables turn execution", async () => {
    const runtime = createBrewvaRuntime({
      cwd: tempCwd("runtime-physics-noop"),
      physics: { mode: "noop" },
    });

    const decision = await runtime.kernel.beginToolCall({
      sessionId: "noop-session",
      toolCallId: "call-1",
      toolName: "read_file",
    });
    expect(decision.kind).toBe("allow");
    expect(runtime.tape.list("noop-session").map((event) => event.type)).toEqual(["tool.proposed"]);

    try {
      await Array.fromAsync(runtime.turn({ sessionId: "noop-session", prompt: "hello" }));
      expect.unreachable("expected noop turn to be disabled");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("runtime_physics_noop_turn_disabled");
    }
  });

  test("replay physics is read-only and never accepts world ports", async () => {
    const events = sourceEvents();
    const provider: RuntimeProviderPort = {
      stream() {
        throw new Error("provider_must_not_run");
      },
    };

    expect(() =>
      createBrewvaRuntime(
        runtimeOptions({
          cwd: tempCwd("runtime-physics-replay-world-port"),
          physics: {
            mode: "replay",
            source: { sessionId: "source-session", events },
            provider,
          },
        }),
      ),
    ).toThrow("runtime_physics_replay_is_read_only");

    const runtime = createBrewvaRuntime({
      cwd: tempCwd("runtime-physics-replay"),
      physics: {
        mode: "replay",
        source: { sessionId: "source-session", events },
      },
    });

    expect(await runtime.start()).toEqual({ recoveredSessions: ["source-session"] });
    const frames = await Array.fromAsync(
      runtime.turn({ sessionId: "source-session", prompt: "ignored" }),
    );
    expect(frames).toEqual(events.map((event) => ({ type: "runtime.event", event })));
    expect(() =>
      runtime.kernel.recordAdvisoryEvent({
        sessionId: "source-session",
        namespace: "test.replay",
        kind: "write",
        version: 1,
        payload: {},
      }),
    ).toThrow("runtime_physics_replay_is_read_only");
  });

  test("replay-then-real forks replay prefix before touching the real provider", async () => {
    const events = sourceEvents();
    const sourceSnapshot = JSON.stringify(events);
    let providerCalls = 0;
    const provider: RuntimeProviderPort = {
      async *stream() {
        providerCalls += 1;
        yield { type: "text", delta: "forked answer" };
      },
    };

    const runtime = createBrewvaRuntime({
      cwd: tempCwd("runtime-physics-replay-then-real"),
      physics: {
        mode: "replay-then-real",
        source: { sessionId: "source-session", events },
        divergeAt: "evt-source-msg",
        target: { sessionId: "fork-session", forkTag: "phase-2" },
        provider,
        toolExecutor: NOOP_TOOL_EXECUTOR,
      },
    });

    const frames = await Array.fromAsync(
      runtime.turn({ sessionId: "fork-session", prompt: "continue from fork" }),
    );

    expect(providerCalls).toBe(1);
    expect(JSON.stringify(events)).toBe(sourceSnapshot);
    expect(frames.map((frame) => frame.type)).toEqual([
      "runtime.event",
      "runtime.event",
      "runtime.event",
      "text",
      "runtime.event",
      "runtime.event",
    ]);
    expect(
      frames
        .filter(
          (frame): frame is Extract<(typeof frames)[number], { type: "runtime.event" }> =>
            frame.type === "runtime.event",
        )
        .map((frame) => frame.event.sessionId),
    ).toEqual(["fork-session", "fork-session", "fork-session", "fork-session", "fork-session"]);
    expect(runtime.tape.list("source-session")).toEqual([]);
    expect(runtime.tape.list("fork-session").map((event) => event.type)).toEqual([
      "turn.started",
      "msg.committed",
      "turn.started",
      "msg.committed",
      "turn.ended",
    ]);
  });

  test("replay-then-real keeps persisted source tape intact when the target forks in the same workspace", async () => {
    const events = sourceEvents();
    const cwd = tempCwd("runtime-physics-replay-then-real-source-tape");
    const tapeDir = join(cwd, ".brewva/tape");
    mkdirSync(tapeDir, { recursive: true });
    writeFileSync(
      join(tapeDir, "source-session.jsonl"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    const provider: RuntimeProviderPort = {
      async *stream() {
        yield { type: "text", delta: "forked answer" };
      },
    };

    const runtime = createBrewvaRuntime({
      cwd,
      physics: {
        mode: "replay-then-real",
        source: { sessionId: "source-session", events },
        divergeAt: "evt-source-msg",
        target: { sessionId: "fork-session", forkTag: "phase-2" },
        provider,
        toolExecutor: NOOP_TOOL_EXECUTOR,
      },
    });

    await Array.fromAsync(runtime.turn({ sessionId: "fork-session", prompt: "continue" }));

    expect(runtime.tape.list("source-session").map((event) => event.id)).toEqual([
      "evt-source-start",
      "evt-source-msg",
    ]);
    expect(runtime.tape.list("fork-session").slice(0, 2)).toMatchObject([
      {
        id: "evt_replay_fork-session_evt-source-start",
        sessionId: "fork-session",
        type: "turn.started",
      },
      {
        id: "evt_replay_fork-session_evt-source-msg",
        sessionId: "fork-session",
        type: "msg.committed",
      },
    ]);
  });

  test("replay-then-real requires a distinct target session when the source is anchored", () => {
    expect(() =>
      createBrewvaRuntime({
        cwd: tempCwd("runtime-physics-replay-same-session"),
        physics: {
          mode: "replay-then-real",
          source: { sessionId: "source-session", events: sourceEvents() },
          divergeAt: "evt-source-msg",
          target: { sessionId: "source-session" },
          provider: {
            async *stream() {},
          },
          toolExecutor: NOOP_TOOL_EXECUTOR,
        } satisfies RuntimePhysicsDeclaration,
      }),
    ).toThrow("runtime_physics_replay_target_must_fork_session");
  });
});
