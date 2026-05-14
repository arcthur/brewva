import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import {
  asBrewvaSessionId,
  asBrewvaToolCallId,
  asBrewvaToolName,
} from "@brewva/brewva-runtime/core";
import { CURRENT_DELEGATION_CONTRACT_VERSION } from "@brewva/brewva-runtime/delegation";
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
import {
  createPromptMessageUpdateEvent,
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

describe("shell runtime: error surfaces and overlays", () => {
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

  test("Kimi connect flow selects platform before accepting pasted API keys", async () => {
    const providers: ProviderConnectionDescriptor[] = [
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

  test("transcript snapshot command opens the external pager via the runtime hook", async () => {
    const { bundle } = createFakeBundle({
      transcriptSeed: [
        {
          role: "user",
          content: [{ type: "text", text: "Show the current plan." }],
        },
      ],
    });
    const transcriptPagerCalls: number[] = [];
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      async openExternalTranscriptPager() {
        transcriptPagerCalls.push(1);
        return true;
      },
    });

    const handled = await invokePaletteCommand(runtime, "session.transcript");

    expect(handled).toBe(true);
    expect(transcriptPagerCalls).toEqual([1]);
    runtime.dispose();
  });

  test("transcript snapshot command warns when the transcript pager is unavailable", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      async openExternalTranscriptPager() {
        return false;
      },
    });

    const handled = await invokePaletteCommand(runtime, "session.transcript");

    expect(handled).toBe(true);
    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "warning",
      message: "No external pager is available for the current shell.",
    });
    runtime.dispose();
  });
});
