import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  handleInspectChannelCommand,
  handleInsightsChannelCommand,
  handleQuestionsChannelCommand,
} from "@brewva/brewva-cli/channel";
import {
  DEFAULT_TELEGRAM_CHANNEL_NAME,
  runChannelMode,
  type ChannelModeLauncher,
  type RunChannelModeDependencies,
} from "@brewva/brewva-gateway";
import { createHostedSession } from "@brewva/brewva-gateway/hosted";
import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import { type ChannelTurnBridge, type TurnEnvelope } from "@brewva/brewva-runtime/channels";
import { OPERATOR_QUESTION_ANSWERED_EVENT_TYPE } from "@brewva/brewva-runtime/events";
import { createRecoveryWalStore } from "@brewva/brewva-runtime/recovery";
import { recordHostedDelegationOutcome } from "../../helpers/events.js";
import { waitUntil } from "../../helpers/process.js";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

function writeChannelConfig(
  workspace: string,
  options: {
    orchestrationEnabled?: boolean;
    orchestrationLimits?: {
      maxLiveRuntimes?: number;
      idleRuntimeTtlMs?: number;
    };
  } = {},
): string {
  const configPath = join(workspace, ".brewva", "brewva.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        channels: {
          orchestration: {
            enabled: options.orchestrationEnabled ?? false,
            limits: {
              maxLiveRuntimes: options.orchestrationLimits?.maxLiveRuntimes,
              idleRuntimeTtlMs: options.orchestrationLimits?.idleRuntimeTtlMs,
            },
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );
  return configPath;
}

function recordDelegatedOpenQuestion(input: {
  runtime: BrewvaHostedRuntimePort;
  sessionId: string;
  runId: string;
  question: string;
}): string {
  recordHostedDelegationOutcome({
    runtime: input.runtime,
    sessionId: input.sessionId,
    runId: input.runId,
    payload: {
      delegate: "advisor",
      kind: "consult",
      consultKind: "review",
    },
    outcome: {
      ok: true,
      runId: input.runId,
      delegate: "advisor",
      label: "advisor",
      kind: "consult",
      consultKind: "review",
      status: "ok",
      summary: "Open question available.",
      data: {
        kind: "consult",
        consultKind: "review",
        conclusion: "The run needs operator input.",
        followUpQuestions: [input.question],
      },
      metrics: { durationMs: 1 },
      evidenceRefs: [],
    },
  });
  return `delegation:${input.runId}:1`;
}

function createInboundTurn(input: { turnId: string; text: string }): TurnEnvelope {
  return {
    schema: "brewva.turn.v1",
    kind: "user",
    sessionId: "telegram-session",
    turnId: input.turnId,
    channel: "telegram",
    conversationId: "12345",
    timestamp: Date.now(),
    parts: [{ type: "text", text: input.text }],
  };
}

function readTurnText(turn: TurnEnvelope | undefined): string {
  const part = turn?.parts[0];
  return part && "text" in part ? part.text : "";
}

describe("gateway contract: telegram channel dispatch", () => {
  test("recovers telegram polling offset from the existing channel wal before launcher startup", async () => {
    const workspace = createTestWorkspace("channel-telegram-polling-offset");
    const configPath = writeChannelConfig(workspace);
    const store = createRecoveryWalStore({
      workspaceRoot: workspace,
      config: DEFAULT_BREWVA_CONFIG.infrastructure.recoveryWal,
      scope: "channel-telegram",
    });
    const row = store.appendPending(
      {
        schema: "brewva.turn.v1",
        kind: "user",
        sessionId: "telegram-session",
        turnId: "turn-offset-1",
        channel: "telegram",
        conversationId: "12345",
        timestamp: Date.now(),
        parts: [{ type: "text", text: "hello" }],
        meta: {
          ingressSequence: 10,
        },
      },
      "channel",
    );
    store.markDone(row.walId);

    const channelConfig = {
      telegram: {
        token: "bot-token",
      },
    };
    const abortController = new AbortController();
    let recoveredOffset: number | undefined;

    const launcher: ChannelModeLauncher = (input) => {
      recoveredOffset = (
        input as {
          recovery?: { initialPollingOffset?: number };
        }
      ).recovery?.initialPollingOffset;
      const bridge = {
        async start(): Promise<void> {
          abortController.abort();
        },
        async stop(): Promise<void> {
          return;
        },
        async sendTurn(): Promise<Record<string, never>> {
          return {};
        },
      };
      return {
        bridge: bridge as unknown as ChannelTurnBridge,
      };
    };

    try {
      await runChannelMode({
        cwd: workspace,
        configPath,
        managedToolMode: "direct",
        verbose: false,
        channel: "telegram",
        channelConfig,
        shutdownSignal: abortController.signal,
        dependencies: {
          launchers: {
            telegram: launcher,
          },
        },
      });
    } finally {
      cleanupTestWorkspace(workspace);
    }

    expect(recoveredOffset).toBe(11);
  });

  test("recovers telegram polling offset after wal compaction retains the ingress watermark", async () => {
    const workspace = createTestWorkspace("channel-telegram-polling-offset-compacted");
    const configPath = writeChannelConfig(workspace);
    let nowMs = 10_000;
    const store = createRecoveryWalStore({
      workspaceRoot: workspace,
      config: {
        ...DEFAULT_BREWVA_CONFIG.infrastructure.recoveryWal,
        compactAfterMs: 100,
      },
      scope: "channel-telegram",
      now: () => nowMs,
    });
    const row = store.appendPending(
      {
        schema: "brewva.turn.v1",
        kind: "user",
        sessionId: "telegram-session",
        turnId: "turn-offset-compacted-1",
        channel: "telegram",
        conversationId: "12345",
        timestamp: Date.now(),
        parts: [{ type: "text", text: "hello" }],
        meta: {
          ingressSequence: 10,
        },
      },
      "channel",
    );
    store.markDone(row.walId);
    nowMs += 500;
    store.compact();

    const channelConfig = {
      telegram: {
        token: "bot-token",
      },
    };
    const abortController = new AbortController();
    let recoveredOffset: number | undefined;

    const launcher: ChannelModeLauncher = (input) => {
      recoveredOffset = (
        input as {
          recovery?: { initialPollingOffset?: number };
        }
      ).recovery?.initialPollingOffset;
      const bridge = {
        async start(): Promise<void> {
          abortController.abort();
        },
        async stop(): Promise<void> {
          return;
        },
        async sendTurn(): Promise<Record<string, never>> {
          return {};
        },
      };
      return {
        bridge: bridge as unknown as ChannelTurnBridge,
      };
    };

    try {
      await runChannelMode({
        cwd: workspace,
        configPath,
        managedToolMode: "direct",
        verbose: false,
        channel: "telegram",
        channelConfig,
        shutdownSignal: abortController.signal,
        dependencies: {
          launchers: {
            telegram: launcher,
          },
        },
      });
    } finally {
      cleanupTestWorkspace(workspace);
    }

    expect(recoveredOffset).toBe(11);
  });

  test("fails closed before launcher startup when the telegram wal is malformed", async () => {
    const workspace = createTestWorkspace("channel-telegram-malformed-wal");
    const configPath = writeChannelConfig(workspace);
    const walDir = join(workspace, DEFAULT_BREWVA_CONFIG.infrastructure.recoveryWal.dir);
    mkdirSync(walDir, { recursive: true });
    writeFileSync(join(walDir, "channel-telegram.jsonl"), '{"bad":true}\n', "utf8");

    const channelConfig = {
      telegram: {
        token: "bot-token",
      },
    };
    let launcherCalled = false;
    const previousExitCode = process.exitCode ?? 0;
    process.exitCode = 0;

    try {
      await runChannelMode({
        cwd: workspace,
        configPath,
        managedToolMode: "direct",
        verbose: false,
        channel: "telegram",
        channelConfig,
        dependencies: {
          launchers: {
            telegram: () => {
              launcherCalled = true;
              return {
                bridge: {
                  async start(): Promise<void> {
                    return;
                  },
                  async stop(): Promise<void> {
                    return;
                  },
                  async sendTurn(): Promise<Record<string, never>> {
                    return {};
                  },
                } as unknown as ChannelTurnBridge,
              };
            },
          },
        },
      });

      expect(launcherCalled).toBe(false);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
      cleanupTestWorkspace(workspace);
    }
  });

  test("telegram inbound turns include channel policy", async () => {
    const workspace = createTestWorkspace("channel-telegram-dispatch");
    const configPath = writeChannelConfig(workspace);
    const channelConfig = {
      telegram: {
        token: "bot-token",
      },
    };
    const capturedPrompts: string[] = [];
    const outboundTurns: TurnEnvelope[] = [];
    const abortController = new AbortController();

    const launcher: ChannelModeLauncher = (input) => {
      const bridge = {
        async start(): Promise<void> {
          await input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-e2e-1",
              text: "hello from channel e2e",
            }),
          );
          await waitUntil(
            () => outboundTurns.length > 0,
            3_000,
            "timed out waiting for channel mode dispatch to complete",
          );
          abortController.abort();
        },
        async stop(): Promise<void> {
          return;
        },
        async sendTurn(turn: TurnEnvelope): Promise<Record<string, never>> {
          outboundTurns.push(turn);
          return {};
        },
      };
      return {
        bridge: bridge as unknown as ChannelTurnBridge,
      };
    };

    const dependencies: RunChannelModeDependencies = {
      collectPromptTurnOutputs: async (_session, prompt) => {
        capturedPrompts.push(prompt);
        return {
          assistantText: "ACK_FROM_FAKE_PROMPT_EXECUTOR",
          toolOutputs: [],
        };
      },
      launchers: {
        telegram: launcher,
      },
    };

    try {
      await runChannelMode({
        cwd: workspace,
        configPath,
        managedToolMode: "direct",
        verbose: false,
        channel: "telegram",
        channelConfig,
        shutdownSignal: abortController.signal,
        dependencies,
      });
    } finally {
      cleanupTestWorkspace(workspace);
    }

    const prompt = capturedPrompts[0] ?? "";
    expect(prompt).toContain("[Brewva Channel Policy]");
    expect(prompt).toContain(`Transport: ${DEFAULT_TELEGRAM_CHANNEL_NAME}`);
    expect(prompt).toContain("[channel:telegram] conversation:12345");
    expect(prompt).toContain("hello from channel e2e");
    expect(outboundTurns[0]?.parts).toEqual([
      { type: "text", text: "ACK_FROM_FAKE_PROMPT_EXECUTOR" },
    ]);
  });

  test("channel orchestration handles /status inline without a model turn", async () => {
    const workspace = createTestWorkspace("channel-telegram-inspect");
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "index.ts"), "export const ok = true;\n", "utf8");
    const configPath = writeChannelConfig(workspace, { orchestrationEnabled: true });
    const channelConfig = {
      telegram: {
        token: "bot-token",
      },
    };
    const capturedPrompts: string[] = [];
    const outboundTurns: TurnEnvelope[] = [];
    const abortController = new AbortController();

    const launcher: ChannelModeLauncher = (input) => {
      const bridge = {
        async start(): Promise<void> {
          await input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-agent-1",
              text: "hello from channel e2e",
            }),
          );
          await input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-inspect-1",
              text: "/status src",
            }),
          );
          await waitUntil(
            () => outboundTurns.length >= 2,
            5_000,
            "timed out waiting for channel inspect reply",
          );
          abortController.abort();
        },
        async stop(): Promise<void> {
          return;
        },
        async sendTurn(turn: TurnEnvelope): Promise<Record<string, never>> {
          outboundTurns.push(turn);
          return {};
        },
      };
      return {
        bridge: bridge as unknown as ChannelTurnBridge,
      };
    };

    const dependencies: RunChannelModeDependencies = {
      collectPromptTurnOutputs: async (_session, prompt) => {
        capturedPrompts.push(prompt);
        return {
          assistantText: "ACK_FROM_FAKE_PROMPT_EXECUTOR",
          toolOutputs: [],
        };
      },
      handleInspectCommand: handleInspectChannelCommand,
      launchers: {
        telegram: launcher,
      },
    };

    try {
      await runChannelMode({
        cwd: workspace,
        configPath,
        managedToolMode: "direct",
        verbose: false,
        channel: "telegram",
        channelConfig,
        shutdownSignal: abortController.signal,
        dependencies,
      });
    } finally {
      cleanupTestWorkspace(workspace);
    }

    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]).toContain("hello from channel e2e");

    const statusText = outboundTurns[1]?.parts[0];
    expect(statusText).toEqual(
      expect.objectContaining({
        type: "text",
      }),
    );
    const text = statusText && "text" in statusText ? statusText.text : "";
    expect(text).toContain("Status @default");
    expect(text).toContain("Inspect");
    expect(text).toContain("  Inspect @default —");
    expect(text).toContain("  Dir: src");
    expect(text).toContain("  Findings:");
  });

  test("channel orchestration includes insights inside /status output", async () => {
    const workspace = createTestWorkspace("channel-telegram-inspects");
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "index.ts"), "export const ok = true;\n", "utf8");
    const configPath = writeChannelConfig(workspace, { orchestrationEnabled: true });
    const channelConfig = {
      telegram: {
        token: "bot-token",
      },
    };
    const capturedPrompts: string[] = [];
    const outboundTurns: TurnEnvelope[] = [];
    const abortController = new AbortController();

    const launcher: ChannelModeLauncher = (input) => {
      const bridge = {
        async start(): Promise<void> {
          await input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-agent-insights-1",
              text: "hello from channel e2e",
            }),
          );
          await input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-insights-1",
              text: "/status .",
            }),
          );
          await waitUntil(
            () => outboundTurns.length >= 2,
            5_000,
            "timed out waiting for channel insights reply",
          );
          abortController.abort();
        },
        async stop(): Promise<void> {
          return;
        },
        async sendTurn(turn: TurnEnvelope): Promise<Record<string, never>> {
          outboundTurns.push(turn);
          return {};
        },
      };
      return {
        bridge: bridge as unknown as ChannelTurnBridge,
      };
    };

    const dependencies: RunChannelModeDependencies = {
      collectPromptTurnOutputs: async (_session, prompt) => {
        capturedPrompts.push(prompt);
        return {
          assistantText: "ACK_FROM_FAKE_PROMPT_EXECUTOR",
          toolOutputs: [],
        };
      },
      handleInspectCommand: handleInspectChannelCommand,
      handleInsightsCommand: handleInsightsChannelCommand,
      launchers: {
        telegram: launcher,
      },
    };

    try {
      await runChannelMode({
        cwd: workspace,
        configPath,
        managedToolMode: "direct",
        verbose: false,
        channel: "telegram",
        channelConfig,
        shutdownSignal: abortController.signal,
        dependencies,
      });
    } finally {
      cleanupTestWorkspace(workspace);
    }

    expect(capturedPrompts).toHaveLength(1);

    const statusText = outboundTurns[1]?.parts[0];
    expect(statusText).toEqual(
      expect.objectContaining({
        type: "text",
      }),
    );
    const text = statusText && "text" in statusText ? statusText.text : "";
    expect(text).toContain("Status @default");
    expect(text).toContain("Insights");
    expect(text).toContain("  Insights @default");
    expect(text).toContain("  Dirs:");
    expect(text).toContain("  Verification:");
    expect(text).not.toContain("Brewva Project Insights");
  });

  test("channel orchestration includes operator input inside /status output", async () => {
    const workspace = createTestWorkspace("channel-telegram-questions");
    const configPath = writeChannelConfig(workspace, { orchestrationEnabled: true });
    const channelConfig = {
      telegram: {
        token: "bot-token",
      },
    };
    const capturedPrompts: string[] = [];
    const outboundTurns: TurnEnvelope[] = [];
    const abortController = new AbortController();
    let hostedSession:
      | {
          runtime: Awaited<ReturnType<typeof createHostedSession>>["runtime"];
          sessionId: string;
        }
      | undefined;

    const launcher: ChannelModeLauncher = (input) => {
      const bridge = {
        async start(): Promise<void> {
          await input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-agent-questions-1",
              text: "hello from channel e2e",
            }),
          );
          await waitUntil(
            () => outboundTurns.length >= 1 && hostedSession !== undefined,
            5_000,
            "timed out waiting for agent session bootstrap",
          );
          recordDelegatedOpenQuestion({
            runtime: hostedSession!.runtime,
            sessionId: hostedSession!.sessionId,
            runId: "telegram-status-question-1",
            question: "Should the update target the daemon or the print path?",
          });
          await input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-questions-1",
              text: "/status",
            }),
          );
          await waitUntil(
            () => outboundTurns.length >= 2,
            5_000,
            "timed out waiting for channel questions reply",
          );
          abortController.abort();
        },
        async stop(): Promise<void> {
          return;
        },
        async sendTurn(turn: TurnEnvelope): Promise<Record<string, never>> {
          outboundTurns.push(turn);
          return {};
        },
      };
      return {
        bridge: bridge as unknown as ChannelTurnBridge,
      };
    };

    const dependencies: RunChannelModeDependencies = {
      createSession: async (options) => {
        const result = await createHostedSession(options);
        hostedSession = {
          runtime: result.runtime,
          sessionId: result.session.sessionManager.getSessionId(),
        };
        return result;
      },
      collectPromptTurnOutputs: async (_session, prompt) => {
        capturedPrompts.push(prompt);
        return {
          assistantText: "ACK_FROM_FAKE_PROMPT_EXECUTOR",
          toolOutputs: [],
        };
      },
      handleQuestionsCommand: handleQuestionsChannelCommand,
      launchers: {
        telegram: launcher,
      },
    };

    try {
      await runChannelMode({
        cwd: workspace,
        configPath,
        managedToolMode: "direct",
        verbose: false,
        channel: "telegram",
        channelConfig,
        shutdownSignal: abortController.signal,
        dependencies,
      });
    } finally {
      cleanupTestWorkspace(workspace);
    }

    expect(capturedPrompts).toHaveLength(1);
    const statusText = outboundTurns[1]?.parts[0];
    expect(statusText).toEqual(
      expect.objectContaining({
        type: "text",
      }),
    );
    const text = statusText && "text" in statusText ? statusText.text : "";
    expect(text).toContain("Operator input");
    expect(text).toContain("  Operator inbox @default");
    expect(text).toContain("  Follow-up questions:");
    expect(text).toContain("Should the update target the daemon or the print path?");
    expect(text).toContain(
      "Use /answer [@agent] <question-id> <answer> to resolve one prompt at a time.",
    );
  });

  test("channel orchestration routes /answer through the focused agent and records the answer event", async () => {
    const workspace = createTestWorkspace("channel-telegram-answer");
    const configPath = writeChannelConfig(workspace, { orchestrationEnabled: true });
    const channelConfig = {
      telegram: {
        token: "bot-token",
      },
    };
    const capturedPrompts: string[] = [];
    const outboundTurns: TurnEnvelope[] = [];
    const abortController = new AbortController();
    let observedAnswerEventCount = 0;
    let hostedSession:
      | {
          runtime: Awaited<ReturnType<typeof createHostedSession>>["runtime"];
          sessionId: string;
          questionId?: string;
        }
      | undefined;

    const launcher: ChannelModeLauncher = (input) => {
      const bridge = {
        async start(): Promise<void> {
          await input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-agent-answer-1",
              text: "hello from channel e2e",
            }),
          );
          await waitUntil(
            () => outboundTurns.length >= 1 && hostedSession !== undefined,
            5_000,
            "timed out waiting for agent session bootstrap",
          );
          hostedSession!.questionId = recordDelegatedOpenQuestion({
            runtime: hostedSession!.runtime,
            sessionId: hostedSession!.sessionId,
            runId: "telegram-answer-question-1",
            question: "Should the update target the daemon or the print path?",
          });
          await input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-answer-1",
              text: `/answer ${hostedSession!.questionId} Target the daemon path first.`,
            }),
          );
          await waitUntil(
            () =>
              capturedPrompts.length >= 2 &&
              (hostedSession?.runtime.inspect.events.records
                .query(hostedSession.sessionId)
                .filter((event) => event.type === OPERATOR_QUESTION_ANSWERED_EVENT_TYPE).length ??
                0) >= 1,
            5_000,
            "timed out waiting for answer routing prompt and event",
          );
          observedAnswerEventCount =
            hostedSession?.runtime.inspect.events.records
              .query(hostedSession.sessionId)
              .filter((event) => event.type === OPERATOR_QUESTION_ANSWERED_EVENT_TYPE).length ?? 0;
          abortController.abort();
        },
        async stop(): Promise<void> {
          return;
        },
        async sendTurn(turn: TurnEnvelope): Promise<Record<string, never>> {
          outboundTurns.push(turn);
          return {};
        },
      };
      return {
        bridge: bridge as unknown as ChannelTurnBridge,
      };
    };

    const dependencies: RunChannelModeDependencies = {
      createSession: async (options) => {
        const result = await createHostedSession(options);
        hostedSession = {
          runtime: result.runtime,
          sessionId: result.session.sessionManager.getSessionId(),
        };
        return result;
      },
      collectPromptTurnOutputs: async (_session, prompt) => {
        capturedPrompts.push(prompt);
        return {
          assistantText: "ACK_FROM_FAKE_PROMPT_EXECUTOR",
          toolOutputs: [],
        };
      },
      handleQuestionsCommand: handleQuestionsChannelCommand,
      launchers: {
        telegram: launcher,
      },
    };

    try {
      await runChannelMode({
        cwd: workspace,
        configPath,
        managedToolMode: "direct",
        verbose: false,
        channel: "telegram",
        channelConfig,
        shutdownSignal: abortController.signal,
        dependencies,
      });
    } finally {
      cleanupTestWorkspace(workspace);
    }

    expect(capturedPrompts).toHaveLength(2);
    expect(capturedPrompts[1]).toContain(`Question ID: ${hostedSession?.questionId}`);
    expect(capturedPrompts[1]).toContain("Answer: Target the daemon path first.");
    expect(observedAnswerEventCount).toBe(1);
  });

  test("channel orchestration keeps /status and /answer durable after agent session eviction", async () => {
    const workspace = createTestWorkspace("channel-telegram-durable-questions-after-eviction");
    const configPath = writeChannelConfig(workspace, {
      orchestrationEnabled: true,
      orchestrationLimits: {
        maxLiveRuntimes: 1,
      },
    });
    const channelConfig = {
      telegram: {
        token: "bot-token",
      },
    };
    const capturedPrompts: string[] = [];
    const outboundTurns: TurnEnvelope[] = [];
    const abortController = new AbortController();
    let observedQuestionSurface:
      | {
          sessionIds: string[];
          liveSessionId?: string;
        }
      | undefined;
    let observedAnswerEventCount = 0;
    let defaultSession:
      | {
          runtime: Awaited<ReturnType<typeof createHostedSession>>["runtime"];
          sessionId: string;
          questionId?: string;
        }
      | undefined;

    const launcher: ChannelModeLauncher = (input) => {
      const bridge = {
        async start(): Promise<void> {
          await input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-default-evicted-1",
              text: "hello default agent",
            }),
          );
          await waitUntil(
            () => outboundTurns.length >= 1 && defaultSession !== undefined,
            5_000,
            "timed out waiting for default agent session bootstrap",
          );
          defaultSession!.questionId = recordDelegatedOpenQuestion({
            runtime: defaultSession!.runtime,
            sessionId: defaultSession!.sessionId,
            runId: "telegram-default-question-1",
            question: "Should the update target the daemon or the print path?",
          });

          await input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-create-analyst-1",
              text: "/agent new analyst",
            }),
          );
          await input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-analyst-evict-1",
              text: "@analyst hello analyst",
            }),
          );
          await waitUntil(
            () => capturedPrompts.length >= 2,
            5_000,
            "timed out waiting for analyst prompt after default eviction",
          );

          await input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-questions-after-evict-1",
              text: "/status @default",
            }),
          );
          await waitUntil(
            () =>
              outboundTurns.some((turn) =>
                readTurnText(turn).includes(
                  "Should the update target the daemon or the print path?",
                ),
              ),
            5_000,
            "timed out waiting for durable questions reply after eviction",
          );

          await input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-answer-after-evict-1",
              text: `/answer @default ${defaultSession!.questionId} Target the daemon path first.`,
            }),
          );
          await waitUntil(
            () =>
              capturedPrompts.some((prompt) =>
                prompt.includes(`Question ID: ${defaultSession!.questionId}`),
              ) &&
              (defaultSession?.runtime.inspect.events.records
                .query(defaultSession.sessionId)
                .filter((event) => event.type === OPERATOR_QUESTION_ANSWERED_EVENT_TYPE).length ??
                0) >= 1,
            5_000,
            "timed out waiting for durable answer routing after eviction",
          );
          observedAnswerEventCount =
            defaultSession?.runtime.inspect.events.records
              .query(defaultSession.sessionId)
              .filter((event) => event.type === OPERATOR_QUESTION_ANSWERED_EVENT_TYPE).length ?? 0;
          abortController.abort();
        },
        async stop(): Promise<void> {
          return;
        },
        async sendTurn(turn: TurnEnvelope): Promise<Record<string, never>> {
          outboundTurns.push(turn);
          return {};
        },
      };
      return {
        bridge: bridge as unknown as ChannelTurnBridge,
      };
    };

    const dependencies: RunChannelModeDependencies = {
      createSession: async (options) => {
        const result = await createHostedSession(options);
        if ((options?.runtime?.identity.agentId ?? "default") === "default" && !defaultSession) {
          defaultSession = {
            runtime: result.runtime,
            sessionId: result.session.sessionManager.getSessionId(),
          };
        }
        return result;
      },
      collectPromptTurnOutputs: async (_session, prompt) => {
        capturedPrompts.push(prompt);
        return {
          assistantText: "ACK_FROM_FAKE_PROMPT_EXECUTOR",
          toolOutputs: [],
        };
      },
      handleQuestionsCommand: async (input) => {
        observedQuestionSurface = input.questionSurface
          ? {
              sessionIds: [...input.questionSurface.sessionIds],
              liveSessionId: input.questionSurface.liveSessionId,
            }
          : undefined;
        return handleQuestionsChannelCommand(input);
      },
      launchers: {
        telegram: launcher,
      },
    };

    try {
      await runChannelMode({
        cwd: workspace,
        configPath,
        managedToolMode: "direct",
        verbose: false,
        channel: "telegram",
        channelConfig,
        shutdownSignal: abortController.signal,
        dependencies,
      });
    } finally {
      cleanupTestWorkspace(workspace);
    }

    const questionsReply = outboundTurns.find((turn) =>
      readTurnText(turn).includes("Operator inbox @default"),
    );
    expect(readTurnText(questionsReply)).toContain(
      "Should the update target the daemon or the print path?",
    );
    expect(observedQuestionSurface?.liveSessionId).toBe(undefined);
    expect(observedQuestionSurface?.sessionIds).toContain(defaultSession?.sessionId ?? "");
    expect(
      capturedPrompts.some((prompt) =>
        prompt.includes(`Question ID: ${defaultSession?.questionId}`),
      ),
    ).toBe(true);
    expect(observedAnswerEventCount).toBe(1);
  });

  test("channel orchestration does not record answer receipts before a routed answer turn fails", async () => {
    const workspace = createTestWorkspace("channel-telegram-answer-receipt-before-route-failure");
    const configPath = writeChannelConfig(workspace, { orchestrationEnabled: true });
    const channelConfig = {
      telegram: {
        token: "bot-token",
      },
    };
    const outboundTurns: TurnEnvelope[] = [];
    const abortController = new AbortController();
    let promptCount = 0;
    let observedAnswerEventCount = 0;
    let defaultSession:
      | {
          runtime: Awaited<ReturnType<typeof createHostedSession>>["runtime"];
          sessionId: string;
          questionId?: string;
        }
      | undefined;

    const launcher: ChannelModeLauncher = (input) => {
      const bridge = {
        async start(): Promise<void> {
          await input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-answer-receipt-1",
              text: "hello default agent",
            }),
          );
          await waitUntil(
            () => outboundTurns.length >= 1 && defaultSession !== undefined,
            5_000,
            "timed out waiting for default session bootstrap",
          );
          defaultSession!.questionId = recordDelegatedOpenQuestion({
            runtime: defaultSession!.runtime,
            sessionId: defaultSession!.sessionId,
            runId: "telegram-answer-receipt-question-1",
            question: "Should the update target the daemon or the print path?",
          });

          await input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-answer-receipt-failure-1",
              text: `/answer ${defaultSession!.questionId} Target the daemon path first.`,
            }),
          );
          await waitUntil(
            () => promptCount >= 2,
            5_000,
            "timed out waiting for routed answer failure",
          );
          observedAnswerEventCount =
            defaultSession?.runtime.inspect.events.records
              .query(defaultSession.sessionId)
              .filter((event) => event.type === OPERATOR_QUESTION_ANSWERED_EVENT_TYPE).length ?? 0;
          abortController.abort();
        },
        async stop(): Promise<void> {
          return;
        },
        async sendTurn(turn: TurnEnvelope): Promise<Record<string, never>> {
          outboundTurns.push(turn);
          return {};
        },
      };
      return {
        bridge: bridge as unknown as ChannelTurnBridge,
      };
    };

    const dependencies: RunChannelModeDependencies = {
      createSession: async (options) => {
        const result = await createHostedSession(options);
        if ((options?.runtime?.identity.agentId ?? "default") === "default" && !defaultSession) {
          defaultSession = {
            runtime: result.runtime,
            sessionId: result.session.sessionManager.getSessionId(),
          };
        }
        return result;
      },
      collectPromptTurnOutputs: async () => {
        promptCount += 1;
        if (promptCount >= 2) {
          throw new Error("simulated_answer_route_failure");
        }
        return {
          assistantText: "ACK_FROM_FAKE_PROMPT_EXECUTOR",
          toolOutputs: [],
        };
      },
      launchers: {
        telegram: launcher,
      },
    };

    try {
      await runChannelMode({
        cwd: workspace,
        configPath,
        managedToolMode: "direct",
        verbose: false,
        channel: "telegram",
        channelConfig,
        shutdownSignal: abortController.signal,
        dependencies,
      });
    } finally {
      cleanupTestWorkspace(workspace);
    }

    expect(promptCount).toBe(2);
    expect(outboundTurns).toHaveLength(1);
    expect(observedAnswerEventCount).toBe(0);
  });

  test("channel orchestration lets /status target an explicit agent instead of the current focus", async () => {
    const workspace = createTestWorkspace("channel-telegram-inspect-explicit-agent");
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src", "index.ts"), "export const ok = true;\n", "utf8");
    const configPath = writeChannelConfig(workspace, { orchestrationEnabled: true });
    const channelConfig = {
      telegram: {
        token: "bot-token",
      },
    };
    const capturedPrompts: string[] = [];
    const outboundTurns: TurnEnvelope[] = [];
    const abortController = new AbortController();

    const launcher: ChannelModeLauncher = (input) => {
      const bridge = {
        async start(): Promise<void> {
          await input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-default-1",
              text: "hello default agent",
            }),
          );
          await input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-create-1",
              text: "/agent new analyst",
            }),
          );
          await input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-analyst-1",
              text: "@analyst hello analyst agent",
            }),
          );
          await input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-inspect-explicit-1",
              text: "/status @default src",
            }),
          );
          await waitUntil(
            () => outboundTurns.length >= 4,
            5_000,
            "timed out waiting for explicit-agent inspect reply",
          );
          abortController.abort();
        },
        async stop(): Promise<void> {
          return;
        },
        async sendTurn(turn: TurnEnvelope): Promise<Record<string, never>> {
          outboundTurns.push(turn);
          return {};
        },
      };
      return {
        bridge: bridge as unknown as ChannelTurnBridge,
      };
    };

    const dependencies: RunChannelModeDependencies = {
      collectPromptTurnOutputs: async (_session, prompt) => {
        capturedPrompts.push(prompt);
        return {
          assistantText: "ACK_FROM_FAKE_PROMPT_EXECUTOR",
          toolOutputs: [],
        };
      },
      handleInspectCommand: handleInspectChannelCommand,
      launchers: {
        telegram: launcher,
      },
    };

    try {
      await runChannelMode({
        cwd: workspace,
        configPath,
        managedToolMode: "direct",
        verbose: false,
        channel: "telegram",
        channelConfig,
        shutdownSignal: abortController.signal,
        dependencies,
      });
    } finally {
      cleanupTestWorkspace(workspace);
    }

    expect(capturedPrompts).toHaveLength(2);
    expect(capturedPrompts[0]).toContain("hello default agent");
    expect(capturedPrompts[1]).toContain("hello analyst agent");

    const explicitInsightText = outboundTurns[3]?.parts[0];
    const text =
      explicitInsightText && "text" in explicitInsightText ? explicitInsightText.text : "";
    expect(text).toContain("Status @default (focus @analyst)");
    expect(text).toContain("  Inspect @default —");
    expect(text).toContain("  Focus: @analyst · explicit target: @default");
    expect(text).toContain("  Dir: src");
  });

  test("channel orchestration routes /update through the focused agent with the shared upgrade workflow", async () => {
    const workspace = createTestWorkspace("channel-telegram-update");
    const configPath = writeChannelConfig(workspace, { orchestrationEnabled: true });
    const channelConfig = {
      telegram: {
        token: "bot-token",
      },
    };
    const capturedPrompts: string[] = [];
    const outboundTurns: TurnEnvelope[] = [];
    const abortController = new AbortController();

    const launcher: ChannelModeLauncher = (input) => {
      const bridge = {
        async start(): Promise<void> {
          await input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-update-1",
              text: "/update target=latest safe rollout",
            }),
          );
          await waitUntil(
            () => outboundTurns.length >= 1,
            5_000,
            "timed out waiting for channel update reply",
          );
          abortController.abort();
        },
        async stop(): Promise<void> {
          return;
        },
        async sendTurn(turn: TurnEnvelope): Promise<Record<string, never>> {
          outboundTurns.push(turn);
          return {};
        },
      };
      return {
        bridge: bridge as unknown as ChannelTurnBridge,
      };
    };

    const dependencies: RunChannelModeDependencies = {
      collectPromptTurnOutputs: async (_session, prompt) => {
        capturedPrompts.push(prompt);
        return {
          assistantText: "UPDATE_ACK_FROM_FAKE_PROMPT_EXECUTOR",
          toolOutputs: [],
        };
      },
      handleInspectCommand: handleInspectChannelCommand,
      launchers: {
        telegram: launcher,
      },
    };

    try {
      await runChannelMode({
        cwd: workspace,
        configPath,
        managedToolMode: "direct",
        verbose: false,
        channel: "telegram",
        channelConfig,
        shutdownSignal: abortController.signal,
        dependencies,
      });
    } finally {
      cleanupTestWorkspace(workspace);
    }

    expect(capturedPrompts).toHaveLength(1);
    expect(capturedPrompts[0]).toContain("Run a Brewva update workflow for this environment.");
    expect(capturedPrompts[0]).toContain("Review the relevant changelog or release notes");
    expect(capturedPrompts[0]).toContain("target=latest safe rollout");
    expect(outboundTurns[0]?.parts).toEqual([
      { type: "text", text: "UPDATE_ACK_FROM_FAKE_PROMPT_EXECUTOR" },
    ]);
  });

  test("channel orchestration blocks a duplicate /update while an earlier update is still pending", async () => {
    const workspace = createTestWorkspace("channel-telegram-update-lock");
    const configPath = writeChannelConfig(workspace, { orchestrationEnabled: true });
    const channelConfig = {
      telegram: {
        token: "bot-token",
      },
    };
    const capturedPrompts: string[] = [];
    const outboundTurns: TurnEnvelope[] = [];
    const abortController = new AbortController();
    let releaseFirstUpdate: (() => void) | undefined;
    const firstUpdateGate = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });

    const launcher: ChannelModeLauncher = (input) => {
      const bridge = {
        async start(): Promise<void> {
          const firstInbound = input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-update-lock-1",
              text: "/update target=latest",
            }),
          );
          await waitUntil(
            () => capturedPrompts.length === 1,
            5_000,
            "timed out waiting for the first update prompt",
          );
          await input.onInboundTurn(
            createInboundTurn({
              turnId: "turn-update-lock-2",
              text: "/update target=latest",
            }),
          );
          await waitUntil(
            () =>
              outboundTurns.some((turn) => {
                const part = turn.parts[0];
                return part?.type === "text" && part.text.includes("Update already in progress");
              }),
            5_000,
            "timed out waiting for the duplicate update rejection",
          );
          releaseFirstUpdate?.();
          await firstInbound;
          await waitUntil(
            () =>
              outboundTurns.some((turn) => {
                const part = turn.parts[0];
                return part?.type === "text" && part.text === "UPDATE_ACK_AFTER_LOCK";
              }),
            5_000,
            "timed out waiting for the original update completion",
          );
          abortController.abort();
        },
        async stop(): Promise<void> {
          return;
        },
        async sendTurn(turn: TurnEnvelope): Promise<Record<string, never>> {
          outboundTurns.push(turn);
          return {};
        },
      };
      return {
        bridge: bridge as unknown as ChannelTurnBridge,
      };
    };

    const dependencies: RunChannelModeDependencies = {
      collectPromptTurnOutputs: async (_session, prompt) => {
        capturedPrompts.push(prompt);
        await firstUpdateGate;
        return {
          assistantText: "UPDATE_ACK_AFTER_LOCK",
          toolOutputs: [],
        };
      },
      handleInspectCommand: handleInspectChannelCommand,
      launchers: {
        telegram: launcher,
      },
    };

    try {
      await runChannelMode({
        cwd: workspace,
        configPath,
        managedToolMode: "direct",
        verbose: false,
        channel: "telegram",
        channelConfig,
        shutdownSignal: abortController.signal,
        dependencies,
      });
    } finally {
      cleanupTestWorkspace(workspace);
    }

    expect(capturedPrompts).toHaveLength(1);
    const outboundTexts = outboundTurns.flatMap((turn) => {
      const part = turn.parts[0];
      return part?.type === "text" ? [part.text] : [];
    });
    expect(outboundTexts.join("\n")).toContain("Update already in progress");
    expect(outboundTexts).toContain("UPDATE_ACK_AFTER_LOCK");
  });
});
