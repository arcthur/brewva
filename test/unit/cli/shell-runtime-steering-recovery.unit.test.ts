import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import { type BrewvaReplaySession } from "@brewva/brewva-runtime/events";
import type { SessionWireFrame } from "@brewva/brewva-runtime/session";
import type { BrewvaToolUiPort } from "@brewva/brewva-substrate/host-api";
import {
  buildBrewvaPromptText,
  type BrewvaPromptContentPart,
} from "@brewva/brewva-substrate/prompt";
import type {
  BrewvaModelPresetState,
  BrewvaPromptSessionEvent,
  BrewvaPromptToolCall,
  BrewvaQueuedPromptView,
  BrewvaSessionModelDescriptor,
  BrewvaShellViewPreferences,
  BrewvaSteerOutcome,
} from "@brewva/brewva-substrate/session";
import { CliShellRuntime } from "../../../packages/brewva-cli/src/shell/controller/shell-runtime.js";
import type {
  ProviderAuthMethod,
  ProviderConnectionDescriptor,
  ProviderOAuthAuthorization,
} from "../../../packages/brewva-cli/src/shell/domain/overlays/payloads.js";
import type { CliShellSessionBundle } from "../../../packages/brewva-cli/src/shell/ports/session-port.js";
import { patchDateNow } from "../../helpers/global-state.js";
import {
  createPromptMessageUpdateEvent,
  createTextDeltaAssistantEvent,
  createToolcallEndAssistantEvent,
} from "../../helpers/prompt-session-events.js";

function modelKey(model: Pick<BrewvaSessionModelDescriptor, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}
function createFakeBundle(
  options: {
    promptHandler?: (text: string) => Promise<void>;
    sessionId?: string;
    transcriptSeed?: unknown[];
    replaySessions?: BrewvaReplaySession[];
    sessionWireBySessionId?: Record<string, SessionWireFrame[]>;
    models?: BrewvaSessionModelDescriptor[];
    availableModelKeys?: string[];
    providers?: ProviderConnectionDescriptor[];
    authMethods?: Record<string, ProviderAuthMethod[]>;
    authorizeOAuth?: (
      provider: string,
      methodId: string,
      inputs?: Record<string, string>,
    ) => Promise<ProviderOAuthAuthorization | undefined>;
    completeOAuth?: (provider: string, methodId: string, code?: string) => Promise<void>;
    queuedPrompts?: BrewvaQueuedPromptView[];
    steerHandler?: (text: string) => Promise<BrewvaSteerOutcome>;
    modelPresetState?: BrewvaModelPresetState;
    isStreaming?: boolean;
  } = {},
) {
  let attachedUi: BrewvaToolUiPort | undefined;
  let sessionListener: ((event: BrewvaPromptSessionEvent) => void) | undefined;
  let queuedPrompts = [...(options.queuedPrompts ?? [])];
  const approvalDecisions: Array<{ requestId: string; input: unknown }> = [];
  const sessionId = options.sessionId ?? "session-1";
  const replaySessions = options.replaySessions ?? [
    {
      sessionId,
      eventCount: 1,
      lastEventAt: Date.now(),
      title: "New session",
    },
  ];
  const rawRuntime = createBrewvaRuntime({
    cwd: mkdtempSync(join(tmpdir(), "brewva-shell-runtime-")),
  }).hosted;
  const runtime = rawRuntime;
  Object.assign(runtime.authority.proposals.requests, {
    decide(_sessionId: string, requestId: string, input: unknown) {
      approvalDecisions.push({ requestId, input });
    },
  });
  Object.assign(runtime.inspect.proposals.requests, {
    listPending() {
      return [];
    },
  });
  Object.assign(runtime.inspect.events.log, {
    listReplaySessions() {
      return replaySessions;
    },
  });
  const querySessionWire = runtime.inspect.sessionWire.query.bind(runtime.inspect.sessionWire);
  const providerConnects: Array<{ provider: string; key: string }> = [];
  Object.assign(runtime.inspect.sessionWire, {
    query(targetSessionId: string) {
      return options.sessionWireBySessionId?.[targetSessionId] ?? querySessionWire(targetSessionId);
    },
  });
  const defaultModel: BrewvaSessionModelDescriptor = {
    provider: "openai",
    id: "gpt-5.4-mini",
    name: "GPT-5.4 Mini",
    contextWindow: 128_000,
    maxTokens: 16_384,
    reasoning: true,
  };
  const allModels = options.models ?? [defaultModel];
  const availableModelKeys = new Set(options.availableModelKeys ?? allModels.map(modelKey));
  let currentModel = allModels[0] ?? defaultModel;
  let thinkingLevel = "high";
  let isStreaming = options.isStreaming ?? false;
  let modelPresetState: BrewvaModelPresetState = options.modelPresetState ?? {
    activeName: "Default",
    defaultName: "Default",
    presets: [{ name: "Default", subagentModels: {}, synthetic: true }],
  };
  let modelPreferences = { recent: [], favorite: [] } as {
    recent: Array<{ provider: string; id: string }>;
    favorite: Array<{ provider: string; id: string }>;
  };
  let diffPreferences: { style: "auto" | "stacked"; wrapMode: "word" | "none" } = {
    style: "auto",
    wrapMode: "word",
  };
  let shellViewPreferences: BrewvaShellViewPreferences = {
    showThinking: true,
    toolDetails: true,
  };

  const session = {
    get model() {
      return currentModel;
    },
    get thinkingLevel() {
      return thinkingLevel;
    },
    get isStreaming() {
      return isStreaming;
    },
    set isStreaming(next: boolean) {
      isStreaming = next;
    },
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
      resolveLineageLeafEntryId() {
        return null;
      },
      buildSessionContext() {
        return { messages: options.transcriptSeed ?? [] };
      },
    },
    settingsManager: {
      getQuietStartup() {
        return false;
      },
      getModelPreferences() {
        return modelPreferences;
      },
      setModelPreferences(next: typeof modelPreferences) {
        modelPreferences = next;
      },
      getDiffPreferences() {
        return diffPreferences;
      },
      setDiffPreferences(next: typeof diffPreferences) {
        diffPreferences = next;
      },
      getShellViewPreferences() {
        return shellViewPreferences;
      },
      setShellViewPreferences(next: BrewvaShellViewPreferences) {
        shellViewPreferences = next;
      },
    },
    modelRegistry: {
      getAll() {
        return allModels;
      },
      getAvailable() {
        return allModels.filter((model) => availableModelKeys.has(modelKey(model)));
      },
    },
    async setModel(model: BrewvaSessionModelDescriptor) {
      currentModel = model;
    },
    getModelPresetState() {
      return structuredClone(modelPresetState);
    },
    selectModelPreset(request: { name: string }) {
      const preset = modelPresetState.presets.find((candidate) => candidate.name === request.name);
      if (!preset) {
        throw new Error(`Unknown model preset: ${request.name}`);
      }
      const previousName = modelPresetState.activeName;
      modelPresetState = {
        ...modelPresetState,
        activeName: preset.name,
        pendingName: undefined,
      };
      return {
        selectedName: preset.name,
        previousName,
        modelChanged: false,
        queued: false,
        effectiveMainModel: preset.mainModel,
      };
    },
    queueModelPresetForNextTurn(name: string) {
      const preset = modelPresetState.presets.find((candidate) => candidate.name === name);
      if (!preset) {
        throw new Error(`Unknown model preset: ${name}`);
      }
      modelPresetState = {
        ...modelPresetState,
        pendingName: preset.name,
      };
      return {
        selectedName: preset.name,
        previousName: modelPresetState.activeName,
        modelChanged: false,
        queued: true,
        effectiveMainModel: preset.mainModel,
      };
    },
    getAvailableThinkingLevels() {
      return currentModel.reasoning ? ["off", "minimal", "low", "medium", "high"] : ["off"];
    },
    setThinkingLevel(level: string) {
      thinkingLevel = level;
    },
    subscribe(listener: (event: BrewvaPromptSessionEvent) => void) {
      sessionListener = listener;
      return () => {
        if (sessionListener === listener) {
          sessionListener = undefined;
        }
      };
    },
    async prompt(parts: readonly BrewvaPromptContentPart[]) {
      if (modelPresetState.pendingName) {
        modelPresetState = {
          ...modelPresetState,
          activeName: modelPresetState.pendingName,
          pendingName: undefined,
        };
      }
      await options.promptHandler?.(buildBrewvaPromptText(parts));
    },
    async steer(text: string) {
      return options.steerHandler?.(text) ?? { status: "no_active_run" };
    },
    getQueuedPrompts() {
      return queuedPrompts;
    },
    removeQueuedPrompt(promptId: string) {
      const index = queuedPrompts.findIndex((item) => item.promptId === promptId);
      if (index < 0) {
        return false;
      }
      queuedPrompts.splice(index, 1);
      sessionListener?.({
        type: "queue.changed",
        items: [...queuedPrompts],
      });
      return true;
    },
    async waitForIdle() {},
    async abort() {},
    dispose() {},
    setUiPort(ui: BrewvaToolUiPort) {
      attachedUi = ui;
    },
  };

  const bundle = {
    session,
    toolDefinitions: new Map(),
    runtime,
    providerConnections: options.providers
      ? {
          catalog: {
            async listProviders() {
              return options.providers ?? [];
            },
          },
          renderer: {
            listAuthMethods(provider: string) {
              return (
                options.authMethods?.[provider] ?? [
                  {
                    id: "api_key" as const,
                    kind: "api_key" as const,
                    type: "api" as const,
                    label: "API key",
                    credentialRef: `vault://${provider}/apiKey`,
                  },
                ]
              );
            },
          },
          credential: {
            async listProviders() {
              return options.providers ?? [];
            },
            async connectApiKey(provider: string, key: string) {
              providerConnects.push({ provider, key });
            },
            async disconnect() {},
            async refresh() {},
          },
          authFlow: {
            listAuthMethods(provider: string) {
              return (
                options.authMethods?.[provider] ?? [
                  {
                    id: "api_key" as const,
                    kind: "api_key" as const,
                    type: "api" as const,
                    label: "API key",
                    credentialRef: `vault://${provider}/apiKey`,
                  },
                ]
              );
            },
            async authorizeOAuth(
              provider: string,
              methodId: string,
              inputs?: Record<string, string>,
            ) {
              return options.authorizeOAuth?.(provider, methodId, inputs);
            },
            async completeOAuth(provider: string, methodId: string, code?: string) {
              await options.completeOAuth?.(provider, methodId, code);
            },
          },
        }
      : undefined,
  } as unknown as CliShellSessionBundle;

  return {
    bundle,
    getAttachedUi: () => attachedUi,
    emitSessionEvent(event: BrewvaPromptSessionEvent) {
      sessionListener?.(event);
    },
    approvalDecisions,
    providerConnects,
    getModelPreferences: () => modelPreferences,
    getDiffPreferences: () => diffPreferences,
    getShellViewPreferences: () => shellViewPreferences,
    getCurrentModel: () => currentModel,
    getModelPresetState: () => structuredClone(modelPresetState),
    setStreaming: (next: boolean) => {
      isStreaming = next;
    },
  };
}

describe("shell runtime: steering and recovery", () => {
  test("shift-tab advances queued preset selection while a turn is streaming", async () => {
    const fixture = createFakeBundle({
      isStreaming: true,
      modelPresetState: {
        activeName: "Default",
        defaultName: "Default",
        presets: [
          { name: "Default", subagentModels: {}, synthetic: true },
          { name: "Claude Lead", mainModel: "anthropic/claude-main:high", subagentModels: {} },
          { name: "OpenAI Stack", mainModel: "openai/gpt-5.5:high", subagentModels: {} },
        ],
      },
    });
    const runtime = new CliShellRuntime(fixture.bundle, {
      cwd: process.cwd(),
      openSession: async () => fixture.bundle,
      createSession: async () => fixture.bundle,
    });

    await runtime.handleInput({
      key: "tab",
      ctrl: false,
      meta: false,
      shift: true,
    });
    await runtime.handleInput({
      key: "tab",
      ctrl: false,
      meta: false,
      shift: true,
    });

    expect(fixture.getModelPresetState()).toMatchObject({
      activeName: "Default",
      pendingName: "OpenAI Stack",
    });
    expect(runtime.getViewState().status.entries.preset).toBe("Default -> OpenAI Stack");

    runtime.dispose();
  });

  test("records interactive rewind checkpoints with monotonic turn ids", async () => {
    const turnIds: string[] = [];
    const { bundle } = createFakeBundle();
    Object.assign(bundle.runtime.authority.session.rewind, {
      recordCheckpoint(
        _sessionId: string,
        input: { turnId?: string },
      ): ReturnType<typeof bundle.runtime.authority.session.rewind.recordCheckpoint> {
        turnIds.push(input.turnId ?? "");
        return {} as ReturnType<typeof bundle.runtime.authority.session.rewind.recordCheckpoint>;
      },
    });
    const restoreDateNow = patchDateNow(() => 1_710_000_000_000);

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    try {
      runtime.ui.setEditorText("first prompt");
      await runtime.handleInput({
        key: "enter",
        ctrl: false,
        meta: false,
        shift: false,
      });
      runtime.ui.setEditorText("second prompt");
      await runtime.handleInput({
        key: "enter",
        ctrl: false,
        meta: false,
        shift: false,
      });

      expect(turnIds).toEqual(["interactive:1710000000000:1", "interactive:1710000000000:2"]);
    } finally {
      restoreDateNow();
      runtime.dispose();
    }
  });

  test("blocks redo while the current session is streaming", async () => {
    const { bundle } = createFakeBundle();
    let redoCalls = 0;
    Object.assign(bundle.runtime.authority.session.rewind, {
      redo(): ReturnType<typeof bundle.runtime.authority.session.rewind.redo> {
        redoCalls += 1;
        return { ok: false, reason: "no_redo" };
      },
    });
    (bundle.session as unknown as { isStreaming: boolean }).isStreaming = true;

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    runtime.ui.setEditorText("/redo");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(redoCalls).toBe(0);
    expect(
      runtime
        .getViewState()
        .notifications.some((notification) =>
          notification.message.includes("Cannot redo while agent is running."),
        ),
    ).toBe(true);
    runtime.dispose();
  });

  test("user message appears exactly once even when session emits message_end for the user turn", async () => {
    const fixture = createFakeBundle();
    const { bundle } = fixture;

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    runtime.ui.setEditorText("你是谁");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    // submitComposer adds the user message; simulate the session also emitting
    // message_end for the same user turn (the normal session behaviour).
    fixture.emitSessionEvent({
      type: "message_end",
      message: {
        role: "user",
        content: [{ type: "text", text: "你是谁" }],
      },
    });

    const userMessages = runtime
      .getViewState()
      .transcript.messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.parts[0]).toMatchObject({ type: "text", text: "你是谁" });

    runtime.dispose();
  });

  test("submitted pasted text expands in the user transcript instead of showing the paste placeholder", async () => {
    const prompts: string[] = [];
    const { bundle } = createFakeBundle({
      promptHandler: async (text) => {
        prompts.push(text);
      },
    });

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();

    const token = "[Pasted ~3 lines]";
    const text = `review ${token} now`;
    const pastedText = "line one\nline two\nline three";
    await runtime.handleInput({
      type: "composer.editorSync",
      text,
      cursor: text.length,
      parts: [
        {
          id: "text-part-1",
          type: "text",
          text: pastedText,
          source: {
            text: {
              start: "review ".length,
              end: "review ".length + token.length,
              value: token,
            },
          },
        },
      ],
    });

    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    const submittedText = `review ${pastedText} now`;
    expect(prompts).toEqual([submittedText]);

    const userMessages = runtime
      .getViewState()
      .transcript.messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.parts[0]).toMatchObject({ type: "text", text: submittedText });

    runtime.dispose();
  });

  test("surfaces semantic input failures as notifications instead of rejecting the key handler", async () => {
    const { bundle } = createFakeBundle({
      promptHandler: async () => {
        throw new Error("prompt exploded");
      },
    });

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("trigger failure");
    const consumed = await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(consumed).toBe(true);
    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "error",
      message: "prompt exploded",
    });
    runtime.dispose();
  });

  test("surfaces assistant errors as notifications and transcript entries", async () => {
    const fixture = createFakeBundle();
    const { bundle } = fixture;

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    fixture.emitSessionEvent({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "No API key for provider: openai-codex",
        content: [],
      },
    });

    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "error",
      message: "No API key for provider: openai-codex",
    });
    expect(
      runtime
        .getViewState()
        .transcript.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.parts.some(
              (part) =>
                part.type === "text" && part.text.includes("No API key for provider: openai-codex"),
            ),
        ),
    ).toBe(true);

    runtime.dispose();
  });

  test("/steer reports later applied and dropped outcomes", async () => {
    const steers: string[] = [];
    const fixture = createFakeBundle({
      steerHandler: async (text) => {
        steers.push(text);
        return { status: "queued", chars: text.length };
      },
    });
    const { bundle } = fixture;

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });
    await runtime.start();

    runtime.ui.setEditorText("/steer keep this boundary in mind");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(steers).toEqual(["keep this boundary in mind"]);
    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "info",
      message: "Queued steer for the current turn.",
    });

    fixture.emitSessionEvent({
      type: "steer_applied",
      text: "keep this boundary in mind",
      toolCallId: "tool-1",
      toolName: "read",
      message: {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "result\n\nUser guidance: keep this boundary in mind" }],
        isError: false,
      },
    });
    await Bun.sleep(0);

    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "info",
      message: "Steer applied to read.",
    });

    fixture.emitSessionEvent({
      type: "steer_dropped",
      text: "too late",
      reason: "no_tool_boundary",
    });
    await Bun.sleep(0);

    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "warning",
      message: "Steer dropped: no tool-result boundary was reached.",
    });

    runtime.dispose();
  });

  test("removes a streamed assistant draft when the stable message is hidden", async () => {
    const fixture = createFakeBundle();
    const { bundle } = fixture;

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();

    fixture.emitSessionEvent(
      createPromptMessageUpdateEvent({
        message: {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Draft answer while skill is incomplete." }],
        },
        assistantMessageEvent: createTextDeltaAssistantEvent({
          delta: "Draft answer while skill is incomplete.",
          partial: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "Draft answer while skill is incomplete." }],
          },
        }),
      }),
    );

    expect(runtime.getViewState().transcript.messages).toHaveLength(1);
    expect(runtime.getViewState().transcript.messages[0]).toMatchObject({
      role: "assistant",
      parts: [{ type: "text", text: "Draft answer while skill is incomplete." }],
    });

    fixture.emitSessionEvent({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        display: false,
        content: [{ type: "text", text: "Draft answer while skill is incomplete." }],
        details: {
          brewvaDraftSuppressed: {
            reason: "active_skill_incomplete",
            skillName: "repository-analysis",
          },
        },
      },
    });

    expect(runtime.getViewState().transcript.messages).toEqual([]);

    runtime.dispose();
  });

  test("rebuilds assistant transcript from assistantMessageEvent.partial when message_update omits message", async () => {
    const fixture = createFakeBundle();
    const { bundle } = fixture;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await runtime.start();

    const partialAssistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Inspect the target file." },
        { type: "text", text: "Reading the file first." },
        {
          type: "toolCall",
          id: "tool-read-partial-only",
          name: "read",
          arguments: { path: "src/app.ts", offset: 1, limit: 10 },
        },
      ],
      stopReason: "toolUse",
    };

    fixture.emitSessionEvent(
      createPromptMessageUpdateEvent({
        assistantMessageEvent: createToolcallEndAssistantEvent({
          contentIndex: 2,
          toolCall: partialAssistantMessage.content[2] as BrewvaPromptToolCall,
          partial: partialAssistantMessage,
        }),
      }),
    );

    expect(runtime.getViewState().transcript.messages).toHaveLength(1);
    expect(runtime.getViewState().transcript.messages[0]).toMatchObject({
      role: "assistant",
      renderMode: "streaming",
      parts: [
        { type: "reasoning", text: "Inspect the target file." },
        { type: "text", text: "Reading the file first." },
        {
          type: "tool",
          toolCallId: "tool-read-partial-only",
          toolName: "read",
          status: "pending",
        },
      ],
    });

    runtime.dispose();
  });
});
