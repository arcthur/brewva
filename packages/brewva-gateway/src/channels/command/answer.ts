import type { TurnEnvelope } from "@brewva/brewva-runtime/protocol";
import {
  buildOperatorQuestionAnswerPrompt,
  buildOperatorQuestionAnsweredPayload,
  resolveOpenQuestionInSessions,
  validateSingleQuestionAnswer,
} from "../../ingress/api.js";
import { toErrorMessage } from "../../utils/errors.js";
import type { ChannelReplyWriter } from "../channel-reply-writer.js";
import type { ChannelQuestionSurface } from "../session/queries.js";
import type { ChannelControlCommand } from "../types.js";
import type { ChannelCommandDispatchResult } from "./dispatch.js";

export async function handleChannelAnswerCommand(input: {
  command: Extract<ChannelControlCommand, { kind: "answer" }>;
  turn: TurnEnvelope;
  replyWriter: ChannelReplyWriter;
  targetAgentId: string;
  focusedAgentId: string;
  isTargetActive: boolean;
  resolveQuestionSurface(
    scopeKey: string,
    agentId: string,
  ): Promise<ChannelQuestionSurface | undefined>;
}): Promise<ChannelCommandDispatchResult> {
  const { command, turn, replyWriter } = input;
  if (!input.isTargetActive) {
    await replyWriter.sendControllerReply(
      turn,
      command.scopeKey,
      `Answer unavailable: agent @${input.targetAgentId} is not active in this workspace.`,
      {
        command: "answer",
        agentId: input.targetAgentId,
        questionId: command.questionId,
        status: "agent_not_active",
      },
    );
    return { handled: true };
  }
  let questionSurface: ChannelQuestionSurface | undefined;
  try {
    questionSurface = await input.resolveQuestionSurface(command.scopeKey, input.targetAgentId);
  } catch (error) {
    await replyWriter.sendControllerReply(
      turn,
      command.scopeKey,
      `Answer unavailable: failed to load durable session history for @${input.targetAgentId} (${toErrorMessage(error)}).`,
      {
        command: "answer",
        agentId: input.targetAgentId,
        questionId: command.questionId,
        status: "question_surface_unavailable",
      },
    );
    return { handled: true };
  }
  if (!questionSurface) {
    await replyWriter.sendControllerReply(
      turn,
      command.scopeKey,
      `Answer unavailable: no durable session history exists for @${input.targetAgentId} in this conversation yet. Send that agent a message first.`,
      {
        command: "answer",
        agentId: input.targetAgentId,
        questionId: command.questionId,
        status: "session_not_found",
      },
    );
    return { handled: true };
  }
  const question = await resolveOpenQuestionInSessions(
    questionSurface.runtime,
    questionSurface.sessionIds,
    command.questionId,
  );
  if (!question) {
    await replyWriter.sendControllerReply(
      turn,
      command.scopeKey,
      `Answer unavailable: no pending operator prompt '${command.questionId}' was found for @${input.targetAgentId}. Use /status${input.targetAgentId === input.focusedAgentId ? "" : ` @${input.targetAgentId}`} first.`,
      {
        command: "answer",
        agentId: input.targetAgentId,
        questionId: command.questionId,
        status: "question_not_found",
      },
    );
    return { handled: true };
  }
  const validatedAnswer = validateSingleQuestionAnswer({
    question,
    answerText: command.answer,
  });
  if (!validatedAnswer.ok) {
    await replyWriter.sendControllerReply(
      turn,
      command.scopeKey,
      `Answer rejected: ${validatedAnswer.error}`,
      {
        command: "answer",
        agentId: input.targetAgentId,
        questionId: command.questionId,
        status: "invalid_answer",
      },
    );
    return { handled: true };
  }
  return {
    handled: false,
    routeAgentId: input.targetAgentId,
    routeTask: buildOperatorQuestionAnswerPrompt({
      question,
      answerText: validatedAnswer.answerText,
    }),
    afterRouteSuccess: () => {
      questionSurface.runtime.ops.channel.command.operatorQuestionAnswered({
        sessionId: question.sessionId,
        payload: buildOperatorQuestionAnsweredPayload({
          question,
          answerText: validatedAnswer.answerText,
          source: "channel",
        }),
      });
    },
  };
}
