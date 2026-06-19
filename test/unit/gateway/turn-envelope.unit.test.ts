import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaRuntime, BrewvaRuntimeOptions } from "@brewva/brewva-runtime";
import type { BrewvaToolUpdateHandler } from "@brewva/brewva-substrate/tools";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import { Type } from "@sinclair/typebox";
import { NOOP_UI } from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/noop-ui.js";
import { createHostedRuntimeAdapter } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";
import {
  runHostedTurnEnvelope,
  type HostedTurnEnvelopeAdapterResult,
} from "../../../packages/brewva-gateway/src/hosted/internal/turn/turn-envelope.js";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "../../../packages/brewva-provider-core/src/providers/faux/index.js";
import { createRuntimeProviderFaceFixture } from "../../helpers/runtime-provider-face.js";

type TestRuntimeOptions = Omit<BrewvaRuntimeOptions, "physics"> & {
  readonly physics?: BrewvaRuntimeOptions["physics"];
};

function createRuntime(prefix: string, options: TestRuntimeOptions = {}): BrewvaRuntime {
  return createBrewvaRuntime({
    ...options,
    cwd: options.cwd ?? mkdtempSync(join(tmpdir(), prefix)),
    physics: options.physics ?? { mode: "noop" },
  });
}

function createAdapterResult(
  input?: Partial<Extract<HostedTurnEnvelopeAdapterResult, { status: "completed" }>>,
): HostedTurnEnvelopeAdapterResult {
  return {
    status: "completed",
    attemptId: input?.attemptId ?? "runtime-turn",
    assistantText: input?.assistantText ?? "done",
    toolOutputs: input?.toolOutputs ?? [],
    diagnostic: {
      sessionId: "unused",
      profile: "interactive",
    },
  };
}

const emptySession = {
  sessionManager: {
    getSessionId: () => "unused",
  },
};

describe("hosted turn envelope", () => {
  test("wraps a custom adapter without writing gateway-owned turn truth", async () => {
    const runtime = createRuntime("brewva-turn-envelope-custom-");

    const result = await runHostedTurnEnvelope({
      session: emptySession as Parameters<typeof runHostedTurnEnvelope>[0]["session"],
      runtime,
      sessionId: "session-envelope-custom",
      prompt: "hello",
      source: "gateway",
      turnId: "turn-custom-1",
      runAdapter: async () => createAdapterResult({ assistantText: "custom done" }),
    });

    expect(result).toMatchObject({
      status: "completed",
      turnId: "turn-custom-1",
      runtimeTurn: 0,
      assistantText: "custom done",
      actions: {
        scheduleTriggerApplied: false,
      },
    });
    expect(runtime.tape.list("session-envelope-custom")).toEqual([]);
  });

  test("creates a runtime turn adapter from the hosted session when no custom adapter is supplied", async () => {
    const runtime = createHostedRuntimeAdapter({
      cwd: mkdtempSync(join(tmpdir(), "brewva-turn-envelope-runtime-adapter-")),
    });
    const sessionId = "session-envelope-runtime-adapter";
    const fauxProvider = registerFauxProvider({
      provider: "faux-turn-envelope",
      api: "faux",
      tokenSize: { min: 1, max: 1 },
    });
    const observedFrames: SessionWireFrame[] = [];
    fauxProvider.setResponses([
      fauxAssistantMessage([
        { type: "thinking", thinking: "thinking..." },
        { type: "text", text: "runtime says hi" },
        fauxToolCall("echo", { value: "runtime-path" }, { id: "tool-runtime-path-1" }),
      ]),
      (context) =>
        fauxAssistantMessage([
          {
            type: "text",
            text: ` after ${context.messages.map((message) => message.role).join(">")}`,
          },
        ]),
    ]);

    try {
      const model = fauxProvider.getModel();
      const session = {
        model,
        sessionManager: {
          getSessionId: () => sessionId,
        },
        getRegisteredTools: () => [
          {
            name: "echo",
            label: "Echo",
            description: "Echoes the provided value.",
            parameters: Type.Object({
              value: Type.String(),
            }),
            brewva: {
              surface: "base",
              actionClass: "runtime_observe",
            },
            async execute(
              _toolCallId: string,
              params: { value: string },
              _signal: AbortSignal | undefined,
              onUpdate: BrewvaToolUpdateHandler<{ stage: string }> | undefined,
            ) {
              await onUpdate?.({
                content: [{ type: "text" as const, text: "echo:preparing" }],
                outcome: { kind: "ok", value: { stage: "preparing" } },
                display: { summaryText: "preparing" },
              });
              await onUpdate?.({
                content: [{ type: "text" as const, text: `echo:progress:${params.value}` }],
                outcome: { kind: "ok", value: { stage: "running" } },
                display: { summaryText: `running ${params.value}` },
              });
              return {
                content: [{ type: "text" as const, text: `echo:${params.value}` }],
                outcome: { kind: "ok", value: { echoed: params.value } },
              };
            },
          },
        ],
        getRuntimeProviderFace: () =>
          createRuntimeProviderFaceFixture({
            model,
            getModelCatalog: () => ({
              async getApiKeyAndHeaders() {
                return { ok: true as const };
              },
            }),
          }),
        createRuntimeToolContext: () => ({
          ui: NOOP_UI,
          hasUI: false,
          cwd: runtime.identity.cwd,
          sessionManager: {
            getSessionId: () => sessionId,
            getLeafId: () => null,
          },
          modelRegistry: {
            getAll: () => [model],
          },
          model,
          isIdle: () => true,
          signal: undefined,
          abort: () => undefined,
          hasPendingMessages: () => false,
          shutdown: () => undefined,
          compact: () => undefined,
          getContextUsage: () => undefined,
          getSystemPrompt: () => "Test hosted system prompt.",
        }),
      };

      const result = await runHostedTurnEnvelope({
        session: session as unknown as Parameters<typeof runHostedTurnEnvelope>[0]["session"],
        runtime,
        sessionId,
        prompt: "use the echo tool",
        source: "interactive",
        turnId: "turn-runtime-adapter-1",
        onFrame: (frame) => observedFrames.push(frame),
      });

      expect(result).toMatchObject({
        status: "completed",
        assistantText: "runtime says hi after user>assistant>assistant>toolResult",
        toolOutputs: [
          {
            toolCallId: "tool-runtime-path-1",
            toolName: "echo",
            verdict: "pass",
            isError: false,
            text: "echo:runtime-path",
            details: { echoed: "runtime-path" },
          },
        ],
      });
      expect(observedFrames.map((frame) => frame.type)).toEqual(
        expect.arrayContaining([
          "attempt.started",
          "assistant.delta",
          "tool.started",
          "tool.progress",
          "tool.finished",
        ]),
      );
      expect(
        observedFrames
          .filter((frame) => frame.type === "tool.progress")
          .map((frame) =>
            frame.type === "tool.progress" ? { text: frame.text, details: frame.details } : {},
          ),
      ).toEqual([
        { text: "echo:preparing", details: { stage: "preparing" } },
        { text: "echo:progress:runtime-path", details: { stage: "running" } },
      ]);
      const events = result.status === "completed" ? runtime.runtime.tape.list(sessionId) : [];
      expect(events.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "turn.started",
          "reason.committed",
          "msg.committed",
          "tool.proposed",
          "tool.committed",
          "turn.ended",
        ]),
      );
    } finally {
      fauxProvider.unregister();
    }
  });

  test("fails fast when no custom adapter or runtime-turn-compatible session is available", async () => {
    const runtime = createRuntime("brewva-turn-envelope-fail-fast-");

    const result = await runHostedTurnEnvelope({
      session: emptySession as Parameters<typeof runHostedTurnEnvelope>[0]["session"],
      runtime,
      sessionId: "session-envelope-fail-fast",
      prompt: "hello",
      source: "interactive",
    });

    expect(result).toMatchObject({
      status: "failed",
      attemptId: "runtime-turn",
    });
    expect(result.status === "failed" ? String(result.error) : "").toContain(
      "hosted_runtime_turn_required",
    );
  });
});

describe("hosted turn envelope compaction boundary", () => {
  const HOSTED_COMPACTION_BOUNDARY = Symbol.for("brewva.hosted.compactionBoundary");

  function createBoundarySession(input: {
    flushResults: boolean[];
    settled: { count: number };
    flushes: { count: number };
  }) {
    return {
      sessionManager: {
        getSessionId: () => "compaction-boundary-session",
      },
      [HOSTED_COMPACTION_BOUNDARY]: () => ({
        consumeToolResultStop: () => false,
        flushPendingCompaction: async () => {
          input.flushes.count += 1;
          return input.flushResults.shift() ?? false;
        },
        settleTurnEndCompaction: async () => {
          input.settled.count += 1;
        },
      }),
    };
  }

  test("flushes and resumes a compaction-suspended turn through the envelope", async () => {
    const runtime = createRuntime("brewva-turn-envelope-compaction-resume-");
    const settled = { count: 0 };
    const flushes = { count: 0 };
    const session = createBoundarySession({ flushResults: [true], settled, flushes });
    const adapterCalls: Array<{ resume: unknown; softCut: unknown }> = [];

    const result = await runHostedTurnEnvelope({
      session: session as unknown as Parameters<typeof runHostedTurnEnvelope>[0]["session"],
      runtime,
      sessionId: "compaction-boundary-session",
      prompt: "trigger",
      source: "channel",
      runAdapter: async (input) => {
        adapterCalls.push({ resume: input.resume, softCut: input.softCut });
        if (adapterCalls.length === 1) {
          return {
            status: "suspended",
            reason: "compaction",
            sourceEventId: null,
            diagnostic: {
              sessionId: "compaction-boundary-session",
              profile: "channel",
            },
          };
        }
        return createAdapterResult();
      },
    });

    expect(result.status).toBe("completed");
    expect(flushes.count).toBe(1);
    expect(settled.count).toBe(1);
    expect(adapterCalls).toHaveLength(2);
    expect(adapterCalls[0]?.resume).toBe(undefined);
    expect(
      typeof (adapterCalls[0]?.softCut as { afterToolResult?: unknown } | undefined)
        ?.afterToolResult,
    ).toBe("function");
    expect(adapterCalls[1]?.resume).toEqual({ kind: "compaction", turnId: result.turnId });
  });

  test("does not resume when the compaction flush fails", async () => {
    const runtime = createRuntime("brewva-turn-envelope-compaction-flush-fail-");
    const settled = { count: 0 };
    const flushes = { count: 0 };
    const session = createBoundarySession({ flushResults: [false], settled, flushes });
    let adapterCalls = 0;

    const result = await runHostedTurnEnvelope({
      session: session as unknown as Parameters<typeof runHostedTurnEnvelope>[0]["session"],
      runtime,
      sessionId: "compaction-boundary-session",
      prompt: "trigger",
      source: "channel",
      runAdapter: async () => {
        adapterCalls += 1;
        return {
          status: "suspended",
          reason: "compaction",
          sourceEventId: null,
          diagnostic: {
            sessionId: "compaction-boundary-session",
            profile: "channel",
          },
        };
      },
    });

    expect(result.status).toBe("failed");
    expect(
      result.status === "failed" && result.error instanceof Error && result.error.message,
    ).toBe("compaction_soft_cut_flush_failed");
    expect(adapterCalls).toBe(1);
    expect(flushes.count).toBe(1);
    expect(settled.count).toBe(0);
  });

  test("settles pending compaction at turn end for completed turns", async () => {
    const runtime = createRuntime("brewva-turn-envelope-compaction-settle-");
    const settled = { count: 0 };
    const flushes = { count: 0 };
    const session = createBoundarySession({ flushResults: [], settled, flushes });

    const result = await runHostedTurnEnvelope({
      session: session as unknown as Parameters<typeof runHostedTurnEnvelope>[0]["session"],
      runtime,
      sessionId: "compaction-boundary-session",
      prompt: "text only",
      source: "channel",
      runAdapter: async () => createAdapterResult(),
    });

    expect(result.status).toBe("completed");
    expect(settled.count).toBe(1);
    expect(flushes.count).toBe(0);
  });
});
