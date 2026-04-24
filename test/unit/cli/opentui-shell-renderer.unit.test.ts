import { describe, expect, test } from "bun:test";
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
  resolveDialogContentWidth,
  resolveDialogSurfaceDimensions,
  resolveDialogWidth,
  resolveToastMaxWidth,
} from "../../../packages/brewva-cli/runtime/shell/overlay-style.js";
import { createToolRenderCache } from "../../../packages/brewva-cli/runtime/shell/tool-render.js";
import { CliShellController } from "../../../packages/brewva-cli/src/shell/controller.js";
import type { CliShellSessionBundle } from "../../../packages/brewva-cli/src/shell/types.js";

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

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    controller.ui.notify("Solid shell notice", "info");

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
      {
        width: 100,
        height: 36,
      },
    );

    try {
      await openTuiSolidAct(async () => {
        await Bun.sleep(CliShellController.STATUS_DEBOUNCE_MS + 20);
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("Brewva");
      expect(frame).toContain("Solid");
      expect(frame).toContain("notice");
    } finally {
      controller.dispose();
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
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
      {
        width: 100,
        height: 24,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      expect(testSetup.captureCharFrame()).toContain("openai/alpha");

      controller.ui.setEditorText("/models beta");
      await openTuiSolidAct(async () => {
        await controller.handleSemanticInput({
          key: "enter",
          ctrl: false,
          meta: false,
          shift: false,
        });
        await controller.handleSemanticInput({
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
      controller.dispose();
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

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    controller.ui.notify("Heads up", "warning");
    controller.ui.setEditorText("/ins");
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
      {
        width: 100,
        height: 36,
      },
    );

    try {
      await openTuiSolidAct(async () => {
        await Bun.sleep(CliShellController.STATUS_DEBOUNCE_MS + 20);
      });
      const frame = await waitForRenderedFrame(testSetup, {
        predicate: (candidate) =>
          candidate.includes("▣ Brewva") &&
          candidate.includes("Hello from Brewva") &&
          candidate.includes("/insights"),
      });
      expect(frame).toContain("▣ Brewva");
      expect(frame).toContain("Hello from Brewva");
      expect(frame).toContain("warning");
      expect(frame).toContain("Heads");
      expect(frame).toContain("/insights");
      expect(frame).toContain("┃  /ins");
    } finally {
      controller.dispose();
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

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    controller.ui.setEditorText("/qu");
    await controller.handleSemanticInput({
      key: "down",
      ctrl: false,
      meta: false,
      shift: false,
    });

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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
      expect(controller.getState().composer.completion?.selectedIndex).toBe(1);
      expect(
        controller.getState().composer.completion?.items[
          controller.getState().composer.completion?.selectedIndex ?? 0
        ],
      ).toMatchObject({
        value: "questions",
      });
    } finally {
      controller.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders command palette metadata from the command provider", async () => {
    const { bundle } = createFakeBundle();

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    await controller.handleSemanticInput({
      key: "k",
      ctrl: true,
      meta: false,
      shift: false,
    });

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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
      controller.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders help hub with command palette entry and navigation hints", async () => {
    const { bundle } = createFakeBundle();

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    controller.ui.setEditorText("/help");
    await controller.handleSemanticInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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
      controller.dispose();
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
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
      {
        width: 100,
        height: 36,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      const message = controller
        .getState()
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
      controller.dispose();
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
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
      {
        width: 100,
        height: 30,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      const message = controller
        .getState()
        .transcript.messages.find((candidate) => candidate.role === "assistant");
      const reasoningPart = message?.parts.find((part) => part.type === "reasoning");
      expect(reasoningPart).toBeDefined();

      const rendererInspector = testSetup.renderer as unknown as OpenTuiTestRendererInspector;
      expect(rendererInspector.root.findDescendantById(`text-${reasoningPart!.id}`)).toBeDefined();

      controller.ui.setEditorText("/thinking");
      await controller.handleSemanticInput({
        key: "enter",
        ctrl: false,
        meta: false,
        shift: false,
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      expect(controller.getState().view.showThinking).toBe(false);
      expect(
        rendererInspector.root.findDescendantById(`text-${reasoningPart!.id}`),
      ).toBeUndefined();
    } finally {
      controller.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("keeps streamed assistant text on the OpenTUI streaming code path", async () => {
    const fixture = createFakeBundle();
    const { bundle } = fixture;
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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

      const message = controller
        .getState()
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
          content: [{ type: "text", text: "Streaming text done" }],
          stopReason: "endTurn",
        },
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      const finalizedTextBlock = rendererInspector.root.findDescendantById(
        `text-${textPart!.id}:block:0`,
      );
      const finalizedRenderable = finalizedTextBlock?.getChildren()[0];
      expect(finalizedRenderable).toBe(streamingRenderable);
      expect(
        (
          finalizedRenderable as
            | { constructor?: { name?: string }; streaming?: boolean }
            | undefined
        )?.constructor?.name,
      ).toBe("CodeRenderable");
      expect((finalizedRenderable as { streaming?: boolean } | undefined)?.streaming).toBe(true);
      expect(
        (finalizedRenderable as { drawUnstyledText?: boolean } | undefined)?.drawUnstyledText,
      ).toBe(false);
    } finally {
      controller.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("routes global semantic keybindings through the Solid shell keyboard transport", async () => {
    const { bundle } = createFakeBundle();
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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

      expect(controller.getState().overlay.active?.kind).toBe("approval");
    } finally {
      controller.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("updates model picker highlight when keyboard navigation changes selection", async () => {
    const { bundle } = createFakeBundle();
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    controller.openOverlay({
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
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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

      expect(controller.getState().overlay.active?.payload).toMatchObject({
        kind: "modelPicker",
        selectedIndex: 1,
      });
      expect(frame).toContain("Beta openai/beta");
    } finally {
      controller.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders long model picker rows as one clipped line with a short footer", async () => {
    const { bundle } = createFakeBundle();
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    controller.openOverlay({
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
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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
      controller.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders provider picker with the OpenCode dialog-select shell", async () => {
    const { bundle } = createFakeBundle();
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    controller.openOverlay({
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
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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
      controller.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders OAuth wait dialog with copyable URL fallback", async () => {
    const { bundle } = createFakeBundle();
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });
    const copiedText: string[] = [];
    const authUrl =
      "https://auth.openai.com/oauth/authorize?client_id=brewva-test&redirect_uri=http://localhost:1455/auth/callback&state=tail-marker";

    await controller.start();
    controller.ui.copyText = async (text: string) => {
      copiedText.push(text);
    };
    controller.openOverlay({
      kind: "oauthWait",
      title: "ChatGPT Pro/Plus (browser)",
      url: authUrl,
      instructions: "Complete authorization in your browser. Brewva will continue automatically.",
    });

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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
      expect(controller.getState().notifications.at(-1)).toMatchObject({
        level: "info",
        message: "Copied to clipboard.",
      });
    } finally {
      controller.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders OAuth manual callback input with keyboard entry", async () => {
    const { bundle } = createFakeBundle();
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });
    const submittedCodes: string[] = [];
    const authUrl =
      "https://auth.openai.com/oauth/authorize?client_id=brewva-test&redirect_uri=http://localhost:1455/auth/callback&state=tail-marker";

    await controller.start();
    controller.openOverlay({
      kind: "oauthWait",
      title: "ChatGPT Pro/Plus (browser)",
      url: authUrl,
      instructions: "Authorize in browser.",
      manualCodePrompt: "Paste the final redirect URL or authorization code.",
      async submitManualCode(code: string) {
        submittedCodes.push(code);
      },
    });

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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
    } finally {
      controller.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("copies selected OpenTUI text with ctrl+c before semantic key handling", async () => {
    const { bundle } = createFakeBundle();
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });
    const selection = createFakeSelectionRenderer("Selected transcript text");
    const copiedText: string[] = [];

    await controller.start();

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, {
        controller,
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
      expect(controller.getState().notifications.at(-1)).toMatchObject({
        level: "info",
        message: "Copied to clipboard.",
      });
    } finally {
      controller.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("wires OpenTUI console copy-selection actions to the shell clipboard", async () => {
    const { bundle } = createFakeBundle();
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });
    const selection = createFakeSelectionRenderer("");
    const copiedText: string[] = [];

    await controller.start();

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, {
        controller,
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
      expect(controller.getState().notifications.at(-1)).toMatchObject({
        level: "info",
        message: "Copied to clipboard.",
      });
    } finally {
      controller.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("ctrl+a with no pending approvals renders a visible empty state instead of a blank overlay", async () => {
    const { bundle } = createFakeBundle();
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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
      expect(controller.getState().overlay.active?.kind).toBe("approval");
      expect(frame).toContain("No pending approvals.");
      expect(frame).toContain(
        "Brewva will show permission requests here when a tool needs approval.",
      );
    } finally {
      controller.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("ctrl+o with no pending operator input renders a visible empty state instead of a blank overlay", async () => {
    const { bundle } = createFakeBundle();
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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
      expect(controller.getState().overlay.active?.kind).toBe("question");
      expect(frame).toContain("No pending operator input.");
      expect(frame).toContain("Brewva will show pending input requests and follow-up questions");
      expect(frame).toContain("your input.");
    } finally {
      controller.dispose();
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
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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

      await openTuiSolidAct(async () => {
        await (
          controller as unknown as { switchBundle(bundle: CliShellSessionBundle): Promise<void> }
        ).switchBundle(secondBundle);
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      frame = testSetup.captureCharFrame();
      expect(frame).toContain("tool:second");
      expect(frame).not.toContain("leak:second");
    } finally {
      controller.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders the prompt action bar with live session status", async () => {
    const { bundle } = createFakeBundle();
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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
      expect(frame).toContain("idle");
      expect(frame).toContain("approvals=0");
      expect(frame).toContain("questions=0");
    } finally {
      controller.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders the OpenCode-style inline approval prompt", async () => {
    const { bundle } = createFakeBundle();
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    controller.openOverlay({
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
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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
      expect(frame).toContain("Permission required");
      expect(frame).toContain("Tool: write");
      expect(frame).toContain("Boundary: effectful");
    } finally {
      controller.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders inline approval diff preview with fullscreen hint", async () => {
    const { bundle } = createFakeBundle();
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    controller.openOverlay({
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
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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

      await controller.handleSemanticInput({
        key: "f",
        ctrl: true,
        meta: false,
        shift: false,
      });
      await testSetup.renderOnce();
      frame = testSetup.captureCharFrame();
      expect(controller.getState().overlay.active?.payload).toMatchObject({
        kind: "approval",
        previewExpanded: true,
      });
      expect(frame).toContain("ctrl+f minimize");
    } finally {
      controller.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders the OpenCode-style inline question prompt", async () => {
    const { bundle } = createFakeBundle();
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    controller.openOverlay({
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
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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
      controller.dispose();
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
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    controller.openOverlay({
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
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
      {
        width: 100,
        height: 28,
      },
    );

    try {
      await testSetup.renderOnce();
      await openTuiSolidAct(async () => {
        await controller.handleSemanticInput({
          key: "enter",
          ctrl: false,
          meta: false,
          shift: false,
        });
      });
      await openTuiSolidAct(async () => {
        await controller.handleSemanticInput({
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
      controller.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders structured inspect overlays with section navigation and details", async () => {
    const { bundle } = createFakeBundle();
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    controller.openOverlay({
      kind: "inspect",
      lines: ["legacy inspect text"],
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
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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
      controller.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("scrolls pager overlays through semantic page-down input", async () => {
    const { bundle } = createFakeBundle();
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    controller.openOverlay({
      kind: "pager",
      lines: Array.from({ length: 40 }, (_, index) => `line-${index + 1}`),
      title: "Task Details",
      scrollOffset: 0,
    });

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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
        await controller.handleSemanticInput({
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
      controller.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("drills from inspect sections into a pager and returns on escape", async () => {
    const { bundle } = createFakeBundle();
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    controller.openOverlay({
      kind: "inspect",
      lines: ["legacy inspect text"],
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
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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
        await controller.handleSemanticInput({
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
        await controller.handleSemanticInput({
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
      controller.dispose();
      testSetup.renderer.destroy();
    }
  });

  test("renders the notification inbox and supports dismissing the selected item", async () => {
    const { bundle } = createFakeBundle();
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    controller.ui.notify("older notification", "info");
    controller.ui.notify("latest notification", "warning");

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
      {
        width: 100,
        height: 28,
      },
    );

    try {
      await openTuiSolidAct(async () => {
        await controller.handleSemanticInput({
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
        await controller.handleSemanticInput({
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
      controller.dispose();
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
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    controller.ui.setEditorText("draft line one");
    await openTuiSolidAct(async () => {
      await controller.handleSemanticInput({
        key: "g",
        ctrl: true,
        meta: false,
        shift: false,
      });
    });

    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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
      controller.dispose();
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

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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
      controller.dispose();
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

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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
      controller.dispose();
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

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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
      controller.dispose();
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

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
      {
        width: 120,
        height: 28,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("Run unit tests");
      expect(frame).toContain("$ bun test");
      expect(frame).toContain("1775 pass");
      expect(frame).not.toContain('"command": "bun test"');
    } finally {
      controller.dispose();
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
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller, toolRenderCache }),
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
      controller.dispose();
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
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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
      controller.dispose();
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

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
      {
        width: 120,
        height: 32,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("structured_process · completed");
      expect(frame).toContain("[mode=deep]");
      expect(frame).toContain("Structured process completed");
      expect(findRenderedColumn(frame, "structured_process · completed")).toBe(
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
      controller.dispose();
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

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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
      controller.dispose();
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

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
      {
        width: 120,
        height: 28,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("git_diff · completed");
      expect(frame).toContain("Repository diff generated.");
      expect(frame).toContain("Diff");
      expect(frame).toContain("old");
      expect(frame).toContain("new");
    } finally {
      controller.dispose();
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

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
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
      controller.dispose();
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

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
      {
        width: 100,
        height: 24,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      expect(controller.getState().transcript.followMode).toBe("live");
      expect(controller.getState().composer.text).toBe("");

      await openTuiSolidAct(async () => {
        await controller.handleSemanticInput({
          key: "home",
          ctrl: false,
          meta: false,
          shift: false,
        });
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      expect(controller.getState().transcript.followMode).toBe("scrolled");
      expect(controller.getState().transcript.scrollOffset).toBeGreaterThan(0);
      expect(controller.getState().composer.text).toBe("");

      await openTuiSolidAct(async () => {
        await controller.handleSemanticInput({
          key: "end",
          ctrl: false,
          meta: false,
          shift: false,
        });
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      expect(controller.getState().transcript.followMode).toBe("live");
      expect(controller.getState().transcript.scrollOffset).toBe(0);
      expect(controller.getState().composer.text).toBe("");
    } finally {
      controller.dispose();
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

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
      {
        width: 100,
        height: 24,
      },
    );

    try {
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      await openTuiSolidAct(async () => {
        await controller.handleSemanticInput({
          key: "home",
          ctrl: false,
          meta: false,
          shift: false,
        });
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const topOffset = controller.getState().transcript.scrollOffset;
      expect(topOffset).toBeGreaterThan(0);

      await openTuiSolidAct(async () => {
        for (let index = 0; index < 5; index += 1) {
          await controller.handleSemanticInput({
            key: "pagedown",
            ctrl: false,
            meta: false,
            shift: false,
          });
        }
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();

      expect(controller.getState().transcript.scrollOffset).toBeLessThan(topOffset);
      expect(controller.getState().transcript.scrollOffset).toBeGreaterThan(0);
      expect(controller.getState().transcript.followMode).toBe("scrolled");
      expect(controller.getState().composer.text).toBe("");
    } finally {
      controller.dispose();
      testSetup.renderer.destroy();
    }
  });
});
