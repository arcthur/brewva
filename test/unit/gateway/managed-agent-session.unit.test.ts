import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import {
  type ContextState,
  createHostedResourceLoader,
  createInMemoryModelCatalog,
  type BrewvaHostPluginFactory,
  type BrewvaHostedResourceLoader,
  type BrewvaPromptThinkingLevel,
  type BrewvaRegisteredModel,
  type BrewvaSessionMessageEntry,
  type BrewvaToolContext,
} from "@brewva/brewva-substrate";
import { createBrewvaManagedAgentSession } from "../../../packages/brewva-gateway/src/host/managed-agent-session.js";
import { HostedRuntimeTapeSessionStore } from "../../../packages/brewva-gateway/src/host/runtime-projection-session-store.js";
import { createHostedTurnPipeline } from "../../../packages/brewva-gateway/src/runtime-plugins/index.js";
import { registerFauxProvider } from "../../../packages/brewva-provider-core/src/providers/faux.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

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

function createSettingsStub() {
  return {
    getQuietStartup() {
      return true;
    },
    getSteeringMode() {
      return "one-at-a-time" as const;
    },
    getFollowUpMode() {
      return "one-at-a-time" as const;
    },
    getTransport() {
      return "sse" as const;
    },
    getThinkingBudgets() {
      return undefined;
    },
    getRetrySettings() {
      return undefined;
    },
    setDefaultModelAndProvider() {},
    setDefaultThinkingLevel() {},
  };
}

async function createResourceLoader(workspace: string): Promise<BrewvaHostedResourceLoader> {
  return createHostedResourceLoader({
    cwd: workspace,
    agentDir: join(workspace, ".brewva-agent"),
  });
}

async function createManagedSessionFixture(testName: string) {
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
    modelCatalog,
    resourceLoader: await createResourceLoader(workspace),
    customTools: [],
    runtimePlugins: [createHostedTurnPipeline({ runtime, registerTools: false })],
    initialModel: TEST_MODEL,
    initialThinkingLevel: "high" as BrewvaPromptThinkingLevel,
  });

  return { workspace, runtime, sessionStore, session };
}

describe("managed agent session compaction", () => {
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
      toolName: "exec_command",
      args: { command: "echo hello" },
    });
    observedPhases.length = 0;

    recordRuntimeEvent(runtime, {
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

    recordRuntimeEvent(runtime, {
      sessionId,
      turn: 1,
      type: "effect_commitment_approval_requested",
      payload: {
        requestId: "approval-1",
        toolName: "exec_command",
        toolCallId: "tool_approval_1",
        subject: "run command",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    recordRuntimeEvent(runtime, {
      sessionId,
      turn: 1,
      type: "effect_commitment_approval_decided",
      payload: {
        requestId: "approval-1",
        decision: "accept",
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    recordRuntimeEvent(runtime, {
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

    recordRuntimeEvent(runtime, {
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
        toolName: "exec_command",
        turn: 1,
      },
      {
        kind: "waiting_approval",
        requestId: "approval-1",
        toolCallId: "tool_approval_1",
        toolName: "exec_command",
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
    const captureContextPlugin: BrewvaHostPluginFactory = (api) => {
      api.on("context", (event) => {
        observedContexts.push(
          structuredClone(event.messages) as Array<{ role?: unknown; content?: unknown }>,
        );
        return event;
      });
    };

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
        await session.prompt("Resume from the restored context.", {
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

  test("hydrates the initial session phase from runtime fact history on resume", async () => {
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
    recordRuntimeEvent(runtime, {
      sessionId,
      turn: 1,
      type: "turn_input_recorded",
      payload: {
        turnId: "turn-history-1",
        trigger: "user",
        promptText: "resume while waiting for approval",
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      turn: 1,
      type: "effect_commitment_approval_requested",
      payload: {
        requestId: "approval-history-1",
        toolName: "exec_command",
        toolCallId: "tool-history-1",
        subject: "run command",
      },
    });

    const observedPhases: string[] = [];
    const plugin: BrewvaHostPluginFactory = (api) => {
      api.on("session_phase_change", (event) => {
        observedPhases.push(event.phase.kind);
      });
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
        toolName: "exec_command",
        turn: 1,
      });
      expect(observedPhases).toContain("waiting_approval");
    } finally {
      session.dispose();
    }
  });

  test("hydrates recovering phase from runtime fact history on resume", async () => {
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
    recordRuntimeEvent(runtime, {
      sessionId,
      turn: 1,
      type: "turn_input_recorded",
      payload: {
        turnId: "turn-history-recovery-1",
        trigger: "recovery",
        promptText: "resume after worker crash",
      },
    });
    recordRuntimeEvent(runtime, {
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
    const plugin: BrewvaHostPluginFactory = (api) => {
      api.on("message_start", () => {
        observedEvents.push("message_start");
      });
      api.on("message_end", () => {
        observedEvents.push("message_end");
      });
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
    const plugin: BrewvaHostPluginFactory = (api) => {
      api.on("thinking_level_select", (event) => {
        observedThinkingLevels.push({
          thinkingLevel: event.thinkingLevel,
          previousThinkingLevel: event.previousThinkingLevel,
        });
      });
    };

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
      const captureContextPlugin: BrewvaHostPluginFactory = (api) => {
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
      };
      const throwingPlugin: BrewvaHostPluginFactory = (api) => {
        api.on("session_compact", () => {
          throw new Error("post-commit plugin failure");
        });
      };

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

        await session.prompt("Continue from the compacted state.", {
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
    runtime.maintain.context.registerProvider({
      source: "brewva.test-context-state",
      category: "narrative",
      budgetClass: "core",
      collect: (input) => {
        input.register({
          id: `context-state:${input.sessionId}`,
          content: "[ContextStateTest]\nstatus: injected primary context",
        });
      },
    });
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
    runtime.maintain.context.appendSupplementalInjection(
      sessionId,
      "Supplemental context block.",
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
    const plugin: BrewvaHostPluginFactory = (api) => {
      api.on("tool_execution_phase_change", (event) => {
        observedPhases.push(event.phase);
      });
      api.on("session_phase_change", (event) => {
        observedSessionPhases.push(event.phase.kind);
      });
      api.on("context_state_change", (event) => {
        observedContextStates.push(structuredClone(event.state));
      });
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
      runtime.maintain.context.registerProvider({
        source: "brewva.test-plugin-state",
        category: "narrative",
        budgetClass: "core",
        collect: (input) => {
          input.register({
            id: `plugin-state:${input.sessionId}`,
            content: "[PluginState]\nstatus: injected",
          });
        },
      });
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
});
