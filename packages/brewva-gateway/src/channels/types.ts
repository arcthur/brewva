import type { GoalCommand } from "@brewva/brewva-vocabulary/goal";
import type { PlanMapCommand } from "@brewva/brewva-vocabulary/plan-map";
import type { ManagedToolMode } from "@brewva/brewva-vocabulary/session";
import type { HostedRuntimeAdapterPort } from "../hosted/api.js";
import type { ChannelModeConfig } from "./launcher.js";
import type { RunChannelModeDependencies } from "./ports.js";

export interface RunChannelModeOptions {
  cwd?: string;
  configPath?: string;
  model?: string;
  agentId?: string;
  managedToolMode: ManagedToolMode;
  verbose: boolean;
  channel: string;
  channelConfig?: ChannelModeConfig;
  onRuntimeReady?: (runtime: HostedRuntimeAdapterPort) => void;
  shutdownSignal?: AbortSignal;
  dependencies?: RunChannelModeDependencies;
}

export type ChannelControlCommand =
  | { kind: "agents"; scopeKey: string }
  | {
      kind: "status";
      scopeKey: string;
      targetAgentId?: string;
      directory?: string;
      top?: number;
      details?: boolean;
    }
  | { kind: "goal"; scopeKey: string; targetAgentId?: string; command: GoalCommand }
  | { kind: "map"; scopeKey: string; targetAgentId?: string; command: PlanMapCommand }
  | {
      kind: "answer";
      scopeKey: string;
      targetAgentId?: string;
      questionId: string;
      answer: string;
    }
  | { kind: "update"; scopeKey: string; targetAgentId?: string; prompt?: string }
  | { kind: "steer"; scopeKey: string; targetAgentId?: string; prompt: string }
  | { kind: "focus"; scopeKey: string; agentId: string }
  | { kind: "agent-create"; scopeKey: string; agentId: string; model?: string }
  | { kind: "agent-delete"; scopeKey: string; agentId: string }
  | { kind: "run"; scopeKey: string; agentIds: string[]; task: string }
  | { kind: "discuss"; scopeKey: string; agentIds: string[]; topic: string; maxRounds?: number }
  | { kind: "route-agent"; scopeKey: string; agentId: string; task: string; viaMention: boolean };
