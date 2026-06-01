import { formatGoalUsage, type GoalCommand, type GoalState } from "@brewva/brewva-vocabulary/goal";
import type { TurnEnvelope } from "@brewva/brewva-vocabulary/wire";
import { enqueueGoalContinuation } from "../../utils/goal-continuation.js";
import type { ChannelReplyWriter } from "../channel-reply-writer.js";
import type { ChannelRuntimeSessionPort } from "../session/coordinator.js";
import type { ChannelControlCommand } from "../types.js";
import type { ChannelCommandDispatchResult } from "./dispatch.js";

function formatGoalStatus(goal: GoalState): string {
  const remaining =
    goal.tokenBudget === null
      ? "unlimited"
      : String(Math.max(0, goal.tokenBudget - goal.usage.tokens));
  return [
    `Goal @${goal.id}`,
    `Status: ${goal.status}`,
    `Objective: ${goal.objective}`,
    `Usage: ${formatGoalUsage(goal.usage)}`,
    `Token budget remaining: ${remaining}`,
  ].join("\n");
}

const GOAL_ACTION_PAST_TENSE: Record<Exclude<GoalCommand["kind"], "status">, string> = {
  start: "started",
  pause: "paused",
  resume: "resumed",
  clear: "cleared",
};

export async function handleChannelGoalCommand(input: {
  command: Extract<ChannelControlCommand, { kind: "goal" }>;
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
      `Goal unavailable: agent @${input.targetAgentId} is not active in this workspace.`,
      {
        command: "goal",
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
      `Goal unavailable: no live session exists for @${input.targetAgentId} in this conversation.`,
      {
        command: "goal",
        agentId: input.targetAgentId,
        status: "session_not_found",
      },
    );
    return { handled: true };
  }

  const sessionId = targetSession.agentSessionId;
  const goalOps = targetSession.operatorRuntime.ops.goal;
  const command = input.command.command;
  if (command.kind === "status") {
    const goal = goalOps.state.get(sessionId);
    await input.replyWriter.sendControllerReply(
      input.turn,
      input.command.scopeKey,
      goal ? formatGoalStatus(goal) : `No active goal for @${input.targetAgentId}.`,
      {
        command: "goal",
        agentId: input.targetAgentId,
        status: goal?.status ?? "none",
        agentSessionId: sessionId,
      },
    );
    return { handled: true };
  }

  const result =
    command.kind === "start"
      ? goalOps.lifecycle.start(sessionId, {
          objective: command.objective,
          tokenBudget: command.tokenBudget,
        })
      : command.kind === "pause"
        ? goalOps.lifecycle.pause(sessionId, { reason: "channel" })
        : command.kind === "resume"
          ? goalOps.lifecycle.resume(sessionId, { reason: "channel" })
          : goalOps.lifecycle.clear(sessionId, { reason: "channel" });

  if (result.ok && result.goal && command.kind === "start") {
    await enqueueGoalContinuation({
      sessionId,
      goal: result.goal,
      recordQueued: (targetSessionId, payload) =>
        goalOps.continuation.recordQueued(targetSessionId, payload),
      prompt: (parts, options) => targetSession.prompt(parts, options),
      promptOptions: { source: "channel" },
    });
  }

  await input.replyWriter.sendControllerReply(
    input.turn,
    input.command.scopeKey,
    result.ok
      ? `Goal ${GOAL_ACTION_PAST_TENSE[command.kind]} for @${input.targetAgentId}.`
      : `Goal command rejected for @${input.targetAgentId}: ${result.reason}.`,
    {
      command: "goal",
      agentId: input.targetAgentId,
      status:
        result.goal?.status ?? (command.kind === "clear" && result.ok ? "cleared" : "rejected"),
      agentSessionId: sessionId,
      action: command.kind,
    },
  );
  return { handled: true };
}
