import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleInspectChannelCommand, handleInsightsChannelCommand } from "@brewva/brewva-cli";
import {
  DEFAULT_TELEGRAM_SKILL_NAME,
  runChannelMode,
  type ChannelModeLauncher,
  type RunChannelModeDependencies,
} from "@brewva/brewva-gateway";
import type { ChannelTurnBridge, TurnEnvelope } from "@brewva/brewva-runtime/channels";
import { waitUntil } from "../../helpers/process.js";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

function writeChannelConfig(
  workspace: string,
  options: {
    orchestrationEnabled?: boolean;
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

describe("gateway contract: telegram channel dispatch", () => {
  test("telegram inbound turns include the unified telegram skill policy", async () => {
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
    expect(prompt).toContain("[Brewva Channel Skill Policy]");
    expect(prompt).toContain(`Primary channel skill: ${DEFAULT_TELEGRAM_SKILL_NAME}`);
    expect(prompt).toContain("[channel:telegram] conversation:12345");
    expect(prompt).toContain("hello from channel e2e");
    expect(outboundTurns[0]?.parts).toEqual([
      { type: "text", text: "ACK_FROM_FAKE_PROMPT_EXECUTOR" },
    ]);
  });

  test("channel orchestration handles /inspect inline without a model turn", async () => {
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
              text: "/inspect src",
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

    const inspectText = outboundTurns[1]?.parts[0];
    expect(inspectText).toEqual(
      expect.objectContaining({
        type: "text",
      }),
    );
    const text = inspectText && "text" in inspectText ? inspectText.text : "";
    expect(text).toContain("Inspect @default —");
    expect(text).toContain("Dir: src");
    expect(text).toContain("Mode: ");
    expect(text).toContain("Scope: ");
    expect(text).toContain("Findings:");
  });

  test("channel orchestration handles /insights inline with the aggregate report surface", async () => {
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
              text: "/insights .",
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

    const insightsText = outboundTurns[1]?.parts[0];
    expect(insightsText).toEqual(
      expect.objectContaining({
        type: "text",
      }),
    );
    const text = insightsText && "text" in insightsText ? insightsText.text : "";
    expect(text).toContain("Insights @default");
    expect(text).toContain("Dirs:");
    expect(text).toContain("Friction:");
    expect(text).toContain("Verification:");
    expect(text).not.toContain("Brewva Project Insights");
    expect(text.split("\n").length).toBeLessThanOrEqual(5);
  });

  test("channel orchestration lets /inspect target an explicit agent instead of the current focus", async () => {
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
              text: "/new-agent analyst",
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
              text: "/inspect @default src",
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
    expect(text).toContain("Inspect @default —");
    expect(text).toContain("Focus: @analyst · explicit target: @default");
    expect(text).toContain("Dir: src");
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
    expect(outboundTexts.some((text) => text.includes("Update already in progress"))).toBe(true);
    expect(outboundTexts).toContain("UPDATE_ACK_AFTER_LOCK");
  });
});
