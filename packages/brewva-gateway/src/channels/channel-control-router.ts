import {
  BrewvaRuntime,
  CHANNEL_COMMAND_RECEIVED_EVENT_TYPE,
  CHANNEL_UPDATE_LOCK_BLOCKED_EVENT_TYPE,
  CHANNEL_UPDATE_REQUESTED_EVENT_TYPE,
  OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
} from "@brewva/brewva-runtime";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";
import { formatCostViewText } from "@brewva/brewva-tools";
import {
  buildOperatorQuestionAnswerPrompt,
  buildOperatorQuestionAnsweredPayload,
  resolveOpenQuestionInSessions,
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

function isControlCommand(match: ChannelCommandMatch): boolean {
  return (
    match.kind === "cost" ||
    match.kind === "questions" ||
    match.kind === "answer" ||
    match.kind === "inspect" ||
    match.kind === "insights" ||
    match.kind === "update" ||
    match.kind === "new-agent" ||
    match.kind === "del-agent" ||
    match.kind === "focus" ||
    match.kind === "run" ||
    match.kind === "discuss"
  );
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
        input.runtime.events.record({
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
      input.runtime.events.record({
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

        await input.registry.setFocus(scopeKey, match.agentId);
        input.runtime.events.record({
          sessionId: turn.sessionId,
          type: "channel_focus_changed",
          payload: {
            scopeKey,
            agentId: match.agentId,
            source: "mention",
          },
        });
        return {
          handled: false,
          routeAgentId: match.agentId,
          routeTask: match.task,
        };
      }

      if (isControlCommand(match)) {
        const authorized = isOwnerAuthorized(
          turn,
          input.orchestrationConfig.owners.telegram,
          input.orchestrationConfig.aclModeWhenOwnersEmpty,
        );
        if (!authorized) {
          input.runtime.events.record({
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

      if (operatorAction?.kind === "inspect_cost") {
        const focusedAgentId = input.registry.resolveFocus(scopeKey);
        const targetAgentId = operatorAction.agentId ?? focusedAgentId;
        if (!input.registry.isActive(targetAgentId)) {
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Cost view unavailable: agent @${targetAgentId} is not active in this workspace.`,
            {
              command: "cost",
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
            `Cost view unavailable: agent @${targetAgentId} does not have a live session.`,
            {
              command: "cost",
              agentId: targetAgentId,
              status: "session_not_found",
            },
          );
          return { handled: true };
        }
        const top = typeof operatorAction.top === "number" ? operatorAction.top : 5;
        await input.replyWriter.sendControllerReply(
          turn,
          scopeKey,
          formatCostViewText(
            targetSession.runtime.cost.getSummary(targetSession.agentSessionId),
            top,
          ),
          {
            command: "cost",
            agentId: targetAgentId,
            top,
          },
        );
        return { handled: true };
      }

      if (operatorAction?.kind === "inspect_questions") {
        const focusedAgentId = input.registry.resolveFocus(scopeKey);
        const targetAgentId = operatorAction.agentId ?? focusedAgentId;
        if (!input.registry.isActive(targetAgentId)) {
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Questions unavailable: agent @${targetAgentId} is not active in this workspace.`,
            {
              command: "questions",
              agentId: targetAgentId,
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
            `Questions unavailable: failed to load durable session history for @${targetAgentId} (${toErrorMessage(error)}).`,
            {
              command: "questions",
              agentId: targetAgentId,
              status: "question_surface_unavailable",
            },
          );
          return { handled: true };
        }
        const result = input.dependencies?.handleQuestionsCommand
          ? await input.dependencies.handleQuestionsCommand({
              turn,
              scopeKey,
              focusedAgentId,
              targetAgentId,
              questionSurface,
            })
          : {
              text: "Questions are unavailable in this host.",
            };
        await input.replyWriter.sendControllerReply(turn, scopeKey, result.text, result.meta);
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
            `Answer unavailable: no open question '${operatorAction.questionId}' was found for @${targetAgentId}. Use /questions${targetAgentId === focusedAgentId ? "" : ` @${targetAgentId}`} first.`,
            {
              command: "answer",
              agentId: targetAgentId,
              questionId: operatorAction.questionId,
              status: "question_not_found",
            },
          );
          return { handled: true };
        }
        questionSurface.runtime.events.record({
          sessionId: question.sessionId,
          type: OPERATOR_QUESTION_ANSWERED_EVENT_TYPE,
          payload: buildOperatorQuestionAnsweredPayload({
            question,
            answerText: operatorAction.answerText,
            source: "channel",
          }),
        });
        return {
          handled: false,
          routeAgentId: targetAgentId,
          routeTask: buildOperatorQuestionAnswerPrompt({
            question,
            answerText: operatorAction.answerText,
          }),
        };
      }

      if (match.kind === "inspect") {
        const focusedAgentId = input.registry.resolveFocus(scopeKey);
        const targetAgentId = match.agentId ?? focusedAgentId;
        if (!input.registry.isActive(targetAgentId)) {
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Inspect unavailable: agent @${targetAgentId} is not active in this workspace.`,
            {
              command: "inspect",
              agentId: targetAgentId,
              status: "agent_not_active",
            },
          );
          return { handled: true };
        }

        const targetSession = input.openLiveSession(scopeKey, targetAgentId);
        const result = input.dependencies?.handleInspectCommand
          ? await input.dependencies.handleInspectCommand({
              directory: match.directory,
              turn,
              scopeKey,
              focusedAgentId,
              targetAgentId,
              targetSession: targetSession
                ? {
                    agentId: targetSession.agentId,
                    runtime: targetSession.runtime,
                    sessionId: targetSession.agentSessionId,
                  }
                : undefined,
            })
          : {
              text: "Inspect is unavailable in this host.",
            };
        await input.replyWriter.sendControllerReply(turn, scopeKey, result.text, result.meta);
        return { handled: true };
      }

      if (match.kind === "insights") {
        const focusedAgentId = input.registry.resolveFocus(scopeKey);
        const targetAgentId = match.agentId ?? focusedAgentId;
        if (!input.registry.isActive(targetAgentId)) {
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Insights unavailable: agent @${targetAgentId} is not active in this workspace.`,
            {
              command: "insights",
              agentId: targetAgentId,
              status: "agent_not_active",
            },
          );
          return { handled: true };
        }

        const targetSession = input.openLiveSession(scopeKey, targetAgentId);
        const result = input.dependencies?.handleInsightsCommand
          ? await input.dependencies.handleInsightsCommand({
              directory: match.directory,
              turn,
              scopeKey,
              focusedAgentId,
              targetAgentId,
              targetSession: targetSession
                ? {
                    agentId: targetSession.agentId,
                    runtime: targetSession.runtime,
                    sessionId: targetSession.agentSessionId,
                  }
                : undefined,
            })
          : {
              text: "Insights are unavailable in this host.",
            };
        await input.replyWriter.sendControllerReply(turn, scopeKey, result.text, result.meta);
        return { handled: true };
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

        input.runtime.events.record({
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

      if (match.kind === "new-agent") {
        try {
          const created = await input.registry.createAgent({
            requestedAgentId: match.agentId,
            model: match.model,
          });
          input.runtime.events.record({
            sessionId: turn.sessionId,
            type: "channel_agent_created",
            payload: {
              scopeKey,
              agentId: created.agentId,
              model: created.model,
            },
          });
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Created agent @${created.agentId}${created.model ? ` (model=${created.model})` : ""}.`,
          );
        } catch (error) {
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Failed to create agent: ${toErrorMessage(error)}`,
          );
        }
        return { handled: true };
      }

      if (match.kind === "del-agent") {
        try {
          const existing = input.registry.get(match.agentId);
          if (!existing || existing.status !== "active") {
            throw new Error(`agent_not_found:${match.agentId}`);
          }
          if (existing.agentId === input.registry.defaultAgentId) {
            throw new Error("cannot_delete_default");
          }
          await input.registry.softDeleteAgent(match.agentId);
          await input.cleanupAgentSessions(match.agentId);
          input.disposeAgentRuntime(match.agentId);
          input.runtime.events.record({
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
        } catch (error) {
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Failed to delete agent: ${toErrorMessage(error)}`,
          );
        }
        return { handled: true };
      }

      if (match.kind === "focus") {
        try {
          const focused = await input.registry.setFocus(scopeKey, match.agentId);
          input.runtime.events.record({
            sessionId: turn.sessionId,
            type: "channel_focus_changed",
            payload: {
              scopeKey,
              agentId: focused,
              source: "command",
            },
          });
          await input.replyWriter.sendControllerReply(turn, scopeKey, `Focus set to @${focused}.`);
        } catch (error) {
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Failed to set focus: ${toErrorMessage(error)}`,
          );
        }
        return { handled: true };
      }

      if (match.kind === "run") {
        input.runtime.events.record({
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
          result.ok ? "Fan-out completed." : `Fan-out failed: ${result.error ?? "unknown_error"}`,
          ...result.results.map((entry) =>
            entry.ok
              ? `- @${entry.agentId}: ${entry.responseText || "(empty)"}`
              : `- @${entry.agentId}: ERROR ${entry.error ?? "unknown_error"}`,
          ),
        ];
        input.runtime.events.record({
          sessionId: turn.sessionId,
          type: "channel_fanout_finished",
          payload: {
            scopeKey,
            targets: match.agentIds,
            ok: result.ok,
            error: result.error,
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
            : `Discussion failed: ${discussion.reason ?? "unknown_error"}`,
        ];
        for (const round of discussion.rounds) {
          input.runtime.events.record({
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
