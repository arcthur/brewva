import type { BrewvaConfig } from "./config.js";
import type { BrewvaToolCallId, BrewvaToolName } from "./identifiers.js";
import type { IntegrityIssue } from "./integrity.js";
import type { ActiveSkillRuntimeState, SkillCompletionFailureRecord } from "./skill.js";
import type { SkillRoutingScope } from "./skill.js";

export type ManagedToolMode = "runtime_plugin" | "direct";

export interface CreateBrewvaSessionOptions {
  cwd?: string;
  configPath?: string;
  config?: BrewvaConfig;
  model?: string;
  agentId?: string;
  routingScopes?: SkillRoutingScope[];
  routingDefaultScopes?: SkillRoutingScope[];
  managedToolMode?: ManagedToolMode;
}

export interface SessionHydrationState {
  status: "cold" | "ready" | "degraded";
  latestEventId?: string;
  hydratedAt?: number;
  issues: IntegrityIssue[];
}

export interface OpenToolCallRecord {
  toolCallId: BrewvaToolCallId;
  toolName: BrewvaToolName;
  openedAt: number;
  turn?: number;
  attempt?: number | null;
  eventId?: string;
}

export interface OpenTurnRecord {
  turn: number;
  startedAt: number;
  eventId?: string;
}

export type SessionUncleanShutdownReason =
  | "open_tool_calls_without_terminal_receipt"
  | "open_turn_without_terminal_receipt"
  | "active_skill_without_terminal_receipt";

export interface SessionUncleanShutdownDiagnostic {
  detectedAt: number;
  reasons: SessionUncleanShutdownReason[];
  openToolCalls: OpenToolCallRecord[];
  openTurns?: OpenTurnRecord[];
  activeSkill?: ActiveSkillRuntimeState;
  latestFailure?: SkillCompletionFailureRecord;
  latestEventType?: string;
  latestEventAt?: number;
}
