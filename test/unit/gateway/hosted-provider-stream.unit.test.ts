import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPromiseAtBoundary } from "@brewva/brewva-effect";
import { BrewvaStream } from "@brewva/brewva-effect/primitives";
import { BrewvaEffect } from "@brewva/brewva-effect/primitives";
import type { AssistantMessage } from "@brewva/brewva-provider-core/contracts";
import { providerRuntimeLayer } from "@brewva/brewva-provider-core/contracts";
import {
  clearApiProviders,
  registerApiProvider,
  unregisterApiProviders,
} from "@brewva/brewva-provider-core/registry";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaRegisteredModel } from "@brewva/brewva-substrate/provider";
import { createHostedProviderStreamFunction } from "../../../packages/brewva-gateway/src/hosted/internal/provider/stream.js";
import { createHostedRuntimeProviderPort } from "../../../packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-execution-ports.js";
import { HOSTED_RUNTIME_TURN_CONTEXT } from "../../../packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-prelude.js";
import {
  fauxAssistantMessage,
  registerFauxProvider,
} from "../../../packages/brewva-provider-core/src/providers/faux/index.js";
import { createProviderEventStream } from "../../helpers/effect-stream.js";

const SOURCE_ID = "hosted-provider-stream-unit-test";

function createMessage(api: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api,
    provider: "unit-provider",
    model: "unit-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function createRuntimeModel(id: string, api: string): BrewvaRegisteredModel {
  return {
    provider: "unit-provider",
    id,
    name: id,
    api,
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 1024,
  };
}

function createRuntimeProviderInput(sessionId: string) {
  return {
    turn: { sessionId, prompt: "next" },
    prompt: {
      status: "ready" as const,
      sessionId,
      messages: [],
      messageSourceEventIds: [],
      admittedBlocks: [],
      droppedAdvisoryBlocks: [],
      tokenEstimate: 0,
      cache: { stablePrefix: false },
    },
  };
}

describe("hosted provider stream", () => {
  test("preserves advisory parse status from provider-core event contract", async () => {
    clearApiProviders();
    registerApiProvider(
      {
        api: "engine-provider-stream-test",
        stream() {
          return createProviderEventStream();
        },
        streamSimple(model) {
          const partial = createMessage(model.api);
          return createProviderEventStream([
            { type: "start", partial },
            {
              type: "toolcall_start",
              contentIndex: 0,
              partial,
              parseStatus: "incomplete",
            },
            {
              type: "toolcall_delta",
              contentIndex: 0,
              delta: '{"query"',
              partial,
              parseStatus: "pending",
            },
            {
              type: "toolcall_end",
              contentIndex: 0,
              toolCall: { type: "toolCall", id: "call_1", name: "search", arguments: {} },
              partial,
              parseStatus: "likely_invalid",
            },
            { type: "done", reason: "toolUse", message: partial },
          ]);
        },
      },
      SOURCE_ID,
    );

    const providerStream = createHostedProviderStreamFunction();
    const stream = providerStream(
      {
        provider: "unit-provider",
        id: "unit-model",
        name: "Unit Model",
        api: "engine-provider-stream-test",
        baseUrl: "https://example.test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      },
      {
        systemPrompt: "test",
        messages: [],
      },
      {
        reasoning: "off",
      },
    );

    const events = await runPromiseAtBoundary(
      stream.pipe(BrewvaStream.runCollect, BrewvaEffect.provide(providerRuntimeLayer)),
    );

    expect(events[1]).toMatchObject({ type: "toolcall_start", parseStatus: "incomplete" });
    expect(events[2]).toMatchObject({ type: "toolcall_delta", parseStatus: "pending" });
    expect(events[3]).toMatchObject({ type: "toolcall_end", parseStatus: "likely_invalid" });

    unregisterApiProviders(SOURCE_ID);
    clearApiProviders();
  });

  test("preserves routed response model on runtime assistant observations", async () => {
    const sourceId = `${SOURCE_ID}-response-model`;
    const api = "runtime-provider-response-model-test";
    const model = createRuntimeModel("openrouter/auto", api);
    let observedMessage: unknown;

    clearApiProviders();
    registerApiProvider(
      {
        api,
        stream() {
          return createProviderEventStream();
        },
        streamSimple(providerModel) {
          const partial = createMessage(providerModel.api);
          return createProviderEventStream([
            {
              type: "done",
              reason: "stop",
              message: {
                ...partial,
                model: providerModel.id,
                responseModel: "anthropic/claude-opus-4.8",
                content: [{ type: "text", text: "ok" }],
                stopReason: "stop",
              },
            },
          ]);
        },
      },
      sourceId,
    );

    try {
      const session = {
        model,
        getRegisteredTools() {
          return [];
        },
        getRuntimeModelCatalog() {
          return {
            async getApiKeyAndHeaders() {
              return { ok: true as const, apiKey: "unit-key" };
            },
          };
        },
        observeRuntimeAssistantMessage(message: unknown) {
          observedMessage = message;
        },
        createRuntimeToolContext() {
          return {
            getSystemPrompt() {
              return "";
            },
          };
        },
      };

      const frames = [];
      const provider = createHostedRuntimeProviderPort(session as never);
      for await (const frame of provider.stream(createRuntimeProviderInput("response-model"))) {
        frames.push(frame);
      }

      expect(frames).toEqual([{ type: "text", delta: "ok" }]);
      expect(observedMessage).toMatchObject({
        role: "assistant",
        model: "openrouter/auto",
        responseModel: "anthropic/claude-opus-4.8",
      });
    } finally {
      unregisterApiProviders(sourceId);
      clearApiProviders();
    }
  });

  test("rotates credential slots before provider fallback and marks cache identity invalidated", async () => {
    const sourceId = `${SOURCE_ID}-credential-rotation`;
    const api = "runtime-provider-credential-rotation-test";
    const model = createRuntimeModel("primary", api);
    const providerFallbacks: unknown[] = [];
    const rotations: unknown[] = [];
    let attempts = 0;

    clearApiProviders();
    registerApiProvider(
      {
        api,
        stream() {
          return createProviderEventStream();
        },
        streamSimple(providerModel, _context, options) {
          attempts += 1;
          providerFallbacks.push(options?.metadata?.providerFallback);
          const partial = createMessage(providerModel.api);
          if (attempts === 1) {
            return createProviderEventStream([
              {
                type: "error",
                reason: "error",
                error: {
                  ...partial,
                  stopReason: "error",
                  errorMessage: "rate limit exceeded",
                },
              },
            ]);
          }
          return createProviderEventStream([
            { type: "text_delta", contentIndex: 0, delta: "ok", partial },
            {
              type: "done",
              reason: "stop",
              message: {
                ...partial,
                content: [{ type: "text", text: "ok" }],
                stopReason: "stop",
              },
            },
          ]);
        },
      },
      sourceId,
    );

    try {
      const session = {
        model,
        getRegisteredTools() {
          return [];
        },
        getRuntimeModelCatalog() {
          return {
            getAll() {
              return [model];
            },
            async getApiKeyAndHeaders() {
              return { ok: true as const, apiKey: "unit-key" };
            },
            rotateCredential(provider: string, reason: "rate_limit", cooldownMs: number) {
              return {
                providerId: provider,
                credentialSlot: "slot-b",
                reason,
                cooldownMs,
              };
            },
          };
        },
        getRuntimeModelRoutingSettings() {
          return {
            fallbackChains: {},
            credentialRotation: { enabled: true, cooldownMs: 5_000 },
          };
        },
        recordRuntimeProviderCredentialRotated(input: unknown) {
          rotations.push(input);
        },
        async prepareRuntimeProviderPayload(input: { payload: unknown }) {
          return input.payload;
        },
        createRuntimeToolContext() {
          return {
            getSystemPrompt() {
              return "";
            },
          };
        },
      };

      const frames = [];
      const provider = createHostedRuntimeProviderPort(session as never);
      for await (const frame of provider.stream(createRuntimeProviderInput("rotation-session"))) {
        frames.push(frame);
      }

      expect(frames).toEqual([{ type: "text", delta: "ok" }]);
      expect(attempts).toBe(2);
      expect(rotations).toEqual([
        {
          providerId: "unit-provider",
          credentialSlot: "slot-b",
          reason: "rate_limit",
          cooldownMs: 5_000,
        },
      ]);
      expect(providerFallbacks).toContainEqual(
        expect.objectContaining({
          active: true,
          selectedRoute: {
            provider: "unit-provider",
            model: "primary",
            credentialSlot: "slot-b",
          },
          reason: "rate_limit",
          cache_invalidated: true,
        }),
      );
    } finally {
      unregisterApiProviders(sourceId);
      clearApiProviders();
    }
  });

  test("does not switch provider routes after an incremental frame has been emitted", async () => {
    const sourceId = `${SOURCE_ID}-no-post-frame-fallback`;
    const api = "runtime-provider-no-post-frame-fallback-test";
    const primary = createRuntimeModel("primary", api);
    const backup = createRuntimeModel("backup", api);
    let attempts = 0;

    clearApiProviders();
    registerApiProvider(
      {
        api,
        stream() {
          return createProviderEventStream();
        },
        streamSimple(providerModel) {
          attempts += 1;
          const partial = createMessage(providerModel.api);
          return createProviderEventStream([
            { type: "text_delta", contentIndex: 0, delta: "partial", partial },
            {
              type: "error",
              reason: "error",
              error: {
                ...partial,
                stopReason: "error",
                errorMessage: "rate limit after partial output",
              },
            },
          ]);
        },
      },
      sourceId,
    );

    try {
      const session = {
        model: primary,
        getRegisteredTools() {
          return [];
        },
        getRuntimeModelCatalog() {
          return {
            getAll() {
              return [primary, backup];
            },
            async getApiKeyAndHeaders() {
              return { ok: true as const, apiKey: "unit-key" };
            },
          };
        },
        getRuntimeModelRoutingSettings() {
          return {
            fallbackChains: { default: ["unit-provider/backup"] },
            credentialRotation: { enabled: false, cooldownMs: 5_000 },
          };
        },
        createRuntimeToolContext() {
          return {
            getSystemPrompt() {
              return "";
            },
          };
        },
      };

      const frames = [];
      let thrown: unknown;
      const provider = createHostedRuntimeProviderPort(session as never);
      try {
        for await (const frame of provider.stream(createRuntimeProviderInput("post-frame"))) {
          frames.push(frame);
        }
      } catch (error) {
        thrown = error;
      }

      expect(frames).toEqual([{ type: "text", delta: "partial" }]);
      expect(attempts).toBe(1);
      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toContain("rate limit after partial output");
    } finally {
      unregisterApiProviders(sourceId);
      clearApiProviders();
    }
  });

  test("uses the active role fallback chain before the default chain", async () => {
    const sourceId = `${SOURCE_ID}-role-fallback`;
    const api = "runtime-provider-role-fallback-test";
    const primary = createRuntimeModel("primary", api);
    const taskBackup = createRuntimeModel("task-backup", api);
    const defaultBackup = createRuntimeModel("default-backup", api);
    const attemptedModels: string[] = [];
    const providerFallbacks: unknown[] = [];

    clearApiProviders();
    registerApiProvider(
      {
        api,
        stream() {
          return createProviderEventStream();
        },
        streamSimple(providerModel, _context, options) {
          attemptedModels.push(providerModel.id);
          providerFallbacks.push(options?.metadata?.providerFallback);
          const partial = createMessage(providerModel.api);
          if (providerModel.id === "primary") {
            return createProviderEventStream([
              {
                type: "error",
                reason: "error",
                error: {
                  ...partial,
                  stopReason: "error",
                  errorMessage: "provider timeout",
                },
              },
            ]);
          }
          return createProviderEventStream([
            { type: "text_delta", contentIndex: 0, delta: providerModel.id, partial },
            {
              type: "done",
              reason: "stop",
              message: {
                ...partial,
                content: [{ type: "text", text: providerModel.id }],
                stopReason: "stop",
              },
            },
          ]);
        },
      },
      sourceId,
    );

    try {
      const session = {
        model: primary,
        getRegisteredTools() {
          return [];
        },
        getRuntimeModelCatalog() {
          return {
            getAll() {
              return [primary, taskBackup, defaultBackup];
            },
            async getApiKeyAndHeaders() {
              return { ok: true as const, apiKey: "unit-key" };
            },
          };
        },
        getRuntimeActiveModelRole() {
          return "task";
        },
        getRuntimeModelRoutingSettings() {
          return {
            fallbackChains: {
              task: ["unit-provider/task-backup"],
              default: ["unit-provider/default-backup"],
            },
            credentialRotation: { enabled: false, cooldownMs: 5_000 },
          };
        },
        createRuntimeToolContext() {
          return {
            getSystemPrompt() {
              return "";
            },
          };
        },
      };

      const frames = [];
      const provider = createHostedRuntimeProviderPort(session as never);
      for await (const frame of provider.stream(createRuntimeProviderInput("role-fallback"))) {
        frames.push(frame);
      }

      expect(frames).toEqual([{ type: "text", delta: "task-backup" }]);
      expect(attemptedModels).toEqual(["primary", "task-backup"]);
      expect(providerFallbacks).toContainEqual(
        expect.objectContaining({
          active: true,
          selectedRoute: {
            provider: "unit-provider",
            model: "task-backup",
          },
          reason: "provider",
        }),
      );
    } finally {
      unregisterApiProviders(sourceId);
      clearApiProviders();
    }
  });

  test("classifies non-standard maximum input length failures as context overflow", async () => {
    const sourceId = `${SOURCE_ID}-context-overflow-fallback`;
    const api = "runtime-provider-context-overflow-fallback-test";
    const primary = createRuntimeModel("primary", api);
    const backup = createRuntimeModel("backup", api);
    const providerFallbacks: unknown[] = [];
    const attemptedModels: string[] = [];

    clearApiProviders();
    registerApiProvider(
      {
        api,
        stream() {
          return createProviderEventStream();
        },
        streamSimple(providerModel, _context, options) {
          attemptedModels.push(providerModel.id);
          providerFallbacks.push(options?.metadata?.providerFallback);
          const partial = createMessage(providerModel.api);
          if (providerModel.id === "primary") {
            return createProviderEventStream([
              {
                type: "error",
                reason: "error",
                error: {
                  ...partial,
                  stopReason: "error",
                  errorMessage: "maximum allowed input length is 128000 tokens",
                },
              },
            ]);
          }
          return createProviderEventStream([
            { type: "text_delta", contentIndex: 0, delta: "ok", partial },
            {
              type: "done",
              reason: "stop",
              message: {
                ...partial,
                content: [{ type: "text", text: "ok" }],
                stopReason: "stop",
              },
            },
          ]);
        },
      },
      sourceId,
    );

    try {
      const session = {
        model: primary,
        getRegisteredTools() {
          return [];
        },
        getRuntimeModelCatalog() {
          return {
            getAll() {
              return [primary, backup];
            },
            async getApiKeyAndHeaders() {
              return { ok: true as const, apiKey: "unit-key" };
            },
          };
        },
        getRuntimeModelRoutingSettings() {
          return {
            fallbackChains: { default: ["unit-provider/backup"] },
            credentialRotation: { enabled: false, cooldownMs: 5_000 },
          };
        },
        createRuntimeToolContext() {
          return {
            getSystemPrompt() {
              return "";
            },
          };
        },
      };

      const frames = [];
      const provider = createHostedRuntimeProviderPort(session as never);
      for await (const frame of provider.stream(createRuntimeProviderInput("context-overflow"))) {
        frames.push(frame);
      }

      expect(frames).toEqual([{ type: "text", delta: "ok" }]);
      expect(attemptedModels).toEqual(["primary", "backup"]);
      expect(providerFallbacks).toContainEqual(
        expect.objectContaining({
          active: true,
          selectedRoute: {
            provider: "unit-provider",
            model: "backup",
          },
          reason: "context",
        }),
      );
    } finally {
      unregisterApiProviders(sourceId);
      clearApiProviders();
    }
  });

  test("converts runtime prompt tool-call messages before tool results", async () => {
    let observedMessages: unknown;
    clearApiProviders();
    registerApiProvider(
      {
        api: "runtime-provider-context-test",
        stream() {
          return createProviderEventStream();
        },
        streamSimple(_model, context) {
          observedMessages = context.messages;
          return createProviderEventStream();
        },
      },
      SOURCE_ID,
    );

    const session = {
      model: {
        provider: "unit-provider",
        id: "unit-model",
        name: "Unit Model",
        api: "runtime-provider-context-test",
        baseUrl: "https://example.test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 1024,
      },
      getRegisteredTools() {
        return [];
      },
      getRuntimeModelCatalog() {
        return {
          async getApiKeyAndHeaders() {
            return { ok: true as const, apiKey: "unit-key" };
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
    };

    const provider = createHostedRuntimeProviderPort(session as never);
    for await (const frame of provider.stream({
      turn: { sessionId: "session-1", prompt: "next" },
      prompt: {
        status: "ready",
        sessionId: "session-1",
        messages: [
          { role: "user", content: "find docs" },
          {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                toolCallId: "call-1",
                toolName: "grep",
                args: { query: "architecture" },
              },
            ],
          },
          {
            role: "tool",
            content: "docs/architecture/system-architecture.md",
            toolCallId: "call-1",
            toolName: "grep",
            isError: false,
          },
        ],
        messageSourceEventIds: ["evt-user", "evt-tool", "evt-tool"],
        admittedBlocks: [
          { id: "evt-user", kind: "turn.started", text: "find docs", required: true },
          { id: "evt-tool", kind: "tool.committed", text: "", required: true },
        ],
        droppedAdvisoryBlocks: [],
        tokenEstimate: 0,
        cache: { stablePrefix: false },
      },
    })) {
      void frame;
    }

    expect(observedMessages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "find docs" }],
        timestamp: expect.any(Number),
      },
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "grep",
            arguments: { query: "architecture" },
          },
        ],
        api: "faux",
        provider: "faux",
        model: "runtime-adapter-history",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: expect.any(Number),
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "grep",
        content: [{ type: "text", text: "docs/architecture/system-architecture.md" }],
        isError: false,
        timestamp: expect.any(Number),
      },
    ]);

    unregisterApiProviders(SOURCE_ID);
    clearApiProviders();
  });

  test("keeps hosted context and appends runtime tool results on provider continuation", async () => {
    const sourceId = `${SOURCE_ID}-hosted-tool-continuation`;
    const api = "runtime-provider-hosted-tool-continuation-test";
    const model = createRuntimeModel("unit-model", api);
    const observedContexts: unknown[][] = [];
    let calls = 0;

    clearApiProviders();
    registerApiProvider(
      {
        api,
        stream() {
          return createProviderEventStream();
        },
        streamSimple(_model, context) {
          calls += 1;
          observedContexts.push([...context.messages]);
          const partial = createMessage(api);
          if (calls === 1) {
            const toolCall = {
              type: "toolCall" as const,
              id: "call-1",
              name: "read_file",
              arguments: { path: "README.md" },
            };
            return createProviderEventStream([
              { type: "text_delta", contentIndex: 0, delta: "Checking.", partial },
              {
                type: "toolcall_end",
                contentIndex: 0,
                toolCall,
                partial,
              },
              {
                type: "done",
                reason: "toolUse",
                message: { ...partial, content: [toolCall] },
              },
            ]);
          }
          return createProviderEventStream([
            {
              type: "done",
              reason: "stop",
              message: {
                ...partial,
                content: [{ type: "text", text: "done" }],
                stopReason: "stop",
              },
            },
          ]);
        },
      },
      sourceId,
    );

    try {
      const session = {
        model,
        getRegisteredTools() {
          return [];
        },
        getRuntimeModelCatalog() {
          return {
            async getApiKeyAndHeaders() {
              return { ok: true as const, apiKey: "unit-key" };
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
        [HOSTED_RUNTIME_TURN_CONTEXT]() {
          return {
            messages: [
              {
                role: "user" as const,
                content: [{ type: "text" as const, text: "read README" }],
                timestamp: 1,
              },
              {
                role: "custom" as const,
                customType: "plugin-context",
                content: "plugin-only context",
                timestamp: 2,
              },
            ],
            runtimeEventCursor: null,
          };
        },
      };
      const runtime = createBrewvaRuntime({
        cwd: mkdtempSync(join(tmpdir(), "brewva-hosted-provider-continuation-")),
        physics: {
          mode: "real",
          provider: createHostedRuntimeProviderPort(session as never),
          toolExecutor: {
            async execute() {
              return {
                outcome: { kind: "ok" as const, value: {} },
                content: "README contents",
              };
            },
          },
        },
      });

      await Array.fromAsync(runtime.turn({ sessionId: "session-1", prompt: "read README" }));

      expect(observedContexts).toHaveLength(2);
      expect(observedContexts[0]).toHaveLength(2);
      expect(observedContexts[1]).toHaveLength(5);
      expect(observedContexts[1]?.[1]).toMatchObject({
        role: "user",
        content: [{ type: "text", text: "plugin-only context" }],
      });
      expect(observedContexts[1]?.[2]).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "Checking." }],
      });
      expect(observedContexts[1]?.[3]).toMatchObject({ role: "assistant" });
      expect(observedContexts[1]?.[4]).toMatchObject({
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read_file",
      });
    } finally {
      unregisterApiProviders(sourceId);
      clearApiProviders();
    }
  });

  test("passes turn identity and provider context summary to provider payload hooks", async () => {
    const fauxProvider = registerFauxProvider({
      provider: "faux-provider-context-hook",
      api: "faux-provider-context-hook",
      tokenSize: { min: 1, max: 1 },
    });
    let observedPrepare: unknown;
    fauxProvider.setResponses([fauxAssistantMessage("ok")]);

    try {
      const model = fauxProvider.getModel();
      const session = {
        model,
        getRegisteredTools() {
          return [];
        },
        getRuntimeModelCatalog() {
          return {
            getAll() {
              return [model];
            },
            async getApiKeyAndHeaders() {
              return { ok: true as const, apiKey: "unit-key" };
            },
          };
        },
        async prepareRuntimeProviderPayload(input: {
          payload: unknown;
          turn: { sessionId: string; turnId?: string };
          providerContext: {
            systemPromptHash: string;
            messageHashes: readonly string[];
            activeToolNames: readonly string[];
            toolSurfaceHash: string;
          };
        }) {
          observedPrepare = {
            turn: input.turn,
            providerContext: input.providerContext,
          };
          return input.payload;
        },
        createRuntimeToolContext() {
          return {
            getSystemPrompt() {
              return "Test system prompt.";
            },
          };
        },
      };

      const provider = createHostedRuntimeProviderPort(session as never);
      for await (const frame of provider.stream(
        createRuntimeProviderInput("payload-hook-session"),
      )) {
        void frame;
      }

      expect(observedPrepare).toMatchObject({
        turn: { sessionId: "payload-hook-session" },
        providerContext: {
          systemPromptHash: expect.any(String),
          messageHashes: [expect.any(String)],
          activeToolNames: [],
          toolSurfaceHash: expect.any(String),
        },
      });
    } finally {
      fauxProvider.unregister();
    }
  });
});
