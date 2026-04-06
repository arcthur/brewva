import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";
import type { AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import {
  createChannelAgentDispatch,
  buildChannelDispatchPrompt,
  collectPromptTurnOutputs,
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

  test("collectPromptTurnOutputs resumes a pending reasoning revert inline and clears superseded channel outputs", async () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-channel-reasoning-resume-")),
    });
    const sessionId = "agent-session:channel-reasoning";
    runtime.maintain.context.onTurnStart(sessionId, 1);
    const checkpointA = runtime.authority.reasoning.recordCheckpoint(sessionId, {
      boundary: "operator_marker",
      leafEntryId: "leaf-channel-a",
    });
    runtime.authority.reasoning.recordCheckpoint(sessionId, {
      boundary: "verification_boundary",
      leafEntryId: "leaf-channel-b",
    });

    const sentMessages: string[] = [];
    const branchWithSummaryCalls: Array<{
      targetLeafEntryId: string | null;
      summaryText: string;
      summaryDetails: Record<string, unknown>;
      replaceCurrent: boolean;
    }> = [];
    const rebuiltMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "restored channel branch summary" }],
      },
    ];
    const replacedMessages: unknown[] = [];
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    const session = {
      subscribe(next: (event: AgentSessionEvent) => void) {
        listener = next;
        return () => {
          listener = undefined;
        };
      },
      sessionManager: {
        getSessionId: () => sessionId,
        branchWithSummary: (
          targetLeafEntryId: string | null,
          summaryText: string,
          summaryDetails: Record<string, unknown>,
          replaceCurrent: boolean,
        ) => {
          branchWithSummaryCalls.push({
            targetLeafEntryId,
            summaryText,
            summaryDetails,
            replaceCurrent,
          });
        },
        buildSessionContext: () => ({
          messages: rebuiltMessages,
        }),
      },
      async prompt(content: string): Promise<void> {
        sentMessages.push(content);
        if (sentMessages.length === 1) {
          listener?.({
            type: "tool_execution_end",
            toolCallId: "tool-stale-1",
            toolName: "read",
            result: "stale branch output",
            isError: false,
          } as AgentSessionEvent);
          runtime.authority.reasoning.revert(sessionId, {
            toCheckpointId: checkpointA.checkpointId,
            trigger: "operator_request",
            continuity: "Resume only from the restored channel branch.",
          });
          throw new Error("turn aborted for reasoning revert");
        }
        listener?.({
          type: "tool_execution_end",
          toolCallId: "tool-current-2",
          toolName: "read",
          result: "current branch output",
          isError: false,
        } as AgentSessionEvent);
        listener?.({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "channel resumed answer" }],
          },
        } as AgentSessionEvent);
      },
      agent: {
        async waitForIdle(): Promise<void> {
          return;
        },
        replaceMessages(messages: unknown): void {
          replacedMessages.push(messages);
        },
      },
    };

    const outputs = await collectPromptTurnOutputs(session as any, "initial channel prompt", {
      runtime,
      sessionId,
      turnId: "turn-channel-reasoning",
    });

    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[0]).toBe("initial channel prompt");
    expect(sentMessages[1]).toContain("Reasoning branch revert completed");
    expect(outputs.assistantText).toBe("channel resumed answer");
    expect(outputs.toolOutputs).toEqual([
      expect.objectContaining({
        toolCallId: "tool-current-2",
        toolName: "read",
      }),
    ]);
    expect(branchWithSummaryCalls).toEqual([
      expect.objectContaining({
        targetLeafEntryId: "leaf-channel-a",
        summaryText: "Resume only from the restored channel branch.",
        replaceCurrent: true,
        summaryDetails: expect.objectContaining({
          toCheckpointId: checkpointA.checkpointId,
        }),
      }),
    ]);
    expect(replacedMessages).toEqual([rebuiltMessages]);
  });
});
