import { describe, expect, test } from "bun:test";
import type { BrewvaReplaySession, SessionWireFrame } from "@brewva/brewva-runtime";
import type {
  BrewvaPromptSessionEvent,
  BrewvaRenderableComponent,
  BrewvaToolDefinition,
  BrewvaToolUiPort,
} from "@brewva/brewva-substrate";
import {
  createOpenTuiSolidElement,
  openTuiSolidAct,
  openTuiSolidTestRender,
} from "@brewva/brewva-tui/internal-opentui-runtime";
import { BrewvaOpenTuiShell } from "../../../packages/brewva-cli/runtime/opentui-shell-renderer.js";
import { CliShellController } from "../../../packages/brewva-cli/src/shell/controller.js";
import type { CliShellSessionBundle } from "../../../packages/brewva-cli/src/shell/types.js";

function createFakeBundle(
  options: {
    approvals?: number;
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
        return { messages: options.seedMessages ?? [] };
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
        proposals: {
          decideEffectCommitment() {},
        },
      },
      inspect: {
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
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
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
      expect(frame).toContain("List unresolved operator questions.");
      expect(frame).toContain("/quit");
      expect(frame).toContain("Exit the interactive shell.");

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
      expect(frame).toContain("List unresolved operator questions.");
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

  test("ctrl+o with no open questions renders a visible empty state instead of a blank overlay", async () => {
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
      expect(frame).toContain("No open questions.");
      expect(frame).toContain(
        "Brewva will show delegated questions here when a run needs your input.",
      );
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

  test("renders the OpenCode-style sidebar on wide terminals", async () => {
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
    const testSetup = await openTuiSolidTestRender(
      createOpenTuiSolidElement(BrewvaOpenTuiShell, { controller }),
      {
        width: 140,
        height: 32,
      },
    );

    try {
      await openTuiSolidAct(async () => {
        await Bun.sleep(CliShellController.STATUS_DEBOUNCE_MS + 20);
      });
      await testSetup.renderOnce();
      await testSetup.renderOnce();
      const frame = testSetup.captureCharFrame();
      expect(frame).toContain("Hello from Brewva");
      expect(frame).toContain("session-1");
      expect(frame).toContain("Inbox");
      expect(frame).toContain("Replay");
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
      expect(frame).toContain("ctrl+a");
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
            toolName: "write",
            toolCallId: "tool-call-1",
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
      selectedIndex: 0,
      snapshot: {
        approvals: [],
        questions: [
          {
            questionId: "delegation:run-1:1",
            sessionId: "session-1",
            createdAt: Date.now(),
            sourceKind: "delegation",
            sourceEventId: "event-1",
            questionText: "Should I update the config before continuing?",
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
      expect(frame).toContain("Question");
      expect(frame).toContain("Should I update the config");
      expect(frame).toContain("delegate label=worker-1 skill=review");
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
            parentSessionId: "session-1",
            status: "completed",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            label: "Review operator state",
            workerSessionId: "worker-session-1",
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
        sessionId: "archived-session",
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

  test("renders exec tools as shell-style transcript blocks", async () => {
    const { bundle } = createFakeBundle({
      seedMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "tool-exec-1",
              name: "exec_command",
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
          toolName: "exec_command",
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
