import { BrewvaRuntime, createOperatorRuntimePort } from "@brewva/brewva-runtime";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";
import {
  CHANNEL_COMMAND_RECEIVED_EVENT_TYPE,
  CHANNEL_UPDATE_LOCK_BLOCKED_EVENT_TYPE,
  CHANNEL_UPDATE_REQUESTED_EVENT_TYPE,
  OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
} from "@brewva/brewva-runtime/events";
import { formatCostViewText } from "@brewva/brewva-tools/workflow";
import {
  buildOperatorQuestionAnswerPrompt,
  buildOperatorQuestionAnsweredPayload,
  resolveOpenQuestionInSessions,
  validateSingleQuestionAnswer,
} from "../operator-questions.js";
import { buildBrewvaUpdatePrompt } from "../update-workflow.js";
import { toErrorMessage } from "../utils/errors.js";
import { isOwnerAuthorized } from "./acl.js";
import { AgentRegistry } from "./agent-registry.js";
import type {
  ChannelInspectCommandInput,
  ChannelInspectCommandResult,
  ChannelInsightsCommandInput,
  ChannelInsightsCommandResult,
  ChannelQuestionsCommandInput,
  ChannelQuestionsCommandResult,
} from "./channel-command-contracts.js";
import type {
  ChannelCommandDispatchResult,
  ChannelPreparedCommand,
} from "./channel-command-dispatch.js";
import type { ChannelReplyWriter } from "./channel-reply-writer.js";
import type { ChannelRuntimeSessionPort } from "./channel-session-coordinator.js";
import type { ChannelQuestionSurface } from "./channel-session-queries.js";
import type { ChannelUpdateLockManager } from "./channel-update-lock.js";
import { type ChannelCommandMatch } from "./command-router.js";
import { ChannelCoordinator } from "./coordinator.js";
import { resolveChannelOperatorAction } from "./operator-actions.js";
import type { ChannelOrchestrationConfig } from "./orchestration-config.js";

function isPublicCommand(match: ChannelCommandMatch): boolean {
  switch (match.kind) {
    case "none":
    case "error":
    case "agents":
    case "route-agent":
      return true;
    case "status":
    case "steer":
    case "answer":
    case "update":
    case "agent-create":
    case "agent-delete":
    case "focus":
    case "run":
    case "discuss":
      return false;
  }
  const exhaustiveCheck: never = match;
  return exhaustiveCheck;
}

function indentBlock(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => `  ${line}`)
    .join("\n");
}

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

function formatStatusSummaryText(input: {
  targetAgentId: string;
  focusedAgentId: string;
  liveSessionId?: string;
  costText: string;
  questionsText: string;
  inspectText?: string;
  insightsText?: string;
}): string {
  const lines = [
    `Status @${input.targetAgentId}${input.targetAgentId === input.focusedAgentId ? "" : ` (focus @${input.focusedAgentId})`}`,
    `Live session: ${input.liveSessionId ?? "none"}`,
    "",
    "Cost",
    indentBlock(input.costText),
    "",
    "Operator input",
    indentBlock(input.questionsText),
  ];
  if (input.inspectText !== undefined) {
    lines.push("", "Inspect", indentBlock(input.inspectText));
  }
  if (input.insightsText !== undefined) {
    lines.push("", "Insights", indentBlock(input.insightsText));
  }
  return lines.join("\n");
}

function buildStatusSectionFailure(
  section: "questions" | "inspect" | "insights",
  message: string,
): ChannelQuestionsCommandResult | ChannelInspectCommandResult | ChannelInsightsCommandResult {
  return {
    text: message,
    meta: {
      command: section,
      status: "dependency_failed",
    },
  };
}

export function createChannelControlRouter(input: {
  runtime: BrewvaRuntime;
  registry: AgentRegistry;
  orchestrationConfig: ChannelOrchestrationConfig;
  replyWriter: ChannelReplyWriter;
  coordinator: Pick<ChannelCoordinator, "fanOut" | "discuss">;
  renderAgentsSnapshot(scopeKey: string): string;
  openLiveSession(scopeKey: string, agentId: string): ChannelRuntimeSessionPort | undefined;
  resolveQuestionSurface(
    scopeKey: string,
    agentId: string,
  ): Promise<ChannelQuestionSurface | undefined>;
  cleanupAgentSessions(agentId: string): Promise<void>;
  disposeAgentRuntime(agentId: string): boolean;
  updateLock: ChannelUpdateLockManager;
  updateExecutionScope: {
    lockKey: string;
    lockTarget: string;
  };
  dependencies?: {
    handleInspectCommand?: (
      input: ChannelInspectCommandInput,
    ) => Promise<ChannelInspectCommandResult>;
    handleInsightsCommand?: (
      input: ChannelInsightsCommandInput,
    ) => Promise<ChannelInsightsCommandResult>;
    handleQuestionsCommand?: (
      input: ChannelQuestionsCommandInput,
    ) => Promise<ChannelQuestionsCommandResult>;
  };
}) {
  return {
    async prepareCommand(
      match: ChannelCommandMatch,
      turn: TurnEnvelope,
      scopeKey: string,
    ): Promise<ChannelPreparedCommand> {
      if (match.kind !== "update") {
        return { match, handled: false };
      }

      const authorized = isOwnerAuthorized(
        turn,
        input.orchestrationConfig.owners.telegram,
        input.orchestrationConfig.aclModeWhenOwnersEmpty,
      );
      if (!authorized) {
        return { match, handled: false };
      }

      const targetAgentId = input.registry.resolveFocus(scopeKey);
      if (!input.registry.isActive(targetAgentId)) {
        return { match, handled: false };
      }

      const reservation = input.updateLock.tryReserve({
        turn,
        scopeKey,
        agentId: targetAgentId,
      });
      if (reservation.kind === "blocked") {
        const blocked = reservation.blocked;
        input.runtime.extensions.hosted.events.record({
          sessionId: turn.sessionId,
          type: CHANNEL_UPDATE_LOCK_BLOCKED_EVENT_TYPE,
          payload: {
            scopeKey,
            turnId: turn.turnId,
            conversationId: turn.conversationId,
            agentId: targetAgentId,
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
          turn,
          scopeKey,
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
          match,
          handled: true,
        };
      }

      return {
        match,
        handled: false,
        release: reservation.release,
      };
    },

    async handleCommand(
      match: ChannelCommandMatch,
      turn: TurnEnvelope,
      scopeKey: string,
      preparedCommand?: ChannelPreparedCommand,
    ): Promise<ChannelCommandDispatchResult> {
      if (match.kind === "none") {
        return { handled: false };
      }

      const operatorAction = resolveChannelOperatorAction(match);
      input.runtime.extensions.hosted.events.record({
        sessionId: turn.sessionId,
        type: CHANNEL_COMMAND_RECEIVED_EVENT_TYPE,
        payload: {
          scopeKey,
          command: match.kind,
          actionKind: operatorAction?.kind ?? null,
          turnId: turn.turnId,
          conversationId: turn.conversationId,
        },
      });

      if (match.kind === "error") {
        await input.replyWriter.sendControllerReply(
          turn,
          scopeKey,
          `Command parse error: ${match.message}`,
        );
        return { handled: true };
      }

      if (match.kind === "route-agent") {
        if (!input.registry.isActive(match.agentId)) {
          return { handled: false };
        }

        const authorized = isOwnerAuthorized(
          turn,
          input.orchestrationConfig.owners.telegram,
          input.orchestrationConfig.aclModeWhenOwnersEmpty,
        );
        if (authorized) {
          const focused = await input.registry.setFocus(scopeKey, match.agentId);
          if (focused.ok) {
            input.runtime.extensions.hosted.events.record({
              sessionId: turn.sessionId,
              type: "channel_focus_changed",
              payload: {
                scopeKey,
                agentId: focused.agentId,
                source: "mention",
              },
            });
          }
        }
        return {
          handled: false,
          routeAgentId: match.agentId,
          routeTask: match.task,
        };
      }

      if (!isPublicCommand(match)) {
        const authorized = isOwnerAuthorized(
          turn,
          input.orchestrationConfig.owners.telegram,
          input.orchestrationConfig.aclModeWhenOwnersEmpty,
        );
        if (!authorized) {
          input.runtime.extensions.hosted.events.record({
            sessionId: turn.sessionId,
            type: "channel_command_rejected",
            payload: {
              scopeKey,
              command: match.kind,
              reason: "owner_acl_denied",
              turnId: turn.turnId,
            },
          });
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            "Command denied: owner permission required.",
          );
          return { handled: true };
        }
      }

      if (match.kind === "agents") {
        await input.replyWriter.sendControllerReply(
          turn,
          scopeKey,
          input.renderAgentsSnapshot(scopeKey),
        );
        return { handled: true };
      }

      if (operatorAction?.kind === "status_summary") {
        const focusedAgentId = input.registry.resolveFocus(scopeKey);
        const targetAgentId = operatorAction.agentId ?? focusedAgentId;
        if (!input.registry.isActive(targetAgentId)) {
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Status unavailable: agent @${targetAgentId} is not active in this workspace.`,
            {
              command: "status",
              agentId: targetAgentId,
              status: "agent_not_active",
            },
          );
          return { handled: true };
        }
        const targetSession = input.openLiveSession(scopeKey, targetAgentId);
        const top = typeof operatorAction.top === "number" ? operatorAction.top : 5;
        const includeDiagnostics =
          operatorAction.details === true || typeof operatorAction.directory === "string";
        let questionSurface: ChannelQuestionSurface | undefined;
        let questionsResult: ChannelQuestionsCommandResult | undefined;
        try {
          questionSurface = await input.resolveQuestionSurface(scopeKey, targetAgentId);
        } catch (error) {
          questionsResult = buildStatusSectionFailure(
            "questions",
            `Operator input unavailable: failed to load durable session history for @${targetAgentId} (${toErrorMessage(error)}).`,
          );
        }
        if (!questionsResult) {
          if (input.dependencies?.handleQuestionsCommand) {
            try {
              questionsResult = await input.dependencies.handleQuestionsCommand({
                turn,
                scopeKey,
                focusedAgentId,
                targetAgentId,
                questionSurface,
              });
            } catch (error) {
              questionsResult = buildStatusSectionFailure(
                "questions",
                `Operator input unavailable: failed to build the questions summary for @${targetAgentId} (${toErrorMessage(error)}).`,
              );
            }
          } else {
            questionsResult = {
              text: "Operator inbox is unavailable in this host.",
            };
          }
        }
        const inspectResult = includeDiagnostics
          ? input.dependencies?.handleInspectCommand
            ? await input.dependencies
                .handleInspectCommand({
                  directory: operatorAction.directory,
                  turn,
                  scopeKey,
                  focusedAgentId,
                  targetAgentId,
                  targetSession: targetSession
                    ? {
                        agentId: targetSession.agentId,
                        runtime: createOperatorRuntimePort(targetSession.runtime),
                        sessionId: targetSession.agentSessionId,
                      }
                    : undefined,
                })
                .catch((error) =>
                  buildStatusSectionFailure(
                    "inspect",
                    `Inspect unavailable: failed to build the inspect summary for @${targetAgentId} (${toErrorMessage(error)}).`,
                  ),
                )
            : {
                text: "Inspect is unavailable in this host.",
              }
          : undefined;
        const insightsResult = includeDiagnostics
          ? input.dependencies?.handleInsightsCommand
            ? await input.dependencies
                .handleInsightsCommand({
                  directory: operatorAction.directory,
                  turn,
                  scopeKey,
                  focusedAgentId,
                  targetAgentId,
                  targetSession: targetSession
                    ? {
                        agentId: targetSession.agentId,
                        runtime: createOperatorRuntimePort(targetSession.runtime),
                        sessionId: targetSession.agentSessionId,
                      }
                    : undefined,
                })
                .catch((error) =>
                  buildStatusSectionFailure(
                    "insights",
                    `Insights unavailable: failed to build the insights summary for @${targetAgentId} (${toErrorMessage(error)}).`,
                  ),
                )
            : {
                text: "Insights are unavailable in this host.",
              }
          : undefined;
        const costText = targetSession
          ? formatCostViewText(
              targetSession.runtime.inspect.cost.getSummary(targetSession.agentSessionId),
              top,
            )
          : `Cost view unavailable: agent @${targetAgentId} does not have a live session.`;
        const statusMeta = {
          command: "status",
          agentId: targetAgentId,
          top,
          directory: operatorAction.directory,
          details: includeDiagnostics,
          liveSessionId: targetSession?.agentSessionId ?? null,
          sections: {
            cost: {
              top,
              liveSessionId: targetSession?.agentSessionId ?? null,
            },
            questions: questionsResult.meta ?? null,
            ...(inspectResult
              ? {
                  inspect: inspectResult.meta ?? null,
                }
              : {}),
            ...(insightsResult
              ? {
                  insights: insightsResult.meta ?? null,
                }
              : {}),
          },
        } satisfies Record<string, unknown>;
        const text = formatStatusSummaryText({
          targetAgentId,
          focusedAgentId,
          liveSessionId: targetSession?.agentSessionId,
          costText,
          questionsText: questionsResult.text,
          inspectText: inspectResult?.text,
          insightsText: insightsResult?.text,
        });
        await input.replyWriter.sendControllerReply(turn, scopeKey, text, statusMeta);
        return { handled: true };
      }

      if (match.kind === "steer") {
        const focusedAgentId = input.registry.resolveFocus(scopeKey);
        const targetAgentId = match.agentId ?? focusedAgentId;
        if (!input.registry.isActive(targetAgentId)) {
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Steer unavailable: agent @${targetAgentId} is not active in this workspace.`,
            {
              command: "steer",
              agentId: targetAgentId,
              status: "agent_not_active",
            },
          );
          return { handled: true };
        }
        const targetSession = input.openLiveSession(scopeKey, targetAgentId);
        if (!targetSession) {
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Steer unavailable: no live session exists for @${targetAgentId} in this conversation.`,
            {
              command: "steer",
              agentId: targetAgentId,
              status: "session_not_found",
            },
          );
          return { handled: true };
        }
        const unsubscribeSteerOutcome = subscribeChannelSteerOutcome({
          session: targetSession,
          replyWriter: input.replyWriter,
          turn,
          scopeKey,
          agentId: targetAgentId,
        });
        let outcome: Awaited<ReturnType<ChannelRuntimeSessionPort["steer"]>>;
        try {
          outcome = await targetSession.steer(match.text);
        } catch (error) {
          unsubscribeSteerOutcome();
          throw error;
        }
        if (outcome.status === "queued") {
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Queued steer for @${targetAgentId}.`,
            {
              command: "steer",
              agentId: targetAgentId,
              status: "queued",
              chars: outcome.chars,
              agentSessionId: targetSession.agentSessionId,
            },
          );
          return { handled: true };
        }
        unsubscribeSteerOutcome();
        await input.replyWriter.sendControllerReply(
          turn,
          scopeKey,
          `Steer unavailable: no turn is currently streaming for @${targetAgentId}.`,
          {
            command: "steer",
            agentId: targetAgentId,
            status: outcome.status,
            agentSessionId: targetSession.agentSessionId,
          },
        );
        return { handled: true };
      }

      if (operatorAction?.kind === "answer_question") {
        const focusedAgentId = input.registry.resolveFocus(scopeKey);
        const targetAgentId = operatorAction.agentId ?? focusedAgentId;
        if (!input.registry.isActive(targetAgentId)) {
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Answer unavailable: agent @${targetAgentId} is not active in this workspace.`,
            {
              command: "answer",
              agentId: targetAgentId,
              questionId: operatorAction.questionId,
              status: "agent_not_active",
            },
          );
          return { handled: true };
        }
        let questionSurface: ChannelQuestionSurface | undefined;
        try {
          questionSurface = await input.resolveQuestionSurface(scopeKey, targetAgentId);
        } catch (error) {
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Answer unavailable: failed to load durable session history for @${targetAgentId} (${toErrorMessage(error)}).`,
            {
              command: "answer",
              agentId: targetAgentId,
              questionId: operatorAction.questionId,
              status: "question_surface_unavailable",
            },
          );
          return { handled: true };
        }
        if (!questionSurface) {
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Answer unavailable: no durable session history exists for @${targetAgentId} in this conversation yet. Send that agent a message first.`,
            {
              command: "answer",
              agentId: targetAgentId,
              questionId: operatorAction.questionId,
              status: "session_not_found",
            },
          );
          return { handled: true };
        }
        const question = await resolveOpenQuestionInSessions(
          questionSurface.runtime,
          questionSurface.sessionIds,
          operatorAction.questionId,
        );
        if (!question) {
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Answer unavailable: no pending operator prompt '${operatorAction.questionId}' was found for @${targetAgentId}. Use /status${targetAgentId === focusedAgentId ? "" : ` @${targetAgentId}`} first.`,
            {
              command: "answer",
              agentId: targetAgentId,
              questionId: operatorAction.questionId,
              status: "question_not_found",
            },
          );
          return { handled: true };
        }
        const validatedAnswer = validateSingleQuestionAnswer({
          question,
          answerText: operatorAction.answerText,
        });
        if (!validatedAnswer.ok) {
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Answer rejected: ${validatedAnswer.error}`,
            {
              command: "answer",
              agentId: targetAgentId,
              questionId: operatorAction.questionId,
              status: "invalid_answer",
            },
          );
          return { handled: true };
        }
        return {
          handled: false,
          routeAgentId: targetAgentId,
          routeTask: buildOperatorQuestionAnswerPrompt({
            question,
            answerText: validatedAnswer.answerText,
          }),
          afterRouteSuccess: () => {
            questionSurface.runtime.extensions.hosted.events.record({
              sessionId: question.sessionId,
              type: OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
              payload: buildOperatorQuestionAnsweredPayload({
                question,
                answerText: validatedAnswer.answerText,
                source: "channel",
              }),
            });
          },
        };
      }

      if (match.kind === "update") {
        const targetAgentId = input.registry.resolveFocus(scopeKey);
        if (!input.registry.isActive(targetAgentId)) {
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Update unavailable: agent @${targetAgentId} is not active in this workspace.`,
            {
              command: "update",
              agentId: targetAgentId,
              status: "agent_not_active",
            },
          );
          return { handled: true };
        }
        if (
          !preparedCommand ||
          preparedCommand.match.kind !== "update" ||
          preparedCommand.handled ||
          typeof preparedCommand.release !== "function"
        ) {
          throw new Error("update_command_not_prepared");
        }

        input.runtime.extensions.hosted.events.record({
          sessionId: turn.sessionId,
          type: CHANNEL_UPDATE_REQUESTED_EVENT_TYPE,
          payload: {
            scopeKey,
            agentId: targetAgentId,
            instructions: match.instructions ?? null,
            turnId: turn.turnId,
            lockKey: input.updateExecutionScope.lockKey,
            lockTarget: input.updateExecutionScope.lockTarget,
          },
        });
        return {
          handled: false,
          routeAgentId: targetAgentId,
          routeTask: buildBrewvaUpdatePrompt({
            runtime: input.runtime,
            rawArgs: match.instructions,
          }),
        };
      }

      if (match.kind === "agent-create") {
        const created = await input.registry.createAgent({
          requestedAgentId: match.agentId,
          model: match.model,
        });
        if (!created.ok) {
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Failed to create agent: ${created.reason}`,
          );
        } else {
          input.runtime.extensions.hosted.events.record({
            sessionId: turn.sessionId,
            type: "channel_agent_created",
            payload: {
              scopeKey,
              agentId: created.agent.agentId,
              model: created.agent.model,
            },
          });
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Created agent @${created.agent.agentId}${created.agent.model ? ` (model=${created.agent.model})` : ""}.`,
          );
        }
        return { handled: true };
      }

      if (match.kind === "agent-delete") {
        const deleted = await input.registry.softDeleteAgent(match.agentId);
        if (!deleted.ok) {
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Failed to delete agent: ${deleted.reason}`,
          );
        } else {
          await input.cleanupAgentSessions(match.agentId);
          input.disposeAgentRuntime(match.agentId);
          input.runtime.extensions.hosted.events.record({
            sessionId: turn.sessionId,
            type: "channel_agent_deleted",
            payload: {
              scopeKey,
              agentId: match.agentId,
            },
          });
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Deleted agent @${match.agentId} (soft delete).`,
          );
        }
        return { handled: true };
      }

      if (match.kind === "focus") {
        const focused = await input.registry.setFocus(scopeKey, match.agentId);
        if (!focused.ok) {
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Failed to set focus: ${focused.reason}`,
          );
        } else {
          input.runtime.extensions.hosted.events.record({
            sessionId: turn.sessionId,
            type: "channel_focus_changed",
            payload: {
              scopeKey,
              agentId: focused.agentId,
              source: "command",
            },
          });
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Focus set to @${focused.agentId}.`,
          );
        }
        return { handled: true };
      }

      if (match.kind === "run") {
        input.runtime.extensions.hosted.events.record({
          sessionId: turn.sessionId,
          type: "channel_fanout_started",
          payload: {
            scopeKey,
            targets: match.agentIds,
          },
        });
        const result = await input.coordinator.fanOut({
          agentIds: match.agentIds,
          task: match.task,
          scopeKey,
        });
        const lines = [
          result.ok ? "Fan-out completed." : `Fan-out failed: ${result.error}`,
          ...result.results.map((entry) =>
            entry.ok
              ? `- @${entry.agentId}: ${entry.responseText || "(empty)"}`
              : `- @${entry.agentId}: ERROR ${entry.error}`,
          ),
        ];
        input.runtime.extensions.hosted.events.record({
          sessionId: turn.sessionId,
          type: "channel_fanout_finished",
          payload: {
            scopeKey,
            targets: match.agentIds,
            ok: result.ok,
            error: result.ok ? undefined : result.error,
          },
        });
        await input.replyWriter.sendControllerReply(turn, scopeKey, lines.join("\n"));
        return { handled: true };
      }

      if (match.kind === "discuss") {
        const discussion = await input.coordinator.discuss({
          agentIds: match.agentIds,
          topic: match.topic,
          maxRounds: match.maxRounds,
          scopeKey,
        });
        const lines = [
          discussion.ok
            ? `Discussion completed (stoppedEarly=${discussion.stoppedEarly}).`
            : `Discussion failed: ${discussion.reason}`,
        ];
        for (const round of discussion.rounds) {
          input.runtime.extensions.hosted.events.record({
            sessionId: turn.sessionId,
            type: "channel_discussion_round",
            payload: {
              scopeKey,
              round: round.round,
              agentId: round.agentId,
            },
          });
          lines.push(`- r${round.round} @${round.agentId}: ${round.responseText || "(empty)"}`);
        }
        await input.replyWriter.sendControllerReply(turn, scopeKey, lines.join("\n"));
        return { handled: true };
      }

      return { handled: false };
    },
  };
}
