import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import { type TurnEnvelope, type TurnPart } from "@brewva/brewva-runtime/channels";
import type { BrewvaWalId } from "@brewva/brewva-runtime/core";
import { type RecoveryWalStore } from "@brewva/brewva-runtime/recovery";
import { LRUCache } from "lru-cache";
import { toErrorMessage } from "../utils/errors.js";
import type { ChannelReplyWriter } from "./channel-reply-writer.js";
import type { ChannelCommandDispatchResult, ChannelPreparedCommand } from "./command/dispatch.js";
import type { ChannelCommandMatch, CommandRouter } from "./command/parser.js";
import {
  createChannelEffectSerialQueue,
  type ChannelEffectSerialQueue,
} from "./effect-serial-queue.js";

const LAST_TURN_CACHE_MAX_ENTRIES_DEFAULT = 2_048;

function extractInboundText(turn: TurnEnvelope): string {
  const texts = turn.parts
    .filter((part): part is Extract<TurnPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text.trim())
    .filter((part) => part.length > 0);
  return texts.join("\n").trim();
}

function rewriteTurnText(turn: TurnEnvelope, text: string): TurnEnvelope {
  return {
    ...turn,
    parts: [{ type: "text", text }],
  };
}

function normalizeLastTurnCacheMaxEntries(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return LAST_TURN_CACHE_MAX_ENTRIES_DEFAULT;
  }
  return Math.max(1, Math.floor(value));
}

export interface ChannelTurnDispatcher {
  enqueueInboundTurn(
    turn: TurnEnvelope,
    enqueueOptions?: {
      walId?: BrewvaWalId;
      awaitCompletion?: boolean;
    },
  ): Promise<void>;
  getLastTurn(scopeKey: string): TurnEnvelope | undefined;
  listQueueTails(): Promise<void>[];
}

export function createChannelTurnDispatcher(input: {
  runtime: BrewvaHostedRuntimePort;
  recoveryWalStore: RecoveryWalStore;
  orchestrationEnabled: boolean;
  defaultAgentId: string;
  commandRouter: Pick<CommandRouter, "match">;
  replyWriter: ChannelReplyWriter;
  resolveScopeKey(turn: TurnEnvelope): string;
  resolveFocusedAgentId(scopeKey: string): string;
  resolveApprovalTargetAgentIdDurably(
    scopeKey: string,
    requestId: string,
  ): Promise<string | undefined>;
  processUserTurnOnAgent(
    turn: TurnEnvelope,
    walId: BrewvaWalId,
    scopeKey: string,
    targetAgentId: string,
  ): Promise<void>;
  handleCommand(
    match: ChannelCommandMatch,
    turn: TurnEnvelope,
    scopeKey: string,
    preparedCommand?: ChannelPreparedCommand,
  ): Promise<ChannelCommandDispatchResult>;
  prepareCommand(
    match: ChannelCommandMatch,
    turn: TurnEnvelope,
    scopeKey: string,
  ): Promise<ChannelPreparedCommand>;
  isShuttingDown(): boolean;
  lastTurnCacheMaxEntries?: number;
}): ChannelTurnDispatcher {
  const scopeQueues = new Map<string, ChannelEffectSerialQueue>();
  const lastTurnCacheMaxEntries = normalizeLastTurnCacheMaxEntries(input.lastTurnCacheMaxEntries);
  const lastTurnByScope = new LRUCache<string, TurnEnvelope>({
    max: lastTurnCacheMaxEntries,
  });

  const rememberLastTurn = (scopeKey: string, turn: TurnEnvelope): void => {
    lastTurnByScope.set(scopeKey, turn);
  };

  const readLastTurn = (scopeKey: string): TurnEnvelope | undefined =>
    lastTurnByScope.get(scopeKey);

  const resolveApprovalTargetAgentIdForDispatch = async (
    turn: TurnEnvelope,
    scopeKey: string,
  ): Promise<string | undefined> => {
    if (!input.orchestrationEnabled || turn.kind !== "approval") {
      return undefined;
    }
    const requestId = turn.approval?.requestId?.trim() ?? "";
    if (!requestId) {
      return undefined;
    }
    return await input.resolveApprovalTargetAgentIdDurably(scopeKey, requestId);
  };

  const processInboundTurn = async (
    turn: TurnEnvelope,
    walId: BrewvaWalId,
    scopeKey: string,
    preparedCommand?: ChannelPreparedCommand,
  ): Promise<void> => {
    input.recoveryWalStore.markInflight(walId);
    rememberLastTurn(scopeKey, turn);

    try {
      const text = extractInboundText(turn);
      const commandResult =
        preparedCommand?.match ??
        (input.orchestrationEnabled && turn.kind === "user" && text.length > 0
          ? input.commandRouter.match(text)
          : ({ kind: "none" } satisfies ChannelCommandMatch));

      if (input.orchestrationEnabled && commandResult.kind !== "none") {
        let commandOutcome: ChannelCommandDispatchResult;
        try {
          commandOutcome = await input.handleCommand(
            commandResult,
            turn,
            scopeKey,
            preparedCommand,
          );
        } catch (error) {
          preparedCommand?.release?.();
          input.runtime.extensions.hosted.events.record({
            sessionId: turn.sessionId,
            type: "channel_command_rejected",
            payload: {
              scopeKey,
              command: commandResult.kind,
              reason: "command_execution_error",
              turnId: turn.turnId,
              error: toErrorMessage(error),
            },
          });
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Command failed: ${toErrorMessage(error)}`,
            {
              command: commandResult.kind,
            },
          );
          input.recoveryWalStore.markDone(walId);
          return;
        }
        if (commandOutcome.handled) {
          preparedCommand?.release?.();
          input.recoveryWalStore.markDone(walId);
          return;
        }

        const routeAgentId = commandOutcome.routeAgentId;
        if (routeAgentId && commandOutcome.routeTask) {
          const rewrittenTurn = rewriteTurnText(turn, commandOutcome.routeTask);
          try {
            await input.processUserTurnOnAgent(rewrittenTurn, walId, scopeKey, routeAgentId);
            await commandOutcome.afterRouteSuccess?.();
            input.recoveryWalStore.markDone(walId);
          } finally {
            preparedCommand?.release?.();
          }
          return;
        }

        preparedCommand?.release?.();
      }

      const durableApprovalAgentId = await resolveApprovalTargetAgentIdForDispatch(turn, scopeKey);
      if (input.orchestrationEnabled && turn.kind === "approval" && !durableApprovalAgentId) {
        input.runtime.extensions.hosted.events.record({
          sessionId: turn.sessionId,
          type: "channel_approval_target_unresolved",
          payload: {
            scopeKey,
            turnId: turn.turnId,
            requestId: turn.approval?.requestId ?? null,
          },
        });
        await input.replyWriter.sendControllerReply(
          turn,
          scopeKey,
          "Approval request is no longer active for this workspace.",
        );
        input.recoveryWalStore.markDone(walId);
        return;
      }
      const fallbackAgentId = input.orchestrationEnabled
        ? (durableApprovalAgentId ?? input.resolveFocusedAgentId(scopeKey))
        : input.defaultAgentId;
      await input.processUserTurnOnAgent(turn, walId, scopeKey, fallbackAgentId);
      input.recoveryWalStore.markDone(walId);
    } catch (error) {
      input.recoveryWalStore.markFailed(walId, toErrorMessage(error));
      throw error;
    }
  };

  return {
    async enqueueInboundTurn(
      turn: TurnEnvelope,
      enqueueOptions: {
        walId?: BrewvaWalId;
        awaitCompletion?: boolean;
      } = {},
    ): Promise<void> {
      if (input.isShuttingDown()) return;

      const walId =
        enqueueOptions.walId ??
        input.recoveryWalStore.appendPending(turn, "channel", {
          dedupeKey: `${turn.channel}:${turn.turnId}`,
        }).walId;

      const scopeKey = input.resolveScopeKey(turn);
      const text = extractInboundText(turn);
      const commandMatch =
        input.orchestrationEnabled && turn.kind === "user" && text.length > 0
          ? input.commandRouter.match(text)
          : ({ kind: "none" } satisfies ChannelCommandMatch);

      let preparedCommand: ChannelPreparedCommand | undefined;
      if (input.orchestrationEnabled && commandMatch.kind !== "none") {
        try {
          preparedCommand = await input.prepareCommand(commandMatch, turn, scopeKey);
        } catch (error) {
          input.runtime.extensions.hosted.events.record({
            sessionId: turn.sessionId,
            type: "channel_command_rejected",
            payload: {
              scopeKey,
              command: commandMatch.kind,
              reason: "command_execution_error",
              turnId: turn.turnId,
              error: toErrorMessage(error),
            },
          });
          await input.replyWriter.sendControllerReply(
            turn,
            scopeKey,
            `Command failed: ${toErrorMessage(error)}`,
            {
              command: commandMatch.kind,
            },
          );
          input.recoveryWalStore.markDone(walId);
          return;
        }
        if (preparedCommand.handled) {
          input.recoveryWalStore.markDone(walId);
          return;
        }
      }

      let queue = scopeQueues.get(scopeKey);
      if (!queue) {
        queue = createChannelEffectSerialQueue({
          name: `channel-turn:${scopeKey}`,
        });
        scopeQueues.set(scopeKey, queue);
      }

      const next = queue.enqueue(async () => {
        await processInboundTurn(turn, walId, scopeKey, preparedCommand);
      });
      const releaseQueue = () => {
        void queue
          .whenIdle()
          .then(async () => {
            if (scopeQueues.get(scopeKey) === queue && queue.isIdle()) {
              scopeQueues.delete(scopeKey);
              await queue.close();
            }
          })
          .catch(() => undefined);
      };
      void next.then(releaseQueue, releaseQueue);

      if (enqueueOptions.awaitCompletion) {
        await next;
      } else {
        void next.catch(() => undefined);
      }
    },
    getLastTurn(scopeKey: string): TurnEnvelope | undefined {
      return readLastTurn(scopeKey);
    },

    listQueueTails(): Promise<void>[] {
      return [...scopeQueues.values()].map((queue) => queue.whenIdle());
    },
  };
}
