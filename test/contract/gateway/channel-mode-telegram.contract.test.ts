import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleInsightChannelCommand } from "@brewva/brewva-cli";
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

  test("channel orchestration handles /insight inline without a model turn", async () => {
    const workspace = createTestWorkspace("channel-telegram-insight");
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
              turnId: "turn-insight-1",
              text: "/insight src",
            }),
          );
          await waitUntil(
            () => outboundTurns.length >= 2,
            5_000,
            "timed out waiting for channel insight reply",
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
      handleInsightCommand: handleInsightChannelCommand,
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

    const insightText = outboundTurns[1]?.parts[0];
    expect(insightText).toEqual(
      expect.objectContaining({
        type: "text",
      }),
    );
    const text = insightText && "text" in insightText ? insightText.text : "";
    expect(text).toContain("Insight @default —");
    expect(text).toContain("Dir: src");
    expect(text).toContain("Mode: ");
    expect(text).toContain("Scope: ");
    expect(text).toContain("Findings:");
  });

  test("channel orchestration lets /insight target an explicit agent instead of the current focus", async () => {
    const workspace = createTestWorkspace("channel-telegram-insight-explicit-agent");
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
              turnId: "turn-insight-explicit-1",
              text: "/insight @default src",
            }),
          );
          await waitUntil(
            () => outboundTurns.length >= 4,
            5_000,
            "timed out waiting for explicit-agent insight reply",
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
      handleInsightCommand: handleInsightChannelCommand,
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
    expect(text).toContain("Insight @default —");
    expect(text).toContain("Focus: @analyst · explicit target: @default");
    expect(text).toContain("Dir: src");
  });
});
