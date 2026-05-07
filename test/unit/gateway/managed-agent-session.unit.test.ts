import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  registerExternalApiProvider,
  unregisterApiProviders,
} from "@brewva/brewva-provider-core/registry";
import { BrewvaRuntime, defineContextSourceProvider } from "@brewva/brewva-runtime";
import type { ContextState } from "@brewva/brewva-substrate/contracts";
import {
  type CreateBrewvaHostPluginRunnerOptions,
  defineInternalHostPlugin,
  type BrewvaToolUiPort,
  type RuntimePluginCapability,
} from "@brewva/brewva-substrate/host-api";
import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate/prompt";
import {
  createInMemoryModelCatalog,
  type BrewvaRegisteredModel,
} from "@brewva/brewva-substrate/provider";
import {
  createHostedResourceLoader,
  type BrewvaHostedResourceLoader,
} from "@brewva/brewva-substrate/resources";
import type {
  BrewvaPromptSessionEvent,
  BrewvaPromptThinkingLevel,
  BrewvaSessionMessageEntry,
} from "@brewva/brewva-substrate/session";
import type { BrewvaToolContext } from "@brewva/brewva-substrate/tools";
import { stableHash, stableStringify } from "../../../packages/brewva-gateway/src/cache/index.js";
import type { HostedSessionLogger } from "../../../packages/brewva-gateway/src/host/logger.js";
import {
  MANAGED_AGENT_SESSION_TEST_ONLY,
  createBrewvaManagedAgentSession,
} from "../../../packages/brewva-gateway/src/host/managed-agent-session.js";
import { runHostedPromptTurn } from "../../../packages/brewva-gateway/src/host/run-hosted-prompt-turn.js";
import { HostedRuntimeTapeSessionStore } from "../../../packages/brewva-gateway/src/host/runtime-projection-session-store.js";
import { createHostedTurnPipeline } from "../../../packages/brewva-gateway/src/runtime-plugins/index.js";
import {
  fauxAssistantMessage,
  registerFauxProvider,
} from "../../../packages/brewva-provider-core/src/providers/faux/index.js";
import { createProviderEventStream } from "../../helpers/effect-stream.js";
import { createToolcallDeltaAssistantEvent } from "../../helpers/prompt-session-events.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

type TestRuntimePlugin = NonNullable<CreateBrewvaHostPluginRunnerOptions["plugins"]>[number];

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve(value?: T | PromiseLike<T>): void;
  reject(error: unknown): void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = (value) => resolvePromise(value as T | PromiseLike<T>);
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function testRuntimePlugin(
  name: string,
  capabilities: readonly RuntimePluginCapability[],
  register: TestRuntimePlugin["register"],
): TestRuntimePlugin {
  return defineInternalHostPlugin({
    name,
    capabilities,
    register,
  });
}

const TEST_MODEL: BrewvaRegisteredModel = {
  provider: "openai",
  id: "gpt-5.4-mini",
  name: "GPT-5.4 Mini",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 128000,
  maxTokens: 8192,
};

function textPrompt(text: string): BrewvaPromptContentPart[] {
  return [{ type: "text", text }];
}

function createUsage() {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function writeRoutableSkill(workspace: string): void {
  const skillDir = join(workspace, ".brewva", "skills", "domain", "runtime-tool-probe");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: runtime-tool-probe",
      "description: Debug runtime and repository behavior.",
      "selection:",
      "  when_to_use: Use when investigating runtime, context, skill, or repository behavior.",
      "    - Inspect runtime and skill behavior.",
      "    - investigate",
      "intent:",
      "  outputs: []",
      "effects:",
      "  allowed_effects:",
      "    - workspace_read",
      "    - runtime_observe",
      "resources:",
      "  default_lease:",
      "    max_tool_calls: 20",
      "    max_tokens: 20000",
      "  hard_ceiling:",
      "    max_tool_calls: 40",
      "    max_tokens: 40000",
      "execution_hints:",
      "  preferred_tools: [read]",
      "  fallback_tools: [grep]",
      "consumes: []",
      "requires: []",
      "---",
      "",
      "# Runtime Tool Probe",
      "",
      "Use this skill to investigate runtime behavior.",
      "",
    ].join("\n"),
    "utf8",
  );
}

function createSettingsStub() {
  return {
    getQuietStartup() {
      return true;
    },
    getQueueMode() {
      return "one-at-a-time" as const;
    },
    getFollowUpMode() {
      return "one-at-a-time" as const;
    },
    getTransport() {
      return "sse" as const;
    },
    getCachePolicy() {
      return {
        retention: "short" as const,
        writeMode: "readWrite" as const,
        scope: "session" as const,
        reason: "default" as const,
      };
    },
    getThinkingBudgets() {
      return undefined;
    },
    getRetrySettings() {
      return undefined;
    },
    setDefaultThinkingLevel() {},
    getModelPreferences() {
      return { recent: [], favorite: [] };
    },
    setModelPreferences() {},
    getDiffPreferences() {
      return { style: "auto" as const, wrapMode: "word" as const };
    },
    setDiffPreferences() {},
    getShellViewPreferences() {
      return { showThinking: true, toolDetails: true };
    },
    setShellViewPreferences() {},
  };
}

async function createResourceLoader(workspace: string): Promise<BrewvaHostedResourceLoader> {
  return createHostedResourceLoader({
    cwd: workspace,
    agentDir: join(workspace, ".brewva-agent"),
  });
}

async function createManagedSessionFixture(
  testName: string,
  options?: { logger?: HostedSessionLogger },
) {
  const workspace = createTestWorkspace(testName);
  const runtime = new BrewvaRuntime({ cwd: workspace });
  const sessionStore = new HostedRuntimeTapeSessionStore(runtime, workspace, `${testName}-session`);
  sessionStore.appendModelChange(TEST_MODEL.provider, TEST_MODEL.id);
  sessionStore.appendThinkingLevelChange("high");

  const modelCatalog = createInMemoryModelCatalog();
  modelCatalog.registerProvider(TEST_MODEL.provider, {
    baseUrl: TEST_MODEL.baseUrl,
    apiKey: "test-key",
    models: [
      {
        id: TEST_MODEL.id,
        name: TEST_MODEL.name,
        api: TEST_MODEL.api,
        reasoning: TEST_MODEL.reasoning,
        input: TEST_MODEL.input,
        cost: TEST_MODEL.cost,
        contextWindow: TEST_MODEL.contextWindow,
        maxTokens: TEST_MODEL.maxTokens,
      },
    ],
  });

  const session = await createBrewvaManagedAgentSession({
    cwd: workspace,
    agentDir: join(workspace, ".brewva-agent"),
    sessionStore,
    settings: createSettingsStub(),
    runtime,
    modelCatalog,
    resourceLoader: await createResourceLoader(workspace),
    customTools: [],
    runtimePlugins: [createHostedTurnPipeline({ runtime, registerTools: false })],
    initialModel: TEST_MODEL,
    initialThinkingLevel: "high" as BrewvaPromptThinkingLevel,
    logger: options?.logger,
  });

  return { workspace, runtime, sessionStore, session };
}

function registerModelCatalogProvider(
  modelCatalog: ReturnType<typeof createInMemoryModelCatalog>,
  model: BrewvaRegisteredModel,
): void {
  modelCatalog.registerProvider(model.provider, {
    baseUrl: model.baseUrl,
    apiKey: "test-key",
    models: [
      {
        id: model.id,
        name: model.name,
        api: model.api,
        reasoning: model.reasoning,
        input: model.input,
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
      },
    ],
  });
}

describe("managed agent session compaction", () => {
  test("recall fingerprinting uses precise source matching and content-hash fallback", () => {
    const fallbackContentHash = stableHash(
      stableStringify({
        source: "brewva.recall-broker",
        count: 2,
        estimatedTokens: 34,
      }),
    );

    const fingerprint = MANAGED_AGENT_SESSION_TEST_ONLY.resolveRecallInjectionFingerprint([
      {
        customType: "brewva-context-injection",
        visibility: "hidden",
        content: [],
        details: {
          contextSources: {
            accepted: true,
            sources: [
              {
                source: "brewva.recall-broker",
                count: 2,
                estimatedTokens: 34,
                budgetClasses: ["recall"],
              },
              {
                source: "brewva.recall-eval",
                count: 1,
                estimatedTokens: 10,
                budgetClasses: ["working"],
                contentHash: "should-not-match",
              },
            ],
          },
        },
      } as never,
    ]);

    expect(fingerprint).toEqual(
      expect.objectContaining({
        present: true,
        accepted: true,
        sourceCount: 1,
        sources: ["brewva.recall-broker"],
        estimatedTokens: 34,
        contentHash: stableHash(
          stableStringify([
            {
              source: "brewva.recall-broker",
              count: 2,
              estimatedTokens: 34,
              contentHash: fallbackContentHash,
            },
          ]),
        ),
      }),
    );
  });

  test("cachedContent stream-error detection only downgrades field-level unsupported messages", () => {
    expect(
      MANAGED_AGENT_SESSION_TEST_ONLY.isCachedContentUnsupportedStreamError(
        'Invalid JSON payload received. Unknown name "cachedContent" at "request".',
      ),
    ).toBe(true);
    expect(
      MANAGED_AGENT_SESSION_TEST_ONLY.isCachedContentUnsupportedStreamError(
        "cached content telemetry was omitted for this turn",
      ),
    ).toBe(false);
  });

  test("compacts history into a durable projection entry and replaces the active context", async () => {
    const { runtime, sessionStore, session } = await createManagedSessionFixture(
      "managed-agent-session-compaction",
    );
    sessionStore.appendModelChange(TEST_MODEL.provider, TEST_MODEL.id);
    sessionStore.appendThinkingLevelChange("high");
    const userMessage = {
      role: "user",
      content: [{ type: "text", text: "Inspect the failing verification output." }],
      timestamp: Date.now(),
    };
    const assistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: "I will inspect the verification output now." }],
      api: TEST_MODEL.api,
      provider: TEST_MODEL.provider,
      model: TEST_MODEL.id,
      usage: createUsage(),
      stopReason: "stop",
      timestamp: Date.now() + 1,
    };
    sessionStore.appendMessage(userMessage);
    sessionStore.appendMessage(assistantMessage);

    const events: string[] = [];
    const unsubscribe = session.subscribe((event) => {
      events.push(event.type);
    });

    let completed = false;
    let compactError: string | undefined;
    const toolContext = (
      session as unknown as {
        createToolContext(): BrewvaToolContext;
      }
    ).createToolContext();

    toolContext.compact({
      customInstructions: "Keep only current verification failures.",
      onComplete: () => {
        completed = true;
      },
      onError: (error) => {
        compactError = error instanceof Error ? error.message : String(error);
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));

    unsubscribe();

    expect(compactError).toBeUndefined();
    expect(completed).toBe(true);
    expect(events).toEqual(expect.arrayContaining(["session_before_compact", "session_compact"]));

    const branch = sessionStore.getBranch();
    expect(branch.map((entry) => entry.type)).toContain("compaction");
    expect(
      runtime.inspect.events
        .list(sessionStore.getSessionId())
        .some((event) => event.type.startsWith("hosted_session_projection_")),
    ).toBe(false);

    const context = sessionStore.buildSessionContext();
    expect(context.messages[0]).toEqual(
      expect.objectContaining({
        role: "compactionSummary",
      }),
    );
    expect(context.messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "assistant" })]),
    );

    session.dispose();
  });

  test("emits session phase changes for assistant streaming and tool execution", async () => {
    const { session } = await createManagedSessionFixture("managed-agent-session-phase-events");
    const observedPhases: unknown[] = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "session_phase_change") {
        observedPhases.push((event as { phase?: unknown }).phase);
      }
    });

    const handleAgentEvent = (
      session as unknown as {
        handleAgentEvent(event: unknown): Promise<void>;
      }
    ).handleAgentEvent.bind(session);

    const assistantMessage = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "Inspecting the repository state." }],
      api: TEST_MODEL.api,
      provider: TEST_MODEL.provider,
      model: TEST_MODEL.id,
      usage: createUsage(),
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };

    await handleAgentEvent({ type: "turn_start" });
    await handleAgentEvent({ type: "message_start", message: assistantMessage });
    await handleAgentEvent({ type: "message_end", message: assistantMessage });
    await handleAgentEvent({
      type: "tool_execution_start",
      toolCallId: "tool_1",
      toolName: "read_file",
      args: { path: "README.md" },
    });
    await handleAgentEvent({
      type: "tool_execution_end",
      toolCallId: "tool_1",
      toolName: "read_file",
      result: {
        content: [{ type: "text" as const, text: "ok" }],
        details: {},
      },
      isError: false,
    });

    unsubscribe();

    expect(observedPhases).toEqual([
      {
        kind: "model_streaming",
        modelCallId: "turn:1:assistant",
        turn: 1,
      },
      {
        kind: "idle",
      },
      {
        kind: "tool_executing",
        toolCallId: "tool_1",
        toolName: "read_file",
        turn: 1,
      },
      {
        kind: "idle",
      },
    ]);

    session.dispose();
  });

  test("preserves advisory parseStatus on subscribed message_update events", async () => {
    const { session } = await createManagedSessionFixture("managed-agent-session-parse-status");
    const observedStatuses: string[] = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type !== "message_update") {
        return;
      }
      const assistantMessageEvent = (
        event as Extract<BrewvaPromptSessionEvent, { type: "message_update" }>
      ).assistantMessageEvent;
      if (assistantMessageEvent?.type === "toolcall_delta" && assistantMessageEvent.parseStatus) {
        observedStatuses.push(assistantMessageEvent.parseStatus);
      }
    });

    const handleAgentEvent = (
      session as unknown as {
        handleAgentEvent(event: unknown): Promise<void>;
      }
    ).handleAgentEvent.bind(session);
    const assistantMessage = {
      role: "assistant" as const,
      content: [{ type: "toolCall" as const, id: "tool_1", name: "search", arguments: {} }],
      api: TEST_MODEL.api,
      provider: TEST_MODEL.provider,
      model: TEST_MODEL.id,
      usage: createUsage(),
      stopReason: "toolUse" as const,
      timestamp: Date.now(),
    };

    try {
      await handleAgentEvent({
        type: "message_update",
        message: assistantMessage,
        assistantMessageEvent: createToolcallDeltaAssistantEvent({
          delta: '{"query"',
          partial: assistantMessage,
          parseStatus: "pending",
        }),
      });
    } finally {
      unsubscribe();
      session.dispose();
    }

    expect(observedStatuses).toEqual(["pending"]);
  });

  test("attaches a UI port after session creation so tool context no longer falls back to NOOP_UI", async () => {
    const { session } = await createManagedSessionFixture("managed-agent-session-ui-attach");
    const createToolContext = (
      session as unknown as {
        createToolContext(): BrewvaToolContext;
      }
    ).createToolContext.bind(session);

    expect(createToolContext().hasUI).toBe(false);

    const ui: BrewvaToolUiPort = {
      async select() {
        return undefined;
      },
      async confirm() {
        return false;
      },
      async input() {
        return undefined;
      },
      notify() {},
      onTerminalInput() {
        return () => undefined;
      },
      setStatus() {},
      setWorkingMessage() {},
      setHiddenThinkingLabel() {},
      async custom() {
        return undefined as never;
      },
      pasteToEditor() {},
      setEditorText() {},
      getEditorText() {
        return "";
      },
      async editor() {
        return undefined;
      },
      setEditorComponent() {},
      theme: {},
      getAllThemes() {
        return [];
      },
      getTheme() {
        return undefined;
      },
      setTheme() {
        return { success: true };
      },
      getToolsExpanded() {
        return true;
      },
      setToolsExpanded() {},
    };

    session.setUiPort(ui);

    const nextContext = createToolContext();
    expect(nextContext.hasUI).toBe(true);
    expect(nextContext.ui).toBe(ui);

    session.dispose();
  });

  test("emits session phase changes for approval and recovery runtime facts", async () => {
    const { runtime, session } = await createManagedSessionFixture(
      "managed-agent-session-runtime-phase-events",
    );
    const observedPhases: unknown[] = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "session_phase_change") {
        observedPhases.push((event as { phase?: unknown }).phase);
      }
    });

    const sessionId = session.sessionManager.getSessionId();
    const handleAgentEvent = (
      session as unknown as {
        handleAgentEvent(event: unknown): Promise<void>;
      }
    ).handleAgentEvent.bind(session);

    await handleAgentEvent({ type: "turn_start" });
    await handleAgentEvent({
      type: "tool_execution_start",
      toolCallId: "tool_approval_1",
      toolName: "exec",
      args: { command: "echo hello" },
    });
    observedPhases.length = 0;

    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 1,
      type: "turn_input_recorded",
      payload: {
        turnId: "turn-1",
        trigger: "user",
        promptText: "request approval and recover",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 1,
      type: "effect_commitment_approval_requested",
      payload: {
        requestId: "approval-1",
        toolName: "exec",
        toolCallId: "tool_approval_1",
        subject: "run command",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 1,
      type: "effect_commitment_approval_decided",
      payload: {
        requestId: "approval-1",
        decision: "accept",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 1,
      type: "session_turn_transition",
      payload: {
        reason: "wal_recovery_resume",
        status: "entered",
        sequence: 1,
        family: "recovery",
        attempt: 1,
        sourceEventId: null,
        sourceEventType: null,
        error: null,
        breakerOpen: false,
        model: null,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 1,
      type: "session_turn_transition",
      payload: {
        reason: "wal_recovery_resume",
        status: "completed",
        sequence: 2,
        family: "recovery",
        attempt: 1,
        sourceEventId: null,
        sourceEventType: null,
        error: null,
        breakerOpen: false,
        model: null,
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    unsubscribe();

    expect(observedPhases).toEqual([
      {
        kind: "waiting_approval",
        requestId: "transition:effect_commitment_pending",
        toolCallId: "tool_approval_1",
        toolName: "exec",
        turn: 1,
      },
      {
        kind: "waiting_approval",
        requestId: "approval-1",
        toolCallId: "tool_approval_1",
        toolName: "exec",
        turn: 1,
      },
      {
        kind: "idle",
      },
      {
        kind: "crashed",
        crashAt: "wal_append",
        turn: 1,
        recoveryAnchor: "transition:wal_recovery_resume",
      },
      {
        kind: "recovering",
        recoveryAnchor: "transition:wal_recovery_resume",
        turn: 1,
      },
      {
        kind: "idle",
      },
    ]);

    session.dispose();
  });

  test("clears provider cache detector state on runtime session clear", async () => {
    const workspace = createTestWorkspace("managed-agent-session-provider-cache-clear");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionStore = new HostedRuntimeTapeSessionStore(
      runtime,
      workspace,
      "managed-agent-session-provider-cache-clear-session",
    );
    const fauxProvider = registerFauxProvider({
      api: "managed-session-provider-cache-faux",
      provider: "managed-session-provider-cache",
      models: [
        {
          id: "managed-session-provider-cache-model",
          name: "Managed Session Provider Cache Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 4096,
        },
      ],
    });
    const model = fauxProvider.getModel() as BrewvaRegisteredModel;
    const modelCatalog = createInMemoryModelCatalog();
    registerModelCatalogProvider(modelCatalog, model);

    try {
      sessionStore.appendModelChange(model.provider, model.id);
      sessionStore.appendThinkingLevelChange("off");
      fauxProvider.setResponses([
        () => fauxAssistantMessage("first"),
        () => fauxAssistantMessage("second"),
        () => fauxAssistantMessage("third"),
      ]);

      const session = await createBrewvaManagedAgentSession({
        cwd: workspace,
        agentDir: join(workspace, ".brewva-agent"),
        sessionStore,
        settings: createSettingsStub(),
        runtime,
        modelCatalog,
        resourceLoader: await createResourceLoader(workspace),
        customTools: [],
        runtimePlugins: [createHostedTurnPipeline({ runtime, registerTools: false })],
        initialModel: model,
        initialThinkingLevel: "off",
      });

      try {
        await session.prompt(textPrompt("Repeat cacheable prompt."), {
          expandPromptTemplates: false,
          source: "channel:telegram",
        });
        await session.waitForIdle();
        expect(
          runtime.inspect.context.getProviderCacheObservation(sessionStore.getSessionId())
            ?.breakObservation.status,
        ).toBe("cold");

        await session.prompt(textPrompt("Repeat cacheable prompt."), {
          expandPromptTemplates: false,
          source: "channel:telegram",
        });
        await session.waitForIdle();
        const warmObservation = runtime.inspect.context.getProviderCacheObservation(
          sessionStore.getSessionId(),
        );
        expect(warmObservation?.breakObservation.status).toBe("warm");
        expect(warmObservation?.fingerprint.channelContextHash).toBe(
          stableHash(stableStringify({ source: "channel:telegram" })),
        );

        runtime.maintain.session.clearState(sessionStore.getSessionId());

        await session.prompt(textPrompt("Repeat cacheable prompt."), {
          expandPromptTemplates: false,
          source: "channel:telegram",
        });
        await session.waitForIdle();
        expect(
          runtime.inspect.context.getProviderCacheObservation(sessionStore.getSessionId())
            ?.breakObservation.status,
        ).toBe("cold");
      } finally {
        session.dispose();
      }
    } finally {
      fauxProvider.unregister();
    }
  });

  test("awaits async provider session clear before model switch resolves", async () => {
    const workspace = createTestWorkspace("managed-agent-session-model-switch-awaits-clear");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionStore = new HostedRuntimeTapeSessionStore(
      runtime,
      workspace,
      "managed-agent-session-model-switch-awaits-clear-session",
    );
    const nextModel: BrewvaRegisteredModel = {
      ...TEST_MODEL,
      provider: "openai-next",
      id: "gpt-next",
      name: "GPT Next",
    };
    const modelCatalog = createInMemoryModelCatalog();
    registerModelCatalogProvider(modelCatalog, TEST_MODEL);
    registerModelCatalogProvider(modelCatalog, nextModel);
    sessionStore.appendModelChange(TEST_MODEL.provider, TEST_MODEL.id);
    sessionStore.appendThinkingLevelChange("high");

    const sourceId = "managed-agent-session-model-switch-awaits-clear-provider";
    const clear = createDeferred();
    const clearedSessions: string[] = [];
    registerExternalApiProvider(
      {
        api: "managed-agent-session-model-switch-awaits-clear",
        stream() {
          return createProviderEventStream();
        },
        streamSimple() {
          return createProviderEventStream();
        },
        sessionResources: {
          clearSession(sessionId) {
            clearedSessions.push(sessionId);
            return clear.promise;
          },
        },
      },
      sourceId,
    );

    const session = await createBrewvaManagedAgentSession({
      cwd: workspace,
      agentDir: join(workspace, ".brewva-agent"),
      sessionStore,
      settings: createSettingsStub(),
      runtime,
      modelCatalog,
      resourceLoader: await createResourceLoader(workspace),
      customTools: [],
      runtimePlugins: [createHostedTurnPipeline({ runtime, registerTools: false })],
      initialModel: TEST_MODEL,
      initialThinkingLevel: "high",
    });

    try {
      if (typeof session.setModel !== "function") {
        throw new Error("managed agent session should expose setModel");
      }
      let resolved = false;
      const switchModel = Promise.resolve(session.setModel(nextModel)).then(() => {
        resolved = true;
      });

      await flushMicrotasks();

      expect(clearedSessions).toEqual([sessionStore.getSessionId()]);
      expect(resolved).toBe(false);

      clear.resolve();
      await switchModel;

      expect(resolved).toBe(true);
    } finally {
      clear.resolve();
      session.dispose();
      unregisterApiProviders(sourceId);
    }
  });

  test("awaits async provider session clear before replacing messages", async () => {
    const { sessionStore, session } = await createManagedSessionFixture(
      "managed-agent-session-replace-awaits-clear",
    );
    const sourceId = "managed-agent-session-replace-awaits-clear-provider";
    const clear = createDeferred();
    const clearedSessions: string[] = [];
    registerExternalApiProvider(
      {
        api: "managed-agent-session-replace-awaits-clear",
        stream() {
          return createProviderEventStream();
        },
        streamSimple() {
          return createProviderEventStream();
        },
        sessionResources: {
          clearSession(sessionId) {
            clearedSessions.push(sessionId);
            return clear.promise;
          },
        },
      },
      sourceId,
    );

    try {
      if (typeof session.replaceMessages !== "function") {
        throw new Error("managed agent session should expose replaceMessages");
      }
      let resolved = false;
      const replaceMessages = Promise.resolve(session.replaceMessages([])).then(() => {
        resolved = true;
      });

      await flushMicrotasks();

      expect(clearedSessions).toEqual([sessionStore.getSessionId()]);
      expect(resolved).toBe(false);

      clear.resolve();
      await replaceMessages;

      expect(resolved).toBe(true);
    } finally {
      clear.resolve();
      session.dispose();
      unregisterApiProviders(sourceId);
    }
  });

  test("replays persisted session context into the first hosted context request", async () => {
    const workspace = createTestWorkspace("managed-agent-session-replay");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionStore = new HostedRuntimeTapeSessionStore(
      runtime,
      workspace,
      "managed-agent-session-replay-session",
    );
    const fauxProvider = registerFauxProvider({
      api: "managed-session-replay-faux",
      provider: "managed-session-replay",
      models: [
        {
          id: "managed-session-replay-model",
          name: "Managed Session Replay Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 4096,
        },
      ],
    });
    const replayModel = fauxProvider.getModel();
    const observedContexts: Array<Array<{ role?: unknown; content?: unknown }>> = [];
    const captureContextPlugin = testRuntimePlugin(
      "capture-replay-context",
      ["context_messages.write"],
      (api) => {
        api.on("context", (event) => {
          observedContexts.push(
            structuredClone(event.messages) as Array<{ role?: unknown; content?: unknown }>,
          );
          return event;
        });
      },
    );

    try {
      sessionStore.appendModelChange(replayModel.provider, replayModel.id);
      sessionStore.appendThinkingLevelChange("off");
      const persistedUserMessage = {
        role: "user",
        content: [{ type: "text", text: "Persisted user prompt." }],
        timestamp: Date.now(),
      } as BrewvaSessionMessageEntry["message"];
      const persistedAssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "Persisted assistant response." }],
        api: replayModel.api,
        provider: replayModel.provider,
        model: replayModel.id,
        usage: createUsage(),
        stopReason: "stop",
        timestamp: Date.now() + 1,
      } as BrewvaSessionMessageEntry["message"];
      sessionStore.appendMessage(persistedUserMessage);
      sessionStore.appendMessage(persistedAssistantMessage);
      sessionStore.appendCustomMessageEntry("note", "Persisted custom instruction.", true, {
        source: "resume-test",
      });
      sessionStore.branchWithSummary(
        sessionStore.getLeafId(),
        "Persisted branch summary.",
        { source: "resume-test" },
        false,
      );

      const modelCatalog = createInMemoryModelCatalog();
      modelCatalog.registerProvider(replayModel.provider, {
        baseUrl: replayModel.baseUrl,
        apiKey: "test-key",
        models: [
          {
            id: replayModel.id,
            name: replayModel.name,
            api: replayModel.api,
            reasoning: replayModel.reasoning,
            input: replayModel.input,
            cost: replayModel.cost,
            contextWindow: replayModel.contextWindow,
            maxTokens: replayModel.maxTokens,
          },
        ],
      });

      fauxProvider.setResponses([
        () => ({
          role: "assistant",
          content: [{ type: "text", text: "Replay acknowledged." }],
          api: replayModel.api,
          provider: replayModel.provider,
          model: replayModel.id,
          usage: createUsage(),
          stopReason: "stop",
          timestamp: Date.now() + 2,
        }),
      ]);

      const session = await createBrewvaManagedAgentSession({
        cwd: workspace,
        agentDir: join(workspace, ".brewva-agent"),
        sessionStore,
        settings: createSettingsStub(),
        modelCatalog,
        resourceLoader: await createResourceLoader(workspace),
        customTools: [],
        runtimePlugins: [
          captureContextPlugin,
          createHostedTurnPipeline({ runtime, registerTools: false }),
        ],
        initialModel: replayModel,
        initialThinkingLevel: "off",
      });

      try {
        await session.prompt(textPrompt("Resume from the restored context."), {
          expandPromptTemplates: false,
        });

        expect(observedContexts).toHaveLength(1);
        expect(observedContexts[0]?.map((message) => message.role)).toEqual([
          "user",
          "assistant",
          "custom",
          "branchSummary",
          "user",
          "custom",
        ]);
        expect(observedContexts[0]?.[0]).toEqual(
          expect.objectContaining({
            role: "user",
            content: [{ type: "text", text: "Persisted user prompt." }],
          }),
        );
        expect(observedContexts[0]?.[1]).toEqual(
          expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "Persisted assistant response." }],
          }),
        );
        expect(observedContexts[0]?.[2]).toEqual(
          expect.objectContaining({
            role: "custom",
            content: "Persisted custom instruction.",
          }),
        );
        expect(observedContexts[0]?.[3]).toEqual(
          expect.objectContaining({
            role: "branchSummary",
            summary: "Persisted branch summary.",
          }),
        );
        expect(observedContexts[0]?.[4]).toEqual(
          expect.objectContaining({
            role: "user",
            content: [{ type: "text", text: "Resume from the restored context." }],
          }),
        );
        expect(observedContexts[0]?.[5]).toEqual(
          expect.objectContaining({
            role: "custom",
          }),
        );
      } finally {
        session.dispose();
      }
    } finally {
      fauxProvider.unregister();
    }
  });

  test("preserves structured file prompt parts in the hosted user message context", async () => {
    const workspace = createTestWorkspace("managed-agent-session-file-parts");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionStore = new HostedRuntimeTapeSessionStore(
      runtime,
      workspace,
      "managed-agent-session-file-parts-session",
    );
    const fauxProvider = registerFauxProvider({
      api: "managed-session-file-parts-faux",
      provider: "managed-session-file-parts",
      models: [
        {
          id: "managed-session-file-parts-model",
          name: "Managed Session File Parts Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 4096,
        },
      ],
    });
    const replayModel = fauxProvider.getModel();
    const observedContexts: Array<Array<{ role?: unknown; content?: unknown }>> = [];
    const captureContextPlugin = testRuntimePlugin(
      "capture-file-parts-context",
      ["context_messages.write"],
      (api) => {
        api.on("context", (event) => {
          observedContexts.push(
            structuredClone(event.messages) as Array<{ role?: unknown; content?: unknown }>,
          );
          return event;
        });
      },
    );

    try {
      sessionStore.appendModelChange(replayModel.provider, replayModel.id);
      sessionStore.appendThinkingLevelChange("off");

      const modelCatalog = createInMemoryModelCatalog();
      modelCatalog.registerProvider(replayModel.provider, {
        baseUrl: replayModel.baseUrl,
        apiKey: "test-key",
        models: [
          {
            id: replayModel.id,
            name: replayModel.name,
            api: replayModel.api,
            reasoning: replayModel.reasoning,
            input: replayModel.input,
            cost: replayModel.cost,
            contextWindow: replayModel.contextWindow,
            maxTokens: replayModel.maxTokens,
          },
        ],
      });

      fauxProvider.setResponses([
        () => ({
          role: "assistant",
          content: [{ type: "text", text: "Structured file prompt acknowledged." }],
          api: replayModel.api,
          provider: replayModel.provider,
          model: replayModel.id,
          usage: createUsage(),
          stopReason: "stop",
          timestamp: Date.now() + 1,
        }),
      ]);

      const session = await createBrewvaManagedAgentSession({
        cwd: workspace,
        agentDir: join(workspace, ".brewva-agent"),
        sessionStore,
        settings: createSettingsStub(),
        modelCatalog,
        resourceLoader: await createResourceLoader(workspace),
        customTools: [],
        runtimePlugins: [
          captureContextPlugin,
          createHostedTurnPipeline({ runtime, registerTools: false }),
        ],
        initialModel: replayModel,
        initialThinkingLevel: "off",
      });

      try {
        await (
          session as unknown as {
            prompt(parts: unknown[], options?: Record<string, unknown>): Promise<void>;
          }
        ).prompt(
          [
            { type: "text", text: "Review this attachment: " },
            {
              type: "file",
              uri: `file://${join(workspace, "README.md")}`,
              displayText: "@README.md",
              name: "README.md",
            },
          ],
          {
            expandPromptTemplates: false,
            source: "interactive",
          },
        );

        expect(observedContexts).toHaveLength(1);
        expect(observedContexts[0]?.[0]).toEqual(
          expect.objectContaining({
            role: "user",
            content: [
              { type: "text", text: "Review this attachment: " },
              {
                type: "file",
                uri: `file://${join(workspace, "README.md")}`,
                displayText: "@README.md",
                name: "README.md",
              },
            ],
          }),
        );
      } finally {
        session.dispose();
      }
    } finally {
      fauxProvider.unregister();
    }
  });

  test("hydrates the initial session phase from lifecycle snapshot on resume", async () => {
    const workspace = createTestWorkspace("managed-agent-session-history-phase");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionStore = new HostedRuntimeTapeSessionStore(
      runtime,
      workspace,
      "managed-agent-session-history-phase-session",
    );
    sessionStore.appendModelChange(TEST_MODEL.provider, TEST_MODEL.id);
    sessionStore.appendThinkingLevelChange("high");

    const sessionId = sessionStore.getSessionId();
    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 1,
      type: "turn_input_recorded",
      payload: {
        turnId: "turn-history-1",
        trigger: "user",
        promptText: "resume while waiting for approval",
      },
    });
    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 1,
      type: "effect_commitment_approval_requested",
      payload: {
        requestId: "approval-history-1",
        toolName: "exec",
        toolCallId: "tool-history-1",
        subject: "run command",
      },
    });
    (
      sessionStore as HostedRuntimeTapeSessionStore & {
        querySessionWire(): never;
      }
    ).querySessionWire = () => {
      throw new Error("managed-agent-session should bootstrap from lifecycle snapshot");
    };

    const observedPhases: string[] = [];
    const plugin = testRuntimePlugin("observe-session-phase", [], (api) => {
      api.on("session_phase_change", (event) => {
        observedPhases.push(event.phase.kind);
      });
    });

    const modelCatalog = createInMemoryModelCatalog();
    modelCatalog.registerProvider(TEST_MODEL.provider, {
      baseUrl: TEST_MODEL.baseUrl,
      apiKey: "test-key",
      models: [
        {
          id: TEST_MODEL.id,
          name: TEST_MODEL.name,
          api: TEST_MODEL.api,
          reasoning: TEST_MODEL.reasoning,
          input: TEST_MODEL.input,
          cost: TEST_MODEL.cost,
          contextWindow: TEST_MODEL.contextWindow,
          maxTokens: TEST_MODEL.maxTokens,
        },
      ],
    });

    const session = await createBrewvaManagedAgentSession({
      cwd: workspace,
      agentDir: join(workspace, ".brewva-agent"),
      sessionStore,
      settings: createSettingsStub(),
      modelCatalog,
      resourceLoader: await createResourceLoader(workspace),
      customTools: [],
      runtimePlugins: [plugin, createHostedTurnPipeline({ runtime, registerTools: false })],
      initialModel: TEST_MODEL,
      initialThinkingLevel: "high",
    });

    try {
      const getSessionPhase = (
        session as unknown as {
          getSessionPhase(): {
            kind: string;
            requestId?: string;
            toolCallId?: string;
            toolName?: string;
            turn?: number;
          };
        }
      ).getSessionPhase.bind(session);

      expect(getSessionPhase()).toEqual({
        kind: "waiting_approval",
        requestId: "approval-history-1",
        toolCallId: "tool-history-1",
        toolName: "exec",
        turn: 1,
      });
      expect(observedPhases).toContain("waiting_approval");
    } finally {
      session.dispose();
    }
  });

  test("does not warn when lifecycle bootstrap reconciles waiting approval posture", async () => {
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    const workspace = createTestWorkspace("managed-agent-session-history-phase-warning");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionStore = new HostedRuntimeTapeSessionStore(
      runtime,
      workspace,
      "managed-agent-session-history-phase-warning-session",
    );
    sessionStore.appendModelChange(TEST_MODEL.provider, TEST_MODEL.id);
    sessionStore.appendThinkingLevelChange("high");

    const sessionId = sessionStore.getSessionId();
    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 1,
      type: "turn_input_recorded",
      payload: {
        turnId: "turn-history-warning-1",
        trigger: "user",
        promptText: "resume while waiting for approval",
      },
    });
    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 1,
      type: "effect_commitment_approval_requested",
      payload: {
        requestId: "approval-history-warning-1",
        toolName: "exec",
        toolCallId: "tool-history-warning-1",
        subject: "run command",
      },
    });
    (
      sessionStore as HostedRuntimeTapeSessionStore & {
        querySessionWire(): never;
      }
    ).querySessionWire = () => {
      throw new Error("managed-agent-session should bootstrap from lifecycle snapshot");
    };

    const modelCatalog = createInMemoryModelCatalog();
    modelCatalog.registerProvider(TEST_MODEL.provider, {
      baseUrl: TEST_MODEL.baseUrl,
      apiKey: "test-key",
      models: [
        {
          id: TEST_MODEL.id,
          name: TEST_MODEL.name,
          api: TEST_MODEL.api,
          reasoning: TEST_MODEL.reasoning,
          input: TEST_MODEL.input,
          cost: TEST_MODEL.cost,
          contextWindow: TEST_MODEL.contextWindow,
          maxTokens: TEST_MODEL.maxTokens,
        },
      ],
    });

    const session = await createBrewvaManagedAgentSession({
      cwd: workspace,
      agentDir: join(workspace, ".brewva-agent"),
      sessionStore,
      settings: createSettingsStub(),
      modelCatalog,
      resourceLoader: await createResourceLoader(workspace),
      customTools: [],
      runtimePlugins: [createHostedTurnPipeline({ runtime, registerTools: false })],
      initialModel: TEST_MODEL,
      initialThinkingLevel: "high",
    });

    try {
      expect(warnings).toEqual([]);
    } finally {
      console.warn = originalWarn;
      session.dispose();
    }
  });

  test("hydrates tool execution phase from lifecycle snapshot on resume", async () => {
    const workspace = createTestWorkspace("managed-agent-session-history-tool-phase");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionStore = new HostedRuntimeTapeSessionStore(
      runtime,
      workspace,
      "managed-agent-session-history-tool-phase-session",
    );
    sessionStore.appendModelChange(TEST_MODEL.provider, TEST_MODEL.id);
    sessionStore.appendThinkingLevelChange("high");

    const sessionId = sessionStore.getSessionId();
    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 2,
      type: "turn_input_recorded",
      payload: {
        turnId: "turn-history-tool-1",
        trigger: "user",
        promptText: "resume while tool execution is still active",
      },
    });
    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 2,
      type: "tool_execution_start",
      payload: {
        toolCallId: "tool-history-tool-1",
        toolName: "read",
      },
    });
    (
      sessionStore as HostedRuntimeTapeSessionStore & {
        querySessionWire(): never;
      }
    ).querySessionWire = () => {
      throw new Error(
        "managed-agent-session should bootstrap tool execution from lifecycle snapshot",
      );
    };

    const modelCatalog = createInMemoryModelCatalog();
    modelCatalog.registerProvider(TEST_MODEL.provider, {
      baseUrl: TEST_MODEL.baseUrl,
      apiKey: "test-key",
      models: [
        {
          id: TEST_MODEL.id,
          name: TEST_MODEL.name,
          api: TEST_MODEL.api,
          reasoning: TEST_MODEL.reasoning,
          input: TEST_MODEL.input,
          cost: TEST_MODEL.cost,
          contextWindow: TEST_MODEL.contextWindow,
          maxTokens: TEST_MODEL.maxTokens,
        },
      ],
    });

    const session = await createBrewvaManagedAgentSession({
      cwd: workspace,
      agentDir: join(workspace, ".brewva-agent"),
      sessionStore,
      settings: createSettingsStub(),
      modelCatalog,
      resourceLoader: await createResourceLoader(workspace),
      customTools: [],
      runtimePlugins: [createHostedTurnPipeline({ runtime, registerTools: false })],
      initialModel: TEST_MODEL,
      initialThinkingLevel: "high",
    });

    try {
      const getSessionPhase = (
        session as unknown as {
          getSessionPhase(): {
            kind: string;
            toolCallId?: string;
            toolName?: string;
            turn?: number;
          };
        }
      ).getSessionPhase.bind(session);

      expect(getSessionPhase()).toEqual({
        kind: "tool_executing",
        toolCallId: "tool-history-tool-1",
        toolName: "read",
        turn: 2,
      });
    } finally {
      session.dispose();
    }
  });

  test("hydrates recovering phase from lifecycle snapshot on resume", async () => {
    const workspace = createTestWorkspace("managed-agent-session-history-recovery-phase");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionStore = new HostedRuntimeTapeSessionStore(
      runtime,
      workspace,
      "managed-agent-session-history-recovery-phase-session",
    );
    sessionStore.appendModelChange(TEST_MODEL.provider, TEST_MODEL.id);
    sessionStore.appendThinkingLevelChange("high");

    const sessionId = sessionStore.getSessionId();
    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 1,
      type: "turn_input_recorded",
      payload: {
        turnId: "turn-history-recovery-1",
        trigger: "recovery",
        promptText: "resume after worker crash",
      },
    });
    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 1,
      type: "session_turn_transition",
      payload: {
        reason: "wal_recovery_resume",
        status: "entered",
        sequence: 1,
        family: "recovery",
        attempt: 1,
        sourceEventId: "wal-1",
        sourceEventType: "recovery_wal_recovery_completed",
        error: null,
        breakerOpen: false,
        model: null,
      },
    });
    (
      sessionStore as HostedRuntimeTapeSessionStore & {
        querySessionWire(): never;
      }
    ).querySessionWire = () => {
      throw new Error("managed-agent-session should bootstrap from lifecycle snapshot");
    };

    const modelCatalog = createInMemoryModelCatalog();
    modelCatalog.registerProvider(TEST_MODEL.provider, {
      baseUrl: TEST_MODEL.baseUrl,
      apiKey: "test-key",
      models: [
        {
          id: TEST_MODEL.id,
          name: TEST_MODEL.name,
          api: TEST_MODEL.api,
          reasoning: TEST_MODEL.reasoning,
          input: TEST_MODEL.input,
          cost: TEST_MODEL.cost,
          contextWindow: TEST_MODEL.contextWindow,
          maxTokens: TEST_MODEL.maxTokens,
        },
      ],
    });

    const session = await createBrewvaManagedAgentSession({
      cwd: workspace,
      agentDir: join(workspace, ".brewva-agent"),
      sessionStore,
      settings: createSettingsStub(),
      modelCatalog,
      resourceLoader: await createResourceLoader(workspace),
      customTools: [],
      runtimePlugins: [createHostedTurnPipeline({ runtime, registerTools: false })],
      initialModel: TEST_MODEL,
      initialThinkingLevel: "high",
    });

    try {
      const getSessionPhase = (
        session as unknown as {
          getSessionPhase(): { kind: string; recoveryAnchor?: string; turn?: number };
        }
      ).getSessionPhase.bind(session);

      expect(getSessionPhase()).toEqual({
        kind: "recovering",
        recoveryAnchor: "transition:wal_recovery_resume",
        turn: 1,
      });
    } finally {
      session.dispose();
    }
  });

  test("does not warn when lifecycle bootstrap reconciles recovering posture", async () => {
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      warnings.push(args);
    };

    const workspace = createTestWorkspace("managed-agent-session-history-recovery-warning");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionStore = new HostedRuntimeTapeSessionStore(
      runtime,
      workspace,
      "managed-agent-session-history-recovery-warning-session",
    );
    sessionStore.appendModelChange(TEST_MODEL.provider, TEST_MODEL.id);
    sessionStore.appendThinkingLevelChange("high");

    const sessionId = sessionStore.getSessionId();
    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 1,
      type: "turn_input_recorded",
      payload: {
        turnId: "turn-history-recovery-warning-1",
        trigger: "recovery",
        promptText: "resume after worker crash",
      },
    });
    runtime.extensions.hosted.events.record({
      sessionId,
      turn: 1,
      type: "session_turn_transition",
      payload: {
        reason: "wal_recovery_resume",
        status: "entered",
        sequence: 1,
        family: "recovery",
        attempt: 1,
        sourceEventId: "wal-warning-1",
        sourceEventType: "recovery_wal_recovery_completed",
        error: null,
        breakerOpen: false,
        model: null,
      },
    });
    (
      sessionStore as HostedRuntimeTapeSessionStore & {
        querySessionWire(): never;
      }
    ).querySessionWire = () => {
      throw new Error("managed-agent-session should bootstrap from lifecycle snapshot");
    };

    const modelCatalog = createInMemoryModelCatalog();
    modelCatalog.registerProvider(TEST_MODEL.provider, {
      baseUrl: TEST_MODEL.baseUrl,
      apiKey: "test-key",
      models: [
        {
          id: TEST_MODEL.id,
          name: TEST_MODEL.name,
          api: TEST_MODEL.api,
          reasoning: TEST_MODEL.reasoning,
          input: TEST_MODEL.input,
          cost: TEST_MODEL.cost,
          contextWindow: TEST_MODEL.contextWindow,
          maxTokens: TEST_MODEL.maxTokens,
        },
      ],
    });

    const session = await createBrewvaManagedAgentSession({
      cwd: workspace,
      agentDir: join(workspace, ".brewva-agent"),
      sessionStore,
      settings: createSettingsStub(),
      modelCatalog,
      resourceLoader: await createResourceLoader(workspace),
      customTools: [],
      runtimePlugins: [createHostedTurnPipeline({ runtime, registerTools: false })],
      initialModel: TEST_MODEL,
      initialThinkingLevel: "high",
    });

    try {
      expect(warnings).toEqual([]);
    } finally {
      console.warn = originalWarn;
      session.dispose();
    }
  });

  test("warns on representable incompatible reconciled phase deltas but preserves compatibility assignment", async () => {
    const warnings: Array<{ message: string; fields?: Record<string, unknown> }> = [];
    const logger: HostedSessionLogger = {
      warn(message, fields) {
        warnings.push({ message, fields });
      },
    };

    const { session } = await createManagedSessionFixture(
      "managed-agent-session-reconcile-warning-invalid-delta",
      { logger },
    );

    try {
      const sessionInternal = session as unknown as {
        transitionSessionPhase(event: { type: string; reason?: string }): Promise<void>;
        reconcileSessionPhase(phase: {
          kind: string;
          modelCallId?: string;
          turn?: number;
        }): Promise<void>;
        getSessionPhase(): {
          kind: string;
          modelCallId?: string;
          turn?: number;
        };
      };

      await sessionInternal.transitionSessionPhase({
        type: "terminate",
        reason: "host_closed",
      });
      await sessionInternal.reconcileSessionPhase({
        kind: "model_streaming",
        modelCallId: "model-reconcile-warning-1",
        turn: 3,
      });

      expect(sessionInternal.getSessionPhase()).toEqual({
        kind: "model_streaming",
        modelCallId: "model-reconcile-warning-1",
        turn: 3,
      });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]?.message).toBe("managed_agent_session_phase_reconcile_mismatch");
      expect(warnings[0]?.fields).toEqual(
        expect.objectContaining({
          validationEvent: "start_model_stream",
          previousKind: "terminated",
          nextKind: "model_streaming",
        }),
      );
    } finally {
      session.dispose();
    }
  });

  test("routes non-turn custom messages through plugin hooks and durable message_end persistence", async () => {
    const workspace = createTestWorkspace("managed-agent-session-custom-message-hooks");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionStore = new HostedRuntimeTapeSessionStore(
      runtime,
      workspace,
      "managed-agent-session-custom-message-hooks-session",
    );
    sessionStore.appendModelChange(TEST_MODEL.provider, TEST_MODEL.id);
    sessionStore.appendThinkingLevelChange("high");

    const observedEvents: string[] = [];
    const plugin = testRuntimePlugin("observe-custom-message-hooks", [], (api) => {
      api.on("message_start", () => {
        observedEvents.push("message_start");
      });
      api.on("message_end", () => {
        observedEvents.push("message_end");
      });
    });

    const modelCatalog = createInMemoryModelCatalog();
    modelCatalog.registerProvider(TEST_MODEL.provider, {
      baseUrl: TEST_MODEL.baseUrl,
      apiKey: "test-key",
      models: [
        {
          id: TEST_MODEL.id,
          name: TEST_MODEL.name,
          api: TEST_MODEL.api,
          reasoning: TEST_MODEL.reasoning,
          input: TEST_MODEL.input,
          cost: TEST_MODEL.cost,
          contextWindow: TEST_MODEL.contextWindow,
          maxTokens: TEST_MODEL.maxTokens,
        },
      ],
    });

    const session = await createBrewvaManagedAgentSession({
      cwd: workspace,
      agentDir: join(workspace, ".brewva-agent"),
      sessionStore,
      settings: createSettingsStub(),
      modelCatalog,
      resourceLoader: await createResourceLoader(workspace),
      customTools: [],
      runtimePlugins: [plugin, createHostedTurnPipeline({ runtime, registerTools: false })],
      initialModel: TEST_MODEL,
      initialThinkingLevel: "high",
    });

    try {
      const sendCustomMessage = (
        session as unknown as {
          sendCustomMessage(
            message: { customType: string; content: string; display?: boolean; details?: unknown },
            options?: { triggerTurn?: boolean },
          ): Promise<void>;
        }
      ).sendCustomMessage.bind(session);

      await sendCustomMessage(
        {
          customType: "note",
          content: "Persist this custom note via plugin hooks.",
          display: true,
          details: { source: "test" },
        },
        { triggerTurn: false },
      );

      expect(observedEvents).toEqual(["message_start", "message_end"]);
      const messageEnds = runtime.inspect.events.query(sessionStore.getSessionId(), {
        type: "message_end",
      });
      expect(messageEnds).toHaveLength(1);
      expect(messageEnds[0]?.payload).toEqual(
        expect.objectContaining({
          role: "custom",
          health: expect.any(Object),
        }),
      );
    } finally {
      session.dispose();
    }
  });

  test("fails fast when a runtime-backed session is created without hosted persistence plugins", async () => {
    const workspace = createTestWorkspace("managed-agent-session-missing-persistence-plugins");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionStore = new HostedRuntimeTapeSessionStore(
      runtime,
      workspace,
      "managed-agent-session-missing-persistence-plugins-session",
    );
    sessionStore.appendModelChange(TEST_MODEL.provider, TEST_MODEL.id);
    sessionStore.appendThinkingLevelChange("high");

    const modelCatalog = createInMemoryModelCatalog();
    modelCatalog.registerProvider(TEST_MODEL.provider, {
      baseUrl: TEST_MODEL.baseUrl,
      apiKey: "test-key",
      models: [
        {
          id: TEST_MODEL.id,
          name: TEST_MODEL.name,
          api: TEST_MODEL.api,
          reasoning: TEST_MODEL.reasoning,
          input: TEST_MODEL.input,
          cost: TEST_MODEL.cost,
          contextWindow: TEST_MODEL.contextWindow,
          maxTokens: TEST_MODEL.maxTokens,
        },
      ],
    });

    return expect(
      createBrewvaManagedAgentSession({
        cwd: workspace,
        agentDir: join(workspace, ".brewva-agent"),
        sessionStore,
        settings: createSettingsStub(),
        modelCatalog,
        resourceLoader: await createResourceLoader(workspace),
        customTools: [],
        runtimePlugins: [],
        initialModel: TEST_MODEL,
        initialThinkingLevel: "high",
      }),
    ).rejects.toThrow(
      "Hosted runtime-backed sessions require persistence handlers for message_end, session_compact.",
    );
  });

  test("emits thinking level changes through host plugins while persisting them durably", async () => {
    const { workspace, runtime, sessionStore, session } = await createManagedSessionFixture(
      "managed-agent-session-thinking-level-select",
    );
    const observedThinkingLevels: Array<{
      thinkingLevel: string;
      previousThinkingLevel?: string;
    }> = [];
    const plugin = testRuntimePlugin("observe-thinking-level", [], (api) => {
      api.on("thinking_level_select", (event) => {
        observedThinkingLevels.push({
          thinkingLevel: event.thinkingLevel,
          previousThinkingLevel: event.previousThinkingLevel,
        });
      });
    });

    session.dispose();

    const modelCatalog = createInMemoryModelCatalog();
    modelCatalog.registerProvider(TEST_MODEL.provider, {
      baseUrl: TEST_MODEL.baseUrl,
      apiKey: "test-key",
      models: [
        {
          id: TEST_MODEL.id,
          name: TEST_MODEL.name,
          api: TEST_MODEL.api,
          reasoning: TEST_MODEL.reasoning,
          input: TEST_MODEL.input,
          cost: TEST_MODEL.cost,
          contextWindow: TEST_MODEL.contextWindow,
          maxTokens: TEST_MODEL.maxTokens,
        },
      ],
    });

    const recreated = await createBrewvaManagedAgentSession({
      cwd: workspace,
      agentDir: join(workspace, ".brewva-agent"),
      sessionStore,
      settings: createSettingsStub(),
      modelCatalog,
      resourceLoader: await createResourceLoader(workspace),
      customTools: [],
      runtimePlugins: [plugin, createHostedTurnPipeline({ runtime, registerTools: false })],
      initialModel: TEST_MODEL,
      initialThinkingLevel: "high",
    });

    try {
      if (!recreated.setThinkingLevel) {
        throw new Error("expected managed session to expose setThinkingLevel");
      }
      recreated.setThinkingLevel("off");

      expect(observedThinkingLevels).toEqual([
        {
          thinkingLevel: "off",
          previousThinkingLevel: "high",
        },
      ]);
      const thinkingLevelEvents = runtime.inspect.events.list(sessionStore.getSessionId(), {
        type: "thinking_level_select",
      });
      expect(
        thinkingLevelEvents.some(
          (event) =>
            event.payload &&
            typeof event.payload === "object" &&
            (event.payload as { thinkingLevel?: unknown }).thinkingLevel === "off",
        ),
      ).toBe(true);
    } finally {
      recreated.dispose();
    }
  });

  test("keeps the live session compacted when a post-commit session_compact plugin throws", async () => {
    const workspace = createTestWorkspace("managed-agent-session-compaction-post-commit-failure");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionStore = new HostedRuntimeTapeSessionStore(
      runtime,
      workspace,
      "managed-agent-session-compaction-post-commit-failure-session",
    );

    const fauxProvider = registerFauxProvider({
      api: "managed-session-compaction-faux",
      provider: "managed-session-compaction",
      models: [
        {
          id: "managed-session-compaction-model",
          name: "Managed Session Compaction Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 4096,
        },
      ],
    });
    const replayModel = fauxProvider.getModel();

    try {
      sessionStore.appendModelChange(replayModel.provider, replayModel.id);
      sessionStore.appendThinkingLevelChange("off");
      sessionStore.appendMessage({
        role: "user",
        content: [{ type: "text", text: "Inspect the failed build." }],
        timestamp: Date.now(),
      } as BrewvaSessionMessageEntry["message"]);
      sessionStore.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "I will inspect the build log." }],
        api: replayModel.api,
        provider: replayModel.provider,
        model: replayModel.id,
        usage: createUsage(),
        stopReason: "stop",
        timestamp: Date.now() + 1,
      } as BrewvaSessionMessageEntry["message"]);

      const observedContexts: Array<
        Array<{ role?: unknown; summary?: unknown; content?: unknown }>
      > = [];
      const captureContextPlugin = testRuntimePlugin(
        "capture-compaction-context",
        ["context_messages.write"],
        (api) => {
          api.on("context", (event) => {
            observedContexts.push(
              structuredClone(event.messages) as Array<{
                role?: unknown;
                summary?: unknown;
                content?: unknown;
              }>,
            );
            return event;
          });
        },
      );
      const throwingPlugin = testRuntimePlugin("throw-after-compaction-commit", [], (api) => {
        api.on("session_compact", () => {
          throw new Error("post-commit plugin failure");
        });
      });

      const modelCatalog = createInMemoryModelCatalog();
      modelCatalog.registerProvider(replayModel.provider, {
        baseUrl: replayModel.baseUrl,
        apiKey: "test-key",
        models: [
          {
            id: replayModel.id,
            name: replayModel.name,
            api: replayModel.api,
            reasoning: replayModel.reasoning,
            input: replayModel.input,
            cost: replayModel.cost,
            contextWindow: replayModel.contextWindow,
            maxTokens: replayModel.maxTokens,
          },
        ],
      });

      fauxProvider.setResponses([
        () => ({
          role: "assistant",
          content: [{ type: "text", text: "Compaction preserved." }],
          api: replayModel.api,
          provider: replayModel.provider,
          model: replayModel.id,
          usage: createUsage(),
          stopReason: "stop",
          timestamp: Date.now() + 2,
        }),
      ]);

      const session = await createBrewvaManagedAgentSession({
        cwd: workspace,
        agentDir: join(workspace, ".brewva-agent"),
        sessionStore,
        settings: createSettingsStub(),
        modelCatalog,
        resourceLoader: await createResourceLoader(workspace),
        customTools: [],
        runtimePlugins: [
          captureContextPlugin,
          createHostedTurnPipeline({ runtime, registerTools: false }),
          throwingPlugin,
        ],
        initialModel: replayModel,
        initialThinkingLevel: "off",
      });

      try {
        await new Promise<void>((resolve, reject) => {
          const requestCompaction = (
            session as unknown as {
              requestCompaction(request: {
                onComplete?: () => void;
                onError?: (error: Error) => void;
              }): void;
            }
          ).requestCompaction.bind(session);

          requestCompaction({
            onComplete: () => resolve(),
            onError: (error) => reject(error),
          });
        });

        await session.prompt(textPrompt("Continue from the compacted state."), {
          expandPromptTemplates: false,
        });

        expect(observedContexts).toHaveLength(1);
        expect(observedContexts[0]?.[0]).toEqual(
          expect.objectContaining({
            role: "compactionSummary",
          }),
        );
        expect(observedContexts[0]?.map((message) => message.role)).toEqual([
          "compactionSummary",
          "user",
          "assistant",
          "user",
          "custom",
        ]);
      } finally {
        session.dispose();
      }
    } finally {
      fauxProvider.unregister();
    }
  });

  test("hydrates ContextState from hosted runtime inspection and emits changes on refresh", async () => {
    const workspace = createTestWorkspace("managed-agent-session-context-state");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionStore = new HostedRuntimeTapeSessionStore(
      runtime,
      workspace,
      "managed-agent-session-context-state-session",
    );

    sessionStore.appendModelChange(TEST_MODEL.provider, TEST_MODEL.id);
    sessionStore.appendThinkingLevelChange("high");

    const sessionId = sessionStore.getSessionId();
    runtime.maintain.context.onTurnStart(sessionId, 1);
    runtime.maintain.context.registerProvider(
      defineContextSourceProvider({
        kind: "working_state",
        source: "brewva.test-context-state",
        category: "narrative",
        collectionOrder: 60,
        selectionPriority: 60,
        readsFrom: ["test.contextState"],
        collect: (input) => {
          input.register({
            id: `context-state:${input.sessionId}`,
            content: "[ContextStateTest]\nstatus: injected primary context",
          });
        },
      }),
    );
    await runtime.maintain.context.buildInjection(
      sessionId,
      "Summarize the current runtime posture.",
      {
        tokens: 512,
        contextWindow: 8_192,
        percent: 0.06,
      },
      {
        injectionScopeId: "leaf-one",
      },
    );
    runtime.maintain.context.appendGuardedSupplementalBlocks(
      sessionId,
      [
        {
          familyId: "test-managed-agent-session",
          content: "Supplemental context block.",
        },
      ],
      {
        tokens: 512,
        contextWindow: 8_192,
        percent: 0.06,
      },
      "leaf-one",
    );
    runtime.maintain.context.observePromptStability(sessionId, {
      stablePrefixHash: "stable-prefix-hash",
      dynamicTailHash: "dynamic-tail-hash",
      injectionScopeId: "leaf-one",
      turn: 1,
    });
    runtime.maintain.context.observeTransientReduction(sessionId, {
      status: "completed",
      reason: null,
      eligibleToolResults: 5,
      clearedToolResults: 2,
      clearedChars: 1200,
      estimatedTokenSavings: 300,
      pressureLevel: "high",
      turn: 1,
    });
    runtime.maintain.context.observeUsage(sessionId, {
      tokens: 6_800,
      contextWindow: 8_192,
      percent: 0.83,
    });
    runtime.authority.session.commitCompaction(sessionId, {
      compactId: "compact-1",
      sanitizedSummary: "Recovered baseline",
      summaryDigest: "digest-1",
      sourceTurn: 1,
      leafEntryId: null,
      referenceContextDigest: null,
      fromTokens: 6_800,
      toTokens: 1_200,
      origin: "extension_api",
    });

    const modelCatalog = createInMemoryModelCatalog();
    modelCatalog.registerProvider(TEST_MODEL.provider, {
      baseUrl: TEST_MODEL.baseUrl,
      apiKey: "test-key",
      models: [
        {
          id: TEST_MODEL.id,
          name: TEST_MODEL.name,
          api: TEST_MODEL.api,
          reasoning: TEST_MODEL.reasoning,
          input: TEST_MODEL.input,
          cost: TEST_MODEL.cost,
          contextWindow: TEST_MODEL.contextWindow,
          maxTokens: TEST_MODEL.maxTokens,
        },
      ],
    });

    const session = await createBrewvaManagedAgentSession({
      cwd: workspace,
      agentDir: join(workspace, ".brewva-agent"),
      sessionStore,
      settings: createSettingsStub(),
      modelCatalog,
      resourceLoader: await createResourceLoader(workspace),
      customTools: [],
      runtimePlugins: [createHostedTurnPipeline({ runtime, registerTools: false })],
      initialModel: TEST_MODEL,
      initialThinkingLevel: "high",
    });

    const observedStates: ContextState[] = [];
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "context_state_change") {
        observedStates.push((event as { state: ContextState }).state);
      }
    });

    try {
      expect(session.getContextState()).toEqual(
        expect.objectContaining({
          budgetPressure: "high",
          promptStabilityFingerprint: "stable-prefix-hash",
          transientReductionActive: true,
          historyBaselineAvailable: true,
          lastInjectionScopeId: "leaf-one",
        }),
      );
      expect(session.getContextState().reservedPrimaryTokens).toBe(0);
      expect(session.getContextState().reservedSupplementalTokens).toBe(0);

      runtime.maintain.context.observeTransientReduction(sessionId, {
        status: "skipped",
        reason: "pressure dropped",
        eligibleToolResults: 1,
        clearedToolResults: 0,
        clearedChars: 0,
        estimatedTokenSavings: 0,
        pressureLevel: "low",
        turn: 2,
      });
      runtime.maintain.context.observeUsage(sessionId, {
        tokens: 1_024,
        contextWindow: 8_192,
        percent: 0.125,
      });
      const syncContextState = (
        session as unknown as {
          syncContextState(): Promise<void>;
        }
      ).syncContextState.bind(session);
      await syncContextState();

      expect(observedStates.at(-1)).toEqual(
        expect.objectContaining({
          budgetPressure: "none",
          transientReductionActive: false,
        }),
      );
    } finally {
      unsubscribe();
      session.dispose();
    }
  });

  test("forwards tool and session state changes through host runtime plugins", async () => {
    const workspace = createTestWorkspace("managed-agent-session-plugin-state-events");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionStore = new HostedRuntimeTapeSessionStore(
      runtime,
      workspace,
      "managed-agent-session-plugin-state-events-session",
    );
    sessionStore.appendModelChange(TEST_MODEL.provider, TEST_MODEL.id);
    sessionStore.appendThinkingLevelChange("high");

    const observedPhases: string[] = [];
    const observedSessionPhases: string[] = [];
    const observedContextStates: ContextState[] = [];
    const plugin = testRuntimePlugin("observe-session-state-events", [], (api) => {
      api.on("tool_execution_phase_change", (event) => {
        observedPhases.push(event.phase);
      });
      api.on("session_phase_change", (event) => {
        observedSessionPhases.push(event.phase.kind);
      });
      api.on("context_state_change", (event) => {
        observedContextStates.push(structuredClone(event.state));
      });
    });

    const modelCatalog = createInMemoryModelCatalog();
    modelCatalog.registerProvider(TEST_MODEL.provider, {
      baseUrl: TEST_MODEL.baseUrl,
      apiKey: "test-key",
      models: [
        {
          id: TEST_MODEL.id,
          name: TEST_MODEL.name,
          api: TEST_MODEL.api,
          reasoning: TEST_MODEL.reasoning,
          input: TEST_MODEL.input,
          cost: TEST_MODEL.cost,
          contextWindow: TEST_MODEL.contextWindow,
          maxTokens: TEST_MODEL.maxTokens,
        },
      ],
    });

    const session = await createBrewvaManagedAgentSession({
      cwd: workspace,
      agentDir: join(workspace, ".brewva-agent"),
      sessionStore,
      settings: createSettingsStub(),
      modelCatalog,
      resourceLoader: await createResourceLoader(workspace),
      customTools: [],
      runtimePlugins: [plugin, createHostedTurnPipeline({ runtime, registerTools: false })],
      initialModel: TEST_MODEL,
      initialThinkingLevel: "high",
    });

    try {
      const handleAgentEvent = (
        session as unknown as {
          handleAgentEvent(event: unknown): Promise<void>;
        }
      ).handleAgentEvent.bind(session);

      runtime.maintain.context.onTurnStart(sessionStore.getSessionId(), 1);
      runtime.maintain.context.registerProvider(
        defineContextSourceProvider({
          kind: "working_state",
          source: "brewva.test-plugin-state",
          category: "narrative",
          collectionOrder: 60,
          selectionPriority: 60,
          readsFrom: ["test.pluginState"],
          collect: (input) => {
            input.register({
              id: `plugin-state:${input.sessionId}`,
              content: "[PluginState]\nstatus: injected",
            });
          },
        }),
      );
      await runtime.maintain.context.buildInjection(
        sessionStore.getSessionId(),
        "Observe hosted state transitions.",
        {
          tokens: 256,
          contextWindow: 8_192,
          percent: 0.03,
        },
        { injectionScopeId: "plugin-scope" },
      );
      runtime.maintain.context.observePromptStability(sessionStore.getSessionId(), {
        stablePrefixHash: "plugin-state-fingerprint",
        dynamicTailHash: "plugin-state-tail",
        injectionScopeId: "plugin-scope",
        turn: 1,
      });
      await (
        session as unknown as {
          syncContextState(): Promise<void>;
        }
      ).syncContextState();

      const assistantMessage = {
        role: "assistant" as const,
        content: [{ type: "toolCall" as const, id: "tool-phase-1", name: "read", arguments: {} }],
        api: TEST_MODEL.api,
        provider: TEST_MODEL.provider,
        model: TEST_MODEL.id,
        usage: createUsage(),
        stopReason: "toolUse" as const,
        timestamp: Date.now(),
      };

      await handleAgentEvent({ type: "turn_start" });
      await handleAgentEvent({ type: "message_start", message: assistantMessage });
      await handleAgentEvent({
        type: "message_end",
        message: {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "starting tool" }],
          api: TEST_MODEL.api,
          provider: TEST_MODEL.provider,
          model: TEST_MODEL.id,
          usage: createUsage(),
          stopReason: "toolUse" as const,
          timestamp: Date.now(),
        },
      });
      await handleAgentEvent({
        type: "tool_execution_start",
        toolCallId: "tool-phase-1",
        toolName: "read",
        args: {},
      });
      await handleAgentEvent({
        type: "tool_execution_phase_change",
        toolCallId: "tool-phase-1",
        toolName: "read",
        phase: "classify",
        args: {},
      });
      await handleAgentEvent({
        type: "tool_execution_phase_change",
        toolCallId: "tool-phase-1",
        toolName: "read",
        phase: "cleanup",
        previousPhase: "record",
        args: {},
      });
      await handleAgentEvent({
        type: "tool_execution_end",
        toolCallId: "tool-phase-1",
        toolName: "read",
        result: {
          content: [{ type: "text" as const, text: "ok" }],
          details: {},
        },
        isError: false,
      });
      await handleAgentEvent({
        type: "message_end",
        message: {
          role: "assistant" as const,
          content: [{ type: "text" as const, text: "done" }],
          api: TEST_MODEL.api,
          provider: TEST_MODEL.provider,
          model: TEST_MODEL.id,
          usage: createUsage(),
          stopReason: "stop" as const,
          timestamp: Date.now() + 1,
        },
      });

      expect(observedPhases).toEqual(["classify", "cleanup"]);
      expect(observedSessionPhases).toContain("model_streaming");
      expect(observedSessionPhases).toContain("tool_executing");
      expect(observedContextStates.at(-1)).toEqual(
        expect.objectContaining({
          promptStabilityFingerprint: "plugin-state-fingerprint",
          lastInjectionScopeId: "plugin-scope",
        }),
      );
    } finally {
      session.dispose();
    }
  });

  test("runtime plugin tool registration after session initialization reaches the provider turn", async () => {
    const workspace = createTestWorkspace("managed-agent-session-dynamic-tool-registration");
    writeRoutableSkill(workspace);
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionStore = new HostedRuntimeTapeSessionStore(
      runtime,
      workspace,
      "managed-agent-session-dynamic-tool-registration-session",
    );
    const fauxProvider = registerFauxProvider({
      api: "managed-session-dynamic-tool-registration-faux",
      provider: "managed-session-dynamic-tool-registration",
      models: [
        {
          id: "managed-session-dynamic-tool-registration-model",
          name: "Managed Session Dynamic Tool Registration Model",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128000,
          maxTokens: 4096,
        },
      ],
    });
    const model = fauxProvider.getModel();
    const observedToolNames: string[][] = [];

    try {
      sessionStore.appendModelChange(model.provider, model.id);
      sessionStore.appendThinkingLevelChange("off");
      const modelCatalog = createInMemoryModelCatalog();
      modelCatalog.registerProvider(model.provider, {
        baseUrl: model.baseUrl,
        apiKey: "test-key",
        models: [
          {
            id: model.id,
            name: model.name,
            api: model.api,
            reasoning: model.reasoning,
            input: model.input,
            cost: model.cost,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
          },
        ],
      });

      fauxProvider.setResponses([
        (context) => {
          observedToolNames.push(context.tools?.map((tool) => tool.name).toSorted() ?? []);
          return {
            role: "assistant",
            content: [{ type: "text", text: "Dynamic tools observed." }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: createUsage(),
            stopReason: "stop",
            timestamp: Date.now(),
          };
        },
      ]);

      const session = await createBrewvaManagedAgentSession({
        cwd: workspace,
        agentDir: join(workspace, ".brewva-agent"),
        sessionStore,
        settings: createSettingsStub(),
        modelCatalog,
        resourceLoader: await createResourceLoader(workspace),
        customTools: [],
        runtimePlugins: [createHostedTurnPipeline({ runtime, registerTools: true })],
        initialModel: model,
        initialThinkingLevel: "off",
      });

      try {
        await session.prompt(
          textPrompt("Inspect runtime, context, skill, and repository behavior."),
        );
        await session.waitForIdle();
      } finally {
        session.dispose();
      }

      expect(observedToolNames[0]).toContain("task_set_spec");
      expect(observedToolNames[0]).toContain("skill_load");
      expect(observedToolNames[0]).toContain("workflow_status");
      expect(observedToolNames[0]).not.toContain("read");
      expect(observedToolNames[0]).not.toContain("edit");
      expect(observedToolNames[0]).not.toContain("write");
    } finally {
      fauxProvider.unregister();
    }
  });

  test("queues interactive prompts by prompt id while streaming and removes them explicitly", async () => {
    const fauxProvider = registerFauxProvider({
      provider: "faux-queue",
      api: "faux",
      tokensPerSecond: 80,
      models: [{ id: "queue-model" }],
    });

    try {
      const workspace = createTestWorkspace("managed-session-queue");
      const runtime = new BrewvaRuntime({ cwd: workspace });
      const sessionStore = new HostedRuntimeTapeSessionStore(
        runtime,
        workspace,
        "managed-session-queue",
      );
      const modelCatalog = createInMemoryModelCatalog();
      const model: BrewvaRegisteredModel = {
        provider: "faux-queue",
        id: "queue-model",
        name: "Queue Model",
        api: "faux",
        baseUrl: "http://localhost:0",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 4096,
      };
      registerModelCatalogProvider(modelCatalog, model);
      fauxProvider.setResponses([
        fauxAssistantMessage("stream ".repeat(60)),
        fauxAssistantMessage("done"),
      ]);

      const session = await createBrewvaManagedAgentSession({
        cwd: workspace,
        agentDir: join(workspace, ".brewva-agent"),
        sessionStore,
        settings: createSettingsStub(),
        runtime,
        modelCatalog,
        resourceLoader: await createResourceLoader(workspace),
        customTools: [],
        runtimePlugins: [createHostedTurnPipeline({ runtime, registerTools: false })],
        initialModel: model,
        initialThinkingLevel: "off",
      });

      const queueSnapshots: string[][] = [];
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "queue.changed" && Array.isArray(event.items)) {
          queueSnapshots.push(
            event.items.map((item) =>
              typeof item === "object" && item !== null && "promptId" in item
                ? String(item.promptId)
                : "",
            ),
          );
        }
      });

      try {
        const firstPrompt = session.prompt(textPrompt("First prompt"), { source: "interactive" });
        for (let attempt = 0; attempt < 20 && !session.isStreaming; attempt += 1) {
          await Bun.sleep(20);
        }

        expect(session.isStreaming).toBe(true);

        await session.prompt(textPrompt("Second queued prompt"), { source: "interactive" });

        const queued = session.getQueuedPrompts();
        expect(queued).toHaveLength(1);
        expect(queued[0]).toMatchObject({
          text: "Second queued prompt",
          behavior: "queue",
        });
        expect(session.removeQueuedPrompt(queued[0]!.promptId)).toBe(true);
        expect(session.getQueuedPrompts()).toEqual([]);
        expect(queueSnapshots).toEqual([[queued[0]!.promptId], []]);
        await firstPrompt;
        await session.waitForIdle();
      } finally {
        unsubscribe();
        session.dispose();
      }
    } finally {
      fauxProvider.unregister();
    }
  });

  test("applies queued model preset before hosted prompt turn dispatches an interactive attempt", async () => {
    const fauxProvider = registerFauxProvider({
      provider: "faux-preset-dispatch",
      api: "faux",
      models: [{ id: "preset-dispatch-model" }],
    });

    try {
      const workspace = createTestWorkspace("managed-session-queued-preset-dispatch");
      const runtime = new BrewvaRuntime({ cwd: workspace });
      const sessionStore = new HostedRuntimeTapeSessionStore(
        runtime,
        workspace,
        "managed-session-queued-preset-dispatch",
      );
      const modelCatalog = createInMemoryModelCatalog();
      const model: BrewvaRegisteredModel = {
        provider: "faux-preset-dispatch",
        id: "preset-dispatch-model",
        name: "Preset Dispatch Model",
        api: "faux",
        baseUrl: "http://localhost:0",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 4096,
      };
      registerModelCatalogProvider(modelCatalog, model);
      sessionStore.appendModelChange(model.provider, model.id);
      sessionStore.appendThinkingLevelChange("off");
      fauxProvider.setResponses([fauxAssistantMessage("done")]);

      const session = await createBrewvaManagedAgentSession({
        cwd: workspace,
        agentDir: join(workspace, ".brewva-agent"),
        sessionStore,
        settings: createSettingsStub(),
        runtime,
        modelCatalog,
        resourceLoader: await createResourceLoader(workspace),
        customTools: [],
        runtimePlugins: [createHostedTurnPipeline({ runtime, registerTools: false })],
        initialModel: model,
        initialThinkingLevel: "off",
        initialModelPresetState: {
          activeName: "Default",
          defaultName: "Default",
          presets: [
            { name: "Default", subagentModels: {}, synthetic: true },
            { name: "Claude Lead", subagentModels: { advisor: "faux-preset-dispatch/advisor" } },
          ],
          pendingName: "Claude Lead",
        },
      });

      try {
        const output = await runHostedPromptTurn({
          session,
          parts: textPrompt("Next interactive turn"),
          source: "interactive",
          runtime,
          sessionId: sessionStore.getSessionId(),
        });

        expect(output.status).toBe("completed");
        expect(session.getModelPresetState?.()).toMatchObject({
          activeName: "Claude Lead",
          pendingName: undefined,
        });
        expect(
          runtime.inspect.events
            .query(sessionStore.getSessionId(), { type: "model_preset_select" })
            .at(-1)?.payload,
        ).toMatchObject({
          presetName: "Claude Lead",
          previousPresetName: "Default",
          source: "queued",
          subagentModels: {
            advisor: "faux-preset-dispatch/advisor",
          },
        });
      } finally {
        session.dispose();
      }
    } finally {
      fauxProvider.unregister();
    }
  });
});
