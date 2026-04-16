import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileAtomic } from "./plane-substrate.js";
import {
  OPTIMIZATION_CONTINUITY_MODE_VALUES,
  OPTIMIZATION_CONTINUITY_STATE_SCHEMA,
  OPTIMIZATION_LINEAGE_STATUS_VALUES,
  OPTIMIZATION_METRIC_DIRECTION_VALUES,
  type DeliberationMemorySessionDigest,
  type OptimizationContinuityState,
  type OptimizationConvergenceSnapshot,
  type OptimizationContinuationSnapshot,
  type OptimizationEscalationSnapshot,
  type OptimizationEvidenceRef,
  type OptimizationGuardSnapshot,
  type OptimizationLineageArtifact,
  type OptimizationLineageMetadata,
  type OptimizationMetricSnapshot,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readNullableString(value: unknown): string | null | undefined {
  return value === null ? null : readString(value);
}

function readNullableNumber(value: unknown): number | null | undefined {
  return value === null ? null : readNumber(value);
}

function readLiteral<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const normalized = readString(value);
  return normalized && allowed.includes(normalized as T) ? (normalized as T) : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => readString(entry) ?? "").filter((entry) => entry.length > 0);
}

function readEvidence(value: unknown): OptimizationEvidenceRef | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = readString(value.sessionId);
  const eventId = readString(value.eventId);
  const eventType = readString(value.eventType);
  const timestamp = readNumber(value.timestamp);
  if (!sessionId || !eventId || !eventType || timestamp === undefined) {
    return undefined;
  }
  return {
    sessionId,
    eventId,
    eventType,
    timestamp,
  };
}

function readSessionDigest(value: unknown): DeliberationMemorySessionDigest | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = readString(value.sessionId);
  const eventCount = readNumber(value.eventCount);
  const lastEventAt = readNumber(value.lastEventAt);
  if (!sessionId || eventCount === undefined || lastEventAt === undefined) {
    return undefined;
  }
  return {
    sessionId,
    eventCount,
    lastEventAt,
  };
}

function readMetric(value: unknown): OptimizationMetricSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const metricKey = readString(value.metricKey);
  const trend = readString(value.trend);
  const observationCount = readNumber(value.observationCount);
  if (!metricKey || observationCount === undefined) {
    return undefined;
  }
  return {
    metricKey,
    direction: readLiteral(value.direction, OPTIMIZATION_METRIC_DIRECTION_VALUES) ?? "unknown",
    unit: readString(value.unit),
    aggregation: readString(value.aggregation),
    minDelta: readNumber(value.minDelta),
    baselineValue: readNumber(value.baselineValue),
    latestValue: readNumber(value.latestValue),
    bestValue: readNumber(value.bestValue),
    trend:
      trend === "improving" || trend === "flat" || trend === "regressing" || trend === "unknown"
        ? trend
        : "unknown",
    observationCount,
    lastObservedAt: readNumber(value.lastObservedAt),
  };
}

function readLineageMetadata(value: unknown): OptimizationLineageMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const metadata: OptimizationLineageMetadata = {
    stuckSignalCount: readNumber(value.stuckSignalCount) ?? 0,
  };
  const latestIterationOutcome = readNullableString(value.latestIterationOutcome);
  if (latestIterationOutcome !== undefined) {
    metadata.latestIterationOutcome = latestIterationOutcome;
  }
  const nextRunAt = readNullableNumber(value.nextRunAt);
  if (nextRunAt !== undefined) {
    metadata.nextRunAt = nextRunAt;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function readGuard(value: unknown): OptimizationGuardSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const guardKey = readString(value.guardKey);
  const observationCount = readNumber(value.observationCount);
  if (!guardKey || observationCount === undefined) {
    return undefined;
  }
  const rawStatusCounts = isRecord(value.statusCounts) ? value.statusCounts : {};
  const statusCounts: Record<string, number> = {};
  for (const [status, count] of Object.entries(rawStatusCounts)) {
    const normalizedStatus = readString(status);
    const normalizedCount = readNumber(count);
    if (!normalizedStatus || normalizedCount === undefined) continue;
    statusCounts[normalizedStatus] = normalizedCount;
  }
  return {
    guardKey,
    lastStatus: readString(value.lastStatus),
    observationCount,
    lastObservedAt: readNumber(value.lastObservedAt),
    statusCounts,
  };
}

function readContinuation(value: unknown): OptimizationContinuationSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const scheduled = readBoolean(value.scheduled);
  if (scheduled === undefined) return undefined;
  return {
    nextOwner: readString(value.nextOwner),
    nextTrigger: readString(value.nextTrigger),
    nextTiming: readString(value.nextTiming),
    nextObjective: readString(value.nextObjective),
    scheduleIntentId: readString(value.scheduleIntentId),
    nextRunAt: readNumber(value.nextRunAt),
    scheduled,
  };
}

function readConvergence(value: unknown): OptimizationConvergenceSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  return {
    status: readString(value.status),
    reasonCode: readString(value.reasonCode),
    summary: readString(value.summary),
    observedAt: readNumber(value.observedAt),
    shouldContinue: readBoolean(value.shouldContinue),
  };
}

function readEscalation(value: unknown): OptimizationEscalationSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const active = readBoolean(value.active);
  if (active === undefined) return undefined;
  return {
    owner: readString(value.owner),
    trigger: readString(value.trigger),
    active,
  };
}

function readLineage(value: unknown): OptimizationLineageArtifact | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value.id);
  const loopKey = readString(value.loopKey);
  const goalRef = readString(value.goalRef);
  const rootSessionId = readString(value.rootSessionId);
  const summary = readString(value.summary);
  const status = readLiteral(value.status, OPTIMIZATION_LINEAGE_STATUS_VALUES);
  const runCount = readNumber(value.runCount);
  const firstObservedAt = readNumber(value.firstObservedAt);
  const lastObservedAt = readNumber(value.lastObservedAt);
  if (
    !id ||
    !loopKey ||
    !goalRef ||
    !rootSessionId ||
    !summary ||
    !status ||
    runCount === undefined ||
    firstObservedAt === undefined ||
    lastObservedAt === undefined
  ) {
    return undefined;
  }
  const evidence = Array.isArray(value.evidence)
    ? value.evidence
        .map((entry) => readEvidence(entry))
        .filter((entry): entry is OptimizationEvidenceRef => Boolean(entry))
    : [];
  return {
    id,
    loopKey,
    goalRef,
    rootSessionId,
    goal: readString(value.goal),
    summary,
    scope: readStringArray(value.scope),
    continuityMode: readLiteral(value.continuityMode, OPTIMIZATION_CONTINUITY_MODE_VALUES),
    status,
    runCount,
    lineageSessionIds: readStringArray(value.lineageSessionIds),
    sourceSkillNames: readStringArray(value.sourceSkillNames),
    latestRunKey: readString(value.latestRunKey),
    latestIterationKey: readString(value.latestIterationKey),
    metric: readMetric(value.metric),
    guard: readGuard(value.guard),
    continuation: readContinuation(value.continuation),
    convergence: readConvergence(value.convergence),
    escalation: readEscalation(value.escalation),
    firstObservedAt,
    lastObservedAt,
    evidence,
    metadata: readLineageMetadata(value.metadata),
  };
}

function normalizeState(value: unknown): OptimizationContinuityState | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schema !== OPTIMIZATION_CONTINUITY_STATE_SCHEMA) return undefined;
  const updatedAt = readNumber(value.updatedAt);
  if (updatedAt === undefined) return undefined;
  const sessionDigests = Array.isArray(value.sessionDigests)
    ? value.sessionDigests
        .map((entry) => readSessionDigest(entry))
        .filter((entry): entry is DeliberationMemorySessionDigest => Boolean(entry))
    : [];
  const lineages = Array.isArray(value.lineages)
    ? value.lineages
        .map((entry) => readLineage(entry))
        .filter((entry): entry is OptimizationLineageArtifact => Boolean(entry))
    : [];
  return {
    schema: OPTIMIZATION_CONTINUITY_STATE_SCHEMA,
    updatedAt,
    sessionDigests,
    lineages,
  };
}

export function resolveOptimizationContinuityStatePath(workspaceRoot: string): string {
  return resolve(workspaceRoot, ".brewva", "deliberation", "optimization-state.json");
}

export class FileOptimizationContinuityStore {
  readonly filePath: string;

  constructor(workspaceRoot: string) {
    this.filePath = resolveOptimizationContinuityStatePath(workspaceRoot);
  }

  read(): OptimizationContinuityState | undefined {
    if (!existsSync(this.filePath)) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as unknown;
      return normalizeState(parsed);
    } catch {
      return undefined;
    }
  }

  write(state: OptimizationContinuityState): void {
    writeFileAtomic(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}
