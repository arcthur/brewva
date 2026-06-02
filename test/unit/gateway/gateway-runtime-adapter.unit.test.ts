import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBrewvaRuntime,
  type RuntimeProviderPort,
  type RuntimeToolExecutorPort,
} from "@brewva/brewva-runtime";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import { createHostedRuntimeAdapter } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";
import {
  canResolveHostedRuntimeTurnRuntime,
  resolveHostedRuntimeTurnRuntime,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-turn-runtime.js";
import { HOSTED_PROMPT_ATTEMPT_DISPATCH } from "../../../packages/brewva-gateway/src/hosted/internal/turn-adapter/hosted-prompt-attempt.js";
import { runHostedRuntimeTurnAdapter } from "../../../packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-adapter.js";
import { HOSTED_RUNTIME_TURN_PRELUDE } from "../../../packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-prelude.js";
import { resolveHostedTurnAdapterProfile } from "../../../packages/brewva-gateway/src/hosted/internal/turn-adapter/state.js";

const NOOP_TOOL_EXECUTOR: RuntimeToolExecutorPort = {
  async execute() {
    return { outcome: { kind: "ok", value: {} }, content: "" };
  },
};

describe("gateway runtime adapter", () => {
  test("hosted adapter delegates turn ownership to runtime.turn", async () => {
    const provider: RuntimeProviderPort = {
      async *stream() {},
    };
    const runtime = createBrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-gateway-runtime-adapter-")),
      physics: { mode: "real", provider, toolExecutor: NOOP_TOOL_EXECUTOR },
    });

    const result = await runHostedRuntimeTurnAdapter({
      runtime,
      sessionId: "adapter-session",
      session: {} as never,
      prompt: "hello",
      profile: resolveHostedTurnAdapterProfile({ source: "interactive" }),
    });

    expect(result).toMatchObject({
      status: "completed",
      attemptId: "runtime-turn",
      assistantText: "",
      toolOutputs: [],
    });
    expect(runtime.tape.list("adapter-session").map((event) => event.type)).toEqual([
      "turn.started",
      "turn.ended",
    ]);
  });

  test("hosted adapter resolves approvals without preparing a new prompt", async () => {
    let preludeCalled = false;
    const turnInputs: unknown[] = [];
    const runtime = {
      async *turn(input: unknown) {
        turnInputs.push(input);
        yield {
          type: "runtime.event",
          event: {
            id: "event-turn-ended",
            type: "turn.ended",
            timestamp: 1_030,
            sessionId: "adapter-resolution-session",
            turnId: "turn-approval",
            payload: { status: "completed" },
          },
        };
      },
    } as never;
    const session = {
      async [HOSTED_RUNTIME_TURN_PRELUDE]() {
        preludeCalled = true;
        return {
          status: "ready" as const,
          promptContent: [{ type: "text" as const, text: "should not be used" }],
        };
      },
    } as never;

    const result = await runHostedRuntimeTurnAdapter({
      runtime,
      sessionId: "adapter-resolution-session",
      turnId: "turn-approval",
      session,
      prompt: [],
      profile: resolveHostedTurnAdapterProfile({ source: "interactive" }),
      resolveApproval: { requestId: "approval:adapter-resolution-session:turn-approval:call-1" },
    });

    expect(result.status).toBe("completed");
    expect(preludeCalled).toBe(false);
    expect(turnInputs).toMatchObject([
      {
        sessionId: "adapter-resolution-session",
        turnId: "turn-approval",
        prompt: [],
        resolveApproval: {
          requestId: "approval:adapter-resolution-session:turn-approval:call-1",
        },
      },
    ]);
  });

  test("hosted runtime adapter commits assistant segments around live tool frames", async () => {
    const observedFrames: SessionWireFrame[] = [];

    await runHostedRuntimeTurnAdapter({
      runtime: {
        async *turn() {
          yield { type: "text", delta: "Before tool." };
          yield {
            type: "tool.progress",
            progress: {
              toolCallId: "tool-1",
              toolName: "read",
              update: { outcome: { kind: "ok", value: {} }, content: "src/app.ts" },
            },
          };
          yield { type: "text", delta: "After tool." };
          yield {
            type: "runtime.event",
            event: {
              id: "event-turn-ended",
              type: "turn.ended",
              timestamp: 1_030,
              turn: "turn-1",
              payload: { status: "completed" },
            },
          };
        },
      } as never,
      sessionId: "adapter-segment-session",
      turnId: "turn-1",
      session: {} as never,
      prompt: "inspect",
      profile: resolveHostedTurnAdapterProfile({ source: "interactive" }),
      onFrame(frame) {
        observedFrames.push(frame);
      },
    });

    const committed = observedFrames.find((frame) => frame.type === "turn.committed");
    expect(committed).toMatchObject({
      type: "turn.committed",
      assistantText: "Before tool.After tool.",
      assistantSegments: [
        { text: "Before tool.", sequence: 1 },
        { text: "After tool.", sequence: 3 },
      ],
    });
  });

  test("hosted runtime adapter keeps canonical tape durability enabled", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-gateway-runtime-adapter-durable-"));
    const runtime = createBrewvaRuntime({ cwd, physics: { mode: "noop" } });
    const session = {
      getRegisteredTools() {
        return [];
      },
      getRuntimeModelCatalog() {
        return {
          async getApiKeyAndHeaders() {
            return { ok: true as const };
          },
        };
      },
      createRuntimeToolContext() {
        return {
          getSystemPrompt() {
            return "";
          },
        };
      },
    } as never;

    const hostedTurnRuntime = await resolveHostedRuntimeTurnRuntime({
      session,
      runtime,
    });
    const decision = await hostedTurnRuntime.kernel.beginToolCall({
      sessionId: "durable-adapter-session",
      toolCallId: "call-1",
      toolName: "read",
    });
    if (decision.kind !== "allow") {
      throw new Error("expected_allow");
    }
    await hostedTurnRuntime.kernel.commitToolResult({
      commitmentId: decision.commitment.id,
      result: { outcome: { kind: "ok", value: {} }, content: "ok" },
    });

    expect(existsSync(join(cwd, ".brewva/tape/durable-adapter-session.jsonl"))).toBe(true);
  });

  test("hosted turn runtime creates explicit physics on the adapter runtime tape", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-gateway-runtime-shared-tape-"));
    const adapter = createHostedRuntimeAdapter({ cwd });
    const session = {
      getRegisteredTools() {
        return [];
      },
      getRuntimeModelCatalog() {
        return {
          async getApiKeyAndHeaders() {
            return { ok: true as const };
          },
        };
      },
      createRuntimeToolContext() {
        return {
          getSystemPrompt() {
            return "";
          },
        };
      },
    } as never;

    const hostedTurnRuntime = await resolveHostedRuntimeTurnRuntime({
      session,
      runtime: adapter,
    });

    const decision = await hostedTurnRuntime.kernel.beginToolCall({
      sessionId: "shared-adapter-session",
      toolCallId: "call-1",
      toolName: "read",
    });
    if (decision.kind !== "allow") {
      throw new Error("expected_allow");
    }
    await hostedTurnRuntime.kernel.commitToolResult({
      commitmentId: decision.commitment.id,
      result: { outcome: { kind: "ok", value: {} }, content: "ok" },
    });

    expect(hostedTurnRuntime.tape).toBe(adapter.runtime.tape);
    expect(adapter.runtime.tape.list("shared-adapter-session").map((event) => event.type)).toEqual([
      "tool.proposed",
      "tool.committed",
    ]);
  });

  test("runtime interrupt suspension maps to cancelled hosted adapter result", async () => {
    const result = await runHostedRuntimeTurnAdapter({
      runtime: {
        async *turn() {
          yield { type: "runtime.suspended", cause: "interrupt" };
        },
      } as never,
      sessionId: "adapter-interrupt-session",
      session: {} as never,
      prompt: "hello",
      profile: resolveHostedTurnAdapterProfile({ source: "interactive" }),
    });

    expect(result).toMatchObject({
      status: "cancelled",
    });
  });

  test("hosted runtime adapter does not bypass prompt-dispatch prelude sessions", () => {
    const session = {
      getRegisteredTools() {
        return [];
      },
      getRuntimeModelCatalog() {
        return {
          async getApiKeyAndHeaders() {
            return { ok: true as const };
          },
        };
      },
      createRuntimeToolContext() {
        return {
          getSystemPrompt() {
            return "";
          },
        };
      },
      async [HOSTED_PROMPT_ATTEMPT_DISPATCH]() {
        return undefined;
      },
    } as never;

    expect(canResolveHostedRuntimeTurnRuntime(session)).toBe(false);
  });

  test("hosted runtime adapter accepts sessions that expose an explicit runtime prelude", () => {
    const session = {
      getRegisteredTools() {
        return [];
      },
      getRuntimeModelCatalog() {
        return {
          async getApiKeyAndHeaders() {
            return { ok: true as const };
          },
        };
      },
      createRuntimeToolContext() {
        return {
          getSystemPrompt() {
            return "";
          },
        };
      },
      async [HOSTED_PROMPT_ATTEMPT_DISPATCH]() {
        return undefined;
      },
      async [HOSTED_RUNTIME_TURN_PRELUDE]() {
        return {
          status: "ready" as const,
          promptText: "prepared",
          promptContent: [{ type: "text" as const, text: "prepared" }],
        };
      },
    } as never;

    expect(canResolveHostedRuntimeTurnRuntime(session, "hello")).toBe(true);
  });

  test("hosted runtime adapter accepts structured prompt parts", () => {
    const session = {
      getRegisteredTools() {
        return [];
      },
      getRuntimeModelCatalog() {
        return {
          async getApiKeyAndHeaders() {
            return { ok: true as const };
          },
        };
      },
      createRuntimeToolContext() {
        return {
          getSystemPrompt() {
            return "";
          },
        };
      },
    } as never;

    expect(
      canResolveHostedRuntimeTurnRuntime(session, [
        { type: "text", text: "look" },
        { type: "image", data: "base64-image", mimeType: "image/png" },
        { type: "file", uri: "file:///workspace/spec.md", name: "spec.md" },
      ]),
    ).toBe(true);
  });
});
