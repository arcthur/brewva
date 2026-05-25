import type { TurnEnvelope } from "@brewva/brewva-vocabulary/wire";
import { buildBrewvaUpdatePrompt } from "../../ingress/api.js";
import type { ChannelReplyWriter } from "../channel-reply-writer.js";
import type { HostedRuntimeAdapterPort } from "../ports.js";
import type { ChannelUpdateLockManager } from "../session/update-lock.js";
import type { ChannelControlCommand } from "../types.js";
import type { ChannelCommandDispatchResult, ChannelPreparedCommand } from "./dispatch.js";
import type { ChannelCommandMatch } from "./parser.js";

export async function prepareChannelUpdateCommand(input: {
  command: Extract<ChannelControlCommand, { kind: "update" }>;
  match: ChannelCommandMatch;
  turn: TurnEnvelope;
  replyWriter: ChannelReplyWriter;
  runtime: HostedRuntimeAdapterPort;
  updateLock: ChannelUpdateLockManager;
  targetAgentId: string;
  isTargetActive: boolean;
  updateExecutionScope: {
    lockKey: string;
    lockTarget: string;
  };
}): Promise<ChannelPreparedCommand> {
  if (!input.isTargetActive) {
    return { match: input.match, handled: false };
  }
  const reservation = input.updateLock.tryReserve({
    turn: input.turn,
    scopeKey: input.command.scopeKey,
    agentId: input.targetAgentId,
  });
  if (reservation.kind === "blocked") {
    const blocked = reservation.blocked;
    input.runtime.ops.channel.command.updateLockBlocked({
      sessionId: input.turn.sessionId,
      payload: {
        scopeKey: input.command.scopeKey,
        turnId: input.turn.turnId,
        conversationId: input.turn.conversationId,
        agentId: input.targetAgentId,
        lockKey: reservation.lockKey,
        lockTarget: reservation.lockTarget,
        blockingScopeKey: blocked.scopeKey,
        blockingTurnId: blocked.turnId,
        blockingConversationId: blocked.conversationId,
        blockingAgentId: blocked.agentId ?? null,
        blockingSessionId: blocked.sessionId,
        blockingRequestedAt: blocked.requestedAt,
      },
    });
    const holder = blocked.agentId ? ` by @${blocked.agentId}` : "";
    await input.replyWriter.sendControllerReply(
      input.turn,
      input.command.scopeKey,
      `Update already in progress for ${reservation.lockTarget}${holder} (scope=${blocked.scopeKey}, turn=${blocked.turnId}). Wait for that run to finish before requesting another /update.`,
      {
        command: "update",
        status: "lock_blocked",
        lockKey: reservation.lockKey,
        lockTarget: reservation.lockTarget,
        blockingScopeKey: blocked.scopeKey,
        blockingTurnId: blocked.turnId,
        blockingAgentId: blocked.agentId ?? null,
      },
    );
    return {
      match: input.match,
      handled: true,
    };
  }
  return {
    match: input.match,
    handled: false,
    release: reservation.release,
  };
}

export async function handleChannelUpdateCommand(input: {
  command: Extract<ChannelControlCommand, { kind: "update" }>;
  turn: TurnEnvelope;
  runtime: HostedRuntimeAdapterPort;
  targetAgentId: string;
  isTargetActive: boolean;
  replyWriter: ChannelReplyWriter;
  preparedCommand?: ChannelPreparedCommand;
  updateExecutionScope: {
    lockKey: string;
    lockTarget: string;
  };
}): Promise<ChannelCommandDispatchResult> {
  if (!input.isTargetActive) {
    await input.replyWriter.sendControllerReply(
      input.turn,
      input.command.scopeKey,
      `Update unavailable: agent @${input.targetAgentId} is not active in this workspace.`,
      {
        command: "update",
        agentId: input.targetAgentId,
        status: "agent_not_active",
      },
    );
    return { handled: true };
  }
  if (
    !input.preparedCommand ||
    input.preparedCommand.match.kind !== "update" ||
    input.preparedCommand.handled ||
    typeof input.preparedCommand.release !== "function"
  ) {
    throw new Error("update_command_not_prepared");
  }
  input.runtime.ops.channel.command.updateRequested({
    sessionId: input.turn.sessionId,
    payload: {
      scopeKey: input.command.scopeKey,
      agentId: input.targetAgentId,
      instructions: input.command.prompt ?? null,
      turnId: input.turn.turnId,
      lockKey: input.updateExecutionScope.lockKey,
      lockTarget: input.updateExecutionScope.lockTarget,
    },
  });
  return {
    handled: false,
    routeAgentId: input.targetAgentId,
    routeTask: buildBrewvaUpdatePrompt({
      runtime: input.runtime,
      rawArgs: input.command.prompt,
    }),
  };
}
