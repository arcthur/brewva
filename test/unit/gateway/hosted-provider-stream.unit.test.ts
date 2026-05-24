import { describe, expect, test } from "bun:test";
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
import type { BrewvaRegisteredModel } from "@brewva/brewva-substrate/provider";
import { createHostedProviderStreamFunction } from "../../../packages/brewva-gateway/src/hosted/internal/provider/stream.js";
import { createHostedRuntimeProviderPort } from "../../../packages/brewva-gateway/src/hosted/internal/turn-adapter/runtime-turn-execution-ports.js";
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
    for await (const _frame of provider.stream({
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
        admittedBlocks: [],
        droppedAdvisoryBlocks: [],
        tokenEstimate: 0,
        cache: { stablePrefix: false },
      },
    })) {
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
});
