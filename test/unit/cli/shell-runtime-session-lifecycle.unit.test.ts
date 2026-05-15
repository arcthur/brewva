import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import { asBrewvaSessionId } from "@brewva/brewva-runtime/core";
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
  BrewvaQueuedPromptView,
  BrewvaSessionModelDescriptor,
  BrewvaShellViewPreferences,
  BrewvaSteerOutcome,
} from "@brewva/brewva-substrate/session";
import { DEFAULT_TUI_THEME } from "../../../packages/brewva-cli/src/internal/tui/index.js";
import { CliShellRuntime } from "../../../packages/brewva-cli/src/shell/controller/shell-runtime.js";
import type {
  ProviderAuthMethod,
  ProviderConnectionDescriptor,
  ProviderOAuthAuthorization,
} from "../../../packages/brewva-cli/src/shell/domain/overlays/payloads.js";
import type { CliShellSessionBundle } from "../../../packages/brewva-cli/src/shell/ports/session-port.js";
import { HostedRuntimeTapeSessionStore } from "../../../packages/brewva-gateway/src/hosted/internal/session/projection/runtime-projection-session-store.js";
import type { StoredSessionMessage } from "../../../packages/brewva-gateway/src/hosted/internal/thread-loop/runtime-session-transcript.js";

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
    presets: [{ name: "Default", delegationModels: {}, synthetic: true }],
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

describe("shell runtime: session lifecycle", () => {
  test("attaches the shell ui port to the managed session", () => {
    const { bundle, getAttachedUi } = createFakeBundle();

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    expect(getAttachedUi()).toBe(runtime.ui);
    runtime.dispose();
  });

  test("routes theme selection through shell state so the renderer can react to it", () => {
    const { bundle } = createFakeBundle();

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    const customTheme = {
      ...DEFAULT_TUI_THEME,
      name: "custom",
      accent: "#7dd3fc",
      borderActive: "#7dd3fc",
    };

    expect(runtime.getViewState().theme).toEqual(DEFAULT_TUI_THEME);
    expect(runtime.ui.getTheme("default")).toEqual(DEFAULT_TUI_THEME);
    expect(runtime.ui.getAllThemes()).toEqual([
      { name: "default" },
      { name: "graphite" },
      { name: "paper" },
    ]);
    expect(runtime.ui.setTheme(customTheme)).toEqual({ success: true });
    expect(runtime.getViewState().theme).toEqual(customTheme);
    expect(runtime.ui.theme).toEqual(customTheme);
    runtime.dispose();
  });

  test("handles theme shell commands for listing and switching built-in themes", async () => {
    const { bundle } = createFakeBundle();

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/theme list");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "info",
      message: "Available themes: default, graphite, paper",
    });

    runtime.ui.setEditorText("/theme paper");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.getViewState().theme.name).toBe("paper");

    runtime.ui.setEditorText("/theme missing");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "warning",
      message: "Unknown theme selection.",
    });
    runtime.dispose();
  });

  test("lineage slash command opens the lineage overlay", async () => {
    const { bundle } = createFakeBundle({ sessionId: "lineage-overlay-session" });
    bundle.runtime.authority.session.lineage.createNode("lineage-overlay-session", {
      lineageNodeId: "lineage:main",
      kind: "main",
      forkPoint: { kind: "session_root" },
      title: "Main task",
    });
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/lineage");
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "lineage",
      selectedIndex: 0,
    });
    runtime.dispose();
  });

  test("lineage overlay checkout updates the hosted branch and visible transcript", async () => {
    const { bundle } = createFakeBundle({ sessionId: "lineage-checkout-session" });
    const workspace = mkdtempSync(join(tmpdir(), "brewva-shell-lineage-checkout-"));
    const store = new HostedRuntimeTapeSessionStore(bundle.runtime, "lineage-checkout-session");
    const mainEntryId = store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "main checkpoint" }],
      timestamp: Date.now(),
    } as StoredSessionMessage);
    const mainAnswerEntryId = store.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "main answer" }],
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.4-mini",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: 0,
        },
      },
      stopReason: "stop",
      timestamp: Date.now() + 1,
    } as StoredSessionMessage);
    store.branch(mainEntryId);
    store.appendMessage({
      role: "user",
      content: [{ type: "text", text: "experiment branch" }],
      timestamp: Date.now() + 2,
    } as StoredSessionMessage);

    const session = bundle.session as unknown as {
      sessionManager: HostedRuntimeTapeSessionStore;
      replaceMessages(messages: unknown[]): Promise<void>;
    };
    const replacedMessages: unknown[][] = [];
    session.sessionManager = store;
    session.replaceMessages = async (messages) => {
      replacedMessages.push(messages);
    };

    const runtime = new CliShellRuntime(bundle, {
      cwd: workspace,
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/lineage");
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "lineage",
      selectedIndex: 1,
    });
    expect(
      (
        runtime.getViewState().overlay.active?.payload as
          | { kind: "lineage"; nodes: Array<{ lineageNodeId: string; leafEntryId: string | null }> }
          | undefined
      )?.nodes.find((node) => node.lineageNodeId === "lineage:main")?.leafEntryId,
    ).toBe(mainAnswerEntryId);

    await runtime.handleInput({ key: "up", ctrl: false, meta: false, shift: false });
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });

    expect(store.getLineageNodeId()).toBe("lineage:main");
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "lineage",
      selectedIndex: 0,
    });
    expect(
      bundle.runtime.inspect.session.lineage.getTree("lineage-checkout-session").selectedByChannel
        .cli,
    ).toBe("lineage:main");
    expect(JSON.stringify(replacedMessages.at(-1))).toContain("main checkpoint");
    expect(JSON.stringify(replacedMessages.at(-1))).not.toContain("experiment branch");

    runtime.dispose();
  });

  test("/help opens the help hub overlay", async () => {
    const { bundle } = createFakeBundle();

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/help");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "helpHub",
      title: "Help",
    });
    expect(runtime.getViewState().overlay.active?.lines?.join("\n") ?? "").toContain("Ctrl+K");

    runtime.dispose();
  });

  test("shift-tab cycles model presets and updates session status", async () => {
    const fixture = createFakeBundle({
      modelPresetState: {
        activeName: "Default",
        defaultName: "Default",
        presets: [
          { name: "Default", delegationModels: {}, synthetic: true },
          { name: "Claude Lead", mainModel: "anthropic/claude-main:high", delegationModels: {} },
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

    expect(fixture.getModelPresetState().activeName).toBe("Claude Lead");
    expect(runtime.getViewState().status.entries.preset).toBe("Claude Lead");
    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "info",
      message: "Model preset: Claude Lead",
    });

    runtime.dispose();
  });

  test("shift-tab queues model preset changes while a turn is streaming", async () => {
    const prompts: string[] = [];
    const fixture = createFakeBundle({
      isStreaming: true,
      promptHandler: async (text) => {
        prompts.push(text);
      },
      modelPresetState: {
        activeName: "Default",
        defaultName: "Default",
        presets: [
          { name: "Default", delegationModels: {}, synthetic: true },
          { name: "Claude Lead", mainModel: "anthropic/claude-main:high", delegationModels: {} },
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

    expect(fixture.getModelPresetState()).toMatchObject({
      activeName: "Default",
      pendingName: "Claude Lead",
    });
    expect(runtime.getViewState().status.entries.preset).toBe("Default -> Claude Lead");

    fixture.setStreaming(false);
    runtime.ui.setEditorText("next turn");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(prompts).toEqual(["next turn"]);
    expect(fixture.getModelPresetState()).toMatchObject({
      activeName: "Claude Lead",
      pendingName: undefined,
    });

    runtime.dispose();
  });

  test("model picker selects models and persists recent/favorite preferences outside prompt turns", async () => {
    const models: BrewvaSessionModelDescriptor[] = [
      {
        provider: "openai",
        id: "gpt-5.4-mini",
        name: "GPT-5.4 Mini",
        contextWindow: 128_000,
        maxTokens: 16_384,
        reasoning: true,
      },
      {
        provider: "anthropic",
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        contextWindow: 200_000,
        maxTokens: 32_000,
        reasoning: true,
      },
    ];
    const fixture = createFakeBundle({ models });
    const { bundle } = fixture;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/model ");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "modelPicker",
    });

    await runtime.handleInput({
      key: "character",
      text: "f",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(fixture.getModelPreferences().favorite).toEqual([
      { provider: "anthropic", id: "claude-opus-4-6" },
    ]);

    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(fixture.getCurrentModel()).toMatchObject({
      provider: "anthropic",
      id: "claude-opus-4-6",
    });
    expect(runtime.getViewState().status.entries.model).toBe("anthropic/claude-opus-4-6");
    expect(fixture.getModelPreferences().recent[0]).toEqual({
      provider: "anthropic",
      id: "claude-opus-4-6",
    });
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "thinkingPicker",
    });

    runtime.dispose();
  });

  test("model picker supports arrow and ctrl-n/ctrl-p navigation before selecting", async () => {
    const models: BrewvaSessionModelDescriptor[] = [
      {
        provider: "openai",
        id: "gpt-5.4-alpha",
        name: "Alpha",
        contextWindow: 128_000,
        maxTokens: 16_384,
        reasoning: false,
      },
      {
        provider: "openai",
        id: "gpt-5.4-beta",
        name: "Beta",
        contextWindow: 128_000,
        maxTokens: 16_384,
        reasoning: false,
      },
    ];
    const fixture = createFakeBundle({ models });
    const { bundle } = fixture;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/model ");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "modelPicker",
      selectedIndex: 0,
    });

    await runtime.handleInput({
      key: "n",
      ctrl: true,
      meta: false,
      shift: false,
    });
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "modelPicker",
      selectedIndex: 1,
    });

    await runtime.handleInput({
      key: "p",
      ctrl: true,
      meta: false,
      shift: false,
    });
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "modelPicker",
      selectedIndex: 0,
    });

    await runtime.handleInput({
      key: "arrowdown",
      ctrl: false,
      meta: false,
      shift: false,
    });
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "modelPicker",
      selectedIndex: 1,
    });

    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(fixture.getCurrentModel()).toMatchObject({
      provider: "openai",
      id: "gpt-5.4-beta",
    });
    expect(runtime.getViewState().overlay.active).toBe(undefined);

    runtime.dispose();
  });

  test("model picker exposes disconnected providers when model search matches their catalog", async () => {
    const models: BrewvaSessionModelDescriptor[] = [
      {
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
        contextWindow: 128_000,
        maxTokens: 16_384,
        reasoning: true,
      },
      {
        provider: "openai-codex",
        id: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        contextWindow: 128_000,
        maxTokens: 16_384,
        reasoning: true,
      },
    ];
    const providers: ProviderConnectionDescriptor[] = [
      {
        id: "openai",
        name: "OpenAI",
        group: "popular",
        connected: false,
        connectionSource: "none",
        modelCount: 1,
        availableModelCount: 0,
        credentialRef: "vault://openai/apiKey",
      },
      {
        id: "openai-codex",
        name: "OpenAI Codex",
        group: "popular",
        connected: false,
        connectionSource: "none",
        modelCount: 1,
        availableModelCount: 0,
        credentialRef: "vault://openai-codex/apiKey",
      },
    ];
    const fixture = createFakeBundle({ models, availableModelKeys: [], providers });
    const { bundle } = fixture;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/model gpt");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    const payload = runtime.getViewState().overlay.active?.payload;
    expect(payload).toMatchObject({
      kind: "modelPicker",
      query: "gpt",
    });
    if (payload?.kind !== "modelPicker") {
      throw new Error("Expected model picker payload.");
    }

    expect(payload.items.map((item) => item.label)).toEqual(["OpenAI", "OpenAI Codex"]);
    expect(payload.items.every((item) => item.kind === "connect_provider")).toBe(true);

    runtime.dispose();
  });

  test("model picker rows keep long provider model ids out of inline details", async () => {
    const models: BrewvaSessionModelDescriptor[] = [
      {
        provider: "google",
        id: "gemini-2.5-flash-lite-preview-06-17",
        name: "Gemini 2.5 Flash Lite Preview 06-17",
        contextWindow: 1_000_000,
        maxTokens: 16_384,
        reasoning: true,
      },
    ];
    const { bundle } = createFakeBundle({ models });
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/model gemini");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    const payload = runtime.getViewState().overlay.active?.payload;
    if (payload?.kind !== "modelPicker") {
      throw new Error("Expected model picker payload.");
    }

    expect(payload.items[0]).toMatchObject({
      kind: "model",
      section: "Google",
      label: "Gemini 2.5 Flash Lite Preview 06-17",
      detail: undefined,
      footer: undefined,
    });

    runtime.dispose();
  });

  test("model picker routes disconnected OpenAI Codex models through the consolidated OpenAI connect flow", async () => {
    const models: BrewvaSessionModelDescriptor[] = [
      {
        provider: "openai",
        id: "gpt-5.4",
        name: "GPT-5.4",
        contextWindow: 128_000,
        maxTokens: 16_384,
        reasoning: true,
      },
      {
        provider: "openai-codex",
        id: "gpt-5.3-codex",
        name: "GPT-5.3 Codex",
        contextWindow: 128_000,
        maxTokens: 16_384,
        reasoning: true,
      },
    ];
    const providers: ProviderConnectionDescriptor[] = [
      {
        id: "openai",
        name: "OpenAI",
        description: "ChatGPT Plus/Pro or API key",
        group: "popular",
        connected: true,
        connectionSource: "vault",
        modelProviders: ["openai", "openai-codex"],
        modelCount: 2,
        availableModelCount: 1,
        credentialRef: "vault://openai/apiKey",
      },
    ];
    const fixture = createFakeBundle({
      models,
      availableModelKeys: ["openai/gpt-5.4"],
      providers,
      authMethods: {
        openai: [
          {
            id: "chatgpt_browser",
            kind: "oauth",
            type: "oauth",
            label: "ChatGPT Pro/Plus (browser)",
            credentialProvider: "openai-codex",
            modelProviderFilter: "openai-codex",
          },
          {
            id: "chatgpt_headless",
            kind: "oauth",
            type: "oauth",
            label: "ChatGPT Pro/Plus (headless)",
            credentialProvider: "openai-codex",
            modelProviderFilter: "openai-codex",
          },
          {
            id: "api_key",
            kind: "api_key",
            type: "api",
            label: "Manually enter API Key",
            credentialRef: "vault://openai/apiKey",
          },
        ],
      },
    });
    const { bundle } = fixture;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/model codex");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });
    await Bun.sleep(0);

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "authMethodPicker",
      items: [
        { id: "chatgpt_browser", label: "ChatGPT Pro/Plus (browser)", detail: "OAuth" },
        { id: "chatgpt_headless", label: "ChatGPT Pro/Plus (headless)", detail: "OAuth" },
        { id: "api_key", label: "Manually enter API Key", detail: "API key" },
      ],
    });

    runtime.dispose();
  });

  test("model picker fuzzy search matches non-contiguous model names", async () => {
    const models: BrewvaSessionModelDescriptor[] = [
      {
        provider: "google",
        id: "gemini-2.5-flash-lite-preview-06-17",
        name: "Gemini 2.5 Flash Lite Preview 06-17",
        contextWindow: 1_000_000,
        maxTokens: 16_384,
        reasoning: true,
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        contextWindow: 200_000,
        maxTokens: 16_384,
        reasoning: true,
      },
    ];
    const { bundle } = createFakeBundle({ models });
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/model gmni");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    const payload = runtime.getViewState().overlay.active?.payload;
    if (payload?.kind !== "modelPicker") {
      throw new Error("Expected model picker payload.");
    }

    expect(payload.items.map((item) => item.label)).toEqual([
      "Gemini 2.5 Flash Lite Preview 06-17",
    ]);

    runtime.dispose();
  });

  test("model picker c shortcut opens the provider connection picker", async () => {
    const providers: ProviderConnectionDescriptor[] = [
      {
        id: "openai",
        name: "OpenAI",
        description: "ChatGPT Plus/Pro or API key",
        group: "popular",
        connected: true,
        connectionSource: "oauth",
        modelProviders: ["openai", "openai-codex"],
        modelCount: 2,
        availableModelCount: 1,
        credentialRef: "vault://openai/apiKey",
      },
    ];
    const fixture = createFakeBundle({ providers });
    const { bundle } = fixture;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/model ");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });
    await runtime.handleInput({
      key: "character",
      text: "codex",
      ctrl: false,
      meta: false,
      shift: false,
    });
    await runtime.handleInput({
      key: "character",
      text: " ",
      ctrl: false,
      meta: false,
      shift: false,
    });
    await runtime.handleInput({
      key: "character",
      text: "c",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "providerPicker",
      query: "codex ",
    });

    runtime.dispose();
  });

  test("session switching preserves drafts per session and restores them when returning", async () => {
    const replaySessions = [
      {
        sessionId: asBrewvaSessionId("session-1"),
        eventCount: 14,
        lastEventAt: 1_710_000_000_000,
        title: "Session One",
      },
      {
        sessionId: asBrewvaSessionId("session-2"),
        eventCount: 9,
        lastEventAt: 1_710_000_100_000,
        title: "Session Two",
      },
    ] satisfies BrewvaReplaySession[];

    const first = createFakeBundle({
      sessionId: "session-1",
      replaySessions,
    });
    const second = createFakeBundle({
      sessionId: "session-2",
      replaySessions,
    });

    const bundles = new Map([
      ["session-1", first.bundle],
      ["session-2", second.bundle],
    ]);

    const runtime = new CliShellRuntime(first.bundle, {
      cwd: process.cwd(),
      openSession: async (sessionId) => bundles.get(sessionId) ?? first.bundle,
      createSession: async () => second.bundle,
    });

    runtime.ui.setEditorText("draft one");
    runtime.openOverlay({
      kind: "sessions",
      selectedIndex: 1,
      query: "",
      sessions: replaySessions,
      currentSessionId: "session-1",
      draftStateBySessionId: {
        "session-1": {
          characters: 9,
          lines: 1,
          preview: "draft one",
        },
      },
    });

    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.getSessionBundle().session.sessionManager.getSessionId()).toBe("session-2");
    expect(runtime.ui.getEditorText()).toBe("");

    runtime.ui.setEditorText("draft two");
    runtime.openOverlay({
      kind: "sessions",
      selectedIndex: 0,
      query: "",
      sessions: replaySessions,
      currentSessionId: "session-2",
      draftStateBySessionId: {
        "session-1": {
          characters: 9,
          lines: 1,
          preview: "draft one",
        },
        "session-2": {
          characters: 9,
          lines: 1,
          preview: "draft two",
        },
      },
    });

    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.getSessionBundle().session.sessionManager.getSessionId()).toBe("session-1");
    expect(runtime.ui.getEditorText()).toBe("draft one");
    runtime.dispose();
  });

  test("session switching seeds queued prompts from the target session immediately", async () => {
    const replaySessions = [
      {
        sessionId: asBrewvaSessionId("session-1"),
        eventCount: 14,
        lastEventAt: 1_710_000_000_000,
        title: "Session One",
      },
      {
        sessionId: asBrewvaSessionId("session-2"),
        eventCount: 9,
        lastEventAt: 1_710_000_100_000,
        title: "Session Two",
      },
    ] satisfies BrewvaReplaySession[];

    const first = createFakeBundle({
      sessionId: "session-1",
      replaySessions,
    });
    const secondQueuedPrompts: BrewvaQueuedPromptView[] = [
      {
        promptId: "queued-1",
        text: "Queued prompt from session two",
        submittedAt: 2,
        behavior: "queue",
      },
    ];
    const second = createFakeBundle({
      sessionId: "session-2",
      replaySessions,
      queuedPrompts: secondQueuedPrompts,
    });

    const bundles = new Map([
      ["session-1", first.bundle],
      ["session-2", second.bundle],
    ]);

    const runtime = new CliShellRuntime(first.bundle, {
      cwd: process.cwd(),
      openSession: async (sessionId) => bundles.get(sessionId) ?? first.bundle,
      createSession: async () => second.bundle,
    });

    runtime.openOverlay({
      kind: "sessions",
      selectedIndex: 1,
      query: "",
      sessions: replaySessions,
      currentSessionId: "session-1",
      draftStateBySessionId: {},
    });

    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.getSessionBundle().session.sessionManager.getSessionId()).toBe("session-2");
    expect(runtime.getViewState().queue).toEqual(secondQueuedPrompts);
    runtime.dispose();
  });

  test("sessions overlay text input filters sessions by title", async () => {
    const replaySessions = [
      {
        sessionId: asBrewvaSessionId("session-1"),
        eventCount: 14,
        lastEventAt: 1_710_000_000_000,
        title: "Command Palette Polish",
      },
      {
        sessionId: asBrewvaSessionId("session-2"),
        eventCount: 9,
        lastEventAt: 1_710_000_100_000,
        title: "Runtime Projection Cleanup",
      },
    ] satisfies BrewvaReplaySession[];

    const { bundle } = createFakeBundle({
      sessionId: "session-1",
      replaySessions,
    });
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await runtime.start();
    await runtime.handleInput({
      key: "g",
      ctrl: true,
      meta: false,
      shift: false,
    });
    await runtime.handleInput({
      key: "character",
      text: "runtime",
      ctrl: false,
      meta: false,
      shift: false,
    });

    const payload = runtime.getViewState().overlay.active?.payload;
    expect(payload).toMatchObject({
      kind: "sessions",
      query: "runtime",
      selectedIndex: 0,
    });
    expect(
      payload?.kind === "sessions" ? payload.sessions.map((session) => session.title) : [],
    ).toEqual(["Runtime Projection Cleanup"]);
    runtime.dispose();
  });

  test("queue overlay closes after deleting the last queued prompt", async () => {
    const queuedPrompts: BrewvaQueuedPromptView[] = [
      {
        promptId: "queued-1",
        text: "Queued prompt",
        submittedAt: 1,
        behavior: "queue",
      },
    ];
    const { bundle } = createFakeBundle({ queuedPrompts });
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await runtime.start();
    runtime.ui.setEditorText("draft");
    await runtime.handleInput({
      key: "b",
      ctrl: true,
      meta: false,
      shift: false,
    });

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "queue",
      selectedIndex: 0,
    });
    expect(runtime.ui.getEditorText()).toBe("draft");

    await runtime.handleInput({
      key: "character",
      text: "d",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.getViewState().queue).toEqual([]);
    expect(runtime.getViewState().overlay.active).toBe(undefined);
    runtime.dispose();
  });

  test("queue overlay notifies when the selected queued prompt leaves the queue", async () => {
    const firstQueuedPrompt: BrewvaQueuedPromptView = {
      promptId: "queued-1",
      text: "First queued prompt",
      submittedAt: 1,
      behavior: "queue",
    };
    const secondQueuedPrompt: BrewvaQueuedPromptView = {
      promptId: "queued-2",
      text: "Second queued prompt",
      submittedAt: 2,
      behavior: "queue",
    };
    const fixture = createFakeBundle({
      queuedPrompts: [firstQueuedPrompt, secondQueuedPrompt],
    });
    const { bundle } = fixture;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await runtime.start();
    await runtime.handleInput({
      key: "b",
      ctrl: true,
      meta: false,
      shift: false,
    });

    fixture.emitSessionEvent({
      type: "queue.changed",
      items: [secondQueuedPrompt],
    });

    expect(
      runtime.getViewState().notifications.map((notification) => notification.message),
    ).toContain("Selected queued prompt left the queue.");
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "queue",
      selectedIndex: 0,
      items: [secondQueuedPrompt],
    });
    runtime.dispose();
  });

  test("session browser still surfaces the current session before any replay events exist", async () => {
    const replaySessions = [
      {
        sessionId: asBrewvaSessionId("archived-session"),
        eventCount: 12,
        lastEventAt: 1_710_000_000_000,
        title: "Archived session",
      },
    ] satisfies BrewvaReplaySession[];

    const { bundle } = createFakeBundle({
      sessionId: "fresh-session",
      replaySessions,
    });

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await runtime.start();
    runtime.ui.setEditorText("draft before first turn");
    await runtime.handleInput({
      key: "g",
      ctrl: true,
      meta: false,
      shift: false,
    });

    const payload = runtime.getViewState().overlay.active?.payload;
    expect(payload).toMatchObject({
      kind: "sessions",
      currentSessionId: "fresh-session",
    });
    expect(
      payload?.kind === "sessions" ? payload.sessions.map((session) => session.sessionId) : [],
    ).toEqual([asBrewvaSessionId("fresh-session"), asBrewvaSessionId("archived-session")]);
    expect(
      payload?.kind === "sessions" ? payload.draftStateBySessionId["fresh-session"] : undefined,
    ).toMatchObject({
      lines: 1,
      preview: "draft before first turn",
    });
    runtime.dispose();
  });
});
