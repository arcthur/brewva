import type { BrewvaConfig } from "./config.js";
import type { SkillRoutingScope } from "./skill.js";

export type ManagedToolMode = "runtime_plugin" | "direct";

export interface CreateBrewvaSessionOptions {
  cwd?: string;
  configPath?: string;
  config?: BrewvaConfig;
  model?: string;
  agentId?: string;
  routingScopes?: SkillRoutingScope[];
  managedToolMode?: ManagedToolMode;
}

export interface SessionHydrationIssue {
  eventId: string;
  eventType: string;
  index: number;
  reason: string;
}

export interface SessionHydrationState {
  status: "cold" | "ready" | "degraded";
  latestEventId?: string;
  hydratedAt?: number;
  issues: SessionHydrationIssue[];
}
