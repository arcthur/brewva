import { describe, expect, test } from "bun:test";
import {
  asBrewvaSessionId,
  asBrewvaToolCallId,
  asBrewvaToolName,
} from "@brewva/brewva-runtime/core";
import type { BrewvaPromptToolCall } from "@brewva/brewva-substrate/session";
import { CURRENT_DELEGATION_CONTRACT_VERSION } from "@brewva/brewva-vocabulary/delegation";
import { CliShellRuntime } from "../../../packages/brewva-cli/src/shell/controller/shell-runtime.js";
import type { ShellEffect } from "../../../packages/brewva-cli/src/shell/domain/effects.js";
import type { ProviderConnectionDescriptor } from "../../../packages/brewva-cli/src/shell/domain/overlays/payloads.js";
import { buildSubagentFooterView } from "../../../packages/brewva-cli/src/shell/domain/subagent-footer.js";
import {
  createPromptMessageUpdateEvent,
  createToolcallEndAssistantEvent,
} from "../../helpers/prompt-session-events.js";
import { createHostedShellFixture } from "../../helpers/shell-fixture.js";

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

describe("shell runtime: error surfaces and overlays", () => {
  test("shift-tab is a no-op when only the synthetic default preset is available", async () => {
    const fixture = createHostedShellFixture();
    const runtime = new CliShellRuntime(fixture.bundle, {
      cwd: process.cwd(),
      openSession: async () => fixture.bundle,
      createSession: async () => fixture.bundle,
    });

    await keymapCommand(runtime, "agent.preset.next");

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
    const fixture = createHostedShellFixture({
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
    await keymapEffect(runtime, { type: "overlay.primary" });
    await Bun.sleep(0);

    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "authMethodPicker",
      title: "Connect Kimi",
    });

    await keymapEffect(runtime, { type: "overlay.moveSelection", delta: 1 });
    await keymapEffect(runtime, { type: "overlay.primary" });
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
    await keymapEffect(runtime, { type: "overlay.primary" });
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
    const fixture = createHostedShellFixture();
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
    const { bundle } = createHostedShellFixture();

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

    const consumedEnter = await keymapEffect(runtime, { type: "overlay.primary" });

    expect(consumedEnter).toBe(true);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "pager",
      title: "Analysis",
      lines: ["Outcome: pass", "Missing checks: none"],
      scrollOffset: 0,
    });

    const consumedEscape = await keymapEffect(runtime, {
      type: "overlay.closeActive",
      cancelled: true,
    });

    expect(consumedEscape).toBe(true);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "inspect",
      selectedIndex: 1,
    });
    runtime.dispose();
  });

  test("task overlays open run output in the subagent footer inspector", async () => {
    const { bundle } = createHostedShellFixture({
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

    const consumedEnter = await keymapEffect(runtime, { type: "overlay.primary" });

    expect(consumedEnter).toBe(true);
    const viewState = runtime.getViewState();
    expect(viewState.overlay.active?.kind ?? "none").toBe("none");
    expect(viewState.focus.active).toBe("subagentFooter");
    expect(viewState.subagentFooter.mode).toBe("inspecting");
    expect(runtime.getSessionWireFrames("worker-session-1")).toHaveLength(1);

    const footerView = buildSubagentFooterView({
      runs: viewState.operator.taskRuns,
      state: viewState.subagentFooter,
      getSessionWireFrames: (sessionId) => runtime.getSessionWireFrames(sessionId),
    });
    expect(footerView.detail?.lines).toEqual(
      expect.arrayContaining([
        "assistant:",
        "  Verifier summary line",
        "  Found stale contract drift.",
        "toolOutputs:",
        "  - exec [pass]",
        "      bun test",
        "      1775 pass",
        "  runId: run-1",
        "  workerSessionId: worker-session-1",
        "  summary: Collected output summary",
      ]),
    );

    runtime.dispose();
  });

  test("notifications open as an inbox, drill into pager details, and support dismiss", async () => {
    const { bundle } = createHostedShellFixture();

    const runtime = new CliShellRuntime(bundle, {
      cwd: process.cwd(),
      openSession: async () => bundle,
      createSession: async () => bundle,
    });

    runtime.ui.notify("older notification", "info");
    runtime.ui.notify("latest notification", "warning");

    const consumedOpen = await keymapCommand(runtime, "operator.inbox");

    expect(consumedOpen).toBe(true);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "inbox",
      selectedIndex: 0,
    });

    const consumedDown = await keymapEffect(runtime, { type: "overlay.moveSelection", delta: 1 });
    expect(consumedDown).toBe(true);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "inbox",
      selectedIndex: 1,
    });

    const consumedUp = await keymapEffect(runtime, { type: "overlay.moveSelection", delta: -1 });
    expect(consumedUp).toBe(true);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "inbox",
      selectedIndex: 0,
    });

    const consumedEnter = await keymapEffect(runtime, { type: "overlay.primary" });

    expect(consumedEnter).toBe(true);
    expect(runtime.getViewState().overlay.active?.payload).toMatchObject({
      kind: "pager",
      title: "Notification [warning]",
    });

    await keymapEffect(runtime, { type: "overlay.closeActive", cancelled: true });

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
    const { bundle } = createHostedShellFixture();
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
      title: "Pager output",
      lines: ["line-1", "line-2"],
      scrollOffset: 0,
    });

    const consumed = await keymapEffect(runtime, { type: "pager.externalActive" });

    expect(consumed).toBe(true);
    expect(pagerCalls).toEqual([
      {
        title: "Pager output",
        lines: ["line-1", "line-2"],
      },
    ]);
    expect(editorCalls).toEqual([]);
    runtime.dispose();
  });

  test("Ctrl-E opens the external pager for inspect overlays before falling back to the editor", async () => {
    const { bundle } = createHostedShellFixture();
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

    const consumed = await keymapEffect(runtime, { type: "pager.externalActive" });

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
    const { bundle } = createHostedShellFixture({
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
    const { bundle } = createHostedShellFixture();
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
