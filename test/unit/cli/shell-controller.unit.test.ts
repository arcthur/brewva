import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrewvaReplaySession, SessionWireFrame } from "@brewva/brewva-runtime";
import {
  buildBrewvaPromptText,
  type BrewvaPromptContentPart,
  type BrewvaPromptSessionEvent,
  type BrewvaToolUiPort,
} from "@brewva/brewva-substrate";
import { DEFAULT_TUI_THEME } from "@brewva/brewva-tui";
import { CliShellController } from "../../../packages/brewva-cli/src/shell/controller.js";
import { createCliShellPromptStore } from "../../../packages/brewva-cli/src/shell/prompt-store.js";
import type { CliShellSessionBundle } from "../../../packages/brewva-cli/src/shell/types.js";

function createFakeBundle(
  options: {
    promptHandler?: (text: string) => Promise<void>;
    sessionId?: string;
    replaySessions?: BrewvaReplaySession[];
    sessionWireBySessionId?: Record<string, SessionWireFrame[]>;
  } = {},
) {
  let attachedUi: BrewvaToolUiPort | undefined;
  let sessionListener: ((event: BrewvaPromptSessionEvent) => void) | undefined;
  const approvalDecisions: Array<{ requestId: string; input: unknown }> = [];
  const sessionId = options.sessionId ?? "session-1";
  const replaySessions = options.replaySessions ?? [
    {
      sessionId,
      eventCount: 1,
      lastEventAt: Date.now(),
    },
  ];

  const session = {
    model: {
      provider: "openai",
      id: "gpt-5.4-mini",
    },
    thinkingLevel: "high",
    isStreaming: false,
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
      buildSessionContext() {
        return { messages: [] };
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
    async prompt(parts: readonly BrewvaPromptContentPart[]) {
      await options.promptHandler?.(buildBrewvaPromptText(parts));
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
    runtime: {
      authority: {
        proposals: {
          decideEffectCommitment(_sessionId: string, requestId: string, input: unknown) {
            approvalDecisions.push({ requestId, input });
          },
        },
      },
      inspect: {
        proposals: {
          listPendingEffectCommitments() {
            return [];
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
    approvalDecisions,
  };
}

describe("shell controller", () => {
  test("attaches the shell ui port to the managed session", () => {
    const { bundle, getAttachedUi } = createFakeBundle();

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    expect(getAttachedUi()).toBe(controller.ui);
    controller.dispose();
  });

  test("routes theme selection through shell state so the renderer can react to it", () => {
    const { bundle } = createFakeBundle();

    const controller = new CliShellController(bundle, {
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

    expect(controller.getState().theme).toEqual(DEFAULT_TUI_THEME);
    expect(controller.ui.getTheme("default")).toEqual(DEFAULT_TUI_THEME);
    expect(controller.ui.getAllThemes()).toEqual([
      { name: "default" },
      { name: "graphite" },
      { name: "paper" },
    ]);
    expect(controller.ui.setTheme(customTheme)).toEqual({ success: true });
    expect(controller.getState().theme).toEqual(customTheme);
    expect(controller.ui.theme).toEqual(customTheme);
    controller.dispose();
  });

  test("handles theme shell commands for listing and switching built-in themes", async () => {
    const { bundle } = createFakeBundle();

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    controller.ui.setEditorText("/theme list");
    await controller.handleSemanticInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(controller.getState().notifications.at(-1)).toMatchObject({
      level: "info",
      message: "Available themes: default, graphite, paper",
    });

    controller.ui.setEditorText("/theme paper");
    await controller.handleSemanticInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(controller.getState().theme.name).toBe("paper");

    controller.ui.setEditorText("/theme missing");
    await controller.handleSemanticInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(controller.getState().notifications.at(-1)).toMatchObject({
      level: "warning",
      message: "Unknown theme selection.",
    });
    controller.dispose();
  });

  test("modal approval overlays suspend composer input and support reject shortcuts", async () => {
    const { bundle, approvalDecisions } = createFakeBundle();

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    controller.ui.setEditorText("draft");
    controller.openOverlay(
      {
        kind: "approval",
        selectedIndex: 0,
        snapshot: {
          approvals: [
            {
              requestId: "approval-1",
              proposalId: "proposal-1",
              toolName: "write_file",
              toolCallId: "tool-call-1",
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

    const consumedCharacter = await controller.handleSemanticInput({
      key: "character",
      text: "x",
      ctrl: false,
      meta: false,
      shift: false,
    });
    expect(consumedCharacter).toBe(true);
    expect(controller.ui.getEditorText()).toBe("draft");
    expect(approvalDecisions).toHaveLength(0);

    const consumedReject = await controller.handleSemanticInput({
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
    expect(controller.ui.getEditorText()).toBe("draft");
    controller.dispose();
  });

  test("question overlays seed an answer command into the composer on primary action", async () => {
    const { bundle } = createFakeBundle();

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    controller.openOverlay(
      {
        kind: "question",
        selectedIndex: 0,
        snapshot: {
          approvals: [],
          questions: [
            {
              questionId: "question-1",
              sessionId: "session-1",
              createdAt: Date.now(),
              sourceKind: "delegation",
              sourceEventId: "event-1",
              sourceLabel: "operator",
              questionText: "Proceed with deployment?",
            },
          ],
          taskRuns: [],
          sessions: [],
        },
      },
      "queued",
    );

    const consumedEnter = await controller.handleSemanticInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(consumedEnter).toBe(true);
    expect(controller.getState().overlay.active).toBeUndefined();
    expect(controller.ui.getEditorText()).toBe("/answer question-1 ");
    controller.dispose();
  });

  test("streaming transcript updates preserve slash completion metadata and selection", async () => {
    const fixture = createFakeBundle();
    const { bundle } = fixture;

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    controller.ui.setEditorText("/qu");

    // Fuzzy sort: "/quit" (prefix score 1000-4=996) ranks above "/questions" (1000-9=991).
    const initialCompletion = controller.getState().composer.completion;
    expect(initialCompletion).toMatchObject({
      kind: "slash",
      query: "qu",
      selectedIndex: 0,
    });
    expect(initialCompletion?.items[0]).toMatchObject({ value: "quit" });
    expect(initialCompletion?.items[1]).toMatchObject({ value: "questions" });

    await controller.handleSemanticInput({
      key: "down",
      ctrl: false,
      meta: false,
      shift: false,
    });

    // After "down", selectedIndex moves to index 1 (questions).
    expect(controller.getState().composer.completion?.items.at(1)).toMatchObject({
      value: "questions",
      description: "List unresolved operator questions.",
    });
    expect(controller.getState().composer.completion?.selectedIndex).toBe(1);

    fixture.emitSessionEvent({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Streaming update while typing." }],
        stopReason: "toolUse",
      },
    });

    // Streaming event must not reset the completion state.
    expect(controller.ui.getEditorText()).toBe("/qu");
    expect(controller.getState().composer.completion?.selectedIndex).toBe(1);
    expect(
      controller.getState().composer.completion?.items[
        controller.getState().composer.completion?.selectedIndex ?? 0
      ],
    ).toMatchObject({
      value: "questions",
      description: "List unresolved operator questions.",
    });

    controller.dispose();
  });

  test("composer history navigates from input boundaries and restores the in-flight draft", async () => {
    const prompts: string[] = [];
    const { bundle } = createFakeBundle({
      promptHandler: async (text) => {
        prompts.push(text);
      },
    });

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    controller.ui.setEditorText("first prompt");
    await controller.handleSemanticInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    controller.ui.setEditorText("second prompt");
    await controller.handleSemanticInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(prompts).toEqual(["first prompt", "second prompt"]);

    controller.ui.setEditorText("draft now");
    expect(
      controller.wantsSemanticInput({
        key: "up",
        ctrl: false,
        meta: false,
        shift: false,
      }),
    ).toBe(false);

    controller.syncComposerFromEditor("draft now", 0);
    expect(
      controller.wantsSemanticInput({
        key: "up",
        ctrl: false,
        meta: false,
        shift: false,
      }),
    ).toBe(true);

    await controller.handleSemanticInput({
      key: "up",
      ctrl: false,
      meta: false,
      shift: false,
    });
    expect(controller.ui.getEditorText()).toBe("second prompt");
    expect(controller.getState().composer.cursor).toBe(0);

    await controller.handleSemanticInput({
      key: "up",
      ctrl: false,
      meta: false,
      shift: false,
    });
    expect(controller.ui.getEditorText()).toBe("first prompt");
    expect(controller.getState().composer.cursor).toBe(0);

    controller.syncComposerFromEditor("first prompt", "first prompt".length);
    await controller.handleSemanticInput({
      key: "down",
      ctrl: false,
      meta: false,
      shift: false,
    });
    expect(controller.ui.getEditorText()).toBe("second prompt");
    expect(controller.getState().composer.cursor).toBe("second prompt".length);

    controller.syncComposerFromEditor("second prompt", "second prompt".length);
    await controller.handleSemanticInput({
      key: "down",
      ctrl: false,
      meta: false,
      shift: false,
    });
    expect(controller.ui.getEditorText()).toBe("draft now");
    expect(controller.getState().composer.cursor).toBe("draft now".length);

    controller.dispose();
  });

  test("slash completion escape clears partial command text and reopens on next typed slash", async () => {
    const fixture = createFakeBundle();
    const { bundle } = fixture;
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    controller.ui.setEditorText("/qu");
    expect(controller.getState().composer.completion).toMatchObject({
      kind: "slash",
      query: "qu",
    });

    // Escape on an incomplete "/command" clears the text entirely (opencode parity).
    await controller.handleSemanticInput({
      key: "escape",
      ctrl: false,
      meta: false,
      shift: false,
    });
    expect(controller.getState().composer.text).toBe("");
    expect(controller.getState().composer.completion).toBeUndefined();

    fixture.emitSessionEvent({
      type: "message_update",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "streaming while completion is dismissed" }],
        stopReason: "toolUse",
      },
    });
    expect(controller.getState().composer.completion).toBeUndefined();

    // After clearing, the user can type a new slash command and completion reopens.
    controller.ui.setEditorText("/qui");
    const afterReopen = controller.getState().composer.completion;
    expect(afterReopen).toMatchObject({ kind: "slash", query: "qui" });
    // "/quit" is the best match for "qui" (prefix: 1000-4=996).
    expect(afterReopen?.items[0]).toMatchObject({ value: "quit" });

    controller.dispose();
  });

  test("slash completion closes after a trailing space and path completion expands directories on tab", async () => {
    const { bundle } = createFakeBundle();
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    controller.ui.setEditorText("/quit ");
    expect(controller.getState().composer.completion).toBeUndefined();

    controller.ui.setEditorText("@pack");
    const completion = controller.getState().composer.completion;
    expect(completion).toMatchObject({
      kind: "path",
    });

    const directoryIndex =
      completion?.items.findIndex(
        (item) => item.kind === "path" && item.detail === "directory" && item.value === "packages/",
      ) ?? -1;
    expect(directoryIndex).toBeGreaterThanOrEqual(0);

    controller.setCompletionSelection(directoryIndex);
    await controller.handleSemanticInput({
      key: "tab",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(controller.ui.getEditorText()).toBe("@packages/");
    expect(controller.getState().composer.completion).toMatchObject({
      kind: "path",
      query: "packages/",
    });

    controller.dispose();
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

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      promptStore,
    });

    try {
      controller.ui.setEditorText("review @READ");
      const completion = controller.getState().composer.completion;
      const fileIndex =
        completion?.items.findIndex(
          (item) => item.kind === "path" && item.detail === "file" && item.value === "README.md",
        ) ?? -1;
      expect(fileIndex).toBeGreaterThanOrEqual(0);

      controller.setCompletionSelection(fileIndex);
      await controller.handleSemanticInput({
        key: "tab",
        ctrl: false,
        meta: false,
        shift: false,
      });

      expect(controller.ui.getEditorText()).toBe("review @README.md");
      expect(controller.getState().composer.parts).toEqual([
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

      await controller.handleSemanticInput({
        key: "escape",
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
      expect(prompts).toEqual(["review @README.md"]);

      controller.dispose();

      const restored = new CliShellController(bundle, {
        cwd: process.cwd(),
        openSession: async () => bundle,
        createSession: async () => bundle,
        promptStore,
      });

      try {
        expect(
          restored.wantsSemanticInput({
            key: "up",
            ctrl: false,
            meta: false,
            shift: false,
          }),
        ).toBe(true);

        await restored.handleSemanticInput({
          key: "up",
          ctrl: false,
          meta: false,
          shift: false,
        });

        expect(restored.ui.getEditorText()).toBe("review @README.md");
        expect(restored.getState().composer.parts).toEqual([
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

  test("stashing the current prompt persists it and ctrl+y restores the latest stashed prompt", async () => {
    const promptRoot = mkdtempSync(join(tmpdir(), "brewva-cli-prompt-stash-"));
    const promptStore = createCliShellPromptStore({ rootDir: promptRoot });
    const { bundle } = createFakeBundle();

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      promptStore,
    });

    try {
      controller.ui.setEditorText("stash @READ");
      const completion = controller.getState().composer.completion;
      const fileIndex =
        completion?.items.findIndex(
          (item) => item.kind === "path" && item.detail === "file" && item.value === "README.md",
        ) ?? -1;
      expect(fileIndex).toBeGreaterThanOrEqual(0);

      controller.setCompletionSelection(fileIndex);
      await controller.handleSemanticInput({
        key: "tab",
        ctrl: false,
        meta: false,
        shift: false,
      });

      await controller.handleSemanticInput({
        key: "s",
        ctrl: true,
        meta: false,
        shift: false,
      });

      expect(controller.ui.getEditorText()).toBe("");
      expect(controller.getState().composer.parts).toEqual([]);
      expect(controller.getState().notifications.at(-1)).toMatchObject({
        level: "info",
        message: "Stashed prompt: stash @README.md. Press Ctrl+Y to restore the latest draft.",
      });

      controller.dispose();

      const restored = new CliShellController(bundle, {
        cwd: process.cwd(),
        openSession: async () => bundle,
        createSession: async () => bundle,
        promptStore,
      });

      try {
        await restored.handleSemanticInput({
          key: "y",
          ctrl: true,
          meta: false,
          shift: false,
        });

        expect(restored.ui.getEditorText()).toBe("stash @README.md");
        expect(restored.getState().composer.parts).toEqual([
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
        expect(restored.getState().notifications.at(-1)).toMatchObject({
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
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await controller.handleSemanticInput({
      key: "y",
      ctrl: true,
      meta: false,
      shift: false,
    });

    expect(controller.getState().notifications.at(-1)).toMatchObject({
      level: "warning",
      message: "No stashed prompts yet. Press Ctrl+S to stash the current prompt first.",
    });

    controller.dispose();
  });

  test("ctrl+s warns clearly when there is no prompt to stash", async () => {
    const { bundle } = createFakeBundle();
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await controller.handleSemanticInput({
      key: "s",
      ctrl: true,
      meta: false,
      shift: false,
    });

    expect(controller.getState().notifications.at(-1)).toMatchObject({
      level: "warning",
      message: "Nothing to stash yet. Type a prompt, then press Ctrl+S.",
    });

    controller.dispose();
  });

  test("slash stash warns clearly when no stashed prompts are available", async () => {
    const promptRoot = mkdtempSync(join(tmpdir(), "brewva-cli-prompt-stash-empty-"));
    const promptStore = createCliShellPromptStore({ rootDir: promptRoot });
    const { bundle } = createFakeBundle();
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      promptStore,
    });

    try {
      await controller.start();
      controller.ui.setEditorText("/stash ");
      await controller.handleSemanticInput({
        key: "enter",
        ctrl: false,
        meta: false,
        shift: false,
      });

      expect(controller.getState().notifications.at(-1)).toMatchObject({
        level: "warning",
        message: "No stashed prompts yet. Press Ctrl+S to stash the current prompt first.",
      });
    } finally {
      controller.dispose();
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

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    controller.ui.setEditorText("ship it");
    const submitInput = {
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    } as const;

    const firstSubmit = controller.handleSemanticInput(submitInput);
    const secondSubmit = controller.handleSemanticInput(submitInput);

    await Bun.sleep(0);
    expect(prompts).toEqual(["ship it"]);
    resolvePrompt?.();
    await firstSubmit;
    await secondSubmit;
    expect(prompts).toEqual(["ship it"]);
    controller.dispose();
  });

  test("user message appears exactly once even when session emits message_end for the user turn", async () => {
    const fixture = createFakeBundle();
    const { bundle } = fixture;

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    controller.ui.setEditorText("你是谁");
    await controller.handleSemanticInput({
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

    const userMessages = controller.getState().transcript.messages.filter((m) => m.role === "user");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]?.parts[0]).toMatchObject({ type: "text", text: "你是谁" });

    controller.dispose();
  });

  test("surfaces semantic input failures as notifications instead of rejecting the key handler", async () => {
    const { bundle } = createFakeBundle({
      promptHandler: async () => {
        throw new Error("prompt exploded");
      },
    });

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    controller.ui.setEditorText("trigger failure");
    const consumed = await controller.handleSemanticInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(consumed).toBe(true);
    expect(controller.getState().notifications.at(-1)).toMatchObject({
      level: "error",
      message: "prompt exploded",
    });
    controller.dispose();
  });

  test("surfaces assistant errors as notifications and transcript entries", async () => {
    const fixture = createFakeBundle();
    const { bundle } = fixture;

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();
    fixture.emitSessionEvent({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        errorMessage: "No API key for provider: openai-codex",
        content: [],
      },
    });

    expect(controller.getState().notifications.at(-1)).toMatchObject({
      level: "error",
      message: "No API key for provider: openai-codex",
    });
    expect(
      controller
        .getState()
        .transcript.messages.some(
          (message) =>
            message.role === "assistant" &&
            message.parts.some(
              (part) =>
                part.type === "text" && part.text.includes("No API key for provider: openai-codex"),
            ),
        ),
    ).toBe(true);

    controller.dispose();
  });

  test("groups assistant reasoning and tool execution updates into transcript parts", async () => {
    const fixture = createFakeBundle();
    const { bundle } = fixture;

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
      operatorPollIntervalMs: 60_000,
    });

    await controller.start();

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
      type: "message_update",
      message: partialAssistantMessage,
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 2,
        toolCall: partialAssistantMessage.content[2] as {
          type: "toolCall";
          id: string;
          name: string;
          arguments: Record<string, unknown>;
        },
        partial: partialAssistantMessage,
      },
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

    expect(controller.getState().transcript.messages).toHaveLength(1);
    expect(controller.getState().transcript.messages[0]).toMatchObject({
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

    controller.dispose();
  });

  test("rebuilds assistant transcript from assistantMessageEvent.partial when message_update omits message", async () => {
    const fixture = createFakeBundle();
    const { bundle } = fixture;
    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    await controller.start();

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

    fixture.emitSessionEvent({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 2,
        toolCall: partialAssistantMessage.content[2] as {
          type: "toolCall";
          id: string;
          name: string;
          arguments: Record<string, unknown>;
        },
        partial: partialAssistantMessage,
      },
    });

    expect(controller.getState().transcript.messages).toHaveLength(1);
    expect(controller.getState().transcript.messages[0]).toMatchObject({
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

    controller.dispose();
  });

  test("inspect overlays drill down into a pager and restore inspect on close", async () => {
    const { bundle } = createFakeBundle();

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

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

    const consumedEnter = await controller.handleSemanticInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(consumedEnter).toBe(true);
    expect(controller.getState().overlay.active?.payload).toMatchObject({
      kind: "pager",
      title: "Analysis",
      lines: ["Outcome: pass", "Missing checks: none"],
      scrollOffset: 0,
    });

    const consumedEscape = await controller.handleSemanticInput({
      key: "escape",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(consumedEscape).toBe(true);
    expect(controller.getState().overlay.active?.payload).toMatchObject({
      kind: "inspect",
      selectedIndex: 1,
    });
    controller.dispose();
  });

  test("task overlays drill down into run output, artifact refs, and worker session hints", async () => {
    const { bundle } = createFakeBundle({
      sessionWireBySessionId: {
        "worker-session-1": [
          {
            schema: "brewva.session-wire.v2",
            sessionId: "worker-session-1",
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
                toolCallId: "tool-1",
                toolName: "exec_command",
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
    });

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
            parentSessionId: "session-1",
            status: "completed",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            label: "Review operator state",
            workerSessionId: "worker-session-1",
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

    const consumedEnter = await controller.handleSemanticInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(consumedEnter).toBe(true);
    expect(controller.getState().overlay.active?.payload).toMatchObject({
      kind: "pager",
      title: "Task run-1 output",
    });

    const pagerPayload = controller.getState().overlay.active?.payload;
    expect(pagerPayload && pagerPayload.kind === "pager" ? pagerPayload.lines : []).toEqual(
      expect.arrayContaining([
        "workerSessionRecentOutput:",
        "  assistant:",
        "    QA summary line",
        "    Found stale contract drift.",
        "  toolOutputs:",
        "    - exec_command [pass]",
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

    controller.dispose();
  });

  test("notifications open as an inbox, drill into pager details, and support dismiss", async () => {
    const { bundle } = createFakeBundle();

    const controller = new CliShellController(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    controller.ui.notify("older notification", "info");
    controller.ui.notify("latest notification", "warning");

    const consumedOpen = await controller.handleSemanticInput({
      key: "n",
      ctrl: true,
      meta: false,
      shift: false,
    });

    expect(consumedOpen).toBe(true);
    expect(controller.getState().overlay.active?.payload).toMatchObject({
      kind: "notifications",
      selectedIndex: 0,
    });

    const consumedEnter = await controller.handleSemanticInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(consumedEnter).toBe(true);
    expect(controller.getState().overlay.active?.payload).toMatchObject({
      kind: "pager",
      title: "Notification [warning]",
    });

    await controller.handleSemanticInput({
      key: "escape",
      ctrl: false,
      meta: false,
      shift: false,
    });

    const consumedDismiss = await controller.handleSemanticInput({
      key: "character",
      text: "d",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(consumedDismiss).toBe(true);
    expect(controller.getState().overlay.active?.payload).toMatchObject({
      kind: "notifications",
      selectedIndex: 0,
    });
    const notificationsPayload = controller.getState().overlay.active?.payload;
    expect(
      notificationsPayload && notificationsPayload.kind === "notifications"
        ? notificationsPayload.notifications.map((notification) => notification.message)
        : [],
    ).toEqual(["older notification"]);
    controller.dispose();
  });

  test("pager context routes Ctrl-E to the external pager instead of the global editor shortcut", async () => {
    const { bundle } = createFakeBundle();
    const pagerCalls: Array<{ title: string; lines: readonly string[] }> = [];
    const editorCalls: Array<{ title: string; prefill?: string }> = [];

    const controller = new CliShellController(bundle, {
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

    controller.openOverlay({
      kind: "pager",
      title: "Task run-1 output",
      lines: ["line-1", "line-2"],
      scrollOffset: 0,
    });

    const consumed = await controller.handleSemanticInput({
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
    controller.dispose();
  });

  test("Ctrl-E opens the external pager for inspect overlays before falling back to the editor", async () => {
    const { bundle } = createFakeBundle();
    const pagerCalls: Array<{ title: string; lines: readonly string[] }> = [];
    const editorCalls: Array<{ title: string; prefill?: string }> = [];

    const controller = new CliShellController(bundle, {
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

    const consumed = await controller.handleSemanticInput({
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
    controller.dispose();
  });

  test("session switching preserves drafts per session and restores them when returning", async () => {
    const replaySessions = [
      {
        sessionId: "session-1",
        eventCount: 14,
        lastEventAt: 1_710_000_000_000,
      },
      {
        sessionId: "session-2",
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

    const controller = new CliShellController(first.bundle, {
      cwd: process.cwd(),
      openSession: async (sessionId) => bundles.get(sessionId) ?? first.bundle,
      createSession: async () => second.bundle,
    });

    controller.ui.setEditorText("draft one");
    controller.openOverlay({
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

    await controller.handleSemanticInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(controller.getBundle().session.sessionManager.getSessionId()).toBe("session-2");
    expect(controller.ui.getEditorText()).toBe("");

    controller.ui.setEditorText("draft two");
    controller.openOverlay({
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

    await controller.handleSemanticInput({
      key: "enter",
      ctrl: false,
      meta: false,
      shift: false,
    });

    expect(controller.getBundle().session.sessionManager.getSessionId()).toBe("session-1");
    expect(controller.ui.getEditorText()).toBe("draft one");
    controller.dispose();
  });

  test("session browser still surfaces the current session before any replay events exist", async () => {
    const replaySessions = [
      {
        sessionId: "archived-session",
        eventCount: 12,
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
    });

    await controller.start();
    controller.ui.setEditorText("draft before first turn");
    await controller.handleSemanticInput({
      key: "g",
      ctrl: true,
      meta: false,
      shift: false,
    });

    const payload = controller.getState().overlay.active?.payload;
    expect(payload).toMatchObject({
      kind: "sessions",
      currentSessionId: "fresh-session",
    });
    expect(
      payload?.kind === "sessions" ? payload.sessions.map((session) => session.sessionId) : [],
    ).toEqual(["fresh-session", "archived-session"]);
    expect(
      payload?.kind === "sessions" ? payload.draftStateBySessionId["fresh-session"] : undefined,
    ).toMatchObject({
      lines: 1,
      preview: "draft before first turn",
    });
    controller.dispose();
  });
});
