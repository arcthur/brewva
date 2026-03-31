import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import { CHANNEL_SESSION_BOUND_EVENT_TYPE } from "@brewva/brewva-runtime";
import { AgentRegistry } from "./agent-registry.js";
import { AgentRuntimeManager } from "./agent-runtime-manager.js";
import type {
  ChannelLiveSessionView,
  ChannelRuntimeSessionPort,
  ChannelSessionCostSummary,
} from "./channel-session-coordinator.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export interface ChannelQuestionSurface {
  runtime: BrewvaRuntime;
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
}

export function createChannelSessionQueries(input: {
  runtime: BrewvaRuntime;
  registry: AgentRegistry;
  runtimeManager: AgentRuntimeManager;
  turnWalScope: string;
  listLiveSessions(): ChannelLiveSessionView[];
  openLiveSession(scopeKey: string, agentId: string): ChannelRuntimeSessionPort | undefined;
  loadInspectionRuntime(agentId: string): Promise<BrewvaRuntime>;
  getSessionCostSummary(sessionId: string): ChannelSessionCostSummary;
  hasReplayableEffectCommitmentRequest(sessionId: string, requestId: string): boolean;
}): ChannelSessionQueries {
  const listChannelBoundSessionIds = (options: {
    runtime: BrewvaRuntime;
    scopeKey: string;
    agentId: string;
  }): string[] => {
    const matches: Array<{ sessionId: string; boundAt: number }> = [];
    for (const sessionId of options.runtime.events.listSessionIds()) {
      const binding = options.runtime.events.query(sessionId, {
        type: CHANNEL_SESSION_BOUND_EVENT_TYPE,
        last: 1,
      })[0];
      if (!binding) {
        continue;
      }
      const payload = isRecord(binding.payload) ? binding.payload : null;
      const bindingScopeKey = readString(payload?.scopeKey);
      const bindingAgentId = readString(payload?.agentId);
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
        const cost = aggregateByAgent.get(agent.agentId) ?? { totalTokens: 0, totalCostUsd: 0 };
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

      input.runtime.events.record({
        sessionId: input.turnWalScope,
        type: "channel_workspace_cost_summary",
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
  };
}
