import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import { buildTurnEnvelope, type TurnEnvelope } from "@brewva/brewva-runtime/channels";
import { toErrorMessage } from "../utils/errors.js";

export interface ChannelToolTurnOutput {
  toolCallId: string;
  toolName: string;
  isError: boolean;
  verdict: string;
  text: string;
}

export interface ChannelReplyWriter {
  sendControllerReply(
    turn: TurnEnvelope,
    scopeKey: string,
    text: string,
    meta?: Record<string, unknown>,
  ): Promise<void>;
  sendAgentOutputs(input: {
    runtime: BrewvaRuntime;
    inbound: TurnEnvelope;
    agentSessionId: string;
    agentId: string;
    assistantText: string;
    toolOutputs: readonly ChannelToolTurnOutput[];
    nextSequence: () => number;
  }): Promise<number>;
}

function buildControllerReplyTurn(input: {
  runtime: BrewvaRuntime;
  inbound: TurnEnvelope;
  text: string;
  sequence: number;
  meta?: Record<string, unknown>;
}): TurnEnvelope {
  const now = Date.now();
  return buildTurnEnvelope({
    kind: "assistant",
    sessionId: input.inbound.sessionId,
    turnId: `${input.inbound.turnId}:assistant:${input.sequence}`,
    channel: input.inbound.channel,
    conversationId: input.inbound.conversationId,
    threadId: input.inbound.threadId,
    timestamp: now,
    parts: [{ type: "text", text: input.text }],
    meta: {
      inReplyToTurnId: input.inbound.turnId,
      agentSessionId: `controller:${input.runtime.agentId}`,
      generatedAt: now,
      ...input.meta,
    },
  });
}

function buildAgentReplyTurn(input: {
  inbound: TurnEnvelope;
  kind: "assistant" | "tool";
  text: string;
  agentSessionId: string;
  sequence: number;
  meta?: Record<string, unknown>;
}): TurnEnvelope {
  const now = Date.now();
  return buildTurnEnvelope({
    kind: input.kind,
    sessionId: input.inbound.sessionId,
    turnId: `${input.inbound.turnId}:${input.kind}:${input.sequence}`,
    channel: input.inbound.channel,
    conversationId: input.inbound.conversationId,
    threadId: input.inbound.threadId,
    timestamp: now,
    parts: [{ type: "text", text: input.text }],
    meta: {
      inReplyToTurnId: input.inbound.turnId,
      agentSessionId: input.agentSessionId,
      generatedAt: now,
      ...input.meta,
    },
  });
}

export function createChannelReplyWriter(input: {
  runtime: BrewvaRuntime;
  sendTurn(turn: TurnEnvelope): Promise<unknown>;
}): ChannelReplyWriter {
  const nextControllerSequenceByScope = new Map<string, number>();

  const nextControllerSequence = (scopeKey: string): number => {
    const next = (nextControllerSequenceByScope.get(scopeKey) ?? 0) + 1;
    nextControllerSequenceByScope.set(scopeKey, next);
    return next;
  };

  return {
    async sendControllerReply(
      turn: TurnEnvelope,
      scopeKey: string,
      text: string,
      meta?: Record<string, unknown>,
    ): Promise<void> {
      const trimmed = text.trim();
      if (!trimmed) return;
      const outbound = buildControllerReplyTurn({
        runtime: input.runtime,
        inbound: turn,
        text: trimmed,
        sequence: nextControllerSequence(scopeKey),
        meta,
      });
      try {
        await input.sendTurn(outbound);
      } catch (error) {
        input.runtime.events.record({
          sessionId: turn.sessionId,
          type: "channel_turn_outbound_error",
          payload: {
            turnId: turn.turnId,
            outboundKind: "assistant",
            agentSessionId: `controller:${input.runtime.agentId}`,
            agentId: input.runtime.agentId,
            scopeKey,
            error: toErrorMessage(error),
            isControllerReply: true,
          },
        });
      }
    },

    async sendAgentOutputs(output): Promise<number> {
      let outboundTurnsSent = 0;

      for (const toolOutput of output.toolOutputs) {
        const toolTurn = buildAgentReplyTurn({
          inbound: output.inbound,
          kind: "tool",
          text: toolOutput.text,
          agentSessionId: output.agentSessionId,
          sequence: output.nextSequence(),
          meta: {
            toolCallId: toolOutput.toolCallId,
            toolName: toolOutput.toolName,
            toolError: toolOutput.isError,
            toolVerdict: toolOutput.verdict,
            agentId: output.agentId,
          },
        });
        try {
          await input.sendTurn(toolTurn);
          outboundTurnsSent += 1;
        } catch (error) {
          output.runtime.events.record({
            sessionId: output.inbound.sessionId,
            type: "channel_turn_outbound_error",
            payload: {
              turnId: output.inbound.turnId,
              outboundKind: "tool",
              toolCallId: toolOutput.toolCallId,
              agentSessionId: output.agentSessionId,
              agentId: output.agentId,
              error: toErrorMessage(error),
            },
          });
        }
      }

      const assistantText = output.assistantText.trim();
      if (!assistantText) {
        return outboundTurnsSent;
      }

      const assistantTurn = buildAgentReplyTurn({
        inbound: output.inbound,
        kind: "assistant",
        text: assistantText,
        agentSessionId: output.agentSessionId,
        sequence: output.nextSequence(),
        meta: {
          agentId: output.agentId,
        },
      });
      try {
        await input.sendTurn(assistantTurn);
        outboundTurnsSent += 1;
      } catch (error) {
        output.runtime.events.record({
          sessionId: output.inbound.sessionId,
          type: "channel_turn_outbound_error",
          payload: {
            turnId: output.inbound.turnId,
            outboundKind: "assistant",
            agentSessionId: output.agentSessionId,
            agentId: output.agentId,
            error: toErrorMessage(error),
          },
        });
      }

      return outboundTurnsSent;
    },
  };
}
