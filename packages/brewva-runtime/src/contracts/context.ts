import type { RuntimeResult } from "./shared.js";
import type { ResourceBudgetLimits } from "./skill.js";

export interface ContextBudgetUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export type TapePressureLevel = "none" | "low" | "medium" | "high";

export type ContextPressureLevel = "none" | "low" | "medium" | "high" | "critical" | "unknown";

export type ContextCompactionReason = "usage_threshold" | "hard_limit";

export interface ContextPressureStatus {
  level: ContextPressureLevel;
  usageRatio: number | null;
  hardLimitRatio: number;
  compactionThresholdRatio: number;
}

export interface ContextCompactionGateStatus {
  required: boolean;
  reason: ContextCompactionReason | null;
  pressure: ContextPressureStatus;
  recentCompaction: boolean;
  windowTurns: number;
  lastCompactionTurn: number | null;
  turnsSinceCompaction: number | null;
}

export interface TapeAnchorState {
  id: string;
  name?: string;
  summary?: string;
  nextSteps?: string;
  turn?: number;
  timestamp: number;
}

export interface OutputSearchTelemetryState {
  recentCalls: number;
  singleQueryCalls: number;
  batchedCalls: number;
  throttledCalls: number;
  blockedCalls: number;
  totalQueries: number;
  totalResults: number;
  averageResultsPerQuery: number | null;
  cacheHits: number;
  cacheMisses: number;
  cacheHitRate: number | null;
  matchLayers: {
    exact: number;
    partial: number;
    fuzzy: number;
    none: number;
  };
  lastThrottleLevel: "normal" | "limited" | "blocked" | "unknown";
  lastTimestamp?: number;
}

export interface TapeStatusState {
  totalEntries: number;
  entriesSinceAnchor: number;
  entriesSinceCheckpoint: number;
  tapePressure: TapePressureLevel;
  thresholds: {
    low: number;
    medium: number;
    high: number;
  };
  lastAnchor?: TapeAnchorState;
  lastCheckpointId?: string;
  outputSearch?: OutputSearchTelemetryState;
}

export type TapeHandoffResult = RuntimeResult<
  {
    eventId: string;
    createdAt: number;
    tapeStatus: TapeStatusState;
  },
  "missing_name" | "event_store_disabled"
>;

export type TapeSearchScope = "current_phase" | "all_phases" | "anchors_only";

export interface TapeSearchMatch {
  eventId: string;
  type: string;
  turn?: number;
  timestamp: number;
  excerpt: string;
}

export interface TapeSearchResult {
  query: string;
  scope: TapeSearchScope;
  scannedEvents: number;
  totalEvents: number;
  matches: TapeSearchMatch[];
}

export interface ContextInjectionDecision {
  accepted: boolean;
  finalText: string;
  originalTokens: number;
  finalTokens: number;
  truncated: boolean;
  droppedReason?: "hard_limit";
}

export interface ContextCompactionDecision {
  shouldCompact: boolean;
  reason?: ContextCompactionReason;
  usage?: ContextBudgetUsage;
}

export interface ToolAccessResult {
  allowed: boolean;
  reason?: string;
  warning?: string;
}

export type ResourceLeaseBudget = ResourceBudgetLimits;

export interface ResourceLeaseRecord {
  id: string;
  sessionId: string;
  skillName: string;
  reason: string;
  budget: ResourceLeaseBudget;
  createdAt: number;
  expiresAt?: number;
  expiresAfterTurn?: number;
  status: "active" | "expired" | "cancelled";
  cancelledAt?: number;
  cancelledReason?: string;
}

export interface ResourceLeaseRequest {
  reason: string;
  budget?: ResourceLeaseBudget;
  ttlMs?: number;
  ttlTurns?: number;
}

export interface ResourceLeaseQuery {
  includeInactive?: boolean;
  skillName?: string;
}

export type ResourceLeaseResult = RuntimeResult<{ lease: ResourceLeaseRecord }>;

export type ResourceLeaseCancelResult = RuntimeResult<{ lease: ResourceLeaseRecord }>;

export interface ParallelAcquireResult {
  accepted: boolean;
  reason?:
    | "disabled"
    | "max_concurrent"
    | "max_total"
    | "skill_max_parallel"
    | "timeout"
    | "cancelled";
}
