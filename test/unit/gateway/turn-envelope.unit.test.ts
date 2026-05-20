import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaRuntime, BrewvaRuntimeOptions } from "@brewva/brewva-runtime";
import type { SessionWireFrame } from "@brewva/brewva-runtime/protocol";
import type { BrewvaToolUpdateHandler } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import { NOOP_UI } from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/noop-ui.js";
import {
  runHostedTurnEnvelope,
  type HostedTurnEnvelopeAdapterResult,
} from "../../../packages/brewva-gateway/src/hosted/internal/turn-adapter/turn-envelope.js";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "../../../packages/brewva-provider-core/src/providers/faux/index.js";

function createRuntime(prefix: string, options: BrewvaRuntimeOptions = {}): BrewvaRuntime {
  return createBrewvaRuntime({
    ...options,
    cwd: options.cwd ?? mkdtempSync(join(tmpdir(), prefix)),
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
    const runtime = createRuntime("brewva-turn-envelope-runtime-adapter-");
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
            text: context.messages.map((message) => message.role).join(">"),
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
                details: { stage: "preparing" },
                display: { summaryText: "preparing" },
              });
              await onUpdate?.({
                content: [{ type: "text" as const, text: `echo:progress:${params.value}` }],
                details: { stage: "running" },
                display: { summaryText: `running ${params.value}` },
              });
              return {
                content: [{ type: "text" as const, text: `echo:${params.value}` }],
                details: { echoed: params.value },
              };
            },
          },
        ],
        getRuntimeModelCatalog: () => ({
          async getApiKeyAndHeaders() {
            return { ok: true as const };
          },
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
        assistantText: "runtime says hi",
        toolOutputs: [
          {
            toolCallId: "tool-runtime-path-1",
            toolName: "echo",
            verdict: "pass",
            isError: false,
            text: "echo:runtime-path",
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
          .map((frame) => (frame.type === "tool.progress" ? frame.text : "")),
      ).toEqual(["echo:preparing", "echo:progress:runtime-path"]);
      const events = result.status === "completed" ? runtime.tape.list(sessionId) : [];
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
