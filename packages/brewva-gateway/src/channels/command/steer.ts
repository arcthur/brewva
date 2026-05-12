import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";
import type { ChannelReplyWriter } from "../channel-reply-writer.js";
import type { ChannelRuntimeSessionPort } from "../session/coordinator.js";
import type { ChannelControlCommand } from "../types.js";
import type { ChannelCommandDispatchResult } from "./dispatch.js";

function formatSteerDropReason(reason: unknown): string {
  switch (reason) {
    case "aborted":
      return "the turn was aborted";
    case "failed":
      return "the turn failed";
    case "no_tool_boundary":
      return "no tool-result boundary was reached";
    case "overwritten":
      return "the committed tool result replaced the guidance";
    default:
      return "the steer could not be applied";
  }
}

function subscribeChannelSteerOutcome(input: {
  session: ChannelRuntimeSessionPort;
  replyWriter: ChannelReplyWriter;
  turn: TurnEnvelope;
  scopeKey: string;
  agentId: string;
}): () => void {
  let unsubscribe: (() => void) | undefined;
  const close = () => {
    unsubscribe?.();
    unsubscribe = undefined;
  };
  unsubscribe = input.session.subscribe((event) => {
    if (event.type !== "steer_applied" && event.type !== "steer_dropped") {
      return;
    }
    close();
    if (event.type === "steer_applied") {
      void input.replyWriter.sendControllerReply(
        input.turn,
        input.scopeKey,
        `Steer applied for @${input.agentId}.`,
        {
          command: "steer",
          agentId: input.agentId,
          status: "applied",
          agentSessionId: input.session.agentSessionId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
        },
      );
      return;
    }
    if (event.type === "steer_dropped") {
      void input.replyWriter.sendControllerReply(
        input.turn,
        input.scopeKey,
        `Steer dropped for @${input.agentId}: ${formatSteerDropReason(event.reason)}.`,
        {
          command: "steer",
          agentId: input.agentId,
          status: "dropped",
          reason: event.reason,
          agentSessionId: input.session.agentSessionId,
        },
      );
    }
  });
  return close;
}

export async function handleChannelSteerCommand(input: {
  command: Extract<ChannelControlCommand, { kind: "steer" }>;
  turn: TurnEnvelope;
  replyWriter: ChannelReplyWriter;
  targetAgentId: string;
  isTargetActive: boolean;
  openLiveSession(scopeKey: string, agentId: string): ChannelRuntimeSessionPort | undefined;
}): Promise<ChannelCommandDispatchResult> {
  if (!input.isTargetActive) {
    await input.replyWriter.sendControllerReply(
      input.turn,
      input.command.scopeKey,
      `Steer unavailable: agent @${input.targetAgentId} is not active in this workspace.`,
      {
        command: "steer",
        agentId: input.targetAgentId,
        status: "agent_not_active",
      },
    );
    return { handled: true };
  }
  const targetSession = input.openLiveSession(input.command.scopeKey, input.targetAgentId);
  if (!targetSession) {
    await input.replyWriter.sendControllerReply(
      input.turn,
      input.command.scopeKey,
      `Steer unavailable: no live session exists for @${input.targetAgentId} in this conversation.`,
      {
        command: "steer",
        agentId: input.targetAgentId,
        status: "session_not_found",
      },
    );
    return { handled: true };
  }
  const unsubscribeSteerOutcome = subscribeChannelSteerOutcome({
    session: targetSession,
    replyWriter: input.replyWriter,
    turn: input.turn,
    scopeKey: input.command.scopeKey,
    agentId: input.targetAgentId,
  });
  let outcome: Awaited<ReturnType<ChannelRuntimeSessionPort["steer"]>>;
  try {
    outcome = await targetSession.steer(input.command.prompt);
  } catch (error) {
    unsubscribeSteerOutcome();
    throw error;
  }
  if (outcome.status === "queued") {
    await input.replyWriter.sendControllerReply(
      input.turn,
      input.command.scopeKey,
      `Queued steer for @${input.targetAgentId}.`,
      {
        command: "steer",
        agentId: input.targetAgentId,
        status: "queued",
        chars: outcome.chars,
        agentSessionId: targetSession.agentSessionId,
      },
    );
    return { handled: true };
  }
  unsubscribeSteerOutcome();
  await input.replyWriter.sendControllerReply(
    input.turn,
    input.command.scopeKey,
    `Steer unavailable: no turn is currently streaming for @${input.targetAgentId}.`,
    {
      command: "steer",
      agentId: input.targetAgentId,
      status: outcome.status,
      agentSessionId: targetSession.agentSessionId,
    },
  );
  return { handled: true };
}
