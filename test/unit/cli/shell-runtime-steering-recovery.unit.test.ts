import { describe, expect, test } from "bun:test";
import type { BrewvaPromptToolCall } from "@brewva/brewva-substrate/session";
import { CliShellRuntime } from "../../../packages/brewva-cli/src/shell/controller/shell-runtime.js";
import type { ShellEffect } from "../../../packages/brewva-cli/src/shell/domain/effects.js";
import { patchDateNow } from "../../helpers/global-state.js";
import {
  createPromptMessageUpdateEvent,
  createTextDeltaAssistantEvent,
  createToolcallEndAssistantEvent,
} from "../../helpers/prompt-session-events.js";
import {
  createHostedShellFixture,
  type HostedShellFixtureOptions,
} from "../../helpers/shell-fixture.js";

async function keymapEffect(runtime: CliShellRuntime, effect: ShellEffect): Promise<boolean> {
  return await runtime.handleInput({
    type: "keymap.effect",
    effect,
  });
}

async function keymapCommand(runtime: CliShellRuntime, commandId: string): Promise<boolean> {
  return await runtime.handleInput({
    type: "keymap.command",
    commandId,
    source: "keybinding",
  });
}

async function submitComposer(runtime: CliShellRuntime): Promise<boolean> {
  return await keymapEffect(runtime, { type: "composer.submit" });
}

function createFakeBundle(options: HostedShellFixtureOptions = {}) {
  return createHostedShellFixture({ fauxProvider: true, ...options });
}

describe("shell runtime: steering and recovery", () => {
  test("shift-tab advances queued preset selection while a turn is streaming", async () => {
    const fixture = createFakeBundle({
      isStreaming: true,
      modelPresetState: {
        activeName: "Default",
        defaultName: "Default",
        presets: [
          { name: "Default", roles: {}, synthetic: true },
          { name: "Claude Lead", roles: { default: "anthropic/claude-main:high" } },
          { name: "OpenAI Stack", roles: { default: "openai/gpt-5.5:high" } },
        ],
      },
    });
    const runtime = new CliShellRuntime(fixture.bundle, {
      cwd: process.cwd(),
      openSession: async () => fixture.bundle,
      createSession: async () => fixture.bundle,
    });

    await keymapCommand(runtime, "agent.preset.next");
    await keymapCommand(runtime, "agent.preset.next");

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
    Object.assign(bundle.runtime.ops.session.rewind, {
      recordCheckpoint(
        _sessionId: string,
        input: { turnId?: string },
      ): ReturnType<typeof bundle.runtime.ops.session.rewind.recordCheckpoint> {
        turnIds.push(input.turnId ?? "");
        return {} as ReturnType<typeof bundle.runtime.ops.session.rewind.recordCheckpoint>;
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
      await submitComposer(runtime);
      runtime.ui.setEditorText("second prompt");
      await submitComposer(runtime);

      expect(turnIds).toEqual(["interactive:1710000000000:1", "interactive:1710000000000:2"]);
    } finally {
      restoreDateNow();
      runtime.dispose();
    }
  });

  test("blocks redo while the current session is streaming", async () => {
    const { bundle } = createFakeBundle();
    let redoCalls = 0;
    Object.assign(bundle.runtime.ops.session.rewind, {
      redo(): ReturnType<typeof bundle.runtime.ops.session.rewind.redo> {
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
    await submitComposer(runtime);

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
    await submitComposer(runtime);

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

  test("projects non-streaming runtime turn assistant output after submit", async () => {
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
    await submitComposer(runtime);
    fixture.emitSessionEvent(
      createPromptMessageUpdateEvent({
        assistantMessageEvent: createTextDeltaAssistantEvent({
          delta: "ok",
          partial: {
            role: "assistant",
            stopReason: "stop",
            content: [{ type: "text", text: "ok" }],
            timestamp: Date.now(),
          },
        }),
      }),
    );

    const assistantMessages = runtime
      .getViewState()
      .transcript.messages.filter((message) => message.role === "assistant");
    expect(assistantMessages).toHaveLength(1);
    expect(assistantMessages[0]?.parts[0]).toMatchObject({ type: "text", text: "ok" });

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

    await submitComposer(runtime);

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
    const { bundle } = createFakeBundle();
    Object.assign(bundle.session, {
      getRuntimeModelCatalog() {
        return {
          async getApiKeyAndHeaders() {
            throw new Error("prompt exploded");
          },
        };
      },
    });

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.setEditorText("trigger failure");
    const consumed = await submitComposer(runtime);

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
    await submitComposer(runtime);

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
