import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrewvaRuntime,
  CURRENT_DELEGATION_CONTRACT_VERSION,
  asBrewvaSessionId,
  asBrewvaToolCallId,
  asBrewvaToolName,
  type SessionWireFrame,
} from "@brewva/brewva-runtime";
import { type BrewvaReplaySession } from "@brewva/brewva-runtime/events";
import {
  buildBrewvaPromptText,
  type BrewvaPromptContentPart,
  type BrewvaQueuedPromptView,
  type BrewvaPromptToolCall,
  type BrewvaPromptSessionEvent,
  type BrewvaShellViewPreferences,
  type BrewvaModelPresetState,
  type BrewvaSessionModelDescriptor,
  type BrewvaSteerOutcome,
  type BrewvaToolUiPort,
} from "@brewva/brewva-substrate";
import { DEFAULT_TUI_THEME } from "@brewva/brewva-tui";
import { createCliShellPromptStore } from "../../../packages/brewva-cli/src/shell/prompt-store.js";
import { CliShellRuntime } from "../../../packages/brewva-cli/src/shell/runtime.js";
import type {
  CliShellSessionBundle,
  ProviderAuthMethod,
  ProviderOAuthAuthorization,
  ProviderConnection,
} from "../../../packages/brewva-cli/src/shell/types.js";
import { patchDateNow } from "../../helpers/global-state.js";
import {
  createPromptMessageUpdateEvent,
  createTextDeltaAssistantEvent,
  createToolcallEndAssistantEvent,
} from "../../helpers/prompt-session-events.js";

function modelKey(model: Pick<BrewvaSessionModelDescriptor, "provider" | "id">): string {
  return `${model.provider}/${model.id}`;
}

async function invokePaletteCommand(runtime: CliShellRuntime, commandId: string): Promise<boolean> {
  return await (
    runtime as unknown as {
      handleShellIntent(intent: {
        type: "command.invoke";
        commandId: string;
        args: string;
        source: "palette";
      }): Promise<boolean>;
    }
  ).handleShellIntent({
    type: "command.invoke",
    commandId,
    args: "",
    source: "palette",
  });
}

function createFakeBundle(
  options: {
    promptHandler?: (text: string) => Promise<void>;
    sessionId?: string;
    replaySessions?: BrewvaReplaySession[];
    sessionWireBySessionId?: Record<string, SessionWireFrame[]>;
    models?: BrewvaSessionModelDescriptor[];
    availableModelKeys?: string[];
    providers?: ProviderConnection[];
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
    },
  ];
  const runtime = new BrewvaRuntime({
    cwd: mkdtempSync(join(tmpdir(), "brewva-shell-runtime-")),
  });
  Object.assign(runtime.authority.proposals, {
    decideEffectCommitment(_sessionId: string, requestId: string, input: unknown) {
      approvalDecisions.push({ requestId, input });
    },
  });
  Object.assign(runtime.inspect.proposals, {
    listPendingEffectCommitments() {
      return [];
    },
  });
  Object.assign(runtime.inspect.events, {
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
      buildSessionContext() {
        return { messages: [] };
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
          async listProviders() {
            return options.providers ?? [];
          },
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
          async connectApiKey(provider: string, key: string) {
            providerConnects.push({ provider, key });
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
          async disconnect() {},
          async refresh() {},
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

describe("shell runtime", () => {
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

  test("reserved runtime slash names stay out of prompt submission in the interactive shell", async () => {
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
    });

    runtime.ui.setEditorText("/questions ");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(prompts).toEqual([]);
    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "warning",
      message:
        "Use /inbox in the interactive shell; /questions remains a headless runtime-plugin command.",
    });

    runtime.dispose();
  });

  test("unknown slash commands stay out of prompt submission in the interactive shell", async () => {
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
    });

    runtime.ui.setEditorText("/models");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(prompts).toEqual([]);
    expect(runtime.ui.getEditorText()).toBe("/models");
    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "warning",
      message: "Unknown slash command: /models. Type /help or press Ctrl+K for commands.",
    });

    runtime.ui.setEditorText("/ ");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(prompts).toEqual([]);
    expect(runtime.ui.getEditorText()).toBe("/ ");
    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "warning",
      message: "Unknown slash command. Type /help or press Ctrl+K for commands.",
    });

    runtime.dispose();
  });

  test("slash completion exposes only promoted shell commands", () => {
    const { bundle } = createFakeBundle();

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/");
    const slashValues = runtime.getViewState().composer.completion?.items.map((item) => item.value);

    expect(slashValues).toContain("model");
    expect(slashValues).toContain("inbox");
    expect(slashValues).toContain("inspect");
    expect(slashValues).not.toContain("connect");
    expect(slashValues).not.toContain("think");
    expect(slashValues).not.toContain("thinking");
    expect(slashValues).not.toContain("tool-details");
    expect(slashValues).not.toContain("diffwrap");
    expect(slashValues).not.toContain("diffstyle");
    expect(slashValues).not.toContain("credentials");
    expect(slashValues).not.toContain("auth");

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

  test("ctrl+k opens command palette and can run model search result", async () => {
    const { bundle } = createFakeBundle();

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await runtime.handleInput({
      key: "k",
      ctrl: true,
      meta: false,
      shift: false,
    });

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "commandPalette",
      title: "Commands",
    });

    for (const text of "model") {
      await runtime.handleInput({
        key: "character",
        text,
        ctrl: false,
        meta: false,
        shift: false,
      });
    }

    const palette = runtime.getViewState().overlay.active?.payload;
    expect(palette).toMatchObject({
      kind: "commandPalette",
      query: "model",
    });
    expect(palette?.kind === "commandPalette" ? palette.items[0]?.label : undefined).toBe(
      "Switch model",
    );

    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "modelPicker",
    });

    runtime.dispose();
  });

  test("quit slash aliases resolve through the command provider", async () => {
    const { bundle } = createFakeBundle();

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    const exited = runtime.waitForExit();
    runtime.ui.setEditorText("/exit");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });
    await exited;

    runtime.dispose();
  });

  test("thinking and tool-details palette commands update durable shell view preferences", async () => {
    const fixture = createFakeBundle();
    const runtime = new CliShellRuntime(fixture.bundle, {
      cwd: process.cwd(),
      openSession: async () => fixture.bundle,
      createSession: async () => fixture.bundle,
    });

    expect(runtime.getViewState().view.showThinking).toBe(true);
    expect(runtime.getViewState().view.toolDetails).toBe(true);

    await invokePaletteCommand(runtime, "view.thinking");

    expect(runtime.getViewState().view.showThinking).toBe(false);
    expect(fixture.getShellViewPreferences().showThinking).toBe(false);
    expect(fixture.getShellViewPreferences().toolDetails).toBe(true);

    await invokePaletteCommand(runtime, "view.toolDetails");

    expect(runtime.getViewState().view.toolDetails).toBe(false);
    expect(fixture.getShellViewPreferences()).toEqual({
      showThinking: false,
      toolDetails: false,
    });

    runtime.dispose();

    const restored = new CliShellRuntime(fixture.bundle, {
      cwd: process.cwd(),
      openSession: async () => fixture.bundle,
      createSession: async () => fixture.bundle,
      operatorPollIntervalMs: 60_000,
    });
    await restored.start();
    expect(restored.getViewState().view.showThinking).toBe(false);
    expect(restored.getViewState().view.toolDetails).toBe(false);
    restored.dispose();
  });

  test("diff palette commands update and persist transcript diff preferences", async () => {
    const fixture = createFakeBundle();
    const runtime = new CliShellRuntime(fixture.bundle, {
      cwd: process.cwd(),
      openSession: async () => fixture.bundle,
      createSession: async () => fixture.bundle,
    });

    expect(runtime.getViewState().diff).toEqual({ style: "auto", wrapMode: "word" });

    await invokePaletteCommand(runtime, "view.diffWrap");

    expect(runtime.getViewState().diff.wrapMode).toBe("none");
    expect(fixture.getDiffPreferences().wrapMode).toBe("none");

    await invokePaletteCommand(runtime, "view.diffStyle");

    expect(runtime.getViewState().diff.style).toBe("stacked");
    expect(fixture.getDiffPreferences().style).toBe("stacked");

    runtime.dispose();
  });

  test("enter on no-argument slash completion executes the selected command", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/mo");
    expect(runtime.getViewState().composer.completion?.items[0]).toMatchObject({
      kind: "command",
      value: "model",
      accept: {
        type: "runCommand",
        commandId: "agent.model",
      },
    });

    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.ui.getEditorText()).toBe("");
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "modelPicker",
    });

    runtime.dispose();
  });

  test("typing a slash query resets selection to the best matching command", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    for (const text of ["/", "/i", "/in", "/inb"]) {
      runtime.ui.setEditorText(text);
    }

    const completion = runtime.getViewState().composer.completion;
    expect(completion?.items[completion.selectedIndex]).toMatchObject({
      kind: "command",
      value: "inbox",
      accept: {
        type: "runCommand",
        commandId: "operator.inbox",
      },
    });

    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.ui.getEditorText()).toBe("");
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "inbox",
    });

    runtime.dispose();
  });

  test("enter on required-argument slash completion inserts the command for continued input", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/ans");
    expect(runtime.getViewState().composer.completion?.items[0]).toMatchObject({
      kind: "command",
      value: "answer",
      accept: {
        type: "runCommand",
        commandId: "operator.answer",
        argumentMode: "required",
      },
    });

    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.ui.getEditorText()).toBe("/answer ");
    expect(runtime.getViewState().overlay.active).toBeUndefined();

    runtime.dispose();
  });

  test("tab on slash completion still expands text for optional command arguments", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/mo");
    await runtime.handleInput({
      key: "tab",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.ui.getEditorText()).toBe("/model ");
    expect(runtime.getViewState().overlay.active).toBeUndefined();

    runtime.dispose();
  });

  test("shift-tab cycles model presets and updates session status", async () => {
    const fixture = createFakeBundle({
      modelPresetState: {
        activeName: "Default",
        defaultName: "Default",
        presets: [
          { name: "Default", subagentModels: {}, synthetic: true },
          { name: "Claude Lead", mainModel: "anthropic/claude-main:high", subagentModels: {} },
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

  test("shift-tab is a no-op when only the synthetic default preset is available", async () => {
    const fixture = createFakeBundle();
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

    expect(fixture.getModelPresetState().activeName).toBe("Default");
    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "info",
      message: "Only one model preset is available.",
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
          { name: "Default", subagentModels: {}, synthetic: true },
          { name: "Claude Lead", mainModel: "anthropic/claude-main:high", subagentModels: {} },
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
    expect(runtime.getViewState().overlay.active).toBeUndefined();

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
    const providers: ProviderConnection[] = [
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
    const providers: ProviderConnection[] = [
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
    const providers: ProviderConnection[] = [
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

  test("picker backspace on an empty query does not rebuild the active overlay", async () => {
    const providers: ProviderConnection[] = [
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
    ];
    const fixture = createFakeBundle({ providers });
    const { bundle } = fixture;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await invokePaletteCommand(runtime, "agent.connect");

    const before = runtime.getViewState().overlay.active?.payload;
    expect(before).toMatchObject({ kind: "providerPicker", query: "" });

    await runtime.handleInput({
      key: "backspace",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.getViewState().overlay.active?.payload).toBe(before);

    runtime.dispose();
  });

  test("provider picker supports ctrl-n/ctrl-p navigation before opening connect flow", async () => {
    const providers: ProviderConnection[] = [
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
        id: "anthropic",
        name: "Anthropic",
        group: "popular",
        connected: false,
        connectionSource: "none",
        modelCount: 1,
        availableModelCount: 0,
        credentialRef: "vault://anthropic/apiKey",
      },
    ];
    const fixture = createFakeBundle({ providers });
    const { bundle } = fixture;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await invokePaletteCommand(runtime, "agent.connect");

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "providerPicker",
      selectedIndex: 0,
    });

    await runtime.handleInput({
      key: "n",
      ctrl: true,
      meta: false,
      shift: false,
    });
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "providerPicker",
      selectedIndex: 1,
    });

    await runtime.handleInput({
      key: "p",
      ctrl: true,
      meta: false,
      shift: false,
    });
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "providerPicker",
      selectedIndex: 0,
    });

    await runtime.handleInput({
      key: "down",
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
      kind: "input",
      message: "API key for Anthropic (vault://anthropic/apiKey)",
      masked: true,
    });

    await runtime.handleInput({
      key: "character",
      text: "sk-test",
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

    expect(fixture.providerConnects).toEqual([{ provider: "anthropic", key: "sk-test" }]);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "modelPicker",
      providerFilter: "anthropic",
    });

    runtime.dispose();
  });

  test("Kimi connect flow selects platform before accepting pasted API keys", async () => {
    const providers: ProviderConnection[] = [
      {
        id: "kimi-coding",
        name: "Kimi",
        group: "popular",
        connected: false,
        connectionSource: "none",
        modelProviders: ["kimi-coding", "moonshot-cn", "moonshot-ai"],
        modelCount: 3,
        availableModelCount: 0,
        credentialRef: "vault://kimi-coding/apiKey",
      },
    ];
    const fixture = createFakeBundle({
      providers,
      authMethods: {
        "kimi-coding": [
          {
            id: "kimi_code_api_key",
            kind: "api_key",
            type: "api",
            label: "Kimi Code",
            credentialRef: "vault://kimi-coding/apiKey",
            credentialProvider: "kimi-coding",
            modelProviderFilter: "kimi-coding",
          },
          {
            id: "moonshot_cn_api_key",
            kind: "api_key",
            type: "api",
            label: "Moonshot AI Open Platform (moonshot.cn)",
            credentialRef: "vault://moonshot-cn/apiKey",
            credentialProvider: "moonshot-cn",
            modelProviderFilter: "moonshot-cn",
          },
          {
            id: "moonshot_ai_api_key",
            kind: "api_key",
            type: "api",
            label: "Moonshot AI Open Platform (moonshot.ai)",
            credentialRef: "vault://moonshot-ai/apiKey",
            credentialProvider: "moonshot-ai",
            modelProviderFilter: "moonshot-ai",
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

    await invokePaletteCommand(runtime, "agent.connect");
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });
    await Bun.sleep(0);

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "authMethodPicker",
      title: "Connect Kimi",
    });

    await runtime.handleInput({ key: "down", ctrl: false, meta: false, shift: false });
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });
    await Bun.sleep(0);

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "input",
      title: "Connect Kimi",
      message: "Moonshot AI Open Platform (moonshot.cn) for Kimi (vault://moonshot-cn/apiKey)",
      masked: true,
      compact: true,
    });

    await runtime.handleInput({
      key: "paste",
      text: "sk-moonshot-pasted\n",
      ctrl: false,
      meta: false,
      shift: false,
    });
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });
    await Bun.sleep(0);

    expect(fixture.providerConnects).toEqual([
      { provider: "moonshot-cn", key: "sk-moonshot-pasted" },
    ]);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "modelPicker",
      providerFilter: "moonshot-cn",
    });

    runtime.dispose();
  });

  test("provider connect flow warns when a provider exposes no in-TUI auth methods", async () => {
    const providers: ProviderConnection[] = [
      {
        id: "external",
        name: "External Provider",
        group: "other",
        connected: false,
        connectionSource: "none",
        modelCount: 1,
        availableModelCount: 0,
        credentialRef: "vault://external/apiKey",
      },
    ];
    const fixture = createFakeBundle({
      providers,
      authMethods: {
        external: [],
      },
    });
    const { bundle } = fixture;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await invokePaletteCommand(runtime, "agent.connect");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });
    await Bun.sleep(0);

    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "warning",
      message:
        "External Provider does not expose an in-TUI auth flow. Configure provider auth, then reopen /model.",
    });

    runtime.dispose();
  });

  test("provider connect flow supports OAuth method selection and auto completion", async () => {
    const providers: ProviderConnection[] = [
      {
        id: "openai",
        name: "OpenAI",
        description: "ChatGPT Plus/Pro or API key",
        group: "popular",
        connected: false,
        connectionSource: "none",
        modelCount: 1,
        availableModelCount: 0,
        credentialRef: "vault://openai/apiKey",
      },
    ];
    const oauthCalls: Array<{
      provider: string;
      methodId: string;
      inputs?: Record<string, string>;
    }> = [];
    const completeCalls: Array<{ provider: string; methodId: string; code?: string }> = [];
    const fixture = createFakeBundle({
      providers,
      availableModelKeys: [],
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
      async authorizeOAuth(provider, methodId, inputs) {
        oauthCalls.push({ provider, methodId, inputs });
        return {
          url: "https://auth.example.test",
          method: "auto",
          instructions: "Authorize in browser.",
        };
      },
      async completeOAuth(provider, methodId, code) {
        completeCalls.push({ provider, methodId, code });
      },
    });
    const { bundle } = fixture;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await invokePaletteCommand(runtime, "agent.connect");
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

    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });
    await Bun.sleep(0);

    expect(oauthCalls).toEqual([{ provider: "openai", methodId: "chatgpt_browser", inputs: {} }]);
    expect(completeCalls).toEqual([
      { provider: "openai", methodId: "chatgpt_browser", code: undefined },
    ]);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "modelPicker",
      providerFilter: "openai-codex",
    });

    runtime.dispose();
  });

  test("provider connect flow lets browser OAuth paste a redirect URL from the wait dialog", async () => {
    const providers: ProviderConnection[] = [
      {
        id: "openai",
        name: "OpenAI",
        description: "ChatGPT Plus/Pro or API key",
        group: "popular",
        connected: false,
        connectionSource: "none",
        modelCount: 1,
        availableModelCount: 0,
        credentialRef: "vault://openai/apiKey",
      },
    ];
    const authUrl = "https://auth.example.test/oauth";
    const completeCalls: Array<{ provider: string; methodId: string; code?: string }> = [];
    let finishBrowserWait: (() => void) | undefined;
    const fixture = createFakeBundle({
      providers,
      availableModelKeys: [],
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
        ],
      },
      async authorizeOAuth() {
        return {
          url: authUrl,
          method: "auto",
          instructions: "Authorize in browser.",
          manualCode: {
            prompt: "Paste the final redirect URL or authorization code.",
          },
        };
      },
      async completeOAuth(provider, methodId, code) {
        completeCalls.push({ provider, methodId, code });
        if (!code) {
          await new Promise<void>((resolve) => {
            finishBrowserWait = resolve;
          });
        }
      },
    });
    const { bundle } = fixture;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await invokePaletteCommand(runtime, "agent.connect");
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });
    await Bun.sleep(0);

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "input",
      title: "ChatGPT Pro/Plus (browser)",
    });

    for (const text of ["h", "t", "t", "p", "s", ":", "/", "/", "callback", "?", "code=abc"]) {
      await runtime.handleInput({
        key: "character",
        text,
        ctrl: false,
        meta: false,
        shift: false,
      });
    }
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });
    finishBrowserWait?.();
    await Bun.sleep(0);

    expect(completeCalls).toEqual([
      { provider: "openai", methodId: "chatgpt_browser", code: undefined },
      { provider: "openai", methodId: "chatgpt_browser", code: "https://callback?code=abc" },
    ]);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "modelPicker",
      providerFilter: "openai-codex",
    });

    runtime.dispose();
  });

  test("provider connect flow closes manual OAuth input when browser OAuth completes", async () => {
    const providers: ProviderConnection[] = [
      {
        id: "openai",
        name: "OpenAI",
        description: "ChatGPT Plus/Pro or API key",
        group: "popular",
        connected: false,
        connectionSource: "none",
        modelCount: 1,
        availableModelCount: 0,
        credentialRef: "vault://openai/apiKey",
      },
    ];
    const completeCalls: Array<{ provider: string; methodId: string; code?: string }> = [];
    let finishBrowserWait: (() => void) | undefined;
    const fixture = createFakeBundle({
      providers,
      availableModelKeys: [],
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
        ],
      },
      async authorizeOAuth() {
        return {
          url: "https://auth.example.test/oauth",
          method: "auto",
          instructions: "Authorize in browser.",
          manualCode: {
            prompt: "Paste the final redirect URL or authorization code.",
          },
        };
      },
      async completeOAuth(provider, methodId, code) {
        completeCalls.push({ provider, methodId, code });
        if (!code) {
          await new Promise<void>((resolve) => {
            finishBrowserWait = resolve;
          });
        }
      },
    });
    const { bundle } = fixture;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await invokePaletteCommand(runtime, "agent.connect");
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });
    await Bun.sleep(0);

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "input",
      title: "ChatGPT Pro/Plus (browser)",
    });

    finishBrowserWait?.();
    await Bun.sleep(0);

    expect(completeCalls).toEqual([
      { provider: "openai", methodId: "chatgpt_browser", code: undefined },
    ]);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "modelPicker",
      providerFilter: "openai-codex",
    });

    runtime.dispose();
  });

  test("provider connect flow does not switch auth methods when browser OAuth fails", async () => {
    const providers: ProviderConnection[] = [
      {
        id: "openai",
        name: "OpenAI",
        description: "ChatGPT Plus/Pro or API key",
        group: "popular",
        connected: false,
        connectionSource: "none",
        modelCount: 1,
        availableModelCount: 0,
        credentialRef: "vault://openai/apiKey",
      },
    ];
    const oauthCalls: Array<{
      provider: string;
      methodId: string;
      inputs?: Record<string, string>;
    }> = [];
    const completeCalls: Array<{ provider: string; methodId: string; code?: string }> = [];
    const fixture = createFakeBundle({
      providers,
      availableModelKeys: [],
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
      async authorizeOAuth(provider, methodId, inputs) {
        oauthCalls.push({ provider, methodId, inputs });
        if (methodId === "chatgpt_browser") {
          const error = new Error(
            "OpenAI browser login uses localhost:1455, but that port is already in use.",
          );
          error.name = "ProviderOAuthPortInUseError";
          throw error;
        }
        return {
          url: "https://auth.openai.test/codex/device",
          method: "auto",
          instructions: "Enter code: CODE-1",
        };
      },
      async completeOAuth(provider, methodId, code) {
        completeCalls.push({ provider, methodId, code });
      },
    });
    const { bundle } = fixture;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await invokePaletteCommand(runtime, "agent.connect");
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

    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });
    await Bun.sleep(0);

    expect(oauthCalls).toEqual([{ provider: "openai", methodId: "chatgpt_browser", inputs: {} }]);
    expect(completeCalls).toEqual([]);
    expect(
      runtime
        .getViewState()
        .notifications.some(
          (notification) =>
            notification.level === "error" &&
            notification.message ===
              "OpenAI browser login uses localhost:1455, but that port is already in use.",
        ),
    ).toBe(true);

    runtime.dispose();
  });

  test("provider connect flow collects conditional OAuth prompts", async () => {
    const providers: ProviderConnection[] = [
      {
        id: "github-copilot",
        name: "GitHub Copilot",
        description: "GitHub OAuth or token",
        group: "popular",
        connected: false,
        connectionSource: "none",
        modelCount: 1,
        availableModelCount: 0,
        credentialRef: "vault://github-copilot/token",
      },
    ];
    const oauthCalls: Array<{
      provider: string;
      methodId: string;
      inputs?: Record<string, string>;
    }> = [];
    const fixture = createFakeBundle({
      providers,
      availableModelKeys: [],
      authMethods: {
        "github-copilot": [
          {
            id: "github_copilot",
            kind: "oauth",
            type: "oauth",
            label: "Login with GitHub Copilot",
            prompts: [
              {
                type: "select",
                key: "deploymentType",
                message: "Select GitHub deployment type",
                options: [
                  { label: "GitHub.com", value: "github.com", hint: "Public" },
                  { label: "GitHub Enterprise", value: "enterprise", hint: "Enterprise" },
                ],
              },
              {
                type: "text",
                key: "enterpriseUrl",
                message: "Enter your GitHub Enterprise URL or domain",
                placeholder: "company.ghe.com",
                when: { key: "deploymentType", op: "eq", value: "enterprise" },
              },
            ],
          },
        ],
      },
      async authorizeOAuth(provider, methodId, inputs) {
        oauthCalls.push({ provider, methodId, inputs });
        return {
          url: "https://github.example.test/login/device",
          method: "auto",
          instructions: "Enter code: GH12-3456",
        };
      },
      async completeOAuth() {},
    });
    const { bundle } = fixture;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await invokePaletteCommand(runtime, "agent.connect");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });
    await Bun.sleep(0);
    await runtime.handleInput({
      key: "down",
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
    await runtime.handleInput({
      key: "character",
      text: "company.ghe.com",
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

    expect(oauthCalls).toEqual([
      {
        provider: "github-copilot",
        methodId: "github_copilot",
        inputs: {
          deploymentType: "enterprise",
          enterpriseUrl: "company.ghe.com",
        },
      },
    ]);

    runtime.dispose();
  });

  test("modal approval overlays suspend composer input and support reject shortcuts", async () => {
    const { bundle, approvalDecisions } = createFakeBundle();

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("draft");
    runtime.openOverlay(
      {
        kind: "approval",
        selectedIndex: 0,
        snapshot: {
          approvals: [
            {
              requestId: "approval-1",
              proposalId: "proposal-1",
              toolName: asBrewvaToolName("write_file"),
              toolCallId: asBrewvaToolCallId("tool-call-1"),
              subject: "write app.ts",
              boundary: "effectful",
              effects: ["workspace_write"],
              argsDigest: "digest-1",
              evidenceRefs: [],
              turn: 1,
              createdAt: Date.now(),
            },
          ],
          questions: [],
          taskRuns: [],
          sessions: [],
        },
      },
      "queued",
    );

    expect(runtime.getViewState().status.trust).toMatchObject({
      phase: "record",
      source: "idle",
    });

    const consumedCharacter = await runtime.handleInput({
      key: "character",
      text: "x",
      ctrl: false,
      meta: false,
      shift: false,
    });
    expect(consumedCharacter).toBe(true);
    expect(runtime.ui.getEditorText()).toBe("draft");
    expect(approvalDecisions).toHaveLength(0);

    const consumedReject = await runtime.handleInput({
      key: "character",
      text: "r",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(consumedReject).toBe(true);
    expect(approvalDecisions).toEqual([
      {
        requestId: "approval-1",
        input: {
          decision: "reject",
          actor: "brewva-cli",
        },
      },
    ]);
    expect(runtime.ui.getEditorText()).toBe("draft");
    expect(runtime.getViewState().status.trust).toMatchObject({
      phase: "record",
      source: "idle",
    });
    runtime.dispose();
  });

  test("interactive question overlays submit the selected answer on primary action", async () => {
    const { bundle, getAttachedUi } = createFakeBundle();

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });
    const ui = getAttachedUi();
    expect(ui).toBeDefined();

    const submission = ui!.custom<readonly (readonly string[])[] | undefined>(
      "question",
      {
        toolCallId: "tool-call-submit",
        title: "Agent needs input",
        questions: [
          {
            header: "Deploy",
            question: "Proceed with deployment?",
            options: [
              { label: "Yes", description: "Continue with deployment" },
              { label: "No", description: "Stop and revisit the plan" },
            ],
            custom: false,
          },
        ],
      },
      {},
    );

    const consumedEnter = await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(consumedEnter).toBe(true);
    expect(runtime.getViewState().overlay.active).toBeUndefined();
    expect(await submission).toEqual([["Yes"]]);
    runtime.dispose();
  });

  test("interactive question overlays move option focus with arrow keys and ctrl-n/ctrl-p", async () => {
    const { bundle, getAttachedUi } = createFakeBundle();

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });
    const ui = getAttachedUi();
    expect(ui).toBeDefined();

    const submission = ui!.custom<readonly (readonly string[])[] | undefined>(
      "question",
      {
        toolCallId: "tool-call-nav",
        title: "Agent needs input",
        questions: [
          {
            header: "Deploy",
            question: "Proceed with deployment?",
            options: [{ label: "Yes" }, { label: "No" }],
            custom: false,
          },
        ],
      },
      {},
    );

    const payload = runtime.getViewState().overlay.active?.payload;
    expect(payload?.kind).toBe("question");

    await runtime.handleInput({
      key: "down",
      ctrl: false,
      meta: false,
      shift: false,
    });
    const activeAfterDown = runtime.getViewState().overlay.active?.payload;
    expect(activeAfterDown?.kind).toBe("question");
    expect(
      activeAfterDown?.kind === "question"
        ? activeAfterDown.draftsByRequestId?.["tool:tool-call-nav"]?.selectedOptionIndex
        : null,
    ).toBe(1);

    await runtime.handleInput({
      key: "up",
      ctrl: false,
      meta: false,
      shift: false,
    });
    const activeAfterUp = runtime.getViewState().overlay.active?.payload;
    expect(activeAfterUp?.kind).toBe("question");
    expect(
      activeAfterUp?.kind === "question"
        ? activeAfterUp.draftsByRequestId?.["tool:tool-call-nav"]?.selectedOptionIndex
        : null,
    ).toBe(0);

    await runtime.handleInput({
      key: "n",
      ctrl: true,
      meta: false,
      shift: false,
    });
    const activeAfterCtrlN = runtime.getViewState().overlay.active?.payload;
    expect(
      activeAfterCtrlN?.kind === "question"
        ? activeAfterCtrlN.draftsByRequestId?.["tool:tool-call-nav"]?.selectedOptionIndex
        : null,
    ).toBe(1);

    const consumedEnter = await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(consumedEnter).toBe(true);
    expect(runtime.getViewState().overlay.active).toBeUndefined();
    expect(await submission).toEqual([["No"]]);
    runtime.dispose();
  });

  test("interactive question custom requests resolve dismissed on abort", async () => {
    const { bundle, getAttachedUi } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });
    const ui = getAttachedUi();
    expect(ui).toBeDefined();
    const abortController = new AbortController();

    const pending = ui!.custom<readonly (readonly string[])[] | undefined>(
      "question",
      {
        toolCallId: "tool-call-abort",
        questions: [
          {
            header: "Deploy",
            question: "Proceed with deployment?",
            options: [{ label: "Yes" }, { label: "No" }],
            custom: false,
          },
        ],
      },
      { signal: abortController.signal },
    );

    expect(runtime.getViewState().overlay.active?.payload?.kind).toBe("question");
    abortController.abort();

    expect(await pending).toBeUndefined();
    expect(runtime.getViewState().overlay.active).toBeUndefined();
    runtime.dispose();
  });

  test("interactive question custom requests resolve dismissed on session switch", async () => {
    const first = createFakeBundle({ sessionId: "session-1" });
    const second = createFakeBundle({ sessionId: "session-2" });
    const runtime = new CliShellRuntime(first.bundle, {
      cwd: process.cwd(),
      openSession: async (sessionId) => (sessionId === "session-2" ? second.bundle : first.bundle),
      createSession: async () => second.bundle,
    });
    const ui = first.getAttachedUi();
    expect(ui).toBeDefined();

    const pending = ui!.custom<readonly (readonly string[])[] | undefined>("question", {
      toolCallId: "tool-call-switch",
      questions: [
        {
          header: "Deploy",
          question: "Proceed with deployment?",
          options: [{ label: "Yes" }, { label: "No" }],
          custom: false,
        },
      ],
    });

    expect(runtime.getViewState().overlay.active?.payload?.kind).toBe("question");

    await runtime.openSessionById("session-2");

    expect(await pending).toBeUndefined();
    expect(runtime.getSessionBundle()).toBe(second.bundle);
    runtime.dispose();
  });

  test("streaming transcript updates preserve slash completion metadata and selection", async () => {
    const fixture = createFakeBundle();
    const { bundle } = fixture;

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    runtime.ui.setEditorText("/in");

    // Fuzzy sort keeps a stable ordered pair so streaming updates preserve selection.
    const initialCompletion = runtime.getViewState().composer.completion;
    expect(initialCompletion).toMatchObject({
      trigger: "/",
      query: "in",
      selectedIndex: 0,
    });
    const secondItem = initialCompletion?.items[1];
    expect(initialCompletion?.items[0]).toMatchObject({ value: "inbox" });
    expect(secondItem).toBeDefined();

    await runtime.handleInput({
      key: "down",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.getViewState().composer.completion?.items.at(1)).toEqual(secondItem);
    expect(runtime.getViewState().composer.completion?.selectedIndex).toBe(1);

    fixture.emitSessionEvent({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Streaming update while typing." }],
        stopReason: "toolUse",
      },
    });

    // Streaming event must not reset the completion state.
    expect(runtime.ui.getEditorText()).toBe("/in");
    expect(runtime.getViewState().composer.completion?.selectedIndex).toBe(1);
    expect(
      runtime.getViewState().composer.completion?.items[
        runtime.getViewState().composer.completion?.selectedIndex ?? 0
      ],
    ).toEqual(secondItem);

    runtime.dispose();
  });

  test("composer history navigates from input boundaries and restores the in-flight draft", async () => {
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
    });

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

    expect(prompts).toEqual(["first prompt", "second prompt"]);

    runtime.ui.setEditorText("draft now");
    expect(
      runtime.wantsInput({
        key: "up",
        ctrl: false,
        meta: false,
        shift: false,
      }),
    ).toBe(false);

    runtime.syncComposerFromEditor("draft now", 0);
    expect(
      runtime.wantsInput({
        key: "up",
        ctrl: false,
        meta: false,
        shift: false,
      }),
    ).toBe(true);

    await runtime.handleInput({
      key: "up",
      ctrl: false,
      meta: false,
      shift: false,
    });
    expect(runtime.ui.getEditorText()).toBe("second prompt");
    expect(runtime.getViewState().composer.cursor).toBe(0);

    await runtime.handleInput({
      key: "up",
      ctrl: false,
      meta: false,
      shift: false,
    });
    expect(runtime.ui.getEditorText()).toBe("first prompt");
    expect(runtime.getViewState().composer.cursor).toBe(0);

    runtime.syncComposerFromEditor("first prompt", "first prompt".length);
    await runtime.handleInput({
      key: "down",
      ctrl: false,
      meta: false,
      shift: false,
    });
    expect(runtime.ui.getEditorText()).toBe("second prompt");
    expect(runtime.getViewState().composer.cursor).toBe("second prompt".length);

    runtime.syncComposerFromEditor("second prompt", "second prompt".length);
    await runtime.handleInput({
      key: "down",
      ctrl: false,
      meta: false,
      shift: false,
    });
    expect(runtime.ui.getEditorText()).toBe("draft now");
    expect(runtime.getViewState().composer.cursor).toBe("draft now".length);

    runtime.dispose();
  });

  test("slash completion escape clears partial command text and reopens on next typed slash", async () => {
    const fixture = createFakeBundle();
    const { bundle } = fixture;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/qu");
    expect(runtime.getViewState().composer.completion).toMatchObject({
      trigger: "/",
      query: "qu",
    });

    // Escape on an incomplete "/command" clears the text entirely (opencode parity).
    await runtime.handleInput({
      key: "escape",
      ctrl: false,
      meta: false,
      shift: false,
    });
    expect(runtime.getViewState().composer.text).toBe("");
    expect(runtime.getViewState().composer.completion).toBeUndefined();

    fixture.emitSessionEvent({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "streaming while completion is dismissed" }],
        stopReason: "toolUse",
      },
    });
    expect(runtime.getViewState().composer.completion).toBeUndefined();

    // After clearing, the user can type a new slash command and completion reopens.
    runtime.ui.setEditorText("/qui");
    const afterReopen = runtime.getViewState().composer.completion;
    expect(afterReopen).toMatchObject({ trigger: "/", query: "qui" });
    // "/quit" is the best match for "qui" (prefix: 1000-4=996).
    expect(afterReopen?.items[0]).toMatchObject({ value: "quit" });

    runtime.dispose();
  });

  test("slash completion closes after a trailing space and path completion expands directories on tab", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/quit ");
    expect(runtime.getViewState().composer.completion).toBeUndefined();

    runtime.ui.setEditorText("@pack");
    const completion = runtime.getViewState().composer.completion;
    expect(completion).toMatchObject({
      trigger: "@",
    });

    const directoryIndex =
      completion?.items.findIndex(
        (item) => item.kind === "directory" && item.value === "packages/",
      ) ?? -1;
    expect(directoryIndex).toBeGreaterThanOrEqual(0);

    runtime.setCompletionSelection(directoryIndex);
    await runtime.handleInput({
      key: "tab",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.ui.getEditorText()).toBe("@packages/");
    expect(runtime.getViewState().composer.completion).toMatchObject({
      trigger: "@",
      query: "packages/",
    });

    runtime.dispose();
  });

  test("accepting path completion creates a file prompt part and restores it from persisted history", async () => {
    const promptRoot = mkdtempSync(join(tmpdir(), "brewva-cli-prompt-history-"));
    const promptStore = createCliShellPromptStore({ rootDir: promptRoot });
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
      promptStore,
    });

    try {
      runtime.ui.setEditorText("review @READ");
      const completion = runtime.getViewState().composer.completion;
      const fileIndex =
        completion?.items.findIndex((item) => item.kind === "file" && item.value === "README.md") ??
        -1;
      expect(fileIndex).toBeGreaterThanOrEqual(0);

      runtime.setCompletionSelection(fileIndex);
      await runtime.handleInput({
        key: "tab",
        ctrl: false,
        meta: false,
        shift: false,
      });

      expect(runtime.ui.getEditorText()).toBe("review @README.md");
      expect(runtime.getViewState().composer.parts).toEqual([
        {
          id: expect.any(String),
          type: "file",
          path: "README.md",
          source: {
            text: {
              start: 7,
              end: 17,
              value: "@README.md",
            },
          },
        },
      ]);

      await runtime.handleInput({
        key: "escape",
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
      expect(prompts).toEqual(["review @README.md"]);

      runtime.dispose();

      const restored = new CliShellRuntime(bundle, {
        cwd: process.cwd(),
        openSession: async () => bundle,
        createSession: async () => bundle,
        promptStore,
      });

      try {
        expect(
          restored.wantsInput({
            key: "up",
            ctrl: false,
            meta: false,
            shift: false,
          }),
        ).toBe(true);

        await restored.handleInput({
          key: "up",
          ctrl: false,
          meta: false,
          shift: false,
        });

        expect(restored.ui.getEditorText()).toBe("review @README.md");
        expect(restored.getViewState().composer.parts).toEqual([
          {
            id: expect.any(String),
            type: "file",
            path: "README.md",
            source: {
              text: {
                start: 7,
                end: 17,
                value: "@README.md",
              },
            },
          },
        ]);
      } finally {
        restored.dispose();
      }
    } finally {
      rmSync(promptRoot, { force: true, recursive: true });
    }
  });

  test("accepting agent completion creates an agent part and submits it as text", async () => {
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
      completionAgents: [{ agentId: "reviewer", description: "Code review agent" }],
    });

    runtime.ui.setEditorText("ask @rev");
    const completion = runtime.getViewState().composer.completion;
    expect(completion).toMatchObject({
      trigger: "@",
    });

    const agentIndex =
      completion?.items.findIndex((item) => item.kind === "agent" && item.value === "reviewer") ??
      -1;
    expect(agentIndex).toBeGreaterThanOrEqual(0);

    runtime.setCompletionSelection(agentIndex);
    await runtime.handleInput({
      key: "tab",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.ui.getEditorText()).toBe("ask @reviewer");
    expect(runtime.getViewState().composer.parts).toEqual([
      {
        id: expect.any(String),
        type: "agent",
        agentId: "reviewer",
        source: {
          text: {
            start: 4,
            end: "ask @reviewer".length,
            value: "@reviewer",
          },
        },
      },
    ]);

    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(prompts).toEqual(["ask @reviewer"]);
    runtime.dispose();
  });

  test("stashing the current prompt persists it and ctrl+y restores the latest stashed prompt", async () => {
    const promptRoot = mkdtempSync(join(tmpdir(), "brewva-cli-prompt-stash-"));
    const promptStore = createCliShellPromptStore({ rootDir: promptRoot });
    const { bundle } = createFakeBundle();

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      promptStore,
    });

    try {
      runtime.ui.setEditorText("stash @READ");
      const completion = runtime.getViewState().composer.completion;
      const fileIndex =
        completion?.items.findIndex((item) => item.kind === "file" && item.value === "README.md") ??
        -1;
      expect(fileIndex).toBeGreaterThanOrEqual(0);

      runtime.setCompletionSelection(fileIndex);
      await runtime.handleInput({
        key: "tab",
        ctrl: false,
        meta: false,
        shift: false,
      });

      await runtime.handleInput({
        key: "s",
        ctrl: true,
        meta: false,
        shift: false,
      });

      expect(runtime.ui.getEditorText()).toBe("");
      expect(runtime.getViewState().composer.parts).toEqual([]);
      expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
        level: "info",
        message: "Stashed prompt: stash @README.md. Press Ctrl+Y to restore the latest draft.",
      });

      runtime.dispose();

      const restored = new CliShellRuntime(bundle, {
        cwd: process.cwd(),
        openSession: async () => bundle,
        createSession: async () => bundle,
        promptStore,
      });

      try {
        await restored.handleInput({
          key: "y",
          ctrl: true,
          meta: false,
          shift: false,
        });

        expect(restored.ui.getEditorText()).toBe("stash @README.md");
        expect(restored.getViewState().composer.parts).toEqual([
          {
            id: expect.any(String),
            type: "file",
            path: "README.md",
            source: {
              text: {
                start: 6,
                end: 16,
                value: "@README.md",
              },
            },
          },
        ]);
        expect(restored.getViewState().notifications.at(-1)).toMatchObject({
          level: "info",
          message: "Restored stashed prompt: stash @README.md",
        });
      } finally {
        restored.dispose();
      }
    } finally {
      rmSync(promptRoot, { force: true, recursive: true });
    }
  });

  test("ctrl+y warns clearly when no stashed prompt is available", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await runtime.handleInput({
      key: "y",
      ctrl: true,
      meta: false,
      shift: false,
    });

    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "warning",
      message: "No stashed prompts yet. Press Ctrl+S to stash the current prompt first.",
    });

    runtime.dispose();
  });

  test("ctrl+s warns clearly when there is no prompt to stash", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await runtime.handleInput({
      key: "s",
      ctrl: true,
      meta: false,
      shift: false,
    });

    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "warning",
      message: "Nothing to stash yet. Type a prompt, then press Ctrl+S.",
    });

    runtime.dispose();
  });

  test("palette stash warns clearly when no stashed prompts are available", async () => {
    const promptRoot = mkdtempSync(join(tmpdir(), "brewva-cli-prompt-stash-empty-"));
    const promptStore = createCliShellPromptStore({ rootDir: promptRoot });
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      promptStore,
    });

    try {
      await runtime.start();
      await invokePaletteCommand(runtime, "composer.stash");

      expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
        level: "warning",
        message: "No stashed prompts yet. Press Ctrl+S to stash the current prompt first.",
      });
    } finally {
      runtime.dispose();
      rmSync(promptRoot, { force: true, recursive: true });
    }
  });

  test("serializes submit actions so rapid enter presses do not overlap prompts", async () => {
    let resolvePrompt: (() => void) | undefined;
    const prompts: string[] = [];
    const { bundle } = createFakeBundle({
      promptHandler: async (text) => {
        prompts.push(text);
        await new Promise<void>((resolve) => {
          resolvePrompt = resolve;
        });
      },
    });

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("ship it");
    const submitInput = {
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    } as const;

    const firstSubmit = runtime.handleInput(submitInput);
    const secondSubmit = runtime.handleInput(submitInput);

    await Bun.sleep(0);
    expect(prompts).toEqual(["ship it"]);
    resolvePrompt?.();
    await firstSubmit;
    await secondSubmit;
    expect(prompts).toEqual(["ship it"]);
    runtime.dispose();
  });

  test("records interactive rewind checkpoints with monotonic turn ids", async () => {
    const turnIds: string[] = [];
    const { bundle } = createFakeBundle();
    Object.assign(bundle.runtime.authority.session, {
      recordRewindCheckpoint(
        _sessionId: string,
        input: { turnId?: string },
      ): ReturnType<typeof bundle.runtime.authority.session.recordRewindCheckpoint> {
        turnIds.push(input.turnId ?? "");
        return {} as ReturnType<typeof bundle.runtime.authority.session.recordRewindCheckpoint>;
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
    Object.assign(bundle.runtime.authority.session, {
      redo(): ReturnType<typeof bundle.runtime.authority.session.redo> {
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

  test("surfaces session undo and redo as transcript notes and prompt status", async () => {
    const { bundle } = createFakeBundle();
    const session = bundle.session as unknown as {
      replaceMessages(messages: unknown[]): void;
      sessionManager: {
        branch?(entryId: string): void;
        branchWithSummary?(
          entryId: string,
          text: string,
          details: Record<string, unknown>,
          replace?: boolean,
        ): void;
      };
    };
    const branches: string[] = [];
    session.replaceMessages = () => {};
    session.sessionManager.branch = (entryId) => {
      branches.push(entryId);
    };
    session.sessionManager.branchWithSummary = (entryId) => {
      branches.push(entryId);
    };

    let undoAvailable = true;
    let redoAvailable = false;
    Object.assign(bundle.runtime.inspect.session, {
      getRewindState(): ReturnType<typeof bundle.runtime.inspect.session.getRewindState> {
        return {
          checkpoints: [],
          rewindAvailable: undoAvailable,
          redoAvailable,
          latestRewindable: undoAvailable
            ? ({
                checkpointId: "checkpoint-1",
              } as ReturnType<
                typeof bundle.runtime.inspect.session.getRewindState
              >["latestRewindable"])
            : undefined,
          nextRedoable: redoAvailable
            ? ({
                checkpointId: "checkpoint-1",
                returnLeafEntryId: "leaf-redo",
              } as ReturnType<typeof bundle.runtime.inspect.session.getRewindState>["nextRedoable"])
            : undefined,
          redoStack: [],
        };
      },
    });
    Object.assign(bundle.runtime.authority.session, {
      rewind(): ReturnType<typeof bundle.runtime.authority.session.rewind> {
        undoAvailable = false;
        redoAvailable = true;
        return {
          ok: true,
          checkpoint: {
            checkpointId: "checkpoint-1",
            turn: 1,
          } as ReturnType<typeof bundle.runtime.authority.session.rewind> extends infer T
            ? T extends { ok: true; checkpoint: infer C }
              ? C
              : never
            : never,
          reasoningRevert: {
            revertId: "revert-1",
            revertSequence: 1,
            toCheckpointId: "checkpoint-1",
            fromCheckpointId: null,
            fromBranchId: "branch-1",
            newBranchId: "branch-2",
            newBranchSequence: 2,
            targetLeafEntryId: "leaf-before",
            trigger: "operator_request",
            linkedRollbackReceiptIds: [],
            continuityPacket: { schema: "brewva.reasoning.continuity.v1", text: "Undo summary" },
            turn: 1,
            eventId: "revert-event-1",
            timestamp: 1,
          },
          abandonedCheckpointIds: [],
          patchSetIds: ["patch-1"],
          rollbackResults: [],
          restoredPrompt: { text: "fix this", parts: [] },
          returnLeafEntryId: "leaf-redo",
          trigger: "undo",
          mode: "both",
          summary: "carry",
        };
      },
      redo(): ReturnType<typeof bundle.runtime.authority.session.redo> {
        undoAvailable = true;
        redoAvailable = false;
        return {
          ok: true,
          checkpoint: {
            checkpointId: "checkpoint-1",
            turn: 1,
          } as ReturnType<typeof bundle.runtime.authority.session.redo> extends infer T
            ? T extends { ok: true; checkpoint: infer C }
              ? C
              : never
            : never,
          patchSetIds: ["patch-1"],
          redoResults: [],
          restoredPrompt: { text: "fix this", parts: [] },
          returnLeafEntryId: "leaf-redo",
          reasoningCheckpoint: {
            checkpointId: "reasoning-checkpoint-redo",
            checkpointSequence: 2,
            branchId: "branch-2",
            branchSequence: 2,
            parentCheckpointId: "checkpoint-1",
            boundary: "operator_marker",
            turn: 1,
            eventId: "reasoning-checkpoint-event-redo",
            timestamp: 2,
            leafEntryId: "leaf-redo",
          },
        };
      },
    });

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    expect(runtime.getViewState().status.entries.rewind).toBe("undo: /undo · rewind: /rewind");

    runtime.ui.setEditorText("/undo");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.ui.getEditorText()).toBe("fix this");
    expect(runtime.getViewState().status.entries.rewind).toBe("redo: /redo");
    expect(runtime.getViewState().transcript.messages.at(-1)).toMatchObject({
      role: "custom",
      parts: [
        {
          type: "text",
          text: expect.stringContaining("Use /redo to restore the undone turn."),
        },
      ],
    });

    runtime.ui.setEditorText("/redo");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(branches).toEqual(["leaf-before", "leaf-redo"]);
    expect(runtime.ui.getEditorText()).toBe("");
    expect(runtime.getViewState().status.entries.rewind).toBe("undo: /undo · rewind: /rewind");
    expect(runtime.getViewState().transcript.messages.at(-1)).toMatchObject({
      role: "custom",
      parts: [
        {
          type: "text",
          text: expect.stringContaining("Session redo applied"),
        },
      ],
    });
    runtime.dispose();
  });

  test("rewinds to a selected active checkpoint from the slash command", async () => {
    const { bundle } = createFakeBundle();
    const session = bundle.session as unknown as {
      replaceMessages(messages: unknown[]): void;
      sessionManager: {
        branch?(entryId: string): void;
        branchWithSummary?(
          entryId: string | null,
          text: string,
          details: Record<string, unknown>,
          replace?: boolean,
        ): void;
        getLeafId?(): string | null;
      };
    };
    const branches: string[] = [];
    const branchSummaries: Array<{
      entryId: string | null;
      text: string;
      details: Record<string, unknown>;
      replace?: boolean;
    }> = [];
    const rewinds: Array<{ checkpointId?: string; mode?: string; summary?: string }> = [];
    session.replaceMessages = () => {};
    session.sessionManager.getLeafId = () => "leaf-before";
    session.sessionManager.branch = (entryId) => {
      branches.push(entryId);
    };
    session.sessionManager.branchWithSummary = (entryId, text, details, replace) => {
      branchSummaries.push({ entryId, text, details, replace });
    };

    Object.assign(bundle.runtime.inspect.session, {
      listRewindTargets(): ReturnType<typeof bundle.runtime.inspect.session.listRewindTargets> {
        return [
          {
            checkpointId: "checkpoint-newer",
            turn: 2,
            timestamp: 200,
            promptPreview: "newer prompt",
            patchSetCountAfter: 1,
            fileSummary: { added: 0, modified: 1, deleted: 0 },
            lineage: { kind: "active" },
          },
          {
            checkpointId: "checkpoint-older",
            turn: 1,
            timestamp: 100,
            promptPreview: "older prompt",
            patchSetCountAfter: 2,
            fileSummary: { added: 1, modified: 0, deleted: 0 },
            lineage: { kind: "active" },
          },
        ];
      },
    });
    Object.assign(bundle.runtime.authority.session, {
      rewind(
        _sessionId: string,
        input: Parameters<typeof bundle.runtime.authority.session.rewind>[1],
      ): ReturnType<typeof bundle.runtime.authority.session.rewind> {
        rewinds.push({
          checkpointId: input?.checkpointId,
          mode: input?.mode,
          summary: input?.summary,
        });
        return {
          ok: true,
          checkpoint: {
            checkpointId: input?.checkpointId ?? "checkpoint-newer",
            turn: input?.checkpointId === "checkpoint-older" ? 1 : 2,
          } as ReturnType<typeof bundle.runtime.authority.session.rewind> extends infer T
            ? T extends { ok: true; checkpoint: infer C }
              ? C
              : never
            : never,
          abandonedCheckpointIds: [],
          patchSetIds: ["patch-1", "patch-2"],
          rollbackResults: [],
          divergenceNote: {
            kind: "conversation_ahead",
            text: "Conversation divergence: 2 patch set(s) were rewound.",
            patchSetCount: 2,
            parentLeafEntryId: "leaf-before",
          },
          restoredPrompt: { text: "older prompt body", parts: [] },
          returnLeafEntryId: "leaf-before",
          trigger: "rewind",
          mode: "code",
          summary: "none",
        };
      },
    });

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    runtime.ui.setEditorText("/rewind code -2");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(rewinds).toEqual([{ checkpointId: "checkpoint-older", mode: "code", summary: "none" }]);
    expect(branches).toEqual([]);
    expect(branchSummaries).toEqual([
      {
        entryId: "leaf-before",
        text: "Conversation divergence: 2 patch set(s) were rewound.",
        details: {
          schema: "brewva.session.rewind.divergence.v1",
          kind: "conversation_ahead",
          patchSetCount: 2,
          parentLeafEntryId: "leaf-before",
        },
        replace: true,
      },
    ]);
    expect(runtime.ui.getEditorText()).toBe("older prompt body");
    expect(runtime.getViewState().transcript.messages.at(-1)).toMatchObject({
      role: "custom",
      parts: [
        {
          type: "text",
          text: expect.stringContaining("Session rewind applied"),
        },
      ],
    });
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
    runtime.syncComposerFromEditor(text, text.length, [
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
    ]);

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

  test("groups assistant reasoning and tool execution updates into transcript parts", async () => {
    const fixture = createFakeBundle();
    const { bundle } = fixture;

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();

    const partialAssistantMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Inspect the file before editing." },
        { type: "text", text: "# Plan\n\n- inspect\n- patch" },
        {
          type: "toolCall",
          id: "tool-read-1",
          name: "read",
          arguments: { path: "src/app.ts", offset: 1, limit: 20 },
        },
      ],
      stopReason: "toolUse",
    };

    fixture.emitSessionEvent({
      ...createPromptMessageUpdateEvent({
        message: partialAssistantMessage,
        assistantMessageEvent: createToolcallEndAssistantEvent({
          contentIndex: 2,
          toolCall: partialAssistantMessage.content[2] as BrewvaPromptToolCall,
          partial: partialAssistantMessage,
        }),
      }),
    });
    fixture.emitSessionEvent({
      type: "tool_execution_update",
      toolCallId: "tool-read-1",
      toolName: "read",
      args: { path: "src/app.ts", offset: 1, limit: 20 },
      partialResult: {
        content: [{ type: "text", text: "const value = 1;" }],
        details: { phase: "partial" },
      },
    });
    fixture.emitSessionEvent({
      type: "tool_execution_end",
      toolCallId: "tool-read-1",
      toolName: "read",
      result: {
        content: [{ type: "text", text: "const value = 1;\nconst next = 2;" }],
        details: { lines: 2 },
      },
      isError: false,
    });
    fixture.emitSessionEvent({
      type: "message_end",
      message: partialAssistantMessage,
    });
    fixture.emitSessionEvent({
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "tool-read-1",
        toolName: "read",
        content: [{ type: "text", text: "const value = 1;\nconst next = 2;" }],
        details: { lines: 2 },
        isError: false,
      },
    });

    expect(runtime.getViewState().transcript.messages).toHaveLength(1);
    expect(runtime.getViewState().transcript.messages[0]).toMatchObject({
      role: "assistant",
      parts: [
        { type: "reasoning", text: "Inspect the file before editing." },
        { type: "text", text: "# Plan\n\n- inspect\n- patch" },
        {
          type: "tool",
          toolCallId: "tool-read-1",
          toolName: "read",
          status: "completed",
          result: {
            details: { lines: 2 },
          },
        },
      ],
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

  test("inspect overlays drill down into a pager and restore inspect on close", async () => {
    const { bundle } = createFakeBundle();

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.openOverlay({
      kind: "inspect",
      lines: ["inspect detail text"],
      sections: [
        {
          id: "summary",
          title: "Summary",
          lines: ["Session: session-1", "Workspace: /tmp/workspace"],
        },
        {
          id: "analysis",
          title: "Analysis",
          lines: ["Outcome: pass", "Missing checks: none"],
        },
      ],
      selectedIndex: 1,
      scrollOffsets: [0, 0],
    });

    const consumedEnter = await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(consumedEnter).toBe(true);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "pager",
      title: "Analysis",
      lines: ["Outcome: pass", "Missing checks: none"],
      scrollOffset: 0,
    });

    const consumedEscape = await runtime.handleInput({
      key: "escape",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(consumedEscape).toBe(true);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "inspect",
      selectedIndex: 1,
    });
    runtime.dispose();
  });

  test("task overlays drill down into run output, artifact refs, and worker session hints", async () => {
    const { bundle } = createFakeBundle({
      sessionWireBySessionId: {
        "worker-session-1": [
          {
            schema: "brewva.session-wire.v2",
            sessionId: asBrewvaSessionId("worker-session-1"),
            frameId: "frame-1",
            ts: Date.now(),
            source: "replay",
            durability: "durable",
            type: "turn.committed",
            turnId: "turn-1",
            attemptId: "attempt-1",
            status: "completed",
            assistantText: "QA summary line\nFound stale contract drift.",
            toolOutputs: [
              {
                toolCallId: asBrewvaToolCallId("tool-1"),
                toolName: asBrewvaToolName("exec"),
                verdict: "pass",
                isError: false,
                text: "bun test\n1775 pass",
              },
            ],
          },
        ],
      },
    });

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.openOverlay({
      kind: "tasks",
      selectedIndex: 0,
      snapshot: {
        approvals: [],
        questions: [],
        taskRuns: [
          {
            contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
            runId: "run-1",
            delegate: "worker-1",
            executionPrimitive: "named",
            visibility: "public",
            isolationStrategy: "shared",
            adoption: {
              contractId: "cli-overlay-test",
              decision: "require_human",
              reason: "Fixture record has not reached parent adoption.",
            },
            parentSessionId: asBrewvaSessionId("session-1"),
            status: "completed",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            label: "Review operator state",
            workerSessionId: asBrewvaSessionId("worker-session-1"),
            summary: "Collected output summary",
            resultData: {
              verdict: "pass",
              checks: [{ name: "unit", status: "pass" }],
            },
            artifactRefs: [
              {
                kind: "patch",
                path: ".orchestrator/subagent-runs/run-1/patch.diff",
                summary: "Suggested patch",
              },
            ],
            error: undefined,
            delivery: {
              mode: "supplemental",
              handoffState: "surfaced",
            },
            totalTokens: 321,
            costUsd: 0.0123,
          },
        ],
        sessions: [],
      },
    });

    const consumedEnter = await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(consumedEnter).toBe(true);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "pager",
      title: "Task run-1 output",
    });

    const pagerPayload = runtime.getViewState().overlay.active?.payload;
    expect(pagerPayload && pagerPayload.kind === "pager" ? pagerPayload.lines : []).toEqual(
      expect.arrayContaining([
        "workerSessionRecentOutput:",
        "  assistant:",
        "    QA summary line",
        "    Found stale contract drift.",
        "  toolOutputs:",
        "    - exec [pass]",
        "      bun test",
        "workerSessionId: worker-session-1",
        "summary: Collected output summary",
        "delivery: supplemental / surfaced",
        "artifactRefs:",
        "  - patch: .orchestrator/subagent-runs/run-1/patch.diff :: Suggested patch",
        "resultData:",
        '    "verdict": "pass",',
      ]),
    );

    runtime.dispose();
  });

  test("notifications open as an inbox, drill into pager details, and support dismiss", async () => {
    const { bundle } = createFakeBundle();

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.notify("older notification", "info");
    runtime.ui.notify("latest notification", "warning");

    const consumedOpen = await runtime.handleInput({
      key: "n",
      ctrl: true,
      meta: false,
      shift: false,
    });

    expect(consumedOpen).toBe(true);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "inbox",
      selectedIndex: 0,
    });

    const consumedDown = await runtime.handleInput({
      key: "down",
      ctrl: false,
      meta: false,
      shift: false,
    });
    expect(consumedDown).toBe(true);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "inbox",
      selectedIndex: 1,
    });

    const consumedUp = await runtime.handleInput({
      key: "up",
      ctrl: false,
      meta: false,
      shift: false,
    });
    expect(consumedUp).toBe(true);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "inbox",
      selectedIndex: 0,
    });

    const consumedEnter = await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(consumedEnter).toBe(true);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "pager",
      title: "Notification [warning]",
    });

    await runtime.handleInput({
      key: "escape",
      ctrl: false,
      meta: false,
      shift: false,
    });

    const consumedDismiss = await runtime.handleInput({
      key: "character",
      text: "d",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(consumedDismiss).toBe(true);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "inbox",
      selectedIndex: 0,
    });
    const notificationsPayload = runtime.getViewState().overlay.active?.payload;
    expect(
      notificationsPayload && notificationsPayload.kind === "inbox"
        ? notificationsPayload.notifications.map((notification) => notification.message)
        : [],
    ).toEqual(["older notification"]);
    runtime.dispose();
  });

  test("pager context routes Ctrl-E to the external pager instead of the global editor shortcut", async () => {
    const { bundle } = createFakeBundle();
    const pagerCalls: Array<{ title: string; lines: readonly string[] }> = [];
    const editorCalls: Array<{ title: string; prefill?: string }> = [];

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      async openExternalEditor(title, prefill) {
        editorCalls.push({ title, prefill });
        return prefill;
      },
      async openExternalPager(title, lines) {
        pagerCalls.push({ title, lines });
        return true;
      },
    });

    runtime.openOverlay({
      kind: "pager",
      title: "Task run-1 output",
      lines: ["line-1", "line-2"],
      scrollOffset: 0,
    });

    const consumed = await runtime.handleInput({
      key: "e",
      ctrl: true,
      meta: false,
      shift: false,
    });

    expect(consumed).toBe(true);
    expect(pagerCalls).toEqual([
      {
        title: "Task run-1 output",
        lines: ["line-1", "line-2"],
      },
    ]);
    expect(editorCalls).toEqual([]);
    runtime.dispose();
  });

  test("Ctrl-E opens the external pager for inspect overlays before falling back to the editor", async () => {
    const { bundle } = createFakeBundle();
    const pagerCalls: Array<{ title: string; lines: readonly string[] }> = [];
    const editorCalls: Array<{ title: string; prefill?: string }> = [];

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      async openExternalEditor(title, prefill) {
        editorCalls.push({ title, prefill });
        return prefill;
      },
      async openExternalPager(title, lines) {
        pagerCalls.push({ title, lines });
        return true;
      },
    });

    runtime.openOverlay({
      kind: "inspect",
      lines: ["inspect detail text"],
      sections: [
        {
          id: "summary",
          title: "Summary",
          lines: ["Session: session-1", "Workspace: /tmp/workspace"],
        },
        {
          id: "analysis",
          title: "Analysis",
          lines: ["Outcome: pass", "Missing checks: none"],
        },
      ],
      selectedIndex: 1,
      scrollOffsets: [0, 0],
    });

    const consumed = await runtime.handleInput({
      key: "e",
      ctrl: true,
      meta: false,
      shift: false,
    });

    expect(consumed).toBe(true);
    expect(pagerCalls).toEqual([
      {
        title: "Analysis",
        lines: ["Outcome: pass", "Missing checks: none"],
      },
    ]);
    expect(editorCalls).toEqual([]);
    runtime.dispose();
  });

  test("session switching preserves drafts per session and restores them when returning", async () => {
    const replaySessions = [
      {
        sessionId: asBrewvaSessionId("session-1"),
        eventCount: 14,
        lastEventAt: 1_710_000_000_000,
      },
      {
        sessionId: asBrewvaSessionId("session-2"),
        eventCount: 9,
        lastEventAt: 1_710_000_100_000,
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
      },
      {
        sessionId: asBrewvaSessionId("session-2"),
        eventCount: 9,
        lastEventAt: 1_710_000_100_000,
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
    expect(runtime.getViewState().overlay.active).toBeUndefined();
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
