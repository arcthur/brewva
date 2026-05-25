import type { TurnEnvelope } from "@brewva/brewva-vocabulary/wire";
import type { HostedRuntimeAdapterPort } from "../ports.js";

export interface ChannelInspectCommandInput {
  directory?: string;
  turn: TurnEnvelope;
  scopeKey: string;
  focusedAgentId: string;
  targetAgentId: string;
  targetSession?: {
    agentId: string;
    runtime: HostedRuntimeAdapterPort;
    sessionId: string;
  };
}

export interface ChannelInspectCommandResult {
  text: string;
  meta?: Record<string, unknown>;
}

export interface ChannelInsightsCommandInput {
  directory?: string;
  turn: TurnEnvelope;
  scopeKey: string;
  focusedAgentId: string;
  targetAgentId: string;
  targetSession?: {
    agentId: string;
    runtime: HostedRuntimeAdapterPort;
    sessionId: string;
  };
}

export interface ChannelInsightsCommandResult {
  text: string;
  meta?: Record<string, unknown>;
}

export interface ChannelQuestionsCommandInput {
  turn: TurnEnvelope;
  scopeKey: string;
  focusedAgentId: string;
  targetAgentId: string;
  questionSurface?: {
    runtime: HostedRuntimeAdapterPort;
    sessionIds: string[];
    liveSessionId?: string;
  };
}

export interface ChannelQuestionsCommandResult {
  text: string;
  meta?: Record<string, unknown>;
}
