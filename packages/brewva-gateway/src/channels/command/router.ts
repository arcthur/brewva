import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import type { TurnEnvelope } from "@brewva/brewva-runtime/channels";
import { CHANNEL_COMMAND_RECEIVED_EVENT_TYPE } from "@brewva/brewva-runtime/events";
import { AgentRegistry } from "../agent-registry.js";
import type { ChannelReplyWriter } from "../channel-reply-writer.js";
import { isPublicChannelControlCommand, resolveChannelControlCommand } from "../control-command.js";
import { ChannelCoordinator } from "../coordinator.js";
import type { ChannelOrchestrationConfig } from "../orchestration-config.js";
import { isOwnerAuthorized } from "../policy/acl.js";
import type { ChannelRuntimeSessionPort } from "../session/coordinator.js";
import type { ChannelQuestionSurface } from "../session/queries.js";
import type { ChannelUpdateLockManager } from "../session/update-lock.js";
import type { ChannelControlCommand } from "../types.js";
import {
  handleChannelAgentCreateCommand,
  handleChannelAgentDeleteCommand,
  handleChannelAgentsCommand,
  handleChannelDiscussCommand,
  handleChannelFocusCommand,
  handleChannelRouteAgentCommand,
  handleChannelRunCommand,
} from "./admin.js";
import { handleChannelAnswerCommand } from "./answer.js";
import type {
  ChannelInspectCommandInput,
  ChannelInspectCommandResult,
  ChannelInsightsCommandInput,
  ChannelInsightsCommandResult,
  ChannelQuestionsCommandInput,
  ChannelQuestionsCommandResult,
} from "./contracts.js";
import type { ChannelCommandDispatchResult, ChannelPreparedCommand } from "./dispatch.js";
import { type ChannelCommandMatch } from "./parser.js";
import { handleChannelStatusCommand } from "./status.js";
import { handleChannelSteerCommand } from "./steer.js";
import { handleChannelUpdateCommand, prepareChannelUpdateCommand } from "./update.js";

export function createChannelControlRouter(input: {
  runtime: BrewvaHostedRuntimePort;
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
  const renderAgentsSnapshot = (scopeKey: string) => input.renderAgentsSnapshot(scopeKey);
  const openLiveSession = (scopeKey: string, agentId: string) =>
    input.openLiveSession(scopeKey, agentId);
  const resolveQuestionSurface = (scopeKey: string, agentId: string) =>
    input.resolveQuestionSurface(scopeKey, agentId);
  const cleanupAgentSessions = (agentId: string) => input.cleanupAgentSessions(agentId);
  const disposeAgentRuntime = (agentId: string) => input.disposeAgentRuntime(agentId);
  const handlers: {
    [K in ChannelControlCommand["kind"]]: (
      command: Extract<ChannelControlCommand, { kind: K }>,
      turn: TurnEnvelope,
      preparedCommand?: ChannelPreparedCommand,
    ) => Promise<ChannelCommandDispatchResult>;
  } = {
    agents: (command, turn) =>
      handleChannelAgentsCommand({
        command,
        turn,
        replyWriter: input.replyWriter,
        renderAgentsSnapshot,
      }),
    status: (command, turn) => {
      const focusedAgentId = input.registry.resolveFocus(command.scopeKey);
      const targetAgentId = command.targetAgentId ?? focusedAgentId;
      return handleChannelStatusCommand({
        command,
        turn,
        runtime: input.runtime,
        replyWriter: input.replyWriter,
        focusedAgentId,
        targetAgentId,
        isTargetActive: input.registry.isActive(targetAgentId),
        openLiveSession,
        resolveQuestionSurface,
        dependencies: input.dependencies,
      });
    },
    steer: (command, turn) => {
      const targetAgentId = command.targetAgentId ?? input.registry.resolveFocus(command.scopeKey);
      return handleChannelSteerCommand({
        command,
        turn,
        replyWriter: input.replyWriter,
        targetAgentId,
        isTargetActive: input.registry.isActive(targetAgentId),
        openLiveSession,
      });
    },
    answer: (command, turn) => {
      const focusedAgentId = input.registry.resolveFocus(command.scopeKey);
      const targetAgentId = command.targetAgentId ?? focusedAgentId;
      return handleChannelAnswerCommand({
        command,
        turn,
        replyWriter: input.replyWriter,
        targetAgentId,
        focusedAgentId,
        isTargetActive: input.registry.isActive(targetAgentId),
        resolveQuestionSurface,
      });
    },
    update: (command, turn, preparedCommand) => {
      const targetAgentId = command.targetAgentId ?? input.registry.resolveFocus(command.scopeKey);
      return handleChannelUpdateCommand({
        command,
        turn,
        runtime: input.runtime,
        targetAgentId,
        isTargetActive: input.registry.isActive(targetAgentId),
        replyWriter: input.replyWriter,
        preparedCommand,
        updateExecutionScope: input.updateExecutionScope,
      });
    },
    "agent-create": (command, turn) =>
      handleChannelAgentCreateCommand({
        command,
        turn,
        registry: input.registry,
        replyWriter: input.replyWriter,
        runtime: input.runtime,
      }),
    "agent-delete": (command, turn) =>
      handleChannelAgentDeleteCommand({
        command,
        turn,
        registry: input.registry,
        replyWriter: input.replyWriter,
        runtime: input.runtime,
        cleanupAgentSessions,
        disposeAgentRuntime,
      }),
    focus: (command, turn) =>
      handleChannelFocusCommand({
        command,
        turn,
        registry: input.registry,
        replyWriter: input.replyWriter,
        runtime: input.runtime,
      }),
    run: (command, turn) =>
      handleChannelRunCommand({
        command,
        turn,
        coordinator: input.coordinator,
        replyWriter: input.replyWriter,
        runtime: input.runtime,
      }),
    discuss: (command, turn) =>
      handleChannelDiscussCommand({
        command,
        turn,
        coordinator: input.coordinator,
        replyWriter: input.replyWriter,
        runtime: input.runtime,
      }),
    "route-agent": (command, turn) =>
      handleChannelRouteAgentCommand({
        command,
        turn,
        registry: input.registry,
        runtime: input.runtime,
        replyWriter: input.replyWriter,
        orchestrationOwners: input.orchestrationConfig.owners.telegram,
        aclModeWhenOwnersEmpty: input.orchestrationConfig.aclModeWhenOwnersEmpty,
      }),
  };

  return {
    async prepareCommand(
      match: ChannelCommandMatch,
      turn: TurnEnvelope,
      scopeKey: string,
    ): Promise<ChannelPreparedCommand> {
      const command = resolveChannelControlCommand(match, scopeKey);
      if (!command || command.kind !== "update") {
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
      return await prepareChannelUpdateCommand({
        command,
        match,
        turn,
        replyWriter: input.replyWriter,
        runtime: input.runtime,
        updateLock: input.updateLock,
        targetAgentId: command.targetAgentId ?? input.registry.resolveFocus(scopeKey),
        isTargetActive: input.registry.isActive(
          command.targetAgentId ?? input.registry.resolveFocus(scopeKey),
        ),
        updateExecutionScope: input.updateExecutionScope,
      });
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

      if (match.kind === "error") {
        input.runtime.extensions.hosted.events.record({
          sessionId: turn.sessionId,
          type: CHANNEL_COMMAND_RECEIVED_EVENT_TYPE,
          payload: {
            scopeKey,
            command: match.kind,
            actionKind: null,
            turnId: turn.turnId,
            conversationId: turn.conversationId,
          },
        });
        await input.replyWriter.sendControllerReply(
          turn,
          scopeKey,
          `Command parse error: ${match.message}`,
        );
        return { handled: true };
      }

      const command = resolveChannelControlCommand(match, scopeKey);
      if (!command) {
        return { handled: false };
      }

      input.runtime.extensions.hosted.events.record({
        sessionId: turn.sessionId,
        type: CHANNEL_COMMAND_RECEIVED_EVENT_TYPE,
        payload: {
          scopeKey,
          command: command.kind,
          actionKind:
            command.kind === "status"
              ? "status_summary"
              : command.kind === "answer"
                ? "answer_question"
                : null,
          turnId: turn.turnId,
          conversationId: turn.conversationId,
        },
      });

      if (!isPublicChannelControlCommand(command)) {
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
              command: command.kind,
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
      const handler = handlers[command.kind] as (
        command: ChannelControlCommand,
        turn: TurnEnvelope,
        preparedCommand?: ChannelPreparedCommand,
      ) => Promise<ChannelCommandDispatchResult>;
      return await handler(command, turn, preparedCommand);
    },
  };
}
