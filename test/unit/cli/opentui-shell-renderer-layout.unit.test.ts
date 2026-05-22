import { describe, expect, test } from "bun:test";
import {
  asBrewvaSessionId,
  asBrewvaToolCallId,
  asBrewvaToolName,
} from "@brewva/brewva-runtime/core";
import {
  CURRENT_DELEGATION_CONTRACT_VERSION,
  type DelegationRunRecord,
} from "@brewva/brewva-runtime/protocol";
import { type BrewvaReplaySession } from "@brewva/brewva-runtime/protocol";
import type { SessionWireFrame } from "@brewva/brewva-runtime/protocol";
import type { BrewvaToolUiPort } from "@brewva/brewva-substrate/host-api";
import type {
  BrewvaPromptSessionEvent,
  BrewvaQueuedPromptView,
  BrewvaSessionModelDescriptor,
} from "@brewva/brewva-substrate/session";
import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import { createTestRenderer } from "@opentui/core/testing";
import {
  createOpenTuiRoot,
  createOpenTuiSolidElement,
  openTuiSolidAct,
  openTuiSolidTestRender,
} from "../../../packages/brewva-cli/runtime/internal-opentui-runtime.js";
import { BrewvaOpenTuiShell } from "../../../packages/brewva-cli/runtime/opentui-shell-renderer.js";
import { resolveDiffView } from "../../../packages/brewva-cli/runtime/shell/diff-view.js";
import {
  resolveDialogContentWidth,
  resolveDialogSurfaceDimensions,
  resolveDialogWidth,
  resolveHighDensityPickerRows,
  resolveSkillsPickerRows,
  resolveToastMaxWidth,
} from "../../../packages/brewva-cli/runtime/shell/overlay-style.js";
import { CliShellRuntime } from "../../../packages/brewva-cli/src/shell/controller/shell-runtime.js";
import type {
  ProviderAuthMethod,
  ProviderConnectionDescriptor,
  ProviderOAuthAuthorization,
} from "../../../packages/brewva-cli/src/shell/domain/overlays/payloads.js";
import type { CliShellSessionBundle } from "../../../packages/brewva-cli/src/shell/ports/session-port.js";
function createFakeBundle(
  options: {
    approvals?: number;
    models?: BrewvaSessionModelDescriptor[];
    availableModelKeys?: string[];
    seedMessages?: unknown[];
    queuedPrompts?: BrewvaQueuedPromptView[];
    sessionId?: string;
    replaySessions?: BrewvaReplaySession[];
    sessionWireBySessionId?: Record<string, SessionWireFrame[]>;
    taskRuns?: DelegationRunRecord[];
    toolDefinitions?: Map<string, BrewvaToolDefinition>;
    providers?: ProviderConnectionDescriptor[];
    authMethods?: Record<string, ProviderAuthMethod[]>;
    authorizeOAuth?: (
      provider: string,
      methodId: string,
      inputs?: Record<string, string>,
    ) => Promise<ProviderOAuthAuthorization | undefined>;
    completeOAuth?: (provider: string, methodId: string, code?: string) => Promise<void>;
  } = {},
) {
  let attachedUi: BrewvaToolUiPort | undefined;
  let sessionListener: ((event: BrewvaPromptSessionEvent) => void) | undefined;
  let queuedPrompts = [...(options.queuedPrompts ?? [])];
  const approvals = Array.from({ length: options.approvals ?? 0 }, (_, index) => ({
    requestId: `approval-${index + 1}`,
    proposalId: `proposal-${index + 1}`,
    toolName: "write_file",
    toolCallId: `tool-call-${index + 1}`,
    subject: `write file ${index + 1}`,
    boundary: "effectful",
    effects: ["workspace_write"],
    argsDigest: `digest-${index + 1}`,
    evidenceRefs: [],
    turn: index + 1,
    createdAt: Date.now(),
  }));
  const sessionId = options.sessionId ?? "session-1";
  const modelKey = (model: Pick<BrewvaSessionModelDescriptor, "provider" | "id">) =>
    `${model.provider}/${model.id}`;
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
  let diffPreferences: { style: "auto" | "stacked"; wrapMode: "word" | "none" } = {
    style: "auto",
    wrapMode: "word",
  };
  let shellViewPreferences = {
    showThinking: true,
    toolDetails: true,
  };
  const replaySessions = options.replaySessions ?? [
    {
      sessionId,
      eventCount: 1,
      lastEventAt: Date.now(),
      title: "New session",
    },
  ];

  const session = {
    get model() {
      return currentModel;
    },
    get thinkingLevel() {
      return thinkingLevel;
    },
    modelRegistry: {
      getAll() {
        return allModels;
      },
      getAvailable() {
        return allModels.filter((model) => availableModelKeys.has(modelKey(model)));
      },
    },
    isStreaming: false,
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
      buildSessionContext() {
        return { messages: options.seedMessages ?? [] };
      },
    },
    settingsManager: {
      getQuietStartup() {
        return false;
      },
      getModelPreferences() {
        return { recent: [], favorite: [] };
      },
      setModelPreferences() {},
      getDiffPreferences() {
        return diffPreferences;
      },
      setDiffPreferences(next: typeof diffPreferences) {
        diffPreferences = next;
      },
      getShellViewPreferences() {
        return shellViewPreferences;
      },
      setShellViewPreferences(next: typeof shellViewPreferences) {
        shellViewPreferences = next;
      },
    },
    subscribe(listener: (event: BrewvaPromptSessionEvent) => void) {
      sessionListener = listener;
      return () => {
        if (sessionListener === listener) {
          sessionListener = undefined;
        }
      };
    },
    async prompt() {},
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
    async setModel(model: BrewvaSessionModelDescriptor) {
      currentModel = model;
    },
    getAvailableThinkingLevels() {
      return currentModel.reasoning ? ["off", "minimal", "low", "medium", "high"] : ["off"];
    },
    setThinkingLevel(level: string) {
      thinkingLevel = level;
    },
    dispose() {},
    setUiPort(ui: BrewvaToolUiPort) {
      attachedUi = ui;
    },
  };

  const bundle = {
    session,
    toolDefinitions: options.toolDefinitions ?? new Map(),
    runtime: {
      identity: {
        cwd: process.cwd(),
        workspaceRoot: process.cwd(),
        agentId: "test-agent",
      },
      ops: {
        session: {
          rewind: {
            recordCheckpoint() {},
            rewind() {
              return { ok: false, reason: "no_checkpoint" };
            },
            redo() {
              return { ok: false, reason: "no_redo" };
            },
            getState() {
              return {
                checkpoints: [],
                rewindAvailable: false,
                redoAvailable: false,
                redoStack: [],
              };
            },
            listTargets() {
              return [];
            },
          },
        },
        proposals: {
          requests: {
            decide() {},
            listPending() {
              return approvals;
            },
          },
        },
        events: {
          records: {
            query() {
              return [];
            },
          },
          replay: {
            listSessions() {
              return replaySessions;
            },
          },
        },
        sessionWire: {
          query(targetSessionId: string) {
            return options.sessionWireBySessionId?.[targetSessionId] ?? [];
          },
        },
      },
    },
    orchestration: {
      subagents: {
        async status() {
          return {
            ok: true,
            runs: options.taskRuns ?? [],
          };
        },
        async cancel() {
          return {
            ok: false,
            error: "not_live",
          };
        },
      },
    },
    providerConnections: options.providers
      ? {
          catalog: {
            async listProviders() {
              return options.providers ?? [];
            },
          },
          renderer: {
            listAuthMethods(provider: string) {
              return options.authMethods?.[provider] ?? [];
            },
          },
          credential: {
            async listProviders() {
              return options.providers ?? [];
            },
            async connectApiKey() {},
            async disconnect() {},
            async refresh() {},
          },
          authFlow: {
            listAuthMethods(provider: string) {
              return options.authMethods?.[provider] ?? [];
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
  };
}

function findRenderedRow(frame: string, needle: string): number {
  const row = frame.split("\n").findIndex((candidate) => candidate.includes(needle));
  if (row < 0) {
    throw new Error(`Expected rendered frame to contain ${needle}`);
  }
  return row;
}

function findRenderedColumn(frame: string, needle: string): number {
  const line = frame.split("\n").find((candidate) => candidate.includes(needle));
  if (!line) {
    throw new Error(`Expected rendered frame to contain ${needle}`);
  }
  return line.indexOf(needle);
}

describe("opentui solid shell runtime: layout contract", () => {
  // Bun v1.3.12 crashes during native TUI renderer teardown on Linux CI
  // (segfault in Bun's internal cleanup, not in test code). The tests all
  // pass; the crash is in the runtime's GC/finalizer phase. Run locally with
  // `bun run test:tui`; skip in CI where the native renderer is unavailable.
  if (process.env.CI === "true") {
    test("skipped in CI due to Bun native TUI teardown crash", () => {
      expect(true).toBe(true);
    });
    return;
  }

  test("keeps shared overlay geometry positive on tiny terminals", () => {
    expect(resolveDialogWidth(4)).toBe(2);
    expect(resolveDialogWidth(1)).toBe(1);
    expect(resolveDialogContentWidth(4)).toBe(1);
    expect(resolveToastMaxWidth(5)).toBe(1);

    const surface = resolveDialogSurfaceDimensions(4, 4);
    expect(surface.surfaceWidth).toBe(2);
    expect(surface.surfaceHeight).toBeGreaterThanOrEqual(1);
    expect(surface.contentHeight).toBeGreaterThanOrEqual(1);
    expect(Object.keys(surface)).not.toContain("topInset");

    expect(resolveSkillsPickerRows(36, 100, 4)).toBeLessThan(
      resolveHighDensityPickerRows(36, 100, 4),
    );
    expect(resolveSkillsPickerRows(8, 100, 0)).toBe(1);
  });

  test("uses opencode-style automatic split diff thresholds", () => {
    expect(resolveDiffView(121, "auto")).toBe("split");
    expect(resolveDiffView(120, "auto")).toBe("unified");
    expect(resolveDiffView(180, "stacked")).toBe("unified");
  });

  test("updates a mounted Solid root instead of stacking duplicate roots", async () => {
    const testSetup = await createTestRenderer({
      width: 40,
      height: 8,
    });
    const root = createOpenTuiRoot(testSetup.renderer);

    try {
      await root.render(createOpenTuiSolidElement("text", null, "first render"));
      await testSetup.renderOnce();
      expect(testSetup.captureCharFrame()).toContain("first render");

      await root.render(createOpenTuiSolidElement("text", null, "second render"));
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("second render");
      expect(frame).not.toContain("first render");
    } finally {
      root.unmount();
    }
  });

  test("renders shell chrome and notifications through the Solid shell", async () => {
    const { bundle } = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "Hello from the Solid Brewva shell",
            },
          ],
        },
      ],
    });

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    runtime.ui.notify("Solid shell notice", "info");

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 100,
        height: 36,
      },
    );

    try {
      await openTuiSolidAct(async () => {
        await Bun.sleep(CliShellRuntime.STATUS_DEBOUNCE_MS + 20);
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("Brewva");
      expect(frame).toContain("Solid");
      expect(frame).toContain("notice");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders live subagent activity with an accurate hidden count above the prompt", async () => {
    const now = Date.now();
    const { bundle } = createFakeBundle({
      taskRuns: Array.from({ length: 7 }, (_, index): DelegationRunRecord => {
        const primary = index === 0;
        const name = primary ? "review-operator-state" : `background-${index}`;
        return {
          contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
          runId: `run-worker-${index + 1}`,
          agent: "worker",
          targetName: primary ? "patch-worker" : "worker",
          delegate: primary ? "patch-worker" : "worker",
          taskName: name,
          taskPath: `/${name}`,
          nickname: primary ? "Review operator state" : `Background ${index}`,
          depth: 1,
          forkTurns: "none",
          gateReason: "implement_isolated",
          modelCategory: "isolated-execution",
          executionPrimitive: "named",
          visibility: "public",
          isolationStrategy: "worktree",
          adoption: {
            contractId: "cli-subagent-activity-test",
            decision: "require_human",
            reason: "Fixture record has not reached parent adoption.",
          },
          parentSessionId: asBrewvaSessionId("session-1"),
          status: "running",
          createdAt: now - 500 - index,
          updatedAt: primary ? now + 1_000 : now - index,
          label: primary ? "Review operator state" : `Background ${index}`,
          summary: primary ? "Inspecting OpenTUI status lane" : `Running background ${index}`,
          workerSessionId: asBrewvaSessionId(`worker-session-${index + 1}`),
        };
      }),
    });
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 160,
        height: 28,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();

      expect(runtime.getViewState().operator.taskRuns).toHaveLength(7);
      expect(frame).toContain("subagents");
      expect(frame).toContain("Patch Worker running");
      expect(frame).toContain("+2");
      expect(frame).not.toContain("tasks=7");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders long model picker rows as one clipped line with a short footer", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    runtime.openOverlay({
      kind: "modelPicker",
      title: "Models",
      query: "gemini",
      selectedIndex: 0,
      items: [
        {
          id: "model:google/gemini-2.5-flash-lite-preview-06-17:google",
          kind: "model",
          section: "google",
          provider: "google",
          modelId: "gemini-2.5-flash-lite-preview-06-17",
          label: "Gemini 2.5 Flash Lite Preview 06-17 With Extra Long Experimental Name",
          footer: "Connect",
          available: false,
        },
      ],
    });

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 60,
        height: 24,
      },
    );

    try {
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      const modelRows = frame
        .split("\n")
        .filter((line) => line.includes("Gemini") || line.includes("Experimental"));

      expect(modelRows).toHaveLength(1);
      expect(modelRows[0]).toContain("Gemini 2.5 Flash Lite Preview");
      expect(modelRows[0]).toContain("…");
      expect(modelRows[0]).toContain("Connect");
      expect(frame).not.toContain("google/gemini-2.5-flash-lite-preview-06-17");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("positions the dynamic model picker higher for long lists", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    runtime.openOverlay({
      kind: "modelPicker",
      title: "Choose model",
      query: "",
      selectedIndex: 0,
      items: Array.from({ length: 18 }, (_, index) => ({
        id: `model:demo/model-${index}:demo`,
        kind: "model" as const,
        section: index < 9 ? "demo-a" : "demo-b",
        provider: "demo",
        modelId: `model-${index}`,
        label: `Demo Model ${index}`,
        available: true,
      })),
    });

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 80,
        height: 24,
      },
    );

    try {
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();

      expect(findRenderedRow(frame, "Choose model")).toBeLessThanOrEqual(5);
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("aligns model picker title, search, sections, and model labels", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    runtime.openOverlay({
      kind: "modelPicker",
      title: "Models",
      query: "",
      selectedIndex: 0,
      items: [
        {
          id: "model:deepseek/deepseek-chat:deepseek",
          kind: "model",
          section: "Recent",
          provider: "deepseek",
          modelId: "deepseek-chat",
          label: "deepseek-chat",
          available: true,
        },
      ],
    });

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 80,
        height: 24,
      },
    );

    try {
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      const titleColumn = findRenderedColumn(frame, "Models");

      expect(findRenderedColumn(frame, "Search")).toBe(titleColumn);
      expect(findRenderedColumn(frame, "Recent")).toBe(titleColumn);
      expect(findRenderedColumn(frame, "deepseek-chat")).toBe(titleColumn);
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders provider picker with the OpenCode dialog-select shell", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    runtime.openOverlay({
      kind: "providerPicker",
      title: "Connect a provider",
      query: "",
      selectedIndex: 0,
      providers: [],
      items: [
        {
          id: "openai",
          section: "Popular",
          label: "OpenAI",
          marker: "✓",
          detail: "(ChatGPT Plus/Pro or API key)",
          footer: "Vault",
          provider: {
            id: "openai",
            name: "OpenAI",
            description: "ChatGPT Plus/Pro or API key",
            group: "popular",
            connected: true,
            connectionSource: "vault",
            modelCount: 2,
            availableModelCount: 2,
            credentialRef: "vault://openai/apiKey",
          },
        },
        {
          id: "google",
          section: "Popular",
          label: "Google",
          detail: "(Gemini CLI)",
          footer: "Gemini CLI",
          provider: {
            id: "google",
            name: "Google",
            description: "Gemini CLI",
            group: "popular",
            connected: false,
            connectionSource: "none",
            modelCount: 1,
            availableModelCount: 0,
            credentialRef: "vault://google/apiKey",
          },
        },
      ],
    });

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 100,
        height: 30,
      },
    );

    try {
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();

      expect(frame).toContain("Connect a provider");
      expect(frame).toContain("Search");
      expect(frame).toContain("Popular");
      expect(frame).toContain("✓");
      expect(frame).toContain("OpenAI");
      expect(frame).toContain("(ChatGPT Plus/Pr");
      expect(frame).toContain("…");
      expect(frame).toContain("Disconnect d");
      expect(frame).not.toContain("Connect Provider");
      expect(frame).not.toContain("Type search");
      expect(frame).not.toContain("›");
      expect(frame).not.toContain("┌");
      expect(frame).not.toContain("└");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders OAuth wait dialog with copyable URL fallback", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });
    const copiedText: string[] = [];
    const authUrl =
      "https://auth.openai.com/oauth/authorize?client_id=brewva-test&redirect_uri=http://localhost:1455/auth/callback&state=tail-marker";

    await runtime.start();
    runtime.ui.copyText = async (text: string) => {
      copiedText.push(text);
    };
    runtime.openOverlay({
      kind: "oauthWait",
      title: "ChatGPT Pro/Plus (browser)",
      url: authUrl,
      instructions: "Complete authorization in your browser. Brewva will continue automatically.",
    });

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 100,
        height: 30,
      },
    );

    try {
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();

      expect(frame).toContain("ChatGPT Pro/Plus (browser)");
      expect(frame).toContain("https://auth.openai.com/oauth/authorize");
      expect(frame).toContain("state=tail-marker");
      expect(frame).toContain("Waiting for authorization...");
      expect(frame).toContain("c copy");
      expect(frame).not.toContain("enter/c");
      expect(frame).not.toContain("authorization code to clipboard");

      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("c");
        await Bun.sleep(0);
      });
      await testSetup.renderOnce();

      expect(copiedText).toEqual([authUrl]);
      expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
        level: "info",
        message: "Copied to clipboard.",
      });
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("ctrl+a with no pending approvals renders a visible empty state instead of a blank overlay", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 100,
        height: 30,
      },
    );

    try {
      await testSetup.renderOnce();
      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("a", { ctrl: true });
      });
      await Bun.sleep(0);
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      const frame = testSetup.captureCharFrame();
      expect(runtime.getViewState().overlay.active?.kind).toBe("approval");
      expect(frame).toContain("Authorize effects");
      expect(frame).toContain("No pending effects to authorize.");
      expect(frame).toContain("Brewva asks before crossing effect boundaries.");
      expect(frame).not.toContain("permission");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("ctrl+o with no pending operator input renders a visible empty state instead of a blank overlay", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 100,
        height: 30,
      },
    );

    try {
      await testSetup.renderOnce();
      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("o", { ctrl: true });
      });
      await Bun.sleep(0);
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      const frame = testSetup.captureCharFrame();
      expect(runtime.getViewState().overlay.active?.kind).toBe("question");
      expect(frame).toContain("No pending operator input.");
      expect(frame).toContain("Brewva will show pending input requests and follow-up questions");
      expect(frame).toContain("your input.");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders the prompt action bar with live session status", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 120,
        height: 40,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("Enter");
      expect(frame).toContain("send");
      expect(frame).toContain("Ctrl+K");
      expect(frame).toContain("/help");
      expect(frame).toContain("Ctrl+O");
      expect(frame).not.toContain("approvals=0");
      expect(frame).not.toContain("questions=0");
      expect(frame).not.toContain("tasks=0");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders the OpenCode-style inline approval prompt", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    runtime.openOverlay({
      kind: "approval",
      selectedIndex: 0,
      snapshot: {
        approvals: [
          {
            requestId: "approval-1",
            proposalId: "proposal-1",
            toolName: asBrewvaToolName("write"),
            toolCallId: asBrewvaToolCallId("tool-call-1"),
            subject: "Write /tmp/output.ts",
            boundary: "effectful",
            effects: ["workspace_write"],
            argsDigest: "digest-1",
            argsSummary: "path=/tmp/output.ts",
            evidenceRefs: [],
            turn: 1,
            createdAt: Date.now(),
          },
        ],
        questions: [],
        taskRuns: [],
        sessions: [],
      },
    });

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 120,
        height: 40,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("Write /tmp/output.ts");
      expect(frame).toContain("Authorize effect");
      expect(frame).toContain("Brewva asks before crossing effect boundaries.");
      expect(frame).toContain(
        "Every code-changing action gets a reason, a receipt, and a recovery path.",
      );
      expect(frame).toContain("Authorize once");
      expect(frame).toContain("Summary: path=/tmp/output.ts");
      expect(frame).toContain("Tool: write");
      expect(frame).toContain("Boundary: effectful");
      expect(frame).not.toContain("trust=authorize");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders inline approval diff preview with fullscreen hint", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    runtime.openOverlay({
      kind: "approval",
      selectedIndex: 0,
      snapshot: {
        approvals: [
          {
            requestId: "approval-1",
            proposalId: "proposal-1",
            toolName: asBrewvaToolName("edit"),
            toolCallId: asBrewvaToolCallId("tool-call-1"),
            subject: "tool:edit",
            boundary: "effectful",
            effects: ["workspace_write"],
            argsDigest: "digest-1",
            argsSummary: "path=src/generated.ts",
            diffPreview: {
              kind: "diff",
              path: "src/generated.ts",
              diff: "--- src/generated.ts\n+++ src/generated.ts\n@@ -1,1 +1,1 @@\n-export const value = 1;\n+export const value = 2;\n",
            },
            evidenceRefs: [],
            turn: 1,
            createdAt: Date.now(),
          },
        ],
        questions: [],
        taskRuns: [],
        sessions: [],
      },
    });

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 120,
        height: 40,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      let frame = testSetup.captureCharFrame();
      expect(frame).toContain("Edit src/generated.ts");
      expect(frame).toContain("ctrl+f fullscreen");
      expect(frame).toContain("1 + export const value = 2;");

      await runtime.handleInput({
        type: "keymap.effect",
        effect: { type: "overlay.toggleFullscreen" },
      });
      await testSetup.renderOnce();
      frame = testSetup.captureCharFrame();
      expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
        kind: "approval",
        previewExpanded: true,
      });
      expect(frame).toContain("ctrl+f minimize");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders the OpenCode-style inline question prompt", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    runtime.openOverlay({
      kind: "question",
      mode: "operator",
      selectedIndex: 0,
      snapshot: {
        approvals: [],
        questions: [
          {
            questionId: "delegation:run-1:request:1:question:1",
            sessionId: "session-1",
            createdAt: Date.now(),
            sourceKind: "delegation",
            sourceEventId: "event-1",
            requestId: "delegation:run-1:request:1",
            requestPosition: 0,
            requestSize: 2,
            header: "Scope",
            questionText: "Should I update the config before continuing?",
            options: [
              { label: "Yes", description: "Update config first" },
              { label: "No", description: "Keep the current config" },
            ],
            sourceLabel: "delegate label=worker-1 skill=review",
            runId: "run-1",
            delegate: "worker-1",
          },
          {
            questionId: "delegation:run-1:request:1:question:2",
            sessionId: "session-1",
            createdAt: Date.now(),
            sourceKind: "delegation",
            sourceEventId: "event-1",
            requestId: "delegation:run-1:request:1",
            requestPosition: 1,
            requestSize: 2,
            header: "Risk",
            questionText: "Which rollout shape should I use?",
            options: [
              { label: "Canary", description: "Lower blast radius" },
              { label: "Full", description: "Fastest rollout" },
            ],
            sourceLabel: "delegate label=worker-1 skill=review",
            runId: "run-1",
            delegate: "worker-1",
          },
        ],
        taskRuns: [],
        sessions: [],
      },
    });

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 120,
        height: 40,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("Scope");
      expect(frame).toContain("Review");
      expect(frame).toContain("Should I update the config");
      expect(frame).toContain("Custom");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders lineage sidebar with session-style marker and left alignment", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    runtime.openOverlay({
      kind: "lineage",
      sessionId: "lineage-session",
      rootNodeId: "lineage:main",
      currentLineageNodeId: "lineage:main",
      selectedIndex: 0,
      nodes: [
        {
          lineageNodeId: "lineage:main",
          parentLineageNodeId: null,
          leafEntryId: null,
          kind: "main",
          title: "Main task",
          depth: 0,
          current: true,
          childCount: 1,
          summaryCount: 0,
          outcomeCount: 0,
          adoptedOutcomeCount: 0,
          forkPoint: "session_root",
        },
        {
          lineageNodeId: "lineage:review",
          parentLineageNodeId: "lineage:main",
          leafEntryId: "entry-review",
          kind: "review",
          title: "Review branch",
          depth: 1,
          current: false,
          childCount: 0,
          summaryCount: 0,
          outcomeCount: 0,
          adoptedOutcomeCount: 0,
          forkPoint: "context_entry:lineage:main:entry-review",
        },
      ],
    });

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 100,
        height: 28,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      const titleColumn = findRenderedColumn(frame, "Lineage");

      expect(frame).toContain("● Main task");
      expect(frame).not.toContain("* Main task");
      expect(findRenderedColumn(frame, "Main task")).toBe(titleColumn);
      expect(findRenderedColumn(frame, "Review branch")).toBe(titleColumn + 2);
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders structured task overlays with a details panel in the Solid shell", async () => {
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
            assistantText: "Verifier summary line\nFound stale contract drift.",
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
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
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
            agent: "worker",
            targetName: "worker",
            delegate: "worker-1",
            taskName: "review-operator-state",
            taskPath: "/review-operator-state",
            nickname: "Review operator state",
            depth: 1,
            forkTurns: "none",
            gateReason: "implement_isolated",
            modelCategory: "isolated-execution",
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
            summary: "Streaming output",
            resultData: {
              verdict: "pass",
            },
            artifactRefs: [
              {
                kind: "patch",
                path: ".orchestrator/subagent-runs/run-1/patch.diff",
                summary: "Suggested patch",
              },
            ],
            delivery: {
              mode: "supplemental",
              handoffState: "surfaced",
            },
            error: undefined,
          },
        ],
        sessions: [],
      },
    });

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 100,
        height: 28,
      },
    );

    try {
      await testSetup.renderOnce();
      await openTuiSolidAct(async () => {
        await runtime.handleInput({
          type: "keymap.effect",
          effect: { type: "overlay.primary" },
        });
      });
      await openTuiSolidAct(async () => {
        await runtime.handleInput({
          type: "keymap.effect",
          effect: { type: "overlay.scrollPage", direction: 1 },
        });
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("Task run-1 output");
      expect(frame).toContain("worker-session-1");
      expect(frame).toContain("Found stale contract drift.");
      expect(frame).toContain("1775 pass");
      expect(frame).toContain("brewva inspect --session worker-session-1");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders structured inspect overlays with section navigation and details", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
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
          id: "verification",
          title: "Verification",
          lines: ["Outcome: pass", "Missing checks: none"],
        },
      ],
      selectedIndex: 1,
      scrollOffsets: [0, 0],
    });

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 100,
        height: 28,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("Inspect");
      expect(frame).toContain("Summary");
      expect(frame).toContain("Verification");
      expect(frame).toContain("Outcome");
      expect(frame).toContain("pass");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });
});
