import type {
  BrewvaPromptSessionEvent,
  BrewvaSteerOutcome,
} from "@brewva/brewva-substrate/session";
import type { ManagedToolMode } from "@brewva/brewva-vocabulary/session";
import type { TurnEnvelope } from "@brewva/brewva-vocabulary/wire";
import type { HostedRuntimeAdapterPort } from "../../hosted/api.js";
import {
  getRuntimeCostSummary,
  listRuntimePendingProposalRequests,
  listRuntimeProposalRequests,
} from "../../hosted/api.js";
import { waitForAllSettledWithTimeout } from "../../utils/async.js";
import { toErrorMessage } from "../../utils/errors.js";
import { recordSessionShutdownIfMissing } from "../../utils/runtime.js";
import { AgentRegistry } from "../agent-registry.js";
import { AgentRuntimeManager } from "../agent-runtime-manager.js";
import {
  createChannelSerialQueueRuntime,
  type ChannelSerialQueueRuntime,
} from "../effect-serial-queue.js";
import type { AgentSessionUsage } from "../policy/eviction.js";
import { selectIdleEvictableAgentsByTtl, selectLruEvictableAgent } from "../policy/eviction.js";
import {
  buildAgentScopedConversationKey,
  buildRoutingScopeKey,
  type RoutingScopeStrategy,
} from "../policy/routing-scope.js";
import type {
  ChannelCreateSessionOptions,
  ChannelHostedSessionResult as HostedSessionResult,
} from "../ports.js";
import { ConversationBindingStore } from "./binding-store.js";

const DEFAULT_CLEANUP_GRACEFUL_TIMEOUT_MS = 2_000;
const SESSION_CREATION_INVALIDATED_ERROR = "session_creation_invalidated";
const REPLAYABLE_EFFECT_COMMITMENT_REQUEST_STATES = ["pending", "accepted"] as const;

export type ChannelSessionCostSummary = ReturnType<
  HostedRuntimeAdapterPort["ops"]["cost"]["summary"]["get"]
>;

function buildEmptyCostSummary(): ChannelSessionCostSummary {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    models: {},
    skills: {},
    tools: {},
    alerts: [],
    budget: {
      action: "warn",
      sessionExceeded: false,
      blocked: false,
    },
  };
}

function isSessionCreationInvalidatedError(error: unknown, agentId: string): boolean {
  return toErrorMessage(error) === `${SESSION_CREATION_INVALIDATED_ERROR}:${agentId}`;
}

export interface ChannelRuntimeSessionPort {
  readonly scopeKey: string;
  readonly agentId: string;
  readonly runtime: HostedRuntimeAdapterPort;
  readonly operatorRuntime: HostedRuntimeAdapterPort;
  readonly agentSessionId: string;
  getCostSummary(): ChannelSessionCostSummary;
  subscribe(listener: (event: BrewvaPromptSessionEvent) => void): () => void;
  steer(text: string): Promise<BrewvaSteerOutcome>;
}

export interface ChannelSessionHandle extends ChannelRuntimeSessionPort {
  readonly session: HostedSessionResult["session"];
}

export interface ChannelLiveSessionView {
  readonly scopeKey: string;
  readonly agentId: string;
  readonly agentSessionId: string;
}

interface ChannelSessionState {
  key: string;
  scopeKey: string;
  agentId: string;
  runtime: HostedRuntimeAdapterPort;
  agentSessionId: string;
  result: HostedSessionResult;
  representativeTurn: TurnEnvelope;
  taskQueue: ChannelSerialQueueRuntime;
  inFlightTasks: number;
  outboundSequence: number;
  lastUsedAt: number;
}

export interface ChannelSessionCoordinator {
  resolveScopeKey(turn: TurnEnvelope): string;
  getOrCreateSession(
    scopeKey: string,
    agentId: string,
    turn: TurnEnvelope,
  ): Promise<ChannelSessionHandle>;
  loadInspectionRuntime(agentId: string): Promise<HostedRuntimeAdapterPort>;
  getLiveSession(scopeKey: string, agentId: string): ChannelLiveSessionView | undefined;
  openLiveSession(scopeKey: string, agentId: string): ChannelRuntimeSessionPort | undefined;
  getSessionByAgentSessionId(sessionId: string): ChannelLiveSessionView | undefined;
  getRepresentativeTurnByAgentSessionId(sessionId: string): TurnEnvelope | undefined;
  listLiveSessions(): ChannelLiveSessionView[];
  getSessionCostSummary(sessionId: string): ChannelSessionCostSummary;
  hasPendingEffectCommitment(sessionId: string, requestId: string): boolean;
  hasReplayableEffectCommitmentRequest(sessionId: string, requestId: string): boolean;
  listQueueTails(): Promise<void>[];
  enqueueSessionTask<T>(handle: ChannelSessionHandle, task: () => Promise<T>): Promise<T>;
  touchSession(handle: ChannelSessionHandle): void;
  nextOutboundSequence(handle: ChannelSessionHandle): number;
  cleanupAgentSessions(agentId: string): Promise<void>;
  disposeRuntime(agentId: string): boolean;
  disposeAllSessions(): Promise<void>;
  evictIdleAgentRuntimesByTtl(now?: number): Promise<string[]>;
}

export function createChannelSessionCoordinator(input: {
  runtime: HostedRuntimeAdapterPort;
  registry: AgentRegistry;
  runtimeManager: AgentRuntimeManager;
  createSession: (options?: ChannelCreateSessionOptions) => Promise<HostedSessionResult>;
  createExtensions: () => ChannelCreateSessionOptions["extensions"];
  sessionOptions: {
    cwd?: string;
    configPath?: string;
    model?: string;
    managedToolMode: ManagedToolMode;
  };
  scopeStrategy: RoutingScopeStrategy;
  idleRuntimeTtlMs: number;
  recoveryWalScope: string;
  cleanupGracefulTimeoutMs?: number;
}): ChannelSessionCoordinator {
  const conversationBindings = ConversationBindingStore.create({
    workspaceRoot: input.runtime.identity.workspaceRoot,
  });
  const sessions = new Map<string, ChannelSessionState>();
  const sessionByAgentSessionId = new Map<string, ChannelSessionState>();
  const sessionEpochByAgent = new Map<string, number>();
  const cleanupQueuesByAgent = new Map<string, ChannelSerialQueueRuntime>();
  const createSessionTasks = new Map<
    string,
    {
      agentId: string;
      epoch: number;
      promise: Promise<ChannelSessionHandle>;
    }
  >();
  const cleanupGracefulTimeoutMs = Math.max(
    0,
    Math.floor(input.cleanupGracefulTimeoutMs ?? DEFAULT_CLEANUP_GRACEFUL_TIMEOUT_MS),
  );

  const getSessionEpoch = (agentId: string): number => sessionEpochByAgent.get(agentId) ?? 0;

  const getAgentCleanupQueue = (agentId: string): ChannelSerialQueueRuntime => {
    let queue = cleanupQueuesByAgent.get(agentId);
    if (!queue) {
      queue = createChannelSerialQueueRuntime({
        name: `channel-agent-cleanup:${agentId}`,
      });
      cleanupQueuesByAgent.set(agentId, queue);
    }
    return queue;
  };

  const releaseAgentCleanupQueueWhenIdle = (
    agentId: string,
    queue: ChannelSerialQueueRuntime,
  ): void => {
    void queue
      .whenIdle()
      .then(async () => {
        if (cleanupQueuesByAgent.get(agentId) === queue && (await queue.isIdle())) {
          cleanupQueuesByAgent.delete(agentId);
          const closed = await queue.closeIfIdle();
          if (!closed && !cleanupQueuesByAgent.has(agentId)) {
            cleanupQueuesByAgent.set(agentId, queue);
          }
        }
      })
      .catch(() => undefined);
  };

  const resolveScopeKey = (turn: TurnEnvelope): string => {
    const conversationKey = buildRoutingScopeKey(turn, input.scopeStrategy);
    const existingScopeId = conversationBindings.resolveScopeId(conversationKey);
    if (existingScopeId) {
      return existingScopeId;
    }

    const created = conversationBindings.ensureBinding({
      conversationKey,
      proposedScopeId: conversationKey,
      channel: turn.channel,
      conversationId: turn.conversationId,
      threadId: turn.threadId,
    });
    input.runtime.ops.channel.session.conversationBound({
      sessionId: input.recoveryWalScope,
      payload: {
        channel: created.channel,
        conversationId: created.conversationId,
        threadId: created.threadId,
        conversationKey: created.conversationKey,
        scopeId: created.scopeId,
      },
      skipTapeCheckpoint: true,
    });
    return created.scopeId;
  };

  const invalidateAgentSessions = (agentId: string): number => {
    const nextEpoch = getSessionEpoch(agentId) + 1;
    sessionEpochByAgent.set(agentId, nextEpoch);
    return nextEpoch;
  };

  const listPendingCreateTasksForAgent = (agentId: string): Promise<ChannelSessionHandle>[] =>
    [...createSessionTasks.values()]
      .filter((entry) => entry.agentId === agentId)
      .map((entry) => entry.promise);

  const buildRuntimeSessionPort = (state: ChannelSessionState): ChannelRuntimeSessionPort => ({
    scopeKey: state.scopeKey,
    agentId: state.agentId,
    runtime: state.runtime,
    operatorRuntime: state.runtime,
    agentSessionId: state.agentSessionId,
    getCostSummary() {
      return getRuntimeCostSummary(state.runtime, state.agentSessionId);
    },
    subscribe(listener) {
      return state.result.session.subscribe(listener);
    },
    steer(text) {
      return state.result.session.steer(text, { source: "channel" });
    },
  });

  const buildSessionHandle = (state: ChannelSessionState): ChannelSessionHandle => ({
    ...buildRuntimeSessionPort(state),
    session: state.result.session,
  });

  const buildLiveSessionView = (state: ChannelSessionState): ChannelLiveSessionView => ({
    scopeKey: state.scopeKey,
    agentId: state.agentId,
    agentSessionId: state.agentSessionId,
  });

  const requireSessionState = (handle: ChannelSessionHandle): ChannelSessionState => {
    const state = sessionByAgentSessionId.get(handle.agentSessionId);
    if (!state) {
      throw new Error(`channel_session_not_live:${handle.agentSessionId}`);
    }
    return state;
  };

  const enqueueSessionTask = async <T>(
    handle: ChannelSessionHandle,
    task: () => Promise<T>,
  ): Promise<T> => {
    const state = requireSessionState(handle);
    return await state.taskQueue.enqueue(async () => {
      state.inFlightTasks += 1;
      try {
        return await task();
      } finally {
        state.inFlightTasks = Math.max(0, state.inFlightTasks - 1);
      }
    });
  };

  const disposeHostedSession = async (inputState: {
    runtime: HostedRuntimeAdapterPort;
    agentSessionId: string;
    result: HostedSessionResult;
  }): Promise<void> => {
    try {
      await inputState.result.session.abort();
    } catch {}
    recordSessionShutdownIfMissing(inputState.runtime, {
      sessionId: inputState.agentSessionId,
      reason: "coordinator_cleanup",
      source: "channel_session_coordinator",
    });
    try {
      inputState.runtime.ops.session.state.clear(inputState.agentSessionId);
    } catch {}
    try {
      inputState.result.session.dispose();
    } catch {}
  };

  const disposeSessionState = async (state: ChannelSessionState): Promise<void> => {
    sessions.delete(state.key);
    sessionByAgentSessionId.delete(state.agentSessionId);
    await disposeHostedSession({
      runtime: state.runtime,
      agentSessionId: state.agentSessionId,
      result: state.result,
    });
    await state.taskQueue.close();
    input.runtimeManager.releaseRuntime(state.agentId);
  };

  const cleanupAgentSessions = async (agentId: string): Promise<void> => {
    const queue = getAgentCleanupQueue(agentId);
    const cleanupTask = queue.enqueue(async () => {
      invalidateAgentSessions(agentId);
      const liveMatches = [...sessions.values()].filter((state) => state.agentId === agentId);
      const pendingCreates = listPendingCreateTasksForAgent(agentId);
      await waitForAllSettledWithTimeout(
        [...liveMatches.map((state) => state.taskQueue.whenIdle()), ...pendingCreates],
        cleanupGracefulTimeoutMs,
      );

      const remainingMatches = [...sessions.values()].filter((state) => state.agentId === agentId);
      await Promise.all(
        remainingMatches.map(async (state) => {
          await disposeSessionState(state);
        }),
      );
    });
    releaseAgentCleanupQueueWhenIdle(agentId, queue);
    await cleanupTask;
  };

  const buildSessionUsages = (): AgentSessionUsage[] =>
    [...sessions.values()].map((state) => ({
      agentId: state.agentId,
      lastUsedAt: state.lastUsedAt,
      inFlightTasks: state.inFlightTasks,
    }));

  const evictAgentRuntime = async (agentId: string): Promise<boolean> => {
    const matches = [...sessions.values()].filter((state) => state.agentId === agentId);
    await waitForAllSettledWithTimeout(
      matches.map((state) => state.taskQueue.whenIdle()),
      cleanupGracefulTimeoutMs,
    );
    if (
      [...sessions.values()].some((state) => state.agentId === agentId && state.inFlightTasks > 0)
    ) {
      return false;
    }
    await cleanupAgentSessions(agentId);
    return input.runtimeManager.disposeRuntime(agentId);
  };

  const evictLeastRecentlyUsedAgentRuntime = async (): Promise<string | null> => {
    const candidate = selectLruEvictableAgent(buildSessionUsages());
    if (!candidate) return null;
    const disposed = await evictAgentRuntime(candidate);
    if (!disposed) return null;
    input.runtime.ops.channel.runtime.evicted({
      sessionId: input.recoveryWalScope,
      payload: {
        agentIds: [candidate],
        source: "capacity_reclaim",
      },
      skipTapeCheckpoint: true,
    });
    return candidate;
  };

  const getOrCreateAgentRuntime = async (agentId: string): Promise<HostedRuntimeAdapterPort> => {
    let workerRuntime: HostedRuntimeAdapterPort | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        workerRuntime = await input.runtimeManager.getOrCreateRuntime(agentId);
        break;
      } catch (error) {
        if (toErrorMessage(error) !== "runtime_capacity_exhausted" || attempt > 0) {
          throw error;
        }
        const reclaimed = await evictLeastRecentlyUsedAgentRuntime();
        if (!reclaimed) {
          throw error;
        }
      }
    }
    if (!workerRuntime) {
      throw new Error("runtime_unavailable");
    }
    return workerRuntime;
  };

  return {
    resolveScopeKey,

    async getOrCreateSession(
      scopeKey: string,
      agentId: string,
      turn: TurnEnvelope,
    ): Promise<ChannelSessionHandle> {
      const key = buildAgentScopedConversationKey(agentId, scopeKey);
      while (true) {
        const cleanupQueue = cleanupQueuesByAgent.get(agentId);
        if (cleanupQueue && !(await cleanupQueue.isIdle())) {
          await cleanupQueue.whenIdle().catch(() => undefined);
          continue;
        }

        if (!input.registry.isActive(agentId)) {
          throw new Error(`agent_not_found:${agentId}`);
        }

        const existing = sessions.get(key);
        if (existing) {
          existing.representativeTurn = turn;
          existing.lastUsedAt = Date.now();
          input.runtimeManager.touchRuntime(agentId);
          return buildSessionHandle(existing);
        }

        const epoch = getSessionEpoch(agentId);
        const pending = createSessionTasks.get(key);
        if (pending && pending.epoch === epoch) {
          try {
            return await pending.promise;
          } catch (error) {
            if (isSessionCreationInvalidatedError(error, agentId)) {
              continue;
            }
            throw error;
          }
        }

        const pendingCreation = {
          agentId,
          epoch,
          promise: (async (): Promise<ChannelSessionHandle> => {
            const workerRuntime = await getOrCreateAgentRuntime(agentId);
            const model = input.registry.getModel(agentId) ?? input.sessionOptions.model;
            const result = await input.createSession({
              cwd: input.sessionOptions.cwd,
              configPath: input.sessionOptions.configPath,
              model,
              managedToolMode: input.sessionOptions.managedToolMode,
              runtime: workerRuntime,
              scopeId: scopeKey,
              extensions: input.createExtensions(),
            });
            const agentSessionId = result.session.sessionManager.getSessionId();
            if (!input.registry.isActive(agentId)) {
              await disposeHostedSession({
                runtime: workerRuntime,
                agentSessionId,
                result,
              });
              throw new Error(`agent_not_found:${agentId}`);
            }
            if (getSessionEpoch(agentId) !== epoch) {
              await disposeHostedSession({
                runtime: workerRuntime,
                agentSessionId,
                result,
              });
              throw new Error(`${SESSION_CREATION_INVALIDATED_ERROR}:${agentId}`);
            }
            input.runtimeManager.retainRuntime(agentId);
            const state: ChannelSessionState = {
              key,
              scopeKey,
              agentId,
              runtime: workerRuntime,
              agentSessionId,
              result,
              representativeTurn: turn,
              taskQueue: createChannelSerialQueueRuntime({
                name: `channel-session:${agentSessionId}`,
              }),
              inFlightTasks: 0,
              outboundSequence: 0,
              lastUsedAt: Date.now(),
            };
            sessions.set(key, state);
            sessionByAgentSessionId.set(state.agentSessionId, state);
            workerRuntime.ops.channel.session.bound({
              sessionId: state.agentSessionId,
              payload: {
                channel: turn.channel,
                conversationId: turn.conversationId,
                channelConversationKey: key,
                scopeKey,
                agentId,
                channelTurnSessionId: turn.sessionId,
                agentSessionId: state.agentSessionId,
              },
            });
            return buildSessionHandle(state);
          })(),
        };

        createSessionTasks.set(key, pendingCreation);
        try {
          return await pendingCreation.promise;
        } catch (error) {
          if (isSessionCreationInvalidatedError(error, agentId)) {
            continue;
          }
          throw error;
        } finally {
          if (createSessionTasks.get(key) === pendingCreation) {
            createSessionTasks.delete(key);
          }
        }
      }
    },
    async loadInspectionRuntime(agentId: string): Promise<HostedRuntimeAdapterPort> {
      return input.runtimeManager.createInspectionRuntime(agentId);
    },

    getLiveSession(scopeKey: string, agentId: string): ChannelLiveSessionView | undefined {
      const state = sessions.get(buildAgentScopedConversationKey(agentId, scopeKey));
      return state ? buildLiveSessionView(state) : undefined;
    },

    openLiveSession(scopeKey: string, agentId: string): ChannelRuntimeSessionPort | undefined {
      const state = sessions.get(buildAgentScopedConversationKey(agentId, scopeKey));
      return state ? buildRuntimeSessionPort(state) : undefined;
    },

    getSessionByAgentSessionId(sessionId: string): ChannelLiveSessionView | undefined {
      const state = sessionByAgentSessionId.get(sessionId);
      return state ? buildLiveSessionView(state) : undefined;
    },

    getRepresentativeTurnByAgentSessionId(sessionId: string): TurnEnvelope | undefined {
      return sessionByAgentSessionId.get(sessionId)?.representativeTurn;
    },

    listLiveSessions(): ChannelLiveSessionView[] {
      return [...sessions.values()].map((state) => buildLiveSessionView(state));
    },

    getSessionCostSummary(sessionId: string): ChannelSessionCostSummary {
      const state = sessionByAgentSessionId.get(sessionId);
      if (!state) {
        return buildEmptyCostSummary();
      }
      return getRuntimeCostSummary(state.runtime, sessionId);
    },

    hasPendingEffectCommitment(sessionId: string, requestId: string): boolean {
      const state = sessionByAgentSessionId.get(sessionId);
      if (!state) {
        return false;
      }
      return listRuntimePendingProposalRequests(state.runtime, sessionId).some(
        (pending: { requestId?: string }) => pending.requestId === requestId,
      );
    },

    hasReplayableEffectCommitmentRequest(sessionId: string, requestId: string): boolean {
      const state = sessionByAgentSessionId.get(sessionId);
      if (!state) {
        return false;
      }
      return REPLAYABLE_EFFECT_COMMITMENT_REQUEST_STATES.some((requestState) =>
        listRuntimeProposalRequests(state.runtime, sessionId, {
          state: requestState,
        }).some((request: { requestId?: string }) => request.requestId === requestId),
      );
    },

    listQueueTails(): Promise<void>[] {
      return [
        ...[...sessions.values()].map((state) => state.taskQueue.whenIdle()),
        ...[...cleanupQueuesByAgent.values()].map((queue) => queue.whenIdle()),
        ...[...createSessionTasks.values()].map((entry) =>
          entry.promise.then(
            () => undefined,
            () => undefined,
          ),
        ),
      ];
    },

    enqueueSessionTask,

    touchSession(handle: ChannelSessionHandle): void {
      const state = requireSessionState(handle);
      state.lastUsedAt = Date.now();
      input.runtimeManager.touchRuntime(state.agentId);
    },

    nextOutboundSequence(handle: ChannelSessionHandle): number {
      const state = requireSessionState(handle);
      state.outboundSequence += 1;
      return state.outboundSequence;
    },

    cleanupAgentSessions,

    disposeRuntime(agentId: string): boolean {
      return input.runtimeManager.disposeRuntime(agentId);
    },

    async disposeAllSessions(): Promise<void> {
      const agentIds = new Set<string>();
      for (const state of sessions.values()) {
        agentIds.add(state.agentId);
      }
      for (const entry of createSessionTasks.values()) {
        agentIds.add(entry.agentId);
      }
      await Promise.allSettled([...agentIds].map((agentId) => cleanupAgentSessions(agentId)));
    },

    async evictIdleAgentRuntimesByTtl(now = Date.now()): Promise<string[]> {
      const candidates = selectIdleEvictableAgentsByTtl(
        buildSessionUsages(),
        now,
        input.idleRuntimeTtlMs,
      );
      const evicted: string[] = [];
      for (const agentId of candidates) {
        const disposed = await evictAgentRuntime(agentId);
        if (disposed) {
          evicted.push(agentId);
        }
      }
      if (evicted.length > 0) {
        input.runtime.ops.channel.runtime.evicted({
          sessionId: input.recoveryWalScope,
          payload: {
            agentIds: evicted,
            source: "idle_ttl_reclaim",
          },
          skipTapeCheckpoint: true,
        });
      }
      return evicted;
    },
  };
}
