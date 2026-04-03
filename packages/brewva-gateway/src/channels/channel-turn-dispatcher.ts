import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  type TurnEnvelope,
  type TurnPart,
  type TurnWALStore,
} from "@brewva/brewva-runtime/channels";
import { LRUCache } from "lru-cache";
import { toErrorMessage } from "../utils/errors.js";
import type {
  ChannelCommandDispatchResult,
  ChannelPreparedCommand,
} from "./channel-command-dispatch.js";
import type { ChannelReplyWriter } from "./channel-reply-writer.js";
import type { ChannelCommandMatch, CommandRouter } from "./command-router.js";

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
      walId?: string;
      awaitCompletion?: boolean;
    },
  ): Promise<void>;
  resolveIngestedSessionId(turn: TurnEnvelope): string | undefined;
  getLastTurn(scopeKey: string): TurnEnvelope | undefined;
  listQueueTails(): Promise<void>[];
}

export function createChannelTurnDispatcher(input: {
  runtime: BrewvaRuntime;
  turnWalStore: TurnWALStore;
  orchestrationEnabled: boolean;
  defaultAgentId: string;
  commandRouter: Pick<CommandRouter, "match">;
  replyWriter: ChannelReplyWriter;
  resolveScopeKey(turn: TurnEnvelope): string;
  resolveFocusedAgentId(scopeKey: string): string;
  isAgentActive(agentId: string): boolean;
  resolveLiveSessionId(scopeKey: string, agentId: string): string | undefined;
  resolveApprovalTargetAgentId(scopeKey: string, requestId: string): string | undefined;
  processUserTurnOnAgent(
    turn: TurnEnvelope,
    walId: string,
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
  const scopeQueues = new Map<string, Promise<void>>();
  const lastTurnCacheMaxEntries = normalizeLastTurnCacheMaxEntries(input.lastTurnCacheMaxEntries);
  const lastTurnByScope = new LRUCache<string, TurnEnvelope>({
    max: lastTurnCacheMaxEntries,
  });

  const rememberLastTurn = (scopeKey: string, turn: TurnEnvelope): void => {
    lastTurnByScope.set(scopeKey, turn);
  };

  const readLastTurn = (scopeKey: string): TurnEnvelope | undefined =>
    lastTurnByScope.get(scopeKey);

  const resolveApprovalTargetAgentIdForTurn = (
    turn: TurnEnvelope,
    scopeKey: string,
  ): string | undefined => {
    if (!input.orchestrationEnabled || turn.kind !== "approval") {
      return undefined;
    }
    const requestId = turn.approval?.requestId?.trim() ?? "";
    if (!requestId) {
      return undefined;
    }
    return input.resolveApprovalTargetAgentId(scopeKey, requestId);
  };

  const resolveTargetAgentId = (turn: TurnEnvelope, scopeKey: string): string => {
    let targetAgentId = input.orchestrationEnabled
      ? input.resolveFocusedAgentId(scopeKey)
      : input.defaultAgentId;

    if (input.orchestrationEnabled) {
      const approvalAgentId = resolveApprovalTargetAgentIdForTurn(turn, scopeKey);
      if (approvalAgentId) {
        targetAgentId = approvalAgentId;
      }
    }

    if (input.orchestrationEnabled && turn.kind === "user") {
      const text = extractInboundText(turn);
      const matched: ChannelCommandMatch =
        text.length > 0 ? input.commandRouter.match(text) : { kind: "none" };
      if (matched.kind === "route-agent" && input.isAgentActive(matched.agentId)) {
        targetAgentId = matched.agentId;
      }
    }

    return targetAgentId;
  };

  const processInboundTurn = async (
    turn: TurnEnvelope,
    walId: string,
    scopeKey: string,
    preparedCommand?: ChannelPreparedCommand,
  ): Promise<void> => {
    input.turnWalStore.markInflight(walId);
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
          input.runtime.events.record({
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
          input.turnWalStore.markDone(walId);
          return;
        }
        if (commandOutcome.handled) {
          preparedCommand?.release?.();
          input.turnWalStore.markDone(walId);
          return;
        }

        const routeAgentId = commandOutcome.routeAgentId;
        if (routeAgentId && commandOutcome.routeTask) {
          const rewrittenTurn = rewriteTurnText(turn, commandOutcome.routeTask);
          try {
            await input.processUserTurnOnAgent(rewrittenTurn, walId, scopeKey, routeAgentId);
            input.turnWalStore.markDone(walId);
          } finally {
            preparedCommand?.release?.();
          }
          return;
        }

        preparedCommand?.release?.();
      }

      const fallbackAgentId = input.orchestrationEnabled
        ? (resolveApprovalTargetAgentIdForTurn(turn, scopeKey) ??
          input.resolveFocusedAgentId(scopeKey))
        : input.defaultAgentId;
      await input.processUserTurnOnAgent(turn, walId, scopeKey, fallbackAgentId);
      input.turnWalStore.markDone(walId);
    } catch (error) {
      input.turnWalStore.markFailed(walId, toErrorMessage(error));
      throw error;
    }
  };

  return {
    async enqueueInboundTurn(
      turn: TurnEnvelope,
      enqueueOptions: {
        walId?: string;
        awaitCompletion?: boolean;
      } = {},
    ): Promise<void> {
      if (input.isShuttingDown()) return;

      const walId =
        enqueueOptions.walId ??
        input.turnWalStore.appendPending(turn, "channel", {
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
          input.runtime.events.record({
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
          input.turnWalStore.markDone(walId);
          return;
        }
        if (preparedCommand.handled) {
          input.turnWalStore.markDone(walId);
          return;
        }
      }

      const previous = scopeQueues.get(scopeKey) ?? Promise.resolve();
      const next = previous
        .catch(() => undefined)
        .then(async () => {
          await processInboundTurn(turn, walId, scopeKey, preparedCommand);
        });
      const settled = next.then(
        () => undefined,
        () => undefined,
      );
      scopeQueues.set(scopeKey, settled);
      void settled.finally(() => {
        if (scopeQueues.get(scopeKey) === settled) {
          scopeQueues.delete(scopeKey);
        }
      });

      if (enqueueOptions.awaitCompletion) {
        await next;
      }
    },

    resolveIngestedSessionId(turn: TurnEnvelope): string | undefined {
      const scopeKey = input.resolveScopeKey(turn);
      const targetAgentId = resolveTargetAgentId(turn, scopeKey);
      return input.resolveLiveSessionId(scopeKey, targetAgentId);
    },

    getLastTurn(scopeKey: string): TurnEnvelope | undefined {
      return readLastTurn(scopeKey);
    },

    listQueueTails(): Promise<void>[] {
      return [...scopeQueues.values()];
    },
  };
}
