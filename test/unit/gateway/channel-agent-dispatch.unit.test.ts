import { describe, expect, test } from "bun:test";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";
import {
  createChannelAgentDispatch,
  buildChannelDispatchPrompt,
} from "../../../packages/brewva-gateway/src/channels/channel-agent-dispatch.js";
import type { ChannelSessionHandle } from "../../../packages/brewva-gateway/src/channels/channel-session-coordinator.js";
import { resolveTelegramChannelSkillPolicyState } from "../../../packages/brewva-gateway/src/channels/skill-policy.js";
import { createRuntimeFixture } from "../../helpers/runtime.js";

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

describe("channel agent dispatch", () => {
  test("buildChannelDispatchPrompt canonicalizes the session id and preserves channel context in the prompt", () => {
    const turn = createInboundTurn();
    const { canonicalTurn, prompt } = buildChannelDispatchPrompt({
      turn,
      agentSessionId: "agent-session:reviewer",
      skillPolicyState: resolveTelegramChannelSkillPolicyState({
        availableSkillNames: ["telegram"],
      }),
    });

    expect(canonicalTurn.sessionId).toBe("agent-session:reviewer");
    expect(canonicalTurn.meta?.channelSessionId).toBe("channel-session:telegram:1");
    expect(prompt).toContain("[Brewva Channel Skill Policy]");
    expect(prompt).toContain("Primary channel skill: telegram");
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
      skillPolicyState: resolveTelegramChannelSkillPolicyState({
        availableSkillNames: ["telegram"],
      }),
    });

    await dispatcher.processUserTurnOnAgent(turn, "wal-1", "chat-1", "reviewer");

    expect(collectCalls).toEqual([
      {
        prompt: expect.stringContaining("[Brewva Channel Skill Policy]"),
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
});
