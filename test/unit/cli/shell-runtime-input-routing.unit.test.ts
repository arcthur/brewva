import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import { asBrewvaToolCallId, asBrewvaToolName } from "@brewva/brewva-runtime/core";
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
import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import { CliShellRuntime } from "../../../packages/brewva-cli/src/shell/controller/shell-runtime.js";
import type {
  ProviderAuthMethod,
  ProviderConnectionDescriptor,
  ProviderOAuthAuthorization,
} from "../../../packages/brewva-cli/src/shell/domain/overlays/payloads.js";
import { createCliShellPromptStore } from "../../../packages/brewva-cli/src/shell/domain/prompt-store.js";
import type { CliShellSessionBundle } from "../../../packages/brewva-cli/src/shell/ports/session-port.js";

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

function requireDefined<T>(value: T | null | undefined, label: string): T {
  if (value == null) {
    throw new Error(`${label} must be available for this test`);
  }
  return value;
}

function createTestToolDefinition(input: {
  name: string;
  requiredCapabilities?: readonly string[];
}): BrewvaToolDefinition {
  return {
    name: input.name,
    label: input.name,
    description: `${input.name} test tool`,
    parameters: {},
    brewva: input.requiredCapabilities
      ? {
          surface: "workflow",
          actionClass: "inspect",
          requiredCapabilities: input.requiredCapabilities,
        }
      : undefined,
    async execute() {
      return { content: [{ type: "text", text: "ok" }] };
    },
  } as unknown as BrewvaToolDefinition;
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
    abortHandler?: () => Promise<void>;
    modelPresetState?: BrewvaModelPresetState;
    isStreaming?: boolean;
    toolDefinitions?: ReadonlyMap<string, BrewvaToolDefinition>;
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
    async abort() {
      await options.abortHandler?.();
    },
    dispose() {},
    setUiPort(ui: BrewvaToolUiPort) {
      attachedUi = ui;
    },
  };

  const bundle = {
    session,
    toolDefinitions: options.toolDefinitions ?? new Map(),
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

describe("shell runtime: input routing", () => {
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
        "Use /inbox in the interactive shell; /questions remains a headless extension command.",
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

  test("context slash opens a read-only context overlay and context compact redirects there", async () => {
    const prompts: string[] = [];
    const fixture = createFakeBundle({
      promptHandler: async (text) => {
        prompts.push(text);
      },
    });
    const { bundle } = fixture;
    let compactionRequests = 0;
    Object.assign(bundle.runtime.operator.context.compaction, {
      request() {
        compactionRequests += 1;
      },
    });

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/context");
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });

    expect(prompts).toEqual([]);
    expect(compactionRequests).toBe(0);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({ kind: "context" });

    await runtime.handleInput({ key: "escape", ctrl: false, meta: false, shift: false });
    runtime.ui.setEditorText("/context compact");
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });

    expect(prompts).toEqual([]);
    expect(compactionRequests).toBe(0);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({ kind: "context" });
    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "warning",
      message: expect.stringContaining("Request compaction"),
    });

    runtime.dispose();
  });

  test("context request compaction palette action uses the existing runtime request path", async () => {
    const fixture = createFakeBundle();
    const { bundle } = fixture;
    const compactionRequests: Array<{ sessionId: string; reason: string }> = [];
    Object.assign(bundle.runtime.operator.context.compaction, {
      request(sessionId: string, reason: string) {
        compactionRequests.push({ sessionId, reason });
      },
    });

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await invokePaletteCommand(runtime, "context.requestCompaction");

    expect(compactionRequests).toEqual([{ sessionId: "session-1", reason: "manual" }]);
    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "info",
      message: "Context compaction requested.",
    });

    runtime.dispose();
  });

  test("authority and rejected authority/review slash names never submit prompts", async () => {
    const prompts: string[] = [];
    const accessChecks: string[] = [];
    const { bundle } = createFakeBundle({
      promptHandler: async (text) => {
        prompts.push(text);
      },
      toolDefinitions: new Map([
        [
          "exec",
          createTestToolDefinition({
            name: "exec",
            requiredCapabilities: ["authority.tools.invocation.start"],
          }),
        ],
      ]),
    });
    Object.assign(bundle.runtime.inspect.tools.access, {
      explain(input: { toolName: string }) {
        accessChecks.push(input.toolName);
        return {
          allowed: true,
          warning: "write requires approval",
        };
      },
    });
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/authority");
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });

    expect(prompts).toEqual([]);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({ kind: "authority" });
    expect(accessChecks).toEqual(["exec"]);
    const authorityPayload = runtime.getViewState().overlay.active?.payload;
    if (authorityPayload?.kind !== "authority") {
      throw new Error("authority overlay must be active");
    }
    const authorityText = authorityPayload.lines.join("\n");
    expect(authorityText).toContain("required=authority.tools.invocation.start");
    expect(authorityText).toContain("exec allowed=true warning=write requires approval");

    await runtime.handleInput({ key: "escape", ctrl: false, meta: false, shift: false });
    const redirects = [
      ["/compact", "context"],
      ["/permissions", "authority"],
      ["/review", "skills"],
      ["/security-review", "skills"],
    ] as const;
    for (const [slash, overlayKind] of redirects) {
      runtime.ui.setEditorText(slash);
      await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });
      expect(prompts).toEqual([]);
      expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
        level: "warning",
      });
      expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
        kind: overlayKind,
      });
      await runtime.handleInput({ key: "escape", ctrl: false, meta: false, shift: false });
    }

    runtime.dispose();
  });

  test("skills slash opens a skill catalog and review remains skill-discoverable only", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/skills");
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({ kind: "skills" });
    await runtime.handleInput({ key: "escape", ctrl: false, meta: false, shift: false });
    runtime.ui.setEditorText("/");
    expect(
      runtime.getViewState().composer.completion?.items.map((item) => item.value),
    ).not.toContain("review");

    runtime.dispose();
  });

  test("copy slash copies the latest assistant answer as markdown", async () => {
    const copied: string[] = [];
    const fixture = createFakeBundle({
      transcriptSeed: [
        { role: "user", content: [{ type: "text", text: "Question" }] },
        { role: "assistant", content: [{ type: "text", text: "Answer body" }] },
      ],
    });
    const runtime = new CliShellRuntime(fixture.bundle, {
      cwd: process.cwd(),
      openSession: async () => fixture.bundle,
      createSession: async () => fixture.bundle,
      copyTextToClipboard: async (text) => {
        copied.push(text);
      },
    });
    await runtime.start();

    runtime.ui.setEditorText("/copy");
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });

    expect(copied).toEqual(["Answer body"]);

    runtime.dispose();
  });

  test("copy slash warns when no assistant answer exists", async () => {
    const copied: string[] = [];
    const fixture = createFakeBundle({
      transcriptSeed: [{ role: "user", content: [{ type: "text", text: "Question" }] }],
    });
    const runtime = new CliShellRuntime(fixture.bundle, {
      cwd: process.cwd(),
      openSession: async () => fixture.bundle,
      createSession: async () => fixture.bundle,
      copyTextToClipboard: async (text) => {
        copied.push(text);
      },
    });
    await runtime.start();

    runtime.ui.setEditorText("/copy");
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });

    expect(copied).toEqual([]);
    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "warning",
      message: "No assistant answer is available to copy.",
    });

    runtime.dispose();
  });

  test("diff slash opens git diagnostics with replay attribution instead of submitting a prompt", async () => {
    const prompts: string[] = [];
    const pagers: Array<{ title: string; lines: readonly string[] }> = [];
    const cwd = mkdtempSync(join(tmpdir(), "brewva-shell-diff-"));
    const { bundle } = createFakeBundle({
      promptHandler: async (text) => {
        prompts.push(text);
      },
    });
    const runtime = new CliShellRuntime(bundle, {
      cwd,
      openSession: async () => bundle,
      createSession: async () => bundle,
      openExternalPager: async (title, lines) => {
        pagers.push({ title, lines });
        return true;
      },
    });

    runtime.ui.setEditorText("/diff");
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });

    expect(prompts).toEqual([]);
    expect(pagers).toHaveLength(1);
    expect(pagers[0]?.title).toBe("Brewva diff");
    const text = pagers[0]?.lines.join("\n") ?? "";
    expect(text).toContain("## Git status");
    expect(text).toContain("Unavailable:");
    expect(text).toContain("## Brewva turn attribution");

    runtime.dispose();
    rmSync(cwd, { recursive: true, force: true });
  });

  test("diff slash bounds large git output before pager rendering", async () => {
    const pagers: Array<{ title: string; lines: readonly string[] }> = [];
    const cwd = mkdtempSync(join(tmpdir(), "brewva-shell-large-diff-"));
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    writeFileSync(
      join(cwd, "large.txt"),
      Array.from({ length: 6_100 }, (_, index) => `before ${index} ${"x".repeat(48)}`).join("\n"),
      "utf8",
    );
    execFileSync("git", ["add", "large.txt"], { cwd, stdio: "ignore" });
    writeFileSync(
      join(cwd, "large.txt"),
      Array.from({ length: 6_100 }, (_, index) => `after ${index} ${"y".repeat(48)}`).join("\n"),
      "utf8",
    );
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd,
      openSession: async () => bundle,
      createSession: async () => bundle,
      openExternalPager: async (title, lines) => {
        pagers.push({ title, lines });
        return true;
      },
    });

    runtime.ui.setEditorText("/diff");
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });

    expect(pagers).toHaveLength(1);
    expect(pagers[0]?.lines.some((line) => line.includes("... truncated after"))).toBe(true);
    expect(pagers[0]?.lines.length ?? 0).toBeLessThan(5_200);

    runtime.dispose();
    rmSync(cwd, { recursive: true, force: true });
  });

  test("patch evidence palette emits attribution and diff stat without full diff text", async () => {
    const pagers: Array<{ title: string; lines: readonly string[] }> = [];
    const cwd = mkdtempSync(join(tmpdir(), "brewva-shell-patch-evidence-"));
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd,
      openSession: async () => bundle,
      createSession: async () => bundle,
      openExternalPager: async (title, lines) => {
        pagers.push({ title, lines });
        return true;
      },
    });

    const handled = await invokePaletteCommand(runtime, "diff.exportPatchEvidence");

    expect(handled).toBe(true);
    expect(pagers).toHaveLength(1);
    expect(pagers[0]?.title).toBe("Brewva patch evidence");
    const text = pagers[0]?.lines.join("\n") ?? "";
    expect(text).toContain("## Brewva turn attribution");
    expect(text).toContain("## Git diff stat");
    expect(text).not.toMatch(/^## Git diff$/m);

    runtime.dispose();
    rmSync(cwd, { recursive: true, force: true });
  });

  test("export slash opens a session handoff bundle with inspect, transcript, and patch evidence", async () => {
    const pagers: Array<{ title: string; lines: readonly string[] }> = [];
    const cwd = mkdtempSync(join(tmpdir(), "brewva-shell-export-"));
    const fixture = createFakeBundle({
      transcriptSeed: [
        { role: "user", content: [{ type: "text", text: "Question" }] },
        { role: "assistant", content: [{ type: "text", text: "Answer body" }] },
      ],
    });
    const runtime = new CliShellRuntime(fixture.bundle, {
      cwd,
      openSession: async () => fixture.bundle,
      createSession: async () => fixture.bundle,
      openExternalPager: async (title, lines) => {
        pagers.push({ title, lines });
        return true;
      },
    });
    await runtime.start();

    runtime.ui.setEditorText("/export");
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });

    expect(pagers).toHaveLength(1);
    expect(pagers[0]?.title).toBe("Brewva session export");
    const text = pagers[0]?.lines.join("\n") ?? "";
    expect(text).toContain("# Brewva Session Handoff Bundle");
    expect(text).toContain("## Inspect Report");
    expect(text).toContain("## Transcript Markdown");
    expect(text).toContain("Answer body");
    expect(text).toContain("## Patch Evidence");

    runtime.dispose();
    rmSync(cwd, { recursive: true, force: true });
  });

  test("init slash opens a read-only project guidance preview", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("/init");
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });

    const payload = runtime.getViewState().overlay.active?.payload;
    expect(payload).toMatchObject({
      kind: "pager",
      title: "Brewva project guidance preview",
    });
    if (payload?.kind !== "pager") {
      throw new Error("init preview must open a pager overlay");
    }
    expect(payload.lines.join("\n")).toContain(
      "This preview is read-only and assembled from the current workspace.",
    );
    expect(payload.lines.join("\n")).toContain("## Verification commands");
    expect(payload.lines.join("\n")).toContain("no verification scripts found");

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
    expect(slashValues).toContain("lineage");
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

  test("escape aborts the active streaming turn from the composer context", async () => {
    let abortCount = 0;
    const { bundle } = createFakeBundle({
      isStreaming: true,
      async abortHandler() {
        abortCount += 1;
      },
    });

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await runtime.handleInput({
      key: "escape",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(abortCount).toBe(1);
    expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
      level: "warning",
      message: "Aborted the current turn.",
    });

    runtime.dispose();
  });

  test("ctrl+c abort-or-exit accepts modified OpenTUI key names", async () => {
    let abortCount = 0;
    const { bundle } = createFakeBundle({
      isStreaming: true,
      async abortHandler() {
        abortCount += 1;
      },
    });

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await runtime.handleInput({
      key: "ctrl+c",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(abortCount).toBe(1);

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
    expect(runtime.getViewState().overlay.active).toBe(undefined);

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
    expect(runtime.getViewState().overlay.active).toBe(undefined);

    runtime.dispose();
  });

  test("picker backspace on an empty query does not rebuild the active overlay", async () => {
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

  test("provider connect flow warns when a provider exposes no in-TUI auth methods", async () => {
    const providers: ProviderConnectionDescriptor[] = [
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
    const providers: ProviderConnectionDescriptor[] = [
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
    const providers: ProviderConnectionDescriptor[] = [
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
    const providers: ProviderConnectionDescriptor[] = [
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
    const providers: ProviderConnectionDescriptor[] = [
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
    const providers: ProviderConnectionDescriptor[] = [
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
    const toolUi = requireDefined(ui, "attached tool UI");

    const submission = toolUi.custom<readonly (readonly string[])[] | undefined>(
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
    expect(runtime.getViewState().overlay.active).toBe(undefined);
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
    const toolUi = requireDefined(ui, "attached tool UI");

    const submission = toolUi.custom<readonly (readonly string[])[] | undefined>(
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
    expect(runtime.getViewState().overlay.active).toBe(undefined);
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
    const toolUi = requireDefined(ui, "attached tool UI");
    const abortController = new AbortController();

    const pending = toolUi.custom<readonly (readonly string[])[] | undefined>(
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

    expect(await pending).toBe(undefined);
    expect(runtime.getViewState().overlay.active).toBe(undefined);
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
    const toolUi = requireDefined(ui, "attached tool UI");

    const pending = toolUi.custom<readonly (readonly string[])[] | undefined>("question", {
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

    await runtime.handleInput({ type: "session.open", sessionId: "session-2" });

    expect(await pending).toBe(undefined);
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
    expect(initialCompletion?.items[0]?.value).toMatch(/in/u);
    const selectedSecondItem = requireDefined(secondItem, "second completion item");

    await runtime.handleInput({
      key: "down",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(runtime.getViewState().composer.completion?.items.at(1)).toEqual(selectedSecondItem);
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

    await runtime.handleInput({
      type: "composer.editorSync",
      text: "draft now",
      cursor: 0,
    });
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

    await runtime.handleInput({
      type: "composer.editorSync",
      text: "first prompt",
      cursor: "first prompt".length,
    });
    await runtime.handleInput({
      key: "down",
      ctrl: false,
      meta: false,
      shift: false,
    });
    expect(runtime.ui.getEditorText()).toBe("second prompt");
    expect(runtime.getViewState().composer.cursor).toBe("second prompt".length);

    await runtime.handleInput({
      type: "composer.editorSync",
      text: "second prompt",
      cursor: "second prompt".length,
    });
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
    expect(runtime.getViewState().composer.completion).toBe(undefined);

    fixture.emitSessionEvent({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "streaming while completion is dismissed" }],
        stopReason: "toolUse",
      },
    });
    expect(runtime.getViewState().composer.completion).toBe(undefined);

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
    expect(runtime.getViewState().composer.completion).toBe(undefined);

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

    await runtime.handleInput({ type: "completion.select", index: directoryIndex });
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

      await runtime.handleInput({ type: "completion.select", index: fileIndex });
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

    await runtime.handleInput({ type: "completion.select", index: agentIndex });
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

      await runtime.handleInput({ type: "completion.select", index: fileIndex });
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
    Object.assign(bundle.runtime.inspect.session.rewind, {
      getState(): ReturnType<typeof bundle.runtime.inspect.session.rewind.getState> {
        return {
          checkpoints: [],
          rewindAvailable: undoAvailable,
          redoAvailable,
          latestRewindable: undoAvailable
            ? ({
                checkpointId: "checkpoint-1",
              } as ReturnType<
                typeof bundle.runtime.inspect.session.rewind.getState
              >["latestRewindable"])
            : undefined,
          nextRedoable: redoAvailable
            ? ({
                checkpointId: "checkpoint-1",
                returnLeafEntryId: "leaf-redo",
              } as ReturnType<
                typeof bundle.runtime.inspect.session.rewind.getState
              >["nextRedoable"])
            : undefined,
          redoStack: [],
        };
      },
    });
    Object.assign(bundle.runtime.authority.session.rewind, {
      rewind(): ReturnType<typeof bundle.runtime.authority.session.rewind.rewind> {
        undoAvailable = false;
        redoAvailable = true;
        return {
          ok: true,
          checkpoint: {
            checkpointId: "checkpoint-1",
            turn: 1,
          } as ReturnType<typeof bundle.runtime.authority.session.rewind.rewind> extends infer T
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
      redo(): ReturnType<typeof bundle.runtime.authority.session.rewind.redo> {
        undoAvailable = true;
        redoAvailable = false;
        return {
          ok: true,
          checkpoint: {
            checkpointId: "checkpoint-1",
            turn: 1,
          } as ReturnType<typeof bundle.runtime.authority.session.rewind.redo> extends infer T
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

    Object.assign(bundle.runtime.inspect.session.rewind, {
      listTargets(): ReturnType<typeof bundle.runtime.inspect.session.rewind.listTargets> {
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
    Object.assign(bundle.runtime.authority.session.rewind, {
      rewind(
        _sessionId: string,
        input: Parameters<typeof bundle.runtime.authority.session.rewind.rewind>[1],
      ): ReturnType<typeof bundle.runtime.authority.session.rewind.rewind> {
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
          } as ReturnType<typeof bundle.runtime.authority.session.rewind.rewind> extends infer T
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
});
