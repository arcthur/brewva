import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrewvaToolUpdateHandler } from "@brewva/brewva-substrate/tools";
import type { TurnEnvelope } from "@brewva/brewva-vocabulary/wire";
import { Type } from "@sinclair/typebox";
import {
  createChannelAgentDispatch,
  buildChannelDispatchPrompt,
  collectPromptTurnOutputs,
} from "../../../packages/brewva-gateway/src/channels/channel-agent-dispatch.js";
import { resolveTelegramChannelPolicyState } from "../../../packages/brewva-gateway/src/channels/policy/channel-policy.js";
import type { ChannelSessionHandle } from "../../../packages/brewva-gateway/src/channels/session/coordinator.js";
import { NOOP_UI } from "../../../packages/brewva-gateway/src/hosted/internal/session/managed-agent/noop-ui.js";
import {
  createHostedRuntimeAdapter,
  type HostedRuntimeAdapterPort,
} from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";
import {
  fauxAssistantMessage,
  fauxToolCall,
  registerFauxProvider,
} from "../../../packages/brewva-provider-core/src/providers/faux/index.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

type RuntimeTurnSession = {
  model: ReturnType<ReturnType<typeof registerFauxProvider>["getModel"]>;
  sessionManager: {
    getSessionId(): string;
  };
  getRegisteredTools(): readonly unknown[];
  getRuntimeModelCatalog(): {
    getApiKeyAndHeaders(): Promise<{ ok: true }>;
  };
  createRuntimeToolContext(): unknown;
};

function createInboundTurn(): TurnEnvelope {
  return {
    schema: "brewva.turn.v1",
    kind: "approval",
    sessionId: "channel-session:telegram:1",
    turnId: "turn-approval-1",
    channel: "telegram",
    conversationId: "chat-1",
    timestamp: Date.now(),
    parts: [{ type: "text", text: "please approve" }],
    approval: {
      requestId: "approval-1",
      title: "Approve deploy",
      detail: "Ship the current patch",
      actions: [{ id: "approve", label: "Approve" }],
    },
  };
}

function createRuntimeTurnFixture(input: {
  providerName: string;
  sessionId: string;
  toolResult?: {
    content: string;
    isError?: boolean;
  };
}): {
  runtime: HostedRuntimeAdapterPort;
  provider: ReturnType<typeof registerFauxProvider>;
  session: RuntimeTurnSession;
  unregister(): void;
} {
  const runtime = createHostedRuntimeAdapter({
    cwd: mkdtempSync(join(tmpdir(), `${input.providerName}-`)),
  });
  const provider = registerFauxProvider({
    provider: input.providerName,
    api: "faux",
    tokenSize: { min: 1, max: 1 },
  });
  const model = provider.getModel();
  const toolResult = input.toolResult;
  const tools =
    toolResult === undefined
      ? []
      : [
          {
            name: "exec",
            label: "Exec",
            description: "Runs a channel-mode test command.",
            parameters: Type.Object({}),
            async execute(
              _toolCallId: string,
              _params: Record<string, never>,
              _signal: AbortSignal | undefined,
              onUpdate: BrewvaToolUpdateHandler<{ stage: string }> | undefined,
            ) {
              await onUpdate?.({
                content: [{ type: "text" as const, text: "exec:running" }],
                outcome: { kind: "ok", value: { stage: "running" } },
                display: { summaryText: "running" },
              });
              return {
                content: [{ type: "text" as const, text: toolResult.content }],
                outcome:
                  toolResult.isError === true
                    ? { kind: "err" as const, error: { message: toolResult.content } }
                    : { kind: "ok" as const, value: {} },
              };
            },
          },
        ];

  return {
    runtime,
    provider,
    session: {
      model,
      sessionManager: {
        getSessionId: () => input.sessionId,
      },
      getRegisteredTools: () => tools,
      getRuntimeModelCatalog: () => ({
        async getApiKeyAndHeaders() {
          return { ok: true as const };
        },
      }),
      createRuntimeToolContext: () => ({
        ui: NOOP_UI,
        hasUI: false,
        cwd: runtime.identity.cwd,
        sessionManager: {
          getSessionId: () => input.sessionId,
          getLeafId: () => null,
        },
        modelRegistry: {
          getAll: () => [model],
        },
        model,
        isIdle: () => true,
        signal: undefined,
        abort: () => undefined,
        hasPendingMessages: () => false,
        shutdown: () => undefined,
        compact: () => undefined,
        getContextUsage: () => undefined,
        getSystemPrompt: () => "Channel mode test system prompt.",
      }),
    },
    unregister() {
      provider.unregister();
    },
  };
}

describe("channel agent dispatch", () => {
  test("buildChannelDispatchPrompt canonicalizes the session id and preserves channel context in the prompt", () => {
    const turn = createInboundTurn();
    const { canonicalTurn, prompt } = buildChannelDispatchPrompt({
      turn,
      agentSessionId: "agent-session:reviewer",
      channelPolicyState: resolveTelegramChannelPolicyState(),
    });

    expect(canonicalTurn.sessionId).toBe("agent-session:reviewer");
    expect(canonicalTurn.meta?.channelSessionId).toBe("channel-session:telegram:1");
    expect(prompt).toContain("[Brewva Channel Policy]");
    expect(prompt).toContain("Transport: telegram");
    expect(prompt).toContain("approval_request:approval-1");
    expect(prompt).toContain("approval_title:Approve deploy");
  });

  test("processUserTurnOnAgent owns prompt assembly, session touch, and outbound reply orchestration", async () => {
    const eventTypes: string[] = [];
    const runtime = createRuntimeFixture({
      events: {
        record: (input: { type: string }) => {
          eventTypes.push(input.type);
          return undefined;
        },
      },
    });
    const turn = createInboundTurn();
    const touchedTurns: TurnEnvelope[] = [];
    const collectCalls: Array<{
      prompt: string;
      sessionId?: string;
      turnId?: string;
    }> = [];
    const touchedAgents: string[] = [];
    const outboundSequences: number[][] = [];
    let nextSequence = 0;

    const state = {
      scopeKey: "chat-1",
      agentId: "reviewer",
      runtime,
      agentSessionId: "agent-session:reviewer",
      session: {
        session: {},
      },
    } as unknown as ChannelSessionHandle;

    const dispatcher = createChannelAgentDispatch({
      registry: {
        touchAgent: async (agentId) => {
          touchedAgents.push(agentId);
        },
      },
      sessionCoordinator: {
        getOrCreateSession: async () => state,
        enqueueSessionTask: async (_state, task) => task(),
        touchSession: (handle) => {
          touchedTurns.push({
            ...turn,
            sessionId: handle.agentSessionId,
            meta: {
              ...turn.meta,
              channelSessionId: turn.sessionId,
            },
          });
        },
        nextOutboundSequence: () => {
          nextSequence += 1;
          return nextSequence;
        },
      },
      replyWriter: {
        sendAgentOutputs: async (input) => {
          outboundSequences.push([input.nextSequence(), input.nextSequence()]);
          expect(input.inbound.sessionId).toBe("agent-session:reviewer");
          expect(input.inbound.meta?.channelSessionId).toBe("channel-session:telegram:1");
          expect(input.agentId).toBe("reviewer");
          return 2;
        },
      },
      collectPromptTurnOutputs: async (_session, prompt, options) => {
        collectCalls.push({
          prompt,
          sessionId: options?.sessionId,
          turnId: options?.turnId,
        });
        return {
          assistantText: "final answer",
          toolOutputs: [
            {
              toolCallId: "tool-1",
              toolName: "read_file",
              isError: false,
              verdict: "success",
              text: "Tool read_file (tool-1) ok",
            },
          ],
        };
      },
      channelPolicyState: resolveTelegramChannelPolicyState(),
    });

    await dispatcher.processUserTurnOnAgent(turn, "wal-1", "chat-1", "reviewer");

    expect(collectCalls).toEqual([
      {
        prompt: expect.stringContaining("[Brewva Channel Policy]"),
        sessionId: "agent-session:reviewer",
        turnId: "turn-approval-1",
      },
    ]);
    expect(collectCalls[0]?.prompt).toContain("approval_request:approval-1");
    expect(touchedTurns).toHaveLength(1);
    expect(touchedTurns[0]?.sessionId).toBe("agent-session:reviewer");
    expect(touchedTurns[0]?.meta?.channelSessionId).toBe("channel-session:telegram:1");
    expect(touchedAgents).toEqual(["reviewer"]);
    expect(outboundSequences).toEqual([[1, 2]]);
    expect(eventTypes).toContain("channel_turn_dispatch_start");
    expect(eventTypes).toContain("channel_turn_dispatch_end");
    expect(eventTypes).toContain("channel_turn_outbound_complete");
  });

  test("executePromptForAgent assigns a distinct internal turn id for repeated delegated runs on the same inbound turn", async () => {
    const runtime = createRuntimeFixture();
    const turn = createInboundTurn();
    const collectCalls: Array<{ turnId?: string }> = [];
    let nextSequence = 0;
    const state = {
      scopeKey: "chat-1",
      agentId: "reviewer",
      runtime,
      agentSessionId: "agent-session:reviewer",
      session: {
        session: {},
      },
    } as unknown as ChannelSessionHandle;

    const dispatcher = createChannelAgentDispatch({
      registry: {
        touchAgent: async () => undefined,
      },
      sessionCoordinator: {
        getOrCreateSession: async () => state,
        enqueueSessionTask: async (_state, task) => task(),
        touchSession: () => undefined,
        nextOutboundSequence: () => {
          nextSequence += 1;
          return nextSequence;
        },
      },
      replyWriter: {
        sendAgentOutputs: async () => 0,
      },
      collectPromptTurnOutputs: async (_session, _prompt, options) => {
        collectCalls.push({ turnId: options?.turnId });
        return {
          assistantText: "ok",
          toolOutputs: [],
        };
      },
      channelPolicyState: resolveTelegramChannelPolicyState(),
    });

    await dispatcher.executePromptForAgent({
      scopeKey: "chat-1",
      agentId: "reviewer",
      prompt: "first delegated task",
      reason: "a2a",
      turn,
    });
    await dispatcher.executePromptForAgent({
      scopeKey: "chat-1",
      agentId: "reviewer",
      prompt: "second delegated task",
      reason: "a2a",
      turn,
    });

    expect(collectCalls).toEqual([
      { turnId: "turn-approval-1:a2a:1" },
      { turnId: "turn-approval-1:a2a:2" },
    ]);
  });

  test("collectPromptTurnOutputs aggregates assistant and tool outputs from runtime.turn", async () => {
    const sessionId = "channel-output-session";
    const fixture = createRuntimeTurnFixture({
      providerName: "faux-channel-output",
      sessionId,
      toolResult: { content: "done" },
    });
    fixture.provider.setResponses([
      fauxAssistantMessage([
        { type: "text", text: "final answer" },
        fauxToolCall("exec", { command: "pwd" }, { id: "tc-1" }),
      ]),
      fauxAssistantMessage(" after tool"),
    ]);

    try {
      const outputs = await collectPromptTurnOutputs(
        fixture.session as unknown as Parameters<typeof collectPromptTurnOutputs>[0],
        "hello",
        {
          runtime: fixture.runtime as never,
          sessionId,
          turnId: "turn-channel-output",
        },
      );

      expect(outputs.assistantText).toBe("final answer after tool");
      expect(outputs.toolOutputs).toHaveLength(1);
      expect(outputs.toolOutputs[0]?.text).toContain("Tool exec (tc-1) completed");
    } finally {
      fixture.unregister();
    }
  });

  test("collectPromptTurnOutputs marks runtime tool errors as failed", async () => {
    const sessionId = "channel-fail-verdict-session";
    const fixture = createRuntimeTurnFixture({
      providerName: "faux-channel-fail-verdict",
      sessionId,
      toolResult: { content: "FAIL src/foo.test.ts", isError: true },
    });
    fixture.provider.setResponses([
      fauxAssistantMessage([fauxToolCall("exec", { command: "pwd" }, { id: "tc-2" })]),
      fauxAssistantMessage("after failed tool"),
    ]);

    try {
      const outputs = await collectPromptTurnOutputs(
        fixture.session as unknown as Parameters<typeof collectPromptTurnOutputs>[0],
        "hello",
        {
          runtime: fixture.runtime as never,
          sessionId,
          turnId: "turn-channel-fail-verdict",
        },
      );

      expect(outputs.toolOutputs).toHaveLength(1);
      expect(outputs.toolOutputs[0]?.text).toContain("Tool exec (tc-2) failed");
    } finally {
      fixture.unregister();
    }
  });
});
