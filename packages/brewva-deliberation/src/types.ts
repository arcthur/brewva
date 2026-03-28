export const DELIBERATION_MEMORY_STATE_SCHEMA = "brewva.deliberation.memory.v2" as const;

export const DELIBERATION_MEMORY_ARTIFACT_KINDS = [
  "repository_strategy_memory",
  "user_collaboration_profile",
  "agent_capability_profile",
  "loop_memory",
] as const;

export type DeliberationMemoryArtifactKind = (typeof DELIBERATION_MEMORY_ARTIFACT_KINDS)[number];

export const DELIBERATION_MEMORY_SCOPE_VALUES = ["repository", "user", "agent", "loop"] as const;
export type DeliberationMemoryApplicabilityScope =
  (typeof DELIBERATION_MEMORY_SCOPE_VALUES)[number];

export const DELIBERATION_MEMORY_RETENTION_BANDS = ["hot", "warm", "cool"] as const;
export type DeliberationMemoryRetentionBand = (typeof DELIBERATION_MEMORY_RETENTION_BANDS)[number];

export interface DeliberationMemoryEvidenceRef {
  sessionId: string;
  eventId: string;
  eventType: string;
  timestamp: number;
}

export interface DeliberationMemoryRetentionSnapshot {
  retentionScore: number;
  retrievalBias: number;
  decayFactor: number;
  ageDays: number;
  evidenceCount: number;
  sessionSpan: number;
  band: DeliberationMemoryRetentionBand;
}

export interface DeliberationMemoryArtifact {
  id: string;
  kind: DeliberationMemoryArtifactKind;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  confidenceScore: number;
  firstCapturedAt: number;
  lastValidatedAt: number;
  applicabilityScope: DeliberationMemoryApplicabilityScope;
  sessionIds: string[];
  evidence: DeliberationMemoryEvidenceRef[];
  metadata?: Record<string, unknown> & {
    retention?: DeliberationMemoryRetentionSnapshot;
  };
}

export interface DeliberationMemorySessionDigest {
  sessionId: string;
  eventCount: number;
  lastEventAt: number;
}

export interface DeliberationMemoryState {
  schema: typeof DELIBERATION_MEMORY_STATE_SCHEMA;
  updatedAt: number;
  sessionDigests: DeliberationMemorySessionDigest[];
  artifacts: DeliberationMemoryArtifact[];
}

export interface DeliberationMemoryRetrieval {
  artifact: DeliberationMemoryArtifact;
  score: number;
}

export const OPTIMIZATION_CONTINUITY_STATE_SCHEMA = "brewva.deliberation.optimization.v1" as const;

export const OPTIMIZATION_LINEAGE_STATUS_VALUES = [
  "active",
  "scheduled",
  "waiting",
  "stuck",
  "converged",
  "escalated",
] as const;

export type OptimizationLineageStatus = (typeof OPTIMIZATION_LINEAGE_STATUS_VALUES)[number];

export type OptimizationEvidenceRef = DeliberationMemoryEvidenceRef;

export interface OptimizationMetricSnapshot {
  metricKey: string;
  direction?: string;
  unit?: string;
  aggregation?: string;
  minDelta?: number;
  baselineValue?: number;
  latestValue?: number;
  bestValue?: number;
  trend: "improving" | "flat" | "regressing" | "unknown";
  observationCount: number;
  lastObservedAt?: number;
}

export interface OptimizationGuardSnapshot {
  guardKey: string;
  lastStatus?: string;
  observationCount: number;
  lastObservedAt?: number;
  statusCounts: Record<string, number>;
}

export interface OptimizationContinuationSnapshot {
  nextOwner?: string;
  nextTrigger?: string;
  nextTiming?: string;
  nextObjective?: string;
  scheduleIntentId?: string;
  nextRunAt?: number;
  scheduled: boolean;
}

export interface OptimizationConvergenceSnapshot {
  status?: string;
  reasonCode?: string;
  summary?: string;
  observedAt?: number;
  shouldContinue?: boolean;
}

export interface OptimizationEscalationSnapshot {
  owner?: string;
  trigger?: string;
  active: boolean;
}

export interface OptimizationLineageArtifact {
  id: string;
  loopKey: string;
  goalRef: string;
  rootSessionId: string;
  goal?: string;
  summary: string;
  scope: string[];
  continuityMode?: string;
  status: OptimizationLineageStatus;
  runCount: number;
  lineageSessionIds: string[];
  sourceSkillNames: string[];
  latestRunKey?: string;
  latestIterationKey?: string;
  metric?: OptimizationMetricSnapshot;
  guard?: OptimizationGuardSnapshot;
  continuation?: OptimizationContinuationSnapshot;
  convergence?: OptimizationConvergenceSnapshot;
  escalation?: OptimizationEscalationSnapshot;
  firstObservedAt: number;
  lastObservedAt: number;
  evidence: OptimizationEvidenceRef[];
  metadata?: Record<string, unknown>;
}

export interface OptimizationContinuityState {
  schema: typeof OPTIMIZATION_CONTINUITY_STATE_SCHEMA;
  updatedAt: number;
  sessionDigests: DeliberationMemorySessionDigest[];
  lineages: OptimizationLineageArtifact[];
}

export interface OptimizationContinuityRetrieval {
  artifact: OptimizationLineageArtifact;
  score: number;
}
