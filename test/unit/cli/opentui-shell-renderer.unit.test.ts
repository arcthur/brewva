import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asBrewvaSessionId,
  asBrewvaToolCallId,
  asBrewvaToolName,
  type BrewvaReplaySession,
  type SessionWireFrame,
} from "@brewva/brewva-runtime";
import type {
  BrewvaPromptSessionEvent,
  BrewvaRenderableComponent,
  BrewvaSessionModelDescriptor,
  BrewvaToolDefinition,
  BrewvaToolUiPort,
} from "@brewva/brewva-substrate";
import {
  createOpenTuiRoot,
  createOpenTuiSolidElement,
  openTuiSolidAct,
  openTuiSolidTestRender,
  type OpenTuiRenderer,
} from "@brewva/brewva-tui/internal-opentui-runtime";
import { createTestRenderer } from "@opentui/core/testing";
import { BrewvaOpenTuiShell } from "../../../packages/brewva-cli/runtime/opentui-shell-renderer.js";
import { resolveDiffView } from "../../../packages/brewva-cli/runtime/shell/diff-view.js";
import {
  COMPLETION_Z_INDEX,
  DIALOG_Z_INDEX,
  resolveDialogContentWidth,
  resolveDialogSurfaceDimensions,
  resolveDialogWidth,
  resolveToastMaxWidth,
} from "../../../packages/brewva-cli/runtime/shell/overlay-style.js";
import { createPalette } from "../../../packages/brewva-cli/runtime/shell/palette.js";
import { ToastStrip } from "../../../packages/brewva-cli/runtime/shell/toast.js";
import { createToolRenderCache } from "../../../packages/brewva-cli/runtime/shell/tool-render.js";
import { CliShellRuntime } from "../../../packages/brewva-cli/src/shell/runtime.js";
import type {
  CliShellSessionBundle,
  ProviderAuthMethod,
  ProviderConnection,
  ProviderOAuthAuthorization,
} from "../../../packages/brewva-cli/src/shell/types.js";

interface OpenTuiTestRenderableInspector {
  getChildren(): unknown[];
}

interface OpenTuiTestRendererInspector {
  root: {
    findDescendantById(id: string): OpenTuiTestRenderableInspector | undefined;
  };
}

interface FakeOpenTuiSelectionRenderer extends OpenTuiRenderer {
  console: {
    onCopySelection?: (text: string) => void | Promise<void>;
  };
  getSelection(): { getSelectedText(): string } | null;
  clearSelection(): void;
}

function createFakeSelectionRenderer(selectedText = "Selected transcript text"): {
  renderer: FakeOpenTuiSelectionRenderer;
  wasCleared(): boolean;
} {
  let currentSelectedText = selectedText;
  let cleared = false;
  return {
    renderer: {
      width: 100,
      height: 30,
      console: {},
      getSelection() {
        if (!currentSelectedText) {
          return null;
        }
        return {
          getSelectedText() {
            return currentSelectedText;
          },
        };
      },
      clearSelection() {
        cleared = true;
        currentSelectedText = "";
      },
      destroy() {},
    },
    wasCleared() {
      return cleared;
    },
  };
}

async function waitForRenderedFrame(
  testSetup: Awaited<ReturnType<typeof openTuiSolidTestRender>>,
  input: {
    predicate(frame: string): boolean;
    attempts?: number;
    settleMs?: number;
  },
): Promise<string> {
  let frame = "";
  const attempts = input.attempts ?? 8;
  const settleMs = input.settleMs ?? 20;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await testSetup.renderOnce();
    frame = testSetup.captureCharFrame();
    if (input.predicate(frame)) {
      return frame;
    }
    await openTuiSolidAct(async () => {
      await Bun.sleep(settleMs);
    });
  }
  return frame;
}

function countOccurrences(text: string, needle: string): number {
  if (needle.length === 0) {
    return 0;
  }
  return text.split(needle).length - 1;
}

function findRenderedColumn(frame: string, needle: string): number {
  const line = frame.split("\n").find((candidate) => candidate.includes(needle));
  expect(line).toBeDefined();
  return line?.indexOf(needle) ?? -1;
}

interface CapturedSpanLike {
  text: string;
  bg: {
    toInts(): [number, number, number, number];
  };
}

interface CapturedFrameLike {
  lines: Array<{
    spans: CapturedSpanLike[];
  }>;
}

interface SpanCaptureRenderSetup {
  captureSpans(): CapturedFrameLike;
}

function hexToRgbInts(hex: string): [number, number, number] {
  const value = hex.replace(/^#/u, "");
  return [
    Number.parseInt(value.slice(0, 2), 16),
    Number.parseInt(value.slice(2, 4), 16),
    Number.parseInt(value.slice(4, 6), 16),
  ];
}

function renderedLineUsesBackground(
  testSetup: Awaited<ReturnType<typeof openTuiSolidTestRender>>,
  needle: string,
  hex: string,
): boolean {
  const [red, green, blue] = hexToRgbInts(hex);
  const frame = (testSetup as typeof testSetup & SpanCaptureRenderSetup).captureSpans();
  const line = frame.lines.find((candidate) =>
    candidate.spans
      .map((span) => span.text)
      .join("")
      .includes(needle),
  );
  expect(line).toBeDefined();
  return (
    line?.spans.some((span) => {
      const [spanRed, spanGreen, spanBlue, alpha] = span.bg.toInts();
      return spanRed === red && spanGreen === green && spanBlue === blue && alpha > 0;
    }) ?? false
  );
}

function createFakeBundle(
  options: {
    approvals?: number;
    models?: BrewvaSessionModelDescriptor[];
    availableModelKeys?: string[];
    seedMessages?: unknown[];
    sessionId?: string;
    replaySessions?: BrewvaReplaySession[];
    sessionWireBySessionId?: Record<string, SessionWireFrame[]>;
    toolDefinitions?: Map<string, BrewvaToolDefinition>;
    providers?: ProviderConnection[];
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
      authority: {
        correction: {
          recordCheckpoint() {},
          undo() {
            return { ok: false, reason: "no_checkpoint" };
          },
          redo() {
            return { ok: false, reason: "no_undone_checkpoint" };
          },
        },
        proposals: {
          decideEffectCommitment() {},
        },
      },
      inspect: {
        correction: {
          getState() {
            return {
              checkpoints: [],
              undoAvailable: false,
              redoAvailable: false,
            };
          },
        },
        proposals: {
          listPendingEffectCommitments() {
            return approvals;
          },
        },
        events: {
          query() {
            return [];
          },
          listReplaySessions() {
            return replaySessions;
          },
        },
        sessionWire: {
          query(targetSessionId: string) {
            return options.sessionWireBySessionId?.[targetSessionId] ?? [];
          },
        },
      },
    },
    providerConnections: options.providers
      ? {
          async listProviders() {
            return options.providers ?? [];
          },
          listAuthMethods(provider: string) {
            return options.authMethods?.[provider] ?? [];
          },
          async connectApiKey() {},
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
  };
}

describe("opentui solid shell runtime", () => {
  test("renders completion above dialog backdrops", () => {
    expect(COMPLETION_Z_INDEX).toBeGreaterThan(DIALOG_Z_INDEX);
  });

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

  test("updates the prompt model label after selecting a model", async () => {
    const models: BrewvaSessionModelDescriptor[] = [
      {
        provider: "openai",
        id: "alpha",
        name: "Alpha",
        contextWindow: 128_000,
        maxTokens: 16_384,
        reasoning: false,
      },
      {
        provider: "anthropic",
        id: "beta",
        name: "Beta",
        contextWindow: 200_000,
        maxTokens: 32_000,
        reasoning: false,
      },
    ];
    const { bundle } = createFakeBundle({ models });
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
        height: 24,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      expect(testSetup.captureCharFrame()).toContain("openai/alpha");

      runtime.ui.setEditorText("/models beta");
      await openTuiSolidAct(async () => {
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
      });

      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("anthropic/beta");
      expect(frame).not.toContain("openai/alpha");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("hides expired toast notifications", async () => {
    const theme = createPalette({
      backgroundApp: "#000000",
      backgroundPanel: "#111111",
      backgroundElement: "#222222",
      backgroundOverlay: "#333333",
      text: "#ffffff",
      textMuted: "#999999",
      textDim: "#666666",
      accent: "#00ffcc",
      accentSoft: "#003333",
      warning: "#ffaa00",
      error: "#ff3300",
      success: "#00dd66",
      border: "#444444",
      borderActive: "#00ffcc",
      borderSubtle: "#222222",
      selectionBg: "#005555",
      selectionText: "#ffffff",
    });
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(ToastStrip, {
        notifications: [
          {
            id: "notification-expired",
            level: "info",
            message: "expired toast notice",
            createdAt: Date.now() - 60_000,
          },
        ],
        theme,
      }),
      {
        width: 100,
        height: 12,
      },
    );

    try {
      await testSetup.renderOnce();
      expect(testSetup.captureCharFrame()).not.toContain("expired toast notice");
    } finally {
      testSetup.renderer.destroy();
    }
  });

  test("renders transcript, notifications, and slash completion inside the Solid shell", async () => {
    const { bundle } = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content: "Hello from Brewva",
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
    runtime.ui.notify("Heads up", "warning");
    runtime.ui.setEditorText("/ins");
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
      const frame = await waitForRenderedFrame(testSetup, {
        predicate: (candidate) =>
          candidate.includes("▣ Brewva") &&
          candidate.includes("Hello from Brewva") &&
          candidate.includes("/inspect"),
      });
      expect(frame).toContain("▣ Brewva");
      expect(frame).toContain("Hello from Brewva");
      expect(frame).toContain("warning");
      expect(frame).toContain("Heads");
      expect(frame).toContain("/inspect");
      expect(frame).toContain("┃  /ins");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders slash completion descriptions and keeps the selection through streaming updates", async () => {
    const fixture = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content: "Hello from Brewva",
        },
      ],
    });
    const { bundle } = fixture;

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    runtime.ui.setEditorText("/qu");
    await runtime.handleInput({
      key: "down",
      ctrl: false,
      meta: false,
      shift: false,
    });

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 120,
        height: 36,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      let frame = testSetup.captureCharFrame();
      expect(frame).toContain("openai/gpt-5.4-mini");
      expect(frame).toContain("think high");
      expect(frame).toContain("┃  /qu");
      expect(frame).toContain("command /questions");
      expect(frame).toContain("/questions");
      expect(frame).not.toContain("List unresolved operator questions.");
      expect(frame).toContain("/quit");
      expect(frame).toContain("Exit the interactive shell.");
      expect(countOccurrences(frame, "Exit the interactive shell.")).toBe(1);
      expect(frame).not.toContain("┌");
      expect(frame).not.toContain("└");

      fixture.emitSessionEvent({
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Streaming update while typing." }],
          stopReason: "toolUse",
        },
      });

      await testSetup.renderOnce();
      await testSetup.renderOnce();
      frame = testSetup.captureCharFrame();
      expect(frame).toContain("┃  /qu");
      expect(frame).toContain("command /questions");
      expect(frame).toContain("/questions");
      expect(frame).not.toContain("List unresolved operator questions.");
      expect(countOccurrences(frame, "Exit the interactive shell.")).toBe(1);
      expect(frame).not.toContain("┌");
      expect(frame).not.toContain("└");
      expect(runtime.getViewState().composer.completion?.selectedIndex).toBe(1);
      expect(
        runtime.getViewState().composer.completion?.items[
          runtime.getViewState().composer.completion?.selectedIndex ?? 0
        ],
      ).toMatchObject({
        value: "questions",
      });
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("updates slash completion highlight when query resets selection", async () => {
    const { bundle } = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content: "Hello from Brewva",
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
    runtime.ui.setEditorText("/q");
    await runtime.handleInput({
      key: "down",
      ctrl: false,
      meta: false,
      shift: false,
    });

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 120,
        height: 36,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      expect(renderedLineUsesBackground(testSetup, "/questions", "#5bc0eb")).toBe(true);

      runtime.ui.setEditorText("/qu");
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      expect(runtime.getViewState().composer.completion?.selectedIndex).toBe(0);
      expect(runtime.getViewState().composer.completion?.items[0]).toMatchObject({
        value: "quit",
      });
      expect(renderedLineUsesBackground(testSetup, "/quit", "#5bc0eb")).toBe(true);
      expect(renderedLineUsesBackground(testSetup, "/questions", "#5bc0eb")).toBe(false);
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders mixed reference completion kinds", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-render-completion-"));
    mkdirSync(join(cwd, "packages"), { recursive: true });
    writeFileSync(join(cwd, "README.md"), "# Test\n");
    const { bundle } = createFakeBundle();

    const runtime = new CliShellRuntime(bundle, {
      cwd,
      openSession: async () => bundle,
      createSession: async () => bundle,
      completionAgents: [{ agentId: "reviewer", description: "Code review agent" }],
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    runtime.ui.setEditorText("@");
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 80,
        height: 18,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("@reviewer");
      expect(countOccurrences(frame, "Code review agent")).toBe(1);
      expect(frame).toContain("agent");
      expect(frame).toContain("@README.md");
      expect(frame).toContain("file");
      expect(frame).toContain("@packages/");
      expect(frame).toContain("directory");
      expect(frame).not.toContain("No matching items");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders command palette metadata from the command provider", async () => {
    const { bundle } = createFakeBundle();

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    await runtime.handleInput({
      key: "k",
      ctrl: true,
      meta: false,
      shift: false,
    });

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 120,
        height: 36,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("Commands");
      expect(frame).toContain("Switch model");
      expect(frame).toContain("Agent");
      expect(frame).toContain("/models");
      expect(frame).toContain("Ctrl+K");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders help hub with command palette entry and navigation hints", async () => {
    const { bundle } = createFakeBundle();

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    runtime.ui.setEditorText("/help");
    await runtime.handleInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 120,
        height: 36,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("Help");
      expect(frame).toContain("Ctrl+K opens the command palette");
      expect(frame).toContain("Enter runs");
      expect(frame).toContain("Switch model");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders assistant prose as separate visual transcript blocks", async () => {
    const { bundle } = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content:
            "I checked the Brewva output.\n\n**Changes**\n- Split prose into readable sections.\n- Keep tool output visually separate.\n\n```ts\nconst value = 1;\n\nconsole.log(value);\n```",
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
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 100,
        height: 36,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      const message = runtime
        .getViewState()
        .transcript.messages.find((candidate) => candidate.role === "assistant");
      const textPart = message?.parts.find((part) => part.type === "text");
      expect(textPart).toBeDefined();

      const rendererInspector = testSetup.renderer as unknown as OpenTuiTestRendererInspector;
      expect(
        rendererInspector.root.findDescendantById(`text-${textPart!.id}:block:0`),
      ).toBeDefined();
      expect(
        rendererInspector.root.findDescendantById(`text-${textPart!.id}:block:1`),
      ).toBeDefined();
      expect(
        rendererInspector.root.findDescendantById(`text-${textPart!.id}:block:2`),
      ).toBeDefined();
      expect(
        rendererInspector.root.findDescendantById(`text-${textPart!.id}:block:3`),
      ).toBeUndefined();

      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("I checked the Brewva output.");
      expect(frame).toContain("Changes");
      expect(frame).toContain("const value = 1;");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders stable assistant Markdown tables through the OpenTUI Markdown renderer", async () => {
    const { bundle } = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content:
            "Runtime surfaces:\n\n| Surface | Role |\n| --- | --- |\n| authority | capability decisions |\n| inspect | read-only observation |\n| maintain | state maintenance |",
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
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 100,
        height: 36,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      const message = runtime
        .getViewState()
        .transcript.messages.find((candidate) => candidate.role === "assistant");
      const textPart = message?.parts.find((part) => part.type === "text");
      expect(textPart).toBeDefined();

      const rendererInspector = testSetup.renderer as unknown as OpenTuiTestRendererInspector;
      const textBlock = rendererInspector.root.findDescendantById(`text-${textPart!.id}:block:1`);
      const tableRenderable = textBlock?.getChildren()[0] as
        | { constructor: { name: string } }
        | undefined;

      expect(tableRenderable?.constructor.name).toBe("MarkdownRenderable");
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("Runtime surfaces:");
      expect(frame).toContain("authority");
      expect(frame).toContain("capability decisions");
      expect(frame).not.toContain("| Surface | Role |");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders stable assistant non-table Markdown through the code fallback", async () => {
    const { bundle } = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content:
            "I checked the Brewva output.\n\n**Changes**\n- Split prose into readable sections.\n- Keep tool output visually separate.\n\n```ts\nconst value = 1;\n```",
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
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 100,
        height: 36,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      const message = runtime
        .getViewState()
        .transcript.messages.find((candidate) => candidate.role === "assistant");
      const textPart = message?.parts.find((part) => part.type === "text");
      expect(textPart).toBeDefined();

      const rendererInspector = testSetup.renderer as unknown as OpenTuiTestRendererInspector;
      for (let index = 0; index < 3; index += 1) {
        const textBlock = rendererInspector.root.findDescendantById(
          `text-${textPart!.id}:block:${index}`,
        );
        const renderable = textBlock?.getChildren()[0] as
          | {
              constructor: { name: string };
              drawUnstyledText?: boolean;
              streaming?: boolean;
            }
          | undefined;

        expect(renderable?.constructor.name).toBe("CodeRenderable");
        expect(renderable?.drawUnstyledText).toBe(true);
        expect(renderable?.streaming).toBe(false);
      }

      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("I checked the Brewva output.");
      expect(frame).toContain("Changes");
      expect(frame).toContain("const value = 1;");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders supported Mermaid flowcharts as diagram blocks", async () => {
    const { bundle } = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content: [
            "The stable path is renderer-owned.",
            "",
            "```mermaid",
            "flowchart LR",
            "  CLI[CLI shell] -->|stable| Markdown[Markdown renderer]",
            "```",
          ].join("\n"),
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
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 96,
        height: 36,
      },
    );

    try {
      const frame = await waitForRenderedFrame(testSetup, {
        predicate: (candidate) => candidate.includes("Mermaid diagram"),
      });

      expect(frame).toContain("The stable path is renderer-owned.");
      expect(frame).toContain("Mermaid diagram");
      expect(frame).toContain("[CLI shell]");
      expect(frame).toContain("stable");
      expect(frame).not.toContain("```mermaid");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("falls back to selectable source for unsupported Mermaid diagrams", async () => {
    const { bundle } = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content: ["```mermaid", "pie title Work", '  "Done" : 10', "```"].join("\n"),
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
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 72,
        height: 24,
      },
    );

    try {
      const frame = await waitForRenderedFrame(testSetup, {
        predicate: (candidate) => candidate.includes("Mermaid source"),
      });

      expect(frame).toContain("Mermaid source");
      expect(frame).toContain("pie title Work");
      expect(frame).not.toContain("Mermaid diagram");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("hides reasoning blocks when thinking visibility is toggled off", async () => {
    const { bundle } = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Inspect the workspace first." },
            { type: "text", text: "Ready." },
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
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 100,
        height: 30,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      const message = runtime
        .getViewState()
        .transcript.messages.find((candidate) => candidate.role === "assistant");
      const reasoningPart = message?.parts.find((part) => part.type === "reasoning");
      expect(reasoningPart).toBeDefined();

      const rendererInspector = testSetup.renderer as unknown as OpenTuiTestRendererInspector;
      expect(rendererInspector.root.findDescendantById(`text-${reasoningPart!.id}`)).toBeDefined();

      runtime.ui.setEditorText("/thinking");
      await runtime.handleInput({
        key: "enter",
        ctrl: false,
        meta: false,
        shift: false,
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      expect(runtime.getViewState().view.showThinking).toBe(false);
      expect(
        rendererInspector.root.findDescendantById(`text-${reasoningPart!.id}`),
      ).toBeUndefined();
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("keeps streamed assistant text on the OpenTUI streaming code path", async () => {
    const fixture = createFakeBundle();
    const { bundle } = fixture;
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
      fixture.emitSessionEvent({
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Streaming text" }],
          stopReason: "toolUse",
        },
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      const message = runtime
        .getViewState()
        .transcript.messages.find((candidate) => candidate.role === "assistant");
      const textPart = message?.parts.find((part) => part.type === "text");
      expect(textPart).toBeDefined();
      const rendererInspector = testSetup.renderer as unknown as OpenTuiTestRendererInspector;
      const textBlock = rendererInspector.root.findDescendantById(`text-${textPart!.id}:block:0`);
      const streamingRenderable = textBlock?.getChildren()[0] as
        | {
            constructor: { name: string };
            drawUnstyledText?: boolean;
            streaming?: boolean;
          }
        | undefined;

      expect(streamingRenderable?.constructor.name).toBe("CodeRenderable");
      expect(streamingRenderable?.drawUnstyledText).toBe(false);
      expect(streamingRenderable?.streaming).toBe(true);

      fixture.emitSessionEvent({
        type: "message_update",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Streaming text while staying in one block" }],
          stopReason: "toolUse",
        },
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      const updatedTextBlock = rendererInspector.root.findDescendantById(
        `text-${textPart!.id}:block:0`,
      );
      const updatedRenderable = updatedTextBlock?.getChildren()[0];
      expect(updatedRenderable).toBe(streamingRenderable);
      expect(
        (updatedRenderable as { drawUnstyledText?: boolean } | undefined)?.drawUnstyledText,
      ).toBe(false);
      expect((updatedRenderable as { streaming?: boolean } | undefined)?.streaming).toBe(true);

      fixture.emitSessionEvent({
        type: "message_end",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: [
                "Streaming table done:",
                "",
                "| Gate | Status |",
                "| --- | --- |",
                "| render | stable |",
              ].join("\n"),
            },
          ],
          stopReason: "endTurn",
        },
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      const finalizedTextBlock = rendererInspector.root.findDescendantById(
        `text-${textPart!.id}:block:1`,
      );
      const finalizedRenderable = finalizedTextBlock?.getChildren()[0];
      expect(finalizedRenderable).not.toBe(streamingRenderable);
      expect(
        (
          finalizedRenderable as
            | { constructor?: { name?: string }; streaming?: boolean }
            | undefined
        )?.constructor?.name,
      ).toBe("MarkdownRenderable");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("routes global semantic keybindings through the Solid shell keyboard transport", async () => {
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

      expect(runtime.getViewState().overlay.active?.kind).toBe("approval");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("updates model picker highlight when keyboard navigation changes selection", async () => {
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
          id: "model:openai/alpha:openai",
          kind: "model",
          provider: "openai",
          modelId: "alpha",
          label: "Alpha",
          detail: "openai/alpha",
          available: true,
        },
        {
          id: "model:openai/beta:openai",
          kind: "model",
          provider: "openai",
          modelId: "beta",
          label: "Beta",
          detail: "openai/beta",
          available: true,
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
      expect(testSetup.captureCharFrame()).toContain("Alpha openai/alpha");

      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("n", { ctrl: true });
        await Bun.sleep(0);
      });
      const frame = await waitForRenderedFrame(testSetup, {
        predicate: (candidate) => candidate.includes("Beta openai/beta"),
      });

      expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
        kind: "modelPicker",
        selectedIndex: 1,
      });
      expect(frame).toContain("Beta openai/beta");
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
          detail: "(API key)",
          provider: {
            id: "google",
            name: "Google",
            description: "API key",
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

  test("renders OAuth manual callback input with keyboard entry", async () => {
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
    const submittedCodes: string[] = [];
    const authUrl =
      "https://auth.openai.com/oauth/authorize?client_id=brewva-test&redirect_uri=http://localhost:1455/auth/callback&state=tail-marker";
    let finishBrowserWait: (() => void) | undefined;
    const { bundle } = createFakeBundle({
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
      async completeOAuth(_provider, _methodId, code) {
        if (code) {
          submittedCodes.push(code);
          return;
        }
        await new Promise<void>((resolve) => {
          finishBrowserWait = resolve;
        });
      },
    });
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    runtime.ui.setEditorText("/connect ");
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });
    await runtime.handleInput({ key: "enter", ctrl: false, meta: false, shift: false });
    await Bun.sleep(0);

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 100,
        height: 30,
      },
    );

    try {
      await testSetup.renderOnce();
      let frame = testSetup.captureCharFrame();
      expect(frame).toContain("enter/p paste callback");

      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("p");
        await Bun.sleep(0);
      });
      await testSetup.renderOnce();
      frame = testSetup.captureCharFrame();
      expect(frame).toContain("Paste the final redirect URL or authorization code.");

      await openTuiSolidAct(async () => {
        await testSetup.mockInput.typeText("https://callback?code=abc");
        testSetup.mockInput.pressEnter();
        await Bun.sleep(0);
      });
      await testSetup.renderOnce();

      expect(submittedCodes).toEqual(["https://callback?code=abc"]);
      finishBrowserWait?.();
    } finally {
      finishBrowserWait?.();
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("copies selected OpenTUI text with ctrl+c before semantic key handling", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });
    const selection = createFakeSelectionRenderer("Selected transcript text");
    const copiedText: string[] = [];

    await runtime.start();

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, {
        runtime: runtime,
        renderer: selection.renderer,
        copyTextToClipboard: async (text: string) => {
          copiedText.push(text);
        },
      }),
      {
        width: 100,
        height: 30,
      },
    );

    try {
      await testSetup.renderOnce();
      await openTuiSolidAct(async () => {
        testSetup.mockInput.pressKey("c", { ctrl: true });
        await Bun.sleep(0);
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      expect(copiedText).toEqual(["Selected transcript text"]);
      expect(selection.wasCleared()).toBe(true);
      expect(runtime.getViewState().notifications.at(-1)).toMatchObject({
        level: "info",
        message: "Copied to clipboard.",
      });
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("wires OpenTUI console copy-selection actions to the shell clipboard", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });
    const selection = createFakeSelectionRenderer("");
    const copiedText: string[] = [];

    await runtime.start();

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, {
        runtime: runtime,
        renderer: selection.renderer,
        copyTextToClipboard: async (text: string) => {
          copiedText.push(text);
        },
      }),
      {
        width: 100,
        height: 30,
      },
    );

    try {
      await testSetup.renderOnce();
      expect(selection.renderer.console.onCopySelection).toBeFunction();

      await openTuiSolidAct(async () => {
        await selection.renderer.console.onCopySelection?.("Console selected text");
        await Bun.sleep(0);
      });
      await testSetup.renderOnce();

      expect(copiedText).toEqual(["Console selected text"]);
      expect(selection.wasCleared()).toBe(true);
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

  test("clears tool renderer cache when switching sessions", async () => {
    const createCustomTool = () =>
      ({
        name: "custom_tool",
        label: "Custom Tool",
        description: "Test-only custom renderer",
        parameters: {},
        async execute() {
          return {
            content: [],
            details: {},
          };
        },
        renderCall(
          args: { label?: string },
          _theme: unknown,
          ctx: { lastComponent?: BrewvaRenderableComponent },
        ) {
          return {
            render() {
              return [
                ctx.lastComponent
                  ? `leak:${args.label ?? "unknown"}`
                  : `tool:${args.label ?? "unknown"}`,
              ];
            },
            invalidate() {},
          };
        },
      }) as unknown as BrewvaToolDefinition;

    const firstTool = createCustomTool();
    const secondTool = createCustomTool();
    const { bundle } = createFakeBundle({
      sessionId: "session-1",
      toolDefinitions: new Map([[firstTool.name, firstTool]]),
      seedMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "shared-tool-call",
              name: firstTool.name,
              arguments: { label: "first" },
            },
          ],
        },
      ],
    });
    const secondBundle = createFakeBundle({
      sessionId: "session-2",
      toolDefinitions: new Map([[secondTool.name, secondTool]]),
      seedMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "shared-tool-call",
              name: secondTool.name,
              arguments: { label: "second" },
            },
          ],
        },
      ],
    }).bundle;
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async (sessionId) => (sessionId === "session-2" ? secondBundle : bundle),
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
      await testSetup.renderOnce();
      let frame = testSetup.captureCharFrame();
      expect(frame).toContain("tool:first");
      expect(frame).not.toContain("leak:first");

      await openTuiSolidAct(async () => {
        await runtime.openSessionById("session-2");
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      frame = testSetup.captureCharFrame();
      expect(frame).toContain("tool:second");
      expect(frame).not.toContain("leak:second");
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
      expect(frame).toContain("enter");
      expect(frame).toContain("send");
      expect(frame).toContain("ctrl+k");
      expect(frame).toContain("/help");
      expect(frame).toContain("ctrl+o");
      expect(frame).toContain("Brewva keeps receipts you can inspect, replay, and undo from.");
      expect(frame).toContain("approvals=0");
      expect(frame).toContain("questions=0");
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
        key: "f",
        ctrl: true,
        meta: false,
        shift: false,
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
        height: 32,
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
            runId: "run-1",
            delegate: "worker-1",
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
          key: "enter",
          ctrl: false,
          meta: false,
          shift: false,
        });
      });
      await openTuiSolidAct(async () => {
        await runtime.handleInput({
          key: "pagedown",
          ctrl: false,
          meta: false,
          shift: false,
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

  test("scrolls pager overlays through semantic page-down input", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    runtime.openOverlay({
      kind: "pager",
      lines: Array.from({ length: 40 }, (_, index) => `line-${index + 1}`),
      title: "Task Details",
      scrollOffset: 0,
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
      let frame = testSetup.captureCharFrame();
      expect(frame).toContain("line-1");

      await openTuiSolidAct(async () => {
        await runtime.handleInput({
          key: "pagedown",
          ctrl: false,
          meta: false,
          shift: false,
        });
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      frame = testSetup.captureCharFrame();
      expect(frame).toContain("line-20");
      expect(frame).not.toContain("line-4");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("drills from inspect sections into a pager and returns on escape", async () => {
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
          id: "analysis",
          title: "Analysis",
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
      let frame = testSetup.captureCharFrame();
      expect(frame).toContain("Inspect");
      expect(frame).toContain("Analysis");

      await openTuiSolidAct(async () => {
        await runtime.handleInput({
          key: "enter",
          ctrl: false,
          meta: false,
          shift: false,
        });
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      frame = testSetup.captureCharFrame();
      expect(frame).toContain("Analysis");
      expect(frame).toContain("Missing");
      expect(frame).toContain("close/back");

      await openTuiSolidAct(async () => {
        await runtime.handleInput({
          key: "escape",
          ctrl: false,
          meta: false,
          shift: false,
        });
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      frame = testSetup.captureCharFrame();
      expect(frame).toContain("Inspect");
      expect(frame).toContain("Analysis");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders the notification inbox and supports dismissing the selected item", async () => {
    const { bundle } = createFakeBundle();
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    runtime.ui.notify("older notification", "info");
    runtime.ui.notify("latest notification", "warning");

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 100,
        height: 28,
      },
    );

    try {
      await openTuiSolidAct(async () => {
        await runtime.handleInput({
          key: "n",
          ctrl: true,
          meta: false,
          shift: false,
        });
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      let frame = testSetup.captureCharFrame();
      expect(frame).toContain("Notifications");
      expect(frame).toContain("latest notification");
      expect(frame).toContain("Details");
      expect(frame).toContain("dismiss d");
      expect(frame).toContain("clear x");
      expect(frame).toContain("details enter");

      await openTuiSolidAct(async () => {
        await runtime.handleInput({
          key: "character",
          text: "d",
          ctrl: false,
          meta: false,
          shift: false,
        });
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      frame = testSetup.captureCharFrame();
      expect(frame).toContain("Notifications");
      expect(frame).not.toContain("latest notification");
      expect(frame).toContain("older notification");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders session browser details for the current session even before replay events exist", async () => {
    const replaySessions = [
      {
        sessionId: asBrewvaSessionId("archived-session"),
        eventCount: 14,
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
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    runtime.ui.setEditorText("draft line one");
    await openTuiSolidAct(async () => {
      await runtime.handleInput({
        key: "g",
        ctrl: true,
        meta: false,
        shift: false,
      });
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
      expect(frame).toContain("Sessions");
      expect(frame).toContain("fresh-session");
      expect(frame).toContain("archived-session");
      expect(frame).toContain("events: 0");
      expect(frame).toContain("current: yes");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders read tools as compact summaries instead of dumping file contents", async () => {
    const { bundle } = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-read-1",
              name: "read",
              arguments: { path: "src/app.ts", offset: 5, limit: 4 },
            },
          ],
          stopReason: "toolUse",
        },
        {
          role: "toolResult",
          toolCallId: "tool-read-1",
          toolName: "read",
          content: [{ type: "text", text: "const hidden = 1;\nconst visible = 2;" }],
          details: { lines: 2 },
          isError: false,
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
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 120,
        height: 28,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("Read src/app.ts:5-8");
      expect(frame).not.toContain("const hidden = 1;");
      expect(frame).not.toContain('"path": "src/app.ts"');
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders write and edit tools with specialized transcript blocks", async () => {
    const { bundle } = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-write-1",
              name: "write",
              arguments: {
                path: "src/generated.ts",
                content: "export const value = 1;\n",
              },
            },
          ],
          stopReason: "toolUse",
        },
        {
          role: "toolResult",
          toolCallId: "tool-write-1",
          toolName: "write",
          content: [{ type: "text", text: "Successfully wrote 24 bytes to src/generated.ts" }],
          isError: false,
        },
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-edit-1",
              name: "edit",
              arguments: { path: "src/generated.ts" },
            },
          ],
          stopReason: "toolUse",
        },
        {
          role: "toolResult",
          toolCallId: "tool-edit-1",
          toolName: "edit",
          content: [{ type: "text", text: "Successfully replaced 1 block(s)." }],
          details: {
            diff: "--- src/generated.ts\n+++ src/generated.ts\n@@ -1,1 +1,1 @@\n-export const value = 1;\n+export const value = 2;\n",
          },
          isError: false,
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
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 120,
        height: 32,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("Wrote src/generated.ts");
      expect(frame).toContain("export const value = 1;");
      expect(frame).toContain("Edit src/generated.ts");
      expect(frame).toContain("1 + export const value = 2;");
      expect(frame).not.toContain('"content": "export const value = 1;');
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders multi-file patch tool results as per-file native diffs", async () => {
    const { bundle } = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-patch-1",
              name: "apply_patch",
              arguments: { description: "update generated files" },
            },
          ],
          stopReason: "toolUse",
        },
        {
          role: "toolResult",
          toolCallId: "tool-patch-1",
          toolName: "apply_patch",
          content: [{ type: "text", text: "Applied patch to 3 files." }],
          details: {
            files: [
              {
                path: "src/created.ts",
                action: "add",
                diff: "--- /dev/null\n+++ src/created.ts\n@@ -0,0 +1,1 @@\n+export const created = true;\n",
              },
              {
                path: "src/generated.ts",
                action: "modify",
                diff: "--- src/generated.ts\n+++ src/generated.ts\n@@ -1,1 +1,1 @@\n-export const value = 1;\n+export const value = 2;\n",
              },
              {
                path: "src/old.ts",
                action: "delete",
                deletions: 12,
              },
            ],
          },
          isError: false,
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
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 140,
        height: 36,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("Created src/created.ts");
      expect(frame).toContain("Patch src/generated.ts");
      expect(frame).toContain("Deleted src/old.ts");
      expect(frame).toContain("export const created = true;");
      expect(frame).toContain("export const value = 2;");
      expect(frame).toContain("-12 lines");
      expect(frame).not.toContain('"description": "update generated files"');
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders exec tools as shell-style transcript blocks", async () => {
    const { bundle } = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-exec-1",
              name: "exec",
              arguments: {
                command: "bun test",
                workdir: "packages/brewva-cli",
                description: "Run unit tests",
              },
            },
          ],
          stopReason: "toolUse",
        },
        {
          role: "toolResult",
          toolCallId: "tool-exec-1",
          toolName: "exec",
          content: [{ type: "text", text: "1775 pass\n0 fail" }],
          details: { exitCode: 0 },
          isError: false,
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
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 120,
        height: 28,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("Record · Run unit tests");
      expect(frame).toContain("Run unit tests");
      expect(frame).toContain("$ bun test");
      expect(frame).toContain("1775 pass");
      expect(frame).not.toContain('"command": "bun test"');
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("collapses long exec output with an expandable hint", async () => {
    const output = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
    const { bundle } = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-exec-long",
              name: "exec",
              arguments: {
                command: "bun test --verbose",
                description: "Run verbose unit tests",
              },
            },
          ],
          stopReason: "toolUse",
        },
        {
          role: "toolResult",
          toolCallId: "tool-exec-long",
          toolName: "exec",
          content: [{ type: "text", text: output }],
          details: { exitCode: 0 },
          isError: false,
        },
      ],
    });
    const toolRenderCache = createToolRenderCache();
    toolRenderCache.resetForSession("session-1");
    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await runtime.start();
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime, toolRenderCache }),
      {
        width: 120,
        height: 32,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("Run verbose unit tests");
      expect(frame).toContain("line 10");
      expect(frame).not.toContain("line 11");
      expect(frame).toContain("Click to expand 2 more line(s) · 12 lines total");
      expect(countOccurrences(frame, "Click to expand")).toBe(1);
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("uses exec display summaries for collapsed shell output when available", async () => {
    const output = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n");
    const { bundle } = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-exec-summary",
              name: "exec",
              arguments: {
                command: "bun test --verbose",
                description: "Run verbose unit tests",
              },
            },
          ],
          stopReason: "toolUse",
        },
        {
          role: "toolResult",
          toolCallId: "tool-exec-summary",
          toolName: "exec",
          content: [{ type: "text", text: output }],
          details: { exitCode: 1 },
          display: {
            summaryText: "[ExecDistilled]\nstatus: failed\n- error at step 7",
            detailsText: output,
            rawText: output,
          },
          isError: false,
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
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 120,
        height: 32,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("[ExecDistilled]");
      expect(frame).toContain("status: failed");
      expect(frame).toContain("error at step 7");
      expect(frame).not.toContain("line 10");
      expect(frame).toContain("Click to expand 9 more line(s) · 12 lines total");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders generic tool display summaries without dumping structured args", async () => {
    const { bundle } = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-generic-display",
              name: "structured_process",
              arguments: {
                mode: "deep",
                payload: {
                  steps: [
                    { id: "prepare", state: "done" },
                    { id: "execute", state: "done" },
                  ],
                },
              },
            },
          ],
          stopReason: "toolUse",
        },
        {
          role: "toolResult",
          toolCallId: "tool-generic-display",
          toolName: "structured_process",
          content: [
            {
              type: "text",
              text: '{\n  "steps": [\n    "prepare",\n    "execute"\n  ]\n}',
            },
          ],
          details: { status: "completed" },
          display: {
            summaryText: "Structured process completed",
            detailsText: "prepare: done\nexecute: done\ncleanup: skipped",
            rawText: '{\n  "steps": [\n    "prepare",\n    "execute"\n  ]\n}',
          },
          isError: false,
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
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 120,
        height: 32,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("Inspect · structured_process");
      expect(frame).toContain("[mode=deep]");
      expect(frame).toContain("Structured process completed");
      expect(findRenderedColumn(frame, "Inspect · structured_process")).toBe(
        findRenderedColumn(frame, "[mode=deep]"),
      );
      expect(findRenderedColumn(frame, "Structured process completed")).toBe(
        findRenderedColumn(frame, "[mode=deep]"),
      );
      expect(frame).toContain("Click to expand 2 more line(s) · 3 lines total");
      expect(countOccurrences(frame, "Click to expand")).toBe(1);
      expect(frame).not.toContain('"payload"');
      expect(frame).not.toContain('"steps"');
      expect(frame).not.toContain("cleanup: skipped");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("collapses generic raw output with total line count when display summary is absent", async () => {
    const output = Array.from({ length: 8 }, (_, index) => `raw line ${index + 1}`).join("\n");
    const { bundle } = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-generic-raw",
              name: "raw_process",
              arguments: { mode: "raw" },
            },
          ],
          stopReason: "toolUse",
        },
        {
          role: "toolResult",
          toolCallId: "tool-generic-raw",
          toolName: "raw_process",
          content: [{ type: "text", text: output }],
          details: { status: "completed" },
          isError: false,
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
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 120,
        height: 32,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("raw line 5");
      expect(frame).not.toContain("raw line 6");
      expect(frame).toContain("Click to expand 3 more line(s) · 8 lines total");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders generic tools with diff-shaped details through DiffView", async () => {
    const { bundle } = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-git-diff",
              name: "git_diff",
              arguments: { scope: "working-tree" },
            },
          ],
          stopReason: "toolUse",
        },
        {
          role: "toolResult",
          toolCallId: "tool-git-diff",
          toolName: "git_diff",
          content: [{ type: "text", text: "Repository diff generated." }],
          details: {
            diff: "--- src/app.ts\n+++ src/app.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
          },
          isError: false,
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
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 120,
        height: 28,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("Inspect · git_diff");
      expect(frame).toContain("Repository diff generated.");
      expect(frame).toContain("Diff");
      expect(frame).toContain("old");
      expect(frame).toContain("new");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders skill_load tools as compact skill summaries instead of dumping markdown", async () => {
    const skillLoadOutput = [
      "# Skill Loaded: repository-analysis",
      "Category: core",
      "Base directory: /Users/bytedance/new_py/brewva/.brewva/skills/.system/core/repository-analysis",
      "",
      "## Contract",
      "- effect level: read_only",
      "- allowed effects: workspace_read, runtime_observe",
      "- denied effects: workspace_write, local_exec",
      "- preferred tools: read, grep",
      "- fallback tools: glob, lsp_symbols",
      "- cost hint: medium",
      "- default lease: max_tool_calls=60, max_tokens=120000, max_parallel=(unset)",
      "- hard ceiling: max_tool_calls=120, max_tokens=220000, max_parallel=(unset)",
      "- required outputs: repository_snapshot, impact_map",
      "- output contracts: repository_snapshot, impact_map",
      "- required inputs: (none)",
      "- optional inputs: (none)",
      "- readiness: available",
      "- routing scope: core",
      "- routable: yes",
      "",
      "## Resources",
      "- references: /Users/bytedance/new_py/brewva/.brewva/skills/.system/project/shared/critical-rules.md, /Users/bytedance/new_py/brewva/.brewva/skills/.system/project/shared/package-boundaries.md",
      "- scripts: (none)",
      "- heuristics: (none)",
      "- invariants: (none)",
      "",
      "## Instructions",
      "## Project Guidance: critical-rules",
      "# Brewva Project Critical Rules",
      "",
      "Long markdown body that should not dominate the transcript.",
    ].join("\n");
    const { bundle } = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-skill-load-1",
              name: "skill_load",
              arguments: { name: "repository-analysis" },
            },
          ],
          stopReason: "toolUse",
        },
        {
          role: "toolResult",
          toolCallId: "tool-skill-load-1",
          toolName: "skill_load",
          content: [{ type: "text", text: skillLoadOutput }],
          details: {
            ok: true,
            skill: "repository-analysis",
            skillReadiness: { readiness: "available" },
          },
          isError: false,
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
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 120,
        height: 32,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain('Skill "repository-analysis"');
      expect(frame).toContain("core");
      expect(frame).toContain("read_only");
      expect(frame).toContain("available");
      expect(frame).toContain("read, grep");
      expect(frame).toContain("references 2");
      expect(frame).not.toContain("# Skill Loaded");
      expect(frame).not.toContain("## Instructions");
      expect(frame).not.toContain("Brewva Project Critical Rules");
      expect(frame).not.toContain("Long markdown body");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("navigates the transcript with home and end keys through the native scrollbox", async () => {
    const { bundle } = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content: Array.from({ length: 120 }, (_, index) => `Line ${index + 1}`).join("\n"),
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
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 100,
        height: 24,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      expect(runtime.getViewState().transcript.followMode).toBe("live");
      expect(runtime.getViewState().composer.text).toBe("");

      await openTuiSolidAct(async () => {
        await runtime.handleInput({
          key: "home",
          ctrl: false,
          meta: false,
          shift: false,
        });
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      expect(runtime.getViewState().transcript.followMode).toBe("scrolled");
      expect(runtime.getViewState().transcript.scrollOffset).toBeGreaterThan(0);
      expect(runtime.getViewState().composer.text).toBe("");

      await openTuiSolidAct(async () => {
        await runtime.handleInput({
          key: "end",
          ctrl: false,
          meta: false,
          shift: false,
        });
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      expect(runtime.getViewState().transcript.followMode).toBe("live");
      expect(runtime.getViewState().transcript.scrollOffset).toBe(0);
      expect(runtime.getViewState().composer.text).toBe("");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("pages the transcript viewport through native scrollbox navigation", async () => {
    const { bundle } = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content: Array.from({ length: 120 }, (_, index) => `Line ${index + 1}`).join("\n"),
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
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { runtime: runtime }),
      {
        width: 100,
        height: 24,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      await openTuiSolidAct(async () => {
        await runtime.handleInput({
          key: "home",
          ctrl: false,
          meta: false,
          shift: false,
        });
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const topOffset = runtime.getViewState().transcript.scrollOffset;
      expect(topOffset).toBeGreaterThan(0);

      await openTuiSolidAct(async () => {
        for (let index = 0; index < 5; index += 1) {
          await runtime.handleInput({
            key: "pagedown",
            ctrl: false,
            meta: false,
            shift: false,
          });
        }
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      expect(runtime.getViewState().transcript.scrollOffset).toBeLessThan(topOffset);
      expect(runtime.getViewState().transcript.scrollOffset).toBeGreaterThan(0);
      expect(runtime.getViewState().transcript.followMode).toBe("scrolled");
      expect(runtime.getViewState().composer.text).toBe("");
    } finally {
      runtime.dispose();
      testSetup.renderer.destroy();
    }
  });
});
