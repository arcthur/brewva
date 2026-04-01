import {
  CONTEXT_SOURCES,
  ITERATION_GUARD_RECORDED_EVENT_TYPE,
  ITERATION_METRIC_OBSERVED_EVENT_TYPE,
  SCHEDULE_EVENT_TYPE,
  SKILL_COMPLETED_EVENT_TYPE,
  coerceGuardResultPayload,
  coerceMetricObservationPayload,
  parseScheduleIntentEvent,
  type BrewvaEventRecord,
  type BrewvaRuntime,
  type ContextSourceProvider,
  type ScheduleIntentEventPayload,
} from "@brewva/brewva-runtime";
import { FileOptimizationContinuityStore } from "./optimization-store.js";
import {
  clamp,
  collectPlaneSessionDigests,
  samePlaneSessionDigests,
  shouldThrottlePlaneRefresh,
  tokenize,
  uniqueStrings,
} from "./plane-substrate.js";
import {
  OPTIMIZATION_CONTINUITY_STATE_SCHEMA,
  type DeliberationMemorySessionDigest,
  type OptimizationContinuityRetrieval,
  type OptimizationContinuityState,
  type OptimizationEvidenceRef,
  type OptimizationLineageArtifact,
  type OptimizationLineageStatus,
  type OptimizationMetricSnapshot,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RETRIEVAL = 2;
const GOAL_LOOP_PREFIX = "goal-loop:";
const OPTIMIZATION_RELEVANT_EVENT_TYPES = new Set([
  SKILL_COMPLETED_EVENT_TYPE,
  ITERATION_METRIC_OBSERVED_EVENT_TYPE,
  ITERATION_GUARD_RECORDED_EVENT_TYPE,
  SCHEDULE_EVENT_TYPE,
]);
const OPTIMIZATION_TRIGGER_TOKENS = new Set([
  "continue",
  "continuation",
  "converge",
  "convergence",
  "goal",
  "goal-loop",
  "guard",
  "iteration",
  "loop",
  "metric",
  "next",
  "optimize",
  "optimization",
  "retry",
  "schedule",
  "stuck",
]);

interface MetricObservationRecord {
  sessionId: string;
  eventId: string;
  timestamp: number;
  metricKey: string;
  value: number;
  unit?: string;
  aggregation?: string;
  source: string;
  iterationKey?: string;
}

interface GuardResultRecord {
  sessionId: string;
  eventId: string;
  timestamp: number;
  guardKey: string;
  status: string;
  source: string;
  iterationKey?: string;
}

interface ScheduleIntentRecord {
  sessionId: string;
  eventId: string;
  timestamp: number;
  payload: ScheduleIntentEventPayload;
}

interface GoalLoopSkillCompletion {
  sessionId: string;
  eventId: string;
  timestamp: number;
  skillName: string;
  loopKey: string;
  loopContract?: Record<string, unknown>;
  iterationReport?: Record<string, unknown>;
  convergenceReport?: Record<string, unknown>;
  continuationPlan?: Record<string, unknown>;
}

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

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => readString(entry) ?? "").filter((entry) => entry.length > 0);
}

function compactText(value: string, maxChars = 280): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(1, maxChars - 3))}...`;
}

function buildEvidence(event: {
  sessionId: string;
  eventId: string;
  timestamp: number;
  eventType: string;
}): OptimizationEvidenceRef {
  return {
    sessionId: event.sessionId,
    eventId: event.eventId,
    eventType: event.eventType,
    timestamp: event.timestamp,
  };
}

function dedupeEvidence(evidence: readonly OptimizationEvidenceRef[]): OptimizationEvidenceRef[] {
  const byKey = new Map<string, OptimizationEvidenceRef>();
  for (const entry of evidence) {
    byKey.set(`${entry.sessionId}:${entry.eventId}`, entry);
  }
  return [...byKey.values()].toSorted(
    (left, right) => right.timestamp - left.timestamp || left.eventId.localeCompare(right.eventId),
  );
}

function resolveLoopKeyFromSource(source: string | undefined): string | undefined {
  if (!source?.startsWith(GOAL_LOOP_PREFIX)) return undefined;
  return source.slice(GOAL_LOOP_PREFIX.length).trim() || undefined;
}

function readObjectField(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const candidate = value?.[key];
  return isRecord(candidate) ? candidate : undefined;
}

function readStringField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  return readString(value?.[key]);
}

function readNumberField(
  value: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  return readNumber(value?.[key]);
}

function summarizeUnknown(value: unknown, maxChars = 120): string | undefined {
  if (typeof value === "string") {
    return compactText(value, maxChars);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (!value) return undefined;
  try {
    return compactText(JSON.stringify(value), maxChars);
  } catch {
    return undefined;
  }
}

function deriveLoopKeyFromRunKey(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  const markerIndex = normalized.indexOf("/run-");
  if (markerIndex <= 0) return undefined;
  return normalized.slice(0, markerIndex).trim() || undefined;
}

function deriveLoopKeyFromIterationKey(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  if (normalized.endsWith("/baseline")) {
    const markerIndex = normalized.indexOf("/run-");
    if (markerIndex <= 0) return undefined;
    return normalized.slice(0, markerIndex).trim() || undefined;
  }
  const markerIndex = normalized.indexOf("/iter-");
  if (markerIndex <= 0) return undefined;
  return deriveLoopKeyFromRunKey(normalized.slice(0, markerIndex).trim());
}

interface LineageProgressKey {
  runIndex?: number;
  runLabel?: string;
  stageRank: number;
  stageIndex?: number;
  rawKey?: string;
}

function parseLineageProgressKey(input: {
  runKey?: string;
  iterationKey?: string;
}): LineageProgressKey | undefined {
  const iterationKey = readString(input.iterationKey);
  const runKey = readString(input.runKey);
  const source = iterationKey ?? runKey;
  if (!source) return undefined;

  const runMatch = source.match(/(?:^|\/)run-([^/]+)/);
  const runLabel = runMatch?.[1]?.trim();
  const runIndex = runLabel && /^\d+$/.test(runLabel) ? Number.parseInt(runLabel, 10) : undefined;

  if (iterationKey?.endsWith("/baseline")) {
    return {
      runIndex,
      runLabel,
      stageRank: 0,
      stageIndex: 0,
      rawKey: iterationKey,
    };
  }

  const iterationMatch = iterationKey?.match(/(?:^|\/)iter-(\d+)/);
  if (iterationMatch) {
    return {
      runIndex,
      runLabel,
      stageRank: 1,
      stageIndex: Number.parseInt(iterationMatch[1] ?? "0", 10),
      rawKey: iterationKey,
    };
  }

  if (iterationKey) {
    return {
      runIndex,
      runLabel,
      stageRank: 2,
      rawKey: iterationKey,
    };
  }

  return {
    runIndex,
    runLabel,
    stageRank: 3,
    rawKey: runKey,
  };
}

function compareLineageProgressKeys(
  left: LineageProgressKey | undefined,
  right: LineageProgressKey | undefined,
): number {
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;

  if (left.runIndex !== undefined || right.runIndex !== undefined) {
    if (left.runIndex === undefined) return 1;
    if (right.runIndex === undefined) return -1;
    if (left.runIndex !== right.runIndex) {
      return left.runIndex - right.runIndex;
    }
  }

  const runLabelCompare = (left.runLabel ?? "").localeCompare(right.runLabel ?? "");
  if (runLabelCompare !== 0) return runLabelCompare;

  if (left.stageRank !== right.stageRank) {
    return left.stageRank - right.stageRank;
  }

  const stageIndexCompare = (left.stageIndex ?? 0) - (right.stageIndex ?? 0);
  if (stageIndexCompare !== 0) return stageIndexCompare;

  return (left.rawKey ?? "").localeCompare(right.rawKey ?? "");
}

function compareRecordIdentity(
  left: { timestamp: number; eventId: string },
  right: { timestamp: number; eventId: string },
): number {
  return left.timestamp - right.timestamp || left.eventId.localeCompare(right.eventId);
}

function resolveLoopKeyFromGoalLoopOutputs(outputs: Record<string, unknown>): string | undefined {
  const loopContract = readObjectField(outputs, "loop_contract");
  const continuationPlan = readObjectField(outputs, "continuation_plan");
  const iterationReport = readObjectField(outputs, "iteration_report");
  const convergenceReport = readObjectField(outputs, "convergence_report");

  return (
    readStringField(loopContract, "loop_key") ??
    readStringField(continuationPlan, "loop_key") ??
    deriveLoopKeyFromIterationKey(readStringField(iterationReport, "iteration_key")) ??
    deriveLoopKeyFromRunKey(readStringField(iterationReport, "run_key")) ??
    deriveLoopKeyFromRunKey(readStringField(convergenceReport, "run_key"))
  );
}

function collectMetricRecords(events: readonly BrewvaEventRecord[]): MetricObservationRecord[] {
  const records: MetricObservationRecord[] = [];
  for (const event of events) {
    if (event.type !== ITERATION_METRIC_OBSERVED_EVENT_TYPE) continue;
    const payload = coerceMetricObservationPayload(event.payload);
    if (!payload) continue;
    const loopKey = resolveLoopKeyFromSource(payload.source);
    if (!loopKey) continue;
    records.push({
      sessionId: event.sessionId,
      eventId: event.id,
      timestamp: event.timestamp,
      metricKey: payload.metricKey,
      value: payload.value,
      unit: payload.unit,
      aggregation: payload.aggregation,
      source: `${GOAL_LOOP_PREFIX}${loopKey}`,
      iterationKey: payload.iterationKey,
    });
  }
  return records;
}

function collectGuardRecords(events: readonly BrewvaEventRecord[]): GuardResultRecord[] {
  const records: GuardResultRecord[] = [];
  for (const event of events) {
    if (event.type !== ITERATION_GUARD_RECORDED_EVENT_TYPE) continue;
    const payload = coerceGuardResultPayload(event.payload);
    if (!payload) continue;
    const loopKey = resolveLoopKeyFromSource(payload.source);
    if (!loopKey) continue;
    records.push({
      sessionId: event.sessionId,
      eventId: event.id,
      timestamp: event.timestamp,
      guardKey: payload.guardKey,
      status: payload.status,
      source: `${GOAL_LOOP_PREFIX}${loopKey}`,
      iterationKey: payload.iterationKey,
    });
  }
  return records;
}

function collectScheduleRecords(events: readonly BrewvaEventRecord[]): ScheduleIntentRecord[] {
  const records: ScheduleIntentRecord[] = [];
  for (const event of events) {
    if (event.type !== SCHEDULE_EVENT_TYPE) continue;
    const payload = parseScheduleIntentEvent(event);
    if (!payload) continue;
    const goalRef = readString(payload.goalRef);
    if (!resolveLoopKeyFromSource(goalRef)) continue;
    records.push({
      sessionId: event.sessionId,
      eventId: event.id,
      timestamp: event.timestamp,
      payload: {
        ...payload,
        goalRef,
      },
    });
  }
  return records;
}

function collectGoalLoopCompletions(
  events: readonly BrewvaEventRecord[],
): GoalLoopSkillCompletion[] {
  const records: GoalLoopSkillCompletion[] = [];
  for (const event of events) {
    if (event.type !== SKILL_COMPLETED_EVENT_TYPE) continue;
    if (!isRecord(event.payload)) continue;
    const skillName = readString(event.payload.skillName);
    const outputs = readObjectField(event.payload, "outputs");
    if (!skillName || !outputs) continue;
    if (skillName !== "goal-loop" && !outputs.loop_contract && !outputs.iteration_report) {
      continue;
    }
    const loopKey = resolveLoopKeyFromGoalLoopOutputs(outputs);
    if (!loopKey) continue;
    records.push({
      sessionId: event.sessionId,
      eventId: event.id,
      timestamp: event.timestamp,
      skillName,
      loopKey,
      loopContract: readObjectField(outputs, "loop_contract"),
      iterationReport: readObjectField(outputs, "iteration_report"),
      convergenceReport: readObjectField(outputs, "convergence_report"),
      continuationPlan: readObjectField(outputs, "continuation_plan"),
    });
  }
  return records;
}

function buildChildToParentMap(
  records: readonly ScheduleIntentRecord[],
): ReadonlyMap<string, string> {
  const mapping = new Map<string, string>();
  for (const record of records.toSorted((left, right) => left.timestamp - right.timestamp)) {
    if (record.payload.kind !== "intent_fired" || record.payload.continuityMode !== "inherit") {
      continue;
    }
    const childSessionId = readString(record.payload.childSessionId);
    if (!childSessionId) continue;
    mapping.set(childSessionId, record.payload.parentSessionId);
  }
  return mapping;
}

function resolveLineageRoot(sessionId: string, childToParent: ReadonlyMap<string, string>): string {
  const visited = new Set<string>();
  let current = sessionId;
  while (!visited.has(current)) {
    visited.add(current);
    const parent = childToParent.get(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return current;
}

function branchKey(goalRef: string, rootSessionId: string): string {
  return `${goalRef}::${rootSessionId}`;
}

function inferDirection(rawDirection: string | undefined): "increase" | "decrease" | "unknown" {
  const normalized = rawDirection?.trim().toLowerCase();
  if (!normalized) return "unknown";
  if (
    normalized.includes("increase") ||
    normalized.includes("improve") ||
    normalized.includes("maximize") ||
    normalized.includes("higher") ||
    normalized.includes("up")
  ) {
    return "increase";
  }
  if (
    normalized.includes("decrease") ||
    normalized.includes("minimize") ||
    normalized.includes("lower") ||
    normalized.includes("down")
  ) {
    return "decrease";
  }
  return "unknown";
}

function deriveBestMetricValue(
  values: readonly number[],
  direction: "increase" | "decrease" | "unknown",
): number | undefined {
  if (values.length === 0) return undefined;
  if (direction === "decrease") {
    return Math.min(...values);
  }
  return Math.max(...values);
}

function deriveMetricTrend(input: {
  direction?: string;
  baselineValue?: number;
  latestValue?: number;
  previousValue?: number;
  minDelta?: number;
}): OptimizationMetricSnapshot["trend"] {
  if (input.latestValue === undefined) return "unknown";
  const reference = input.previousValue ?? input.baselineValue;
  if (reference === undefined) return "unknown";
  const delta = input.latestValue - reference;
  const minDelta = Math.max(0, input.minDelta ?? 0);
  if (Math.abs(delta) <= minDelta) return "flat";
  const direction = inferDirection(input.direction);
  if (direction === "decrease") {
    return delta < 0 ? "improving" : "regressing";
  }
  return delta > 0 ? "improving" : "regressing";
}

function extractRunKey(value: Record<string, unknown> | undefined): string | undefined {
  return readStringField(value, "run_key");
}

function extractIterationKey(value: Record<string, unknown> | undefined): string | undefined {
  return readStringField(value, "iteration_key");
}

function extractIterationOutcome(value: Record<string, unknown> | undefined): string | undefined {
  return readStringField(value, "outcome");
}

function compareMetricRecords(
  left: MetricObservationRecord,
  right: MetricObservationRecord,
): number {
  return (
    compareLineageProgressKeys(
      parseLineageProgressKey({ iterationKey: left.iterationKey }),
      parseLineageProgressKey({ iterationKey: right.iterationKey }),
    ) || compareRecordIdentity(left, right)
  );
}

function compareGuardRecords(left: GuardResultRecord, right: GuardResultRecord): number {
  return (
    compareLineageProgressKeys(
      parseLineageProgressKey({ iterationKey: left.iterationKey }),
      parseLineageProgressKey({ iterationKey: right.iterationKey }),
    ) || compareRecordIdentity(left, right)
  );
}

function compareGoalLoopCompletions(
  left: GoalLoopSkillCompletion,
  right: GoalLoopSkillCompletion,
): number {
  return (
    compareLineageProgressKeys(
      parseLineageProgressKey({
        runKey: extractRunKey(left.iterationReport) ?? extractRunKey(left.convergenceReport),
        iterationKey: extractIterationKey(left.iterationReport),
      }),
      parseLineageProgressKey({
        runKey: extractRunKey(right.iterationReport) ?? extractRunKey(right.convergenceReport),
        iterationKey: extractIterationKey(right.iterationReport),
      }),
    ) || compareRecordIdentity(left, right)
  );
}

function compareScheduleIntentRecords(
  left: ScheduleIntentRecord,
  right: ScheduleIntentRecord,
): number {
  const leftRunIndex = readNumber(left.payload.runIndex);
  const rightRunIndex = readNumber(right.payload.runIndex);
  if (leftRunIndex !== undefined || rightRunIndex !== undefined) {
    if (leftRunIndex === undefined) return 1;
    if (rightRunIndex === undefined) return -1;
    if (leftRunIndex !== rightRunIndex) {
      return leftRunIndex - rightRunIndex;
    }
  }
  return compareRecordIdentity(left, right);
}

function extractContinuationSummary(
  continuationPlan: Record<string, unknown> | undefined,
  cadence: Record<string, unknown> | undefined,
  scheduleRecords: readonly ScheduleIntentRecord[],
): {
  nextOwner?: string;
  nextTrigger?: string;
  nextTiming?: string;
  nextObjective?: string;
  scheduleIntentId?: string;
  nextRunAt?: number;
  scheduled: boolean;
} {
  const nextSchedule = scheduleRecords.toReversed().find((record) => {
    if (record.payload.kind === "intent_cancelled" || record.payload.kind === "intent_converged") {
      return false;
    }
    return record.payload.nextRunAt !== undefined || record.payload.kind === "intent_created";
  });
  const nextTiming =
    readStringField(continuationPlan, "next_run_timing") ?? summarizeUnknown(cadence);
  const nextRunAt =
    readNumberField(continuationPlan, "next_run_at") ?? nextSchedule?.payload.nextRunAt;
  return {
    nextOwner: readStringField(continuationPlan, "next_owner"),
    nextTrigger: readStringField(continuationPlan, "next_run_trigger"),
    nextTiming,
    nextObjective: readStringField(continuationPlan, "next_run_objective"),
    scheduleIntentId:
      readStringField(continuationPlan, "schedule_intent_id") ?? nextSchedule?.payload.intentId,
    nextRunAt,
    scheduled: nextRunAt !== undefined,
  };
}

function deriveConvergenceSnapshot(input: {
  convergenceReport?: Record<string, unknown>;
  convergenceTimestamp?: number;
  continuationScheduled: boolean;
}): OptimizationLineageArtifact["convergence"] {
  const status = readStringField(input.convergenceReport, "status");
  const reasonCode = readStringField(input.convergenceReport, "reason_code");
  const summary =
    readStringField(input.convergenceReport, "metric_trajectory_summary") ??
    summarizeUnknown(input.convergenceReport, 220);
  if (!status && !reasonCode && !summary) {
    return undefined;
  }
  const statusText = `${status ?? ""} ${reasonCode ?? ""}`.toLowerCase();
  const shouldContinue =
    input.continuationScheduled ||
    statusText.includes("continue") ||
    statusText.includes("retry") ||
    statusText.includes("another_run");
  return {
    status,
    reasonCode,
    summary,
    observedAt: input.convergenceTimestamp,
    shouldContinue,
  };
}

function deriveEscalationSnapshot(input: {
  escalationPolicy?: Record<string, unknown>;
  convergence?: OptimizationLineageArtifact["convergence"];
}): OptimizationLineageArtifact["escalation"] {
  const owner = readStringField(input.escalationPolicy, "owner");
  const trigger =
    readStringField(input.escalationPolicy, "trigger") ?? input.convergence?.reasonCode;
  const convergenceText =
    `${input.convergence?.status ?? ""} ${input.convergence?.reasonCode ?? ""}`
      .toLowerCase()
      .trim();
  const active =
    convergenceText.includes("escalat") ||
    convergenceText.includes("blocked") ||
    convergenceText.includes("stuck");
  if (!owner && !trigger && !active) {
    return undefined;
  }
  return {
    owner,
    trigger,
    active,
  };
}

function deriveLineageStatus(input: {
  convergence?: OptimizationLineageArtifact["convergence"];
  continuation?: OptimizationLineageArtifact["continuation"];
  recentOutcomes: string[];
}): OptimizationLineageStatus {
  const convergenceText =
    `${input.convergence?.status ?? ""} ${input.convergence?.reasonCode ?? ""}`
      .toLowerCase()
      .trim();
  if (
    convergenceText.includes("converged") ||
    convergenceText.includes("done") ||
    convergenceText.includes("satisfied") ||
    convergenceText.includes("completed")
  ) {
    return "converged";
  }
  if (
    convergenceText.includes("escalat") ||
    convergenceText.includes("blocked") ||
    convergenceText.includes("manual")
  ) {
    return "escalated";
  }
  const stuckSignals = new Set([
    "no_improvement",
    "guard_regression",
    "below_noise_floor",
    "crash",
  ]);
  const trailingOutcomes = input.recentOutcomes.slice(-3);
  if (
    trailingOutcomes.length >= 3 &&
    trailingOutcomes.every((entry) => stuckSignals.has(entry.trim().toLowerCase()))
  ) {
    return "stuck";
  }
  if (input.continuation?.scheduled) {
    return "scheduled";
  }
  if (
    input.continuation?.nextOwner ||
    input.continuation?.nextTrigger ||
    input.convergence?.shouldContinue
  ) {
    return "waiting";
  }
  return "active";
}

function buildMetricSnapshot(input: {
  contract?: Record<string, unknown>;
  metrics: readonly MetricObservationRecord[];
}): OptimizationLineageArtifact["metric"] {
  const metricConfig = readObjectField(input.contract, "metric");
  const baselineConfig = readObjectField(input.contract, "baseline");
  const metricKey = readStringField(metricConfig, "key") ?? input.metrics.at(-1)?.metricKey;
  if (!metricKey) return undefined;
  const metricValues = input.metrics.map((entry) => entry.value);
  const direction = readStringField(metricConfig, "direction");
  const baselineValue = readNumberField(baselineConfig, "value") ?? input.metrics[0]?.value;
  const latestMetric = input.metrics.at(-1);
  const previousMetric = input.metrics.length > 1 ? input.metrics.at(-2) : undefined;
  return {
    metricKey,
    direction,
    unit: readStringField(metricConfig, "unit") ?? latestMetric?.unit,
    aggregation: readStringField(metricConfig, "aggregation") ?? latestMetric?.aggregation,
    minDelta: readNumberField(metricConfig, "min_delta"),
    baselineValue,
    latestValue: latestMetric?.value,
    bestValue: deriveBestMetricValue(metricValues, inferDirection(direction)),
    trend: deriveMetricTrend({
      direction,
      baselineValue,
      latestValue: latestMetric?.value,
      previousValue: previousMetric?.value,
      minDelta: readNumberField(metricConfig, "min_delta"),
    }),
    observationCount: input.metrics.length,
    lastObservedAt:
      input.metrics.length > 0
        ? Math.max(...input.metrics.map((entry) => entry.timestamp))
        : undefined,
  };
}

function buildGuardSnapshot(input: {
  contract?: Record<string, unknown>;
  guards: readonly GuardResultRecord[];
}): OptimizationLineageArtifact["guard"] {
  const guardConfig = readObjectField(input.contract, "guard");
  const guardKey = readStringField(guardConfig, "key") ?? input.guards.at(-1)?.guardKey;
  if (!guardKey) return undefined;
  const statusCounts: Record<string, number> = {};
  for (const guard of input.guards) {
    statusCounts[guard.status] = (statusCounts[guard.status] ?? 0) + 1;
  }
  const latestGuard = input.guards.at(-1);
  return {
    guardKey,
    lastStatus: latestGuard?.status,
    observationCount: input.guards.length,
    lastObservedAt:
      input.guards.length > 0
        ? Math.max(...input.guards.map((entry) => entry.timestamp))
        : undefined,
    statusCounts,
  };
}

function buildSummary(input: {
  loopKey: string;
  goal?: string;
  metric?: OptimizationLineageArtifact["metric"];
  guard?: OptimizationLineageArtifact["guard"];
  status: OptimizationLineageStatus;
  continuation?: OptimizationLineageArtifact["continuation"];
  convergence?: OptimizationLineageArtifact["convergence"];
}): string {
  const parts = [input.goal ?? `Loop ${input.loopKey}`];
  if (input.metric?.latestValue !== undefined) {
    const metricUnit = input.metric.unit ? ` ${input.metric.unit}` : "";
    parts.push(
      `${input.metric.metricKey}=${input.metric.latestValue}${metricUnit} (${input.metric.trend})`,
    );
  }
  if (input.guard?.lastStatus) {
    parts.push(`guard ${input.guard.guardKey}=${input.guard.lastStatus}`);
  }
  parts.push(`status=${input.status}`);
  if (input.continuation?.nextOwner || input.continuation?.nextTrigger) {
    parts.push(
      `next=${input.continuation.nextOwner ?? "unknown"} via ${input.continuation.nextTrigger ?? "unspecified"}`,
    );
  }
  if (input.continuation?.nextRunAt) {
    parts.push(`next_run_at=${new Date(input.continuation.nextRunAt).toISOString()}`);
  }
  if (input.convergence?.reasonCode) {
    parts.push(`reason=${input.convergence.reasonCode}`);
  }
  return compactText(parts.join(". "), 260);
}

function scoreStatus(status: OptimizationLineageStatus): number {
  switch (status) {
    case "stuck":
      return 1;
    case "scheduled":
      return 0.96;
    case "active":
      return 0.9;
    case "waiting":
      return 0.82;
    case "escalated":
      return 0.78;
    case "converged":
      return 0.45;
  }
}

function buildOptimizationLineages(
  runtime: OptimizationContinuityRuntime,
): OptimizationLineageArtifact[] {
  const metrics: MetricObservationRecord[] = [];
  const guards: GuardResultRecord[] = [];
  const schedules: ScheduleIntentRecord[] = [];
  const completions: GoalLoopSkillCompletion[] = [];

  for (const sessionId of runtime.events.listSessionIds()) {
    const events = runtime.events.list(sessionId);
    metrics.push(...collectMetricRecords(events));
    guards.push(...collectGuardRecords(events));
    schedules.push(...collectScheduleRecords(events));
    completions.push(...collectGoalLoopCompletions(events));
  }

  const childToParent = buildChildToParentMap(schedules);
  const grouped = new Map<
    string,
    {
      goalRef: string;
      rootSessionId: string;
      metrics: MetricObservationRecord[];
      guards: GuardResultRecord[];
      schedules: ScheduleIntentRecord[];
      completions: GoalLoopSkillCompletion[];
      lineageSessionIds: Set<string>;
      sourceSkillNames: Set<string>;
    }
  >();

  const ensureGroup = (goalRef: string, rootSessionId: string) => {
    const key = branchKey(goalRef, rootSessionId);
    const existing = grouped.get(key);
    if (existing) return existing;
    const created = {
      goalRef,
      rootSessionId,
      metrics: [],
      guards: [],
      schedules: [],
      completions: [],
      lineageSessionIds: new Set<string>([rootSessionId]),
      sourceSkillNames: new Set<string>(),
    };
    grouped.set(key, created);
    return created;
  };

  for (const metric of metrics) {
    const rootSessionId = resolveLineageRoot(metric.sessionId, childToParent);
    const group = ensureGroup(metric.source, rootSessionId);
    group.metrics.push(metric);
    group.lineageSessionIds.add(metric.sessionId);
  }

  for (const guard of guards) {
    const rootSessionId = resolveLineageRoot(guard.sessionId, childToParent);
    const group = ensureGroup(guard.source, rootSessionId);
    group.guards.push(guard);
    group.lineageSessionIds.add(guard.sessionId);
  }

  for (const completion of completions) {
    const goalRef = `${GOAL_LOOP_PREFIX}${completion.loopKey}`;
    const rootSessionId = resolveLineageRoot(completion.sessionId, childToParent);
    const group = ensureGroup(goalRef, rootSessionId);
    group.completions.push(completion);
    group.lineageSessionIds.add(completion.sessionId);
    group.sourceSkillNames.add(completion.skillName);
  }

  for (const schedule of schedules) {
    const goalRef = readString(schedule.payload.goalRef);
    if (!goalRef) continue;
    const childSessionId = readString(schedule.payload.childSessionId);
    const isFreshFiredBranch =
      schedule.payload.kind === "intent_fired" && schedule.payload.continuityMode === "fresh";
    const rootSessionId = isFreshFiredBranch
      ? resolveLineageRoot(childSessionId ?? schedule.sessionId, childToParent)
      : resolveLineageRoot(schedule.payload.parentSessionId, childToParent);
    const group = ensureGroup(goalRef, rootSessionId);
    group.schedules.push(schedule);
    if (!isFreshFiredBranch) {
      group.lineageSessionIds.add(schedule.payload.parentSessionId);
    }
    if (schedule.payload.continuityMode === "inherit" && childSessionId) {
      group.lineageSessionIds.add(childSessionId);
    }
    if (isFreshFiredBranch && childSessionId) {
      group.lineageSessionIds.add(childSessionId);
    }
  }

  const artifacts: OptimizationLineageArtifact[] = [];
  for (const group of grouped.values()) {
    const loopKey = resolveLoopKeyFromSource(group.goalRef);
    if (!loopKey) continue;
    const sortedMetrics = group.metrics.toSorted(compareMetricRecords);
    const sortedGuards = group.guards.toSorted(compareGuardRecords);
    const sortedSchedules = group.schedules.toSorted(compareScheduleIntentRecords);
    const sortedCompletions = group.completions.toSorted(compareGoalLoopCompletions);
    const latestContract = sortedCompletions
      .toReversed()
      .find((entry) => entry.loopContract)?.loopContract;
    const latestIterationReport = sortedCompletions
      .toReversed()
      .find((entry) => entry.iterationReport)?.iterationReport;
    const latestConvergenceRecord = sortedCompletions
      .toReversed()
      .find((entry) => entry.convergenceReport);
    const latestContinuationPlan = sortedCompletions
      .toReversed()
      .find((entry) => entry.continuationPlan)?.continuationPlan;

    const continuation = extractContinuationSummary(
      latestContinuationPlan,
      readObjectField(latestContract, "cadence"),
      sortedSchedules,
    );
    const convergence = deriveConvergenceSnapshot({
      convergenceReport: latestConvergenceRecord?.convergenceReport,
      convergenceTimestamp: latestConvergenceRecord?.timestamp,
      continuationScheduled: continuation.scheduled,
    });
    const escalation = deriveEscalationSnapshot({
      escalationPolicy: readObjectField(latestContract, "escalation_policy"),
      convergence,
    });
    const recentOutcomes = sortedCompletions
      .map((entry) => extractIterationOutcome(entry.iterationReport))
      .filter((entry): entry is string => Boolean(entry));
    const status = deriveLineageStatus({
      convergence,
      continuation,
      recentOutcomes,
    });
    const metric = buildMetricSnapshot({
      contract: latestContract,
      metrics: sortedMetrics,
    });
    const guard = buildGuardSnapshot({
      contract: latestContract,
      guards: sortedGuards,
    });
    const evidence = dedupeEvidence([
      ...sortedMetrics.map((entry) =>
        buildEvidence({
          sessionId: entry.sessionId,
          eventId: entry.eventId,
          timestamp: entry.timestamp,
          eventType: ITERATION_METRIC_OBSERVED_EVENT_TYPE,
        }),
      ),
      ...sortedGuards.map((entry) =>
        buildEvidence({
          sessionId: entry.sessionId,
          eventId: entry.eventId,
          timestamp: entry.timestamp,
          eventType: ITERATION_GUARD_RECORDED_EVENT_TYPE,
        }),
      ),
      ...sortedSchedules.map((entry) =>
        buildEvidence({
          sessionId: entry.sessionId,
          eventId: entry.eventId,
          timestamp: entry.timestamp,
          eventType: SCHEDULE_EVENT_TYPE,
        }),
      ),
      ...sortedCompletions.map((entry) =>
        buildEvidence({
          sessionId: entry.sessionId,
          eventId: entry.eventId,
          timestamp: entry.timestamp,
          eventType: SKILL_COMPLETED_EVENT_TYPE,
        }),
      ),
    ]);
    const timestamps = evidence.map((entry) => entry.timestamp);
    const runKeys = uniqueStrings(
      sortedCompletions
        .map(
          (entry) => extractRunKey(entry.iterationReport) ?? extractRunKey(entry.convergenceReport),
        )
        .filter((entry): entry is string => Boolean(entry)),
    );
    const scheduleRunCount = Math.max(
      0,
      ...sortedSchedules.map((entry) => readNumber(entry.payload.runIndex) ?? 0),
    );
    const runCount = Math.max(
      runKeys.length,
      scheduleRunCount,
      sortedMetrics.length > 0 || sortedCompletions.length > 0 ? 1 : 0,
    );
    artifacts.push({
      id: `opt:${loopKey}:${group.rootSessionId}`,
      loopKey,
      goalRef: group.goalRef,
      rootSessionId: group.rootSessionId,
      goal: readStringField(latestContract, "goal"),
      summary: buildSummary({
        loopKey,
        goal: readStringField(latestContract, "goal"),
        metric,
        guard,
        status,
        continuation,
        convergence,
      }),
      scope: readStringArray(latestContract?.scope),
      continuityMode:
        readStringField(latestContract, "continuity_mode") ??
        sortedSchedules.at(-1)?.payload.continuityMode,
      status,
      runCount,
      lineageSessionIds: [...group.lineageSessionIds].toSorted(),
      sourceSkillNames: [...group.sourceSkillNames].toSorted(),
      latestRunKey:
        extractRunKey(latestIterationReport) ??
        extractRunKey(latestConvergenceRecord?.convergenceReport),
      latestIterationKey:
        extractIterationKey(latestIterationReport) ?? sortedMetrics.at(-1)?.iterationKey,
      metric,
      guard,
      continuation,
      convergence,
      escalation,
      firstObservedAt: Math.min(...timestamps),
      lastObservedAt: Math.max(...timestamps),
      evidence: evidence.slice(0, 24),
      metadata: {
        stuckSignalCount: recentOutcomes
          .slice(-3)
          .filter((entry) =>
            ["no_improvement", "guard_regression", "below_noise_floor", "crash"].includes(
              entry.trim().toLowerCase(),
            ),
          ).length,
        latestIterationOutcome: recentOutcomes.at(-1) ?? null,
        nextRunAt: continuation.nextRunAt ?? null,
      },
    });
  }
  return artifacts.toSorted(
    (left, right) =>
      scoreStatus(right.status) - scoreStatus(left.status) ||
      right.lastObservedAt - left.lastObservedAt ||
      left.id.localeCompare(right.id),
  );
}

function createEmptyOptimizationState(
  sessionDigests: readonly DeliberationMemorySessionDigest[] = [],
): OptimizationContinuityState {
  return {
    schema: OPTIMIZATION_CONTINUITY_STATE_SCHEMA,
    updatedAt: Date.now(),
    sessionDigests: [...sessionDigests],
    lineages: [],
  };
}

export function retrieveOptimizationContinuityArtifacts(input: {
  state: OptimizationContinuityState;
  promptText: string;
  now?: number;
  limit?: number;
}): OptimizationContinuityRetrieval[] {
  const now = input.now ?? Date.now();
  const queryTokens = new Set(tokenize(input.promptText));
  const scored = input.state.lineages.map((artifact) => {
    const haystack = tokenize(
      [
        artifact.loopKey,
        artifact.goalRef,
        artifact.goal ?? "",
        artifact.summary,
        artifact.status,
        artifact.scope.join(" "),
        artifact.metric?.metricKey ?? "",
        artifact.guard?.guardKey ?? "",
        artifact.continuation?.nextOwner ?? "",
        artifact.continuation?.nextTrigger ?? "",
      ].join(" "),
    );
    const haystackSet = new Set(haystack);
    const lexicalScore =
      queryTokens.size === 0
        ? 0.55
        : [...queryTokens].filter((token) => haystackSet.has(token)).length / queryTokens.size;
    const ageDays = Math.max(0, now - artifact.lastObservedAt) / DAY_MS;
    const recencyScore = clamp(1 - ageDays / 60, 0.3, 1);
    return {
      artifact,
      score: lexicalScore * 0.5 + recencyScore * 0.25 + scoreStatus(artifact.status) * 0.25,
    };
  });
  return scored
    .toSorted(
      (left, right) =>
        right.score - left.score || left.artifact.id.localeCompare(right.artifact.id),
    )
    .slice(0, Math.max(1, input.limit ?? DEFAULT_MAX_RETRIEVAL));
}

function shouldInjectOptimizationLineages(
  promptText: string,
  lineages: readonly OptimizationLineageArtifact[],
): boolean {
  const tokens = new Set(tokenize(promptText));
  for (const token of tokens) {
    if (OPTIMIZATION_TRIGGER_TOKENS.has(token)) {
      return true;
    }
  }
  return lineages.some((entry) => entry.status === "scheduled" || entry.status === "stuck");
}

function renderContextLineage(lineage: OptimizationLineageArtifact): string {
  const lines = [
    "[OptimizationContinuity]",
    `lineage_id: ${lineage.id}`,
    `loop_key: ${lineage.loopKey}`,
    `status: ${lineage.status}`,
  ];
  if (lineage.goal) {
    lines.push(`goal: ${lineage.goal}`);
  }
  if (lineage.metric?.latestValue !== undefined) {
    const metricUnit = lineage.metric.unit ? ` ${lineage.metric.unit}` : "";
    lines.push(
      `metric: ${lineage.metric.metricKey} latest=${lineage.metric.latestValue}${metricUnit} trend=${lineage.metric.trend}`,
    );
  }
  if (lineage.guard?.lastStatus) {
    lines.push(`guard: ${lineage.guard.guardKey} last=${lineage.guard.lastStatus}`);
  }
  if (lineage.continuation?.nextOwner || lineage.continuation?.nextTrigger) {
    lines.push(
      `continuation: owner=${lineage.continuation.nextOwner ?? "unknown"} trigger=${lineage.continuation.nextTrigger ?? "unspecified"}`,
    );
  }
  if (lineage.continuation?.nextRunAt) {
    lines.push(`next_run_at: ${new Date(lineage.continuation.nextRunAt).toISOString()}`);
  }
  lines.push(`summary: ${lineage.summary}`);
  return lines.join("\n");
}

const planeByRuntime = new WeakMap<object, OptimizationContinuityPlane>();

export type OptimizationContinuityRuntime = Pick<BrewvaRuntime, "workspaceRoot" | "events">;

export class OptimizationContinuityPlane {
  private readonly runtime: OptimizationContinuityRuntime;
  private readonly store: FileOptimizationContinuityStore;
  private readonly minRefreshIntervalMs: number;
  private state: OptimizationContinuityState | undefined;
  private dirty = true;

  constructor(
    runtime: OptimizationContinuityRuntime,
    options: {
      workspaceRoot?: string;
      minRefreshIntervalMs?: number;
    } = {},
  ) {
    this.runtime = runtime;
    this.store = new FileOptimizationContinuityStore(
      options.workspaceRoot ?? runtime.workspaceRoot,
    );
    this.minRefreshIntervalMs = Math.max(0, options.minRefreshIntervalMs ?? 0);
    this.state = this.store.read();
    this.runtime.events.subscribe((event) => {
      if (OPTIMIZATION_RELEVANT_EVENT_TYPES.has(event.type)) {
        this.dirty = true;
      }
    });
  }

  getState(): OptimizationContinuityState {
    return this.sync();
  }

  getCachedState(): OptimizationContinuityState {
    return this.state ?? createEmptyOptimizationState();
  }

  sync(): OptimizationContinuityState {
    return this.reconcile();
  }

  list(
    options: {
      status?: OptimizationLineageStatus;
      loopKey?: string;
      limit?: number;
    } = {},
  ): OptimizationLineageArtifact[] {
    return this.filterLineages(this.sync().lineages, options);
  }

  listCached(
    options: {
      status?: OptimizationLineageStatus;
      loopKey?: string;
      limit?: number;
    } = {},
  ): OptimizationLineageArtifact[] {
    return this.filterLineages(this.state?.lineages ?? [], options);
  }

  getLineage(lineageId: string): OptimizationLineageArtifact | undefined {
    const normalizedId = lineageId.trim();
    if (!normalizedId) return undefined;
    return this.sync().lineages.find((lineage) => lineage.id === normalizedId);
  }

  getLineageCached(lineageId: string): OptimizationLineageArtifact | undefined {
    const normalizedId = lineageId.trim();
    if (!normalizedId) return undefined;
    return this.state?.lineages.find((lineage) => lineage.id === normalizedId);
  }

  getLineagesByLoopKey(loopKey: string): OptimizationLineageArtifact[] {
    const normalizedLoopKey = loopKey.trim();
    if (!normalizedLoopKey) return [];
    return this.sync().lineages.filter((lineage) => lineage.loopKey === normalizedLoopKey);
  }

  retrieve(promptText: string, limit = DEFAULT_MAX_RETRIEVAL): OptimizationContinuityRetrieval[] {
    return retrieveOptimizationContinuityArtifacts({
      state: this.sync(),
      promptText,
      limit,
    });
  }

  retrieveCached(
    promptText: string,
    limit = DEFAULT_MAX_RETRIEVAL,
  ): OptimizationContinuityRetrieval[] {
    if (!this.state) return [];
    return retrieveOptimizationContinuityArtifacts({
      state: this.state,
      promptText,
      limit,
    });
  }

  private filterLineages(
    lineages: readonly OptimizationLineageArtifact[],
    options: {
      status?: OptimizationLineageStatus;
      loopKey?: string;
      limit?: number;
    },
  ): OptimizationLineageArtifact[] {
    return lineages
      .filter((lineage) => !options.status || lineage.status === options.status)
      .filter((lineage) => !options.loopKey || lineage.loopKey === options.loopKey)
      .slice(0, Math.max(1, options.limit ?? lineages.length));
  }

  private reconcile(): OptimizationContinuityState {
    const now = Date.now();
    const sessionDigests = collectPlaneSessionDigests(this.runtime.events);
    const current = this.store.read() ?? this.state;
    const hasState = Boolean(current);
    const digestsChanged =
      !hasState ||
      !samePlaneSessionDigests(
        current?.sessionDigests ?? [],
        sessionDigests as DeliberationMemorySessionDigest[],
      );
    if (!digestsChanged && !this.dirty) {
      this.state = current;
      return current ?? createEmptyOptimizationState(sessionDigests);
    }
    if (
      current &&
      shouldThrottlePlaneRefresh({
        currentUpdatedAt: current.updatedAt,
        dirty: this.dirty,
        digestsChanged,
        minRefreshIntervalMs: this.minRefreshIntervalMs,
        now,
      })
    ) {
      this.state = current;
      return current;
    }

    const nextState: OptimizationContinuityState = {
      schema: OPTIMIZATION_CONTINUITY_STATE_SCHEMA,
      updatedAt: now,
      sessionDigests,
      lineages: buildOptimizationLineages(this.runtime),
    };
    this.store.write(nextState);
    this.state = nextState;
    this.dirty = false;
    return nextState;
  }
}

export function getOrCreateOptimizationContinuityPlane(
  runtime: OptimizationContinuityRuntime,
  options: {
    workspaceRoot?: string;
    minRefreshIntervalMs?: number;
  } = {},
): OptimizationContinuityPlane {
  const key = runtime as unknown as object;
  const existing = planeByRuntime.get(key);
  if (existing) {
    return existing;
  }
  const created = new OptimizationContinuityPlane(runtime, options);
  planeByRuntime.set(key, created);
  return created;
}

export function createOptimizationContinuityContextProvider(input: {
  runtime: BrewvaRuntime;
  maxLineages?: number;
  minRefreshIntervalMs?: number;
}): ContextSourceProvider {
  const plane = getOrCreateOptimizationContinuityPlane(input.runtime, {
    minRefreshIntervalMs: input.minRefreshIntervalMs,
  });
  return {
    source: CONTEXT_SOURCES.optimizationContinuity,
    category: "narrative",
    budgetClass: "recall",
    order: 17,
    collect: (providerInput) => {
      const lineages = plane.list({
        limit: Math.max(1, input.maxLineages ?? DEFAULT_MAX_RETRIEVAL),
      });
      if (!shouldInjectOptimizationLineages(providerInput.promptText, lineages)) {
        return;
      }
      const retrievals = plane.retrieve(providerInput.promptText, input.maxLineages);
      for (const retrieval of retrievals) {
        providerInput.register({
          id: retrieval.artifact.id,
          content: renderContextLineage(retrieval.artifact),
        });
      }
    },
  };
}
