import { CHANNEL_SESSION_BOUND_EVENT_TYPE } from "@brewva/brewva-runtime/protocol";
import { readNonEmptyString } from "@brewva/brewva-std/text";
import { isRecord } from "@brewva/brewva-std/unknown";
import type { HostedRuntimeAdapterPort } from "../../hosted/api.js";
import {
  listRuntimeEventSessionIds,
  listRuntimeProposalRequests,
  queryRuntimeEvents,
} from "../../hosted/api.js";
import { AgentRegistry } from "../agent-registry.js";
import { AgentRuntimeManager } from "../agent-runtime-manager.js";
import type {
  ChannelLiveSessionView,
  ChannelRuntimeSessionPort,
  ChannelSessionCostSummary,
} from "./coordinator.js";

export interface ChannelQuestionSurface {
  runtime: HostedRuntimeAdapterPort;
  sessionIds: string[];
  liveSessionId?: string;
}

export interface ChannelSessionQueries {
  renderAgentsSnapshot(scopeKey: string): string;
  resolveQuestionSurface(
    scopeKey: string,
    agentId: string,
  ): Promise<ChannelQuestionSurface | undefined>;
  resolveApprovalTargetAgentId(scopeKey: string, requestId: string): string | undefined;
  resolveApprovalTargetAgentIdDurably(
    scopeKey: string,
    requestId: string,
  ): Promise<string | undefined>;
}

export function createChannelSessionQueries(input: {
  runtime: HostedRuntimeAdapterPort;
  registry: AgentRegistry;
  runtimeManager: AgentRuntimeManager;
  recoveryWalScope: string;
  listLiveSessions(): ChannelLiveSessionView[];
  openLiveSession(scopeKey: string, agentId: string): ChannelRuntimeSessionPort | undefined;
  loadInspectionRuntime(agentId: string): Promise<HostedRuntimeAdapterPort>;
  getSessionCostSummary(sessionId: string): ChannelSessionCostSummary;
  hasReplayableEffectCommitmentRequest(sessionId: string, requestId: string): boolean;
}): ChannelSessionQueries {
  const REPLAYABLE_EFFECT_COMMITMENT_REQUEST_STATES = ["pending", "accepted"] as const;

  const listChannelBoundSessionIds = (options: {
    runtime: HostedRuntimeAdapterPort;
    scopeKey: string;
    agentId: string;
  }): string[] => {
    const matches: Array<{ sessionId: string; boundAt: number }> = [];
    for (const sessionId of listRuntimeEventSessionIds(options.runtime)) {
      const binding = queryRuntimeEvents(options.runtime, sessionId, {
        type: CHANNEL_SESSION_BOUND_EVENT_TYPE,
        last: 1,
      })[0];
      if (!binding) {
        continue;
      }
      const payload = isRecord(binding.payload) ? binding.payload : null;
      const bindingScopeKey = readNonEmptyString(payload?.scopeKey);
      const bindingAgentId = readNonEmptyString(payload?.agentId);
      if (bindingScopeKey !== options.scopeKey || bindingAgentId !== options.agentId) {
        continue;
      }
      matches.push({
        sessionId,
        boundAt: binding.timestamp,
      });
    }
    return matches
      .toSorted(
        (left, right) =>
          right.boundAt - left.boundAt || left.sessionId.localeCompare(right.sessionId),
      )
      .map((entry) => entry.sessionId);
  };

  const hasReplayableRequestInRuntime = (
    runtime: HostedRuntimeAdapterPort,
    sessionId: string,
    requestId: string,
  ): boolean =>
    REPLAYABLE_EFFECT_COMMITMENT_REQUEST_STATES.some((requestState) =>
      listRuntimeProposalRequests(runtime, sessionId, {
        state: requestState,
      }).some((request: { requestId?: string }) => request.requestId === requestId),
    );

  const listActiveAgentIdsForScope = (scopeKey: string): string[] => {
    const preferred = input.registry
      .snapshot(scopeKey, true)
      .agents.filter((agent) => agent.status === "active")
      .map((agent) => agent.agentId);
    const fallback = input.registry
      .list()
      .filter((agent) => agent.status === "active")
      .map((agent) => agent.agentId);
    return Array.from(new Set([...preferred, ...fallback]));
  };

  return {
    renderAgentsSnapshot(scopeKey: string): string {
      const snapshot = input.registry.snapshot(scopeKey, true);
      const lines: string[] = [
        `Focus: @${snapshot.focusedAgentId}`,
        `Default: @${snapshot.defaultAgentId}`,
        "Agents:",
      ];

      const aggregateByAgent = new Map<
        string,
        {
          totalTokens: number;
          totalCostUsd: number;
        }
      >();
      for (const state of input.listLiveSessions()) {
        const summary = input.getSessionCostSummary(state.agentSessionId);
        const aggregate = aggregateByAgent.get(state.agentId) ?? {
          totalTokens: 0,
          totalCostUsd: 0,
        };
        aggregate.totalTokens += summary.totalTokens;
        aggregate.totalCostUsd += summary.totalCostUsd;
        aggregateByAgent.set(state.agentId, aggregate);
      }

      let workspaceTokens = 0;
      let workspaceCostUsd = 0;

      for (const agent of snapshot.agents) {
        const cost = aggregateByAgent.get(agent.agentId) ?? {
          totalTokens: 0,
          totalCostUsd: 0,
        };
        workspaceTokens += cost.totalTokens;
        workspaceCostUsd += cost.totalCostUsd;
        const focused = agent.isFocused ? " [focused]" : "";
        const deleted = agent.status === "deleted" ? " [deleted]" : "";
        const lastActive = agent.lastActiveAt ? ` lastActive=${agent.lastActiveAt}` : "";
        const model = agent.model ? ` model=${agent.model}` : "";
        lines.push(
          `- @${agent.agentId}${focused}${deleted}${model}${lastActive} tokens=${cost.totalTokens} cost=$${cost.totalCostUsd.toFixed(
            4,
          )}`,
        );
      }

      const runtimes = input.runtimeManager.listRuntimes();
      lines.push(
        `Runtime pool: live=${runtimes.length}/${input.runtimeManager.maxLiveRuntimes} idleTtlMs=${input.runtimeManager.idleRuntimeTtlMs}`,
      );
      lines.push(
        `Workspace active-session cost: tokens=${workspaceTokens} cost=$${workspaceCostUsd.toFixed(
          4,
        )} active_sessions=${input.listLiveSessions().length}`,
      );

      input.runtime.ops.channel.session.workspaceCostSummary({
        sessionId: input.recoveryWalScope,
        payload: {
          scopeKey,
          activeSessions: input.listLiveSessions().length,
          totalTokens: workspaceTokens,
          totalCostUsd: workspaceCostUsd,
        },
        skipTapeCheckpoint: true,
      });

      return lines.join("\n");
    },

    async resolveQuestionSurface(
      scopeKey: string,
      agentId: string,
    ): Promise<ChannelQuestionSurface | undefined> {
      const liveSession = input.openLiveSession(scopeKey, agentId);
      const questionRuntime = liveSession?.runtime ?? (await input.loadInspectionRuntime(agentId));
      const liveSessionId = liveSession?.agentSessionId;
      const sessionIds = Array.from(
        new Set([
          ...(liveSessionId ? [liveSessionId] : []),
          ...listChannelBoundSessionIds({
            runtime: questionRuntime,
            scopeKey,
            agentId,
          }),
        ]),
      );
      if (sessionIds.length === 0) {
        return undefined;
      }
      return {
        runtime: questionRuntime,
        sessionIds,
        liveSessionId,
      };
    },

    resolveApprovalTargetAgentId(scopeKey: string, requestId: string): string | undefined {
      const matchesReplayableRequest = (state: ChannelLiveSessionView): boolean => {
        if (!input.registry.isActive(state.agentId)) {
          return false;
        }
        return input.hasReplayableEffectCommitmentRequest(state.agentSessionId, requestId);
      };

      for (const state of input.listLiveSessions()) {
        if (state.scopeKey !== scopeKey) {
          continue;
        }
        if (matchesReplayableRequest(state)) {
          return state.agentId;
        }
      }

      for (const state of input.listLiveSessions()) {
        if (state.scopeKey === scopeKey) {
          continue;
        }
        if (matchesReplayableRequest(state)) {
          return state.agentId;
        }
      }
      return undefined;
    },

    async resolveApprovalTargetAgentIdDurably(
      scopeKey: string,
      requestId: string,
    ): Promise<string | undefined> {
      const liveAgentId = this.resolveApprovalTargetAgentId(scopeKey, requestId);
      if (liveAgentId) {
        return liveAgentId;
      }

      for (const agentId of listActiveAgentIdsForScope(scopeKey)) {
        const inspectionRuntime = await input.loadInspectionRuntime(agentId);
        for (const sessionId of listChannelBoundSessionIds({
          runtime: inspectionRuntime,
          scopeKey,
          agentId,
        })) {
          if (hasReplayableRequestInRuntime(inspectionRuntime, sessionId, requestId)) {
            return agentId;
          }
        }
      }

      return undefined;
    },
  };
}
