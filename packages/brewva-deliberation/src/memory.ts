import { createHash } from "node:crypto";
import type { TaskSpec, TruthState, WorkflowArtifact } from "@brewva/brewva-runtime";
import {
  CONTEXT_SOURCES,
  ITERATION_GUARD_RECORDED_EVENT_TYPE,
  ITERATION_METRIC_OBSERVED_EVENT_TYPE,
  SKILL_COMPLETED_EVENT_TYPE,
  TASK_EVENT_TYPE,
  TRUTH_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  coerceGuardResultPayload,
  coerceTaskLedgerPayload,
  coerceTruthLedgerPayload,
  coerceMetricObservationPayload,
  deriveWorkflowArtifacts,
  foldTruthLedgerEvents,
  type BrewvaEventRecord,
  type BrewvaRuntime,
  type ContextSourceProvider,
} from "@brewva/brewva-runtime";
import { FileDeliberationMemoryStore } from "./file-store.js";
import {
  clamp,
  collectPlaneSessionDigests,
  samePlaneSessionDigests,
  shouldThrottlePlaneRefresh,
  tokenize,
  uniqueStrings,
} from "./plane-substrate.js";
import {
  DELIBERATION_MEMORY_STATE_SCHEMA,
  type DeliberationMemoryArtifact,
  type DeliberationMemoryEvidenceRef,
  type DeliberationMemoryRetentionSnapshot,
  type DeliberationMemoryRetrieval,
  type DeliberationMemorySessionDigest,
  type DeliberationMemoryState,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_RETRIEVAL = 6;
const DELIBERATION_MEMORY_MAX_ARTIFACTS = 12;
const DELIBERATION_MEMORY_RETENTION_PER_KIND_CAP: Record<
  DeliberationMemoryArtifact["kind"],
  number
> = {
  repository_strategy_memory: 3,
  user_collaboration_profile: 1,
  agent_capability_profile: 1,
  loop_memory: 8,
};
const DELIBERATION_MEMORY_MIN_RETENTION_SCORE: Record<DeliberationMemoryArtifact["kind"], number> =
  {
    repository_strategy_memory: 0.28,
    user_collaboration_profile: 0.42,
    agent_capability_profile: 0.4,
    loop_memory: 0.3,
  };
const DELIBERATION_MEMORY_RELEVANT_EVENT_TYPES = new Set([
  SKILL_COMPLETED_EVENT_TYPE,
  ITERATION_METRIC_OBSERVED_EVENT_TYPE,
  ITERATION_GUARD_RECORDED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  TASK_EVENT_TYPE,
  TRUTH_EVENT_TYPE,
]);

export interface MetricObservationRecord {
  sessionId: string;
  eventId: string;
  timestamp: number;
  metricKey: string;
  value: number;
  source: string;
  iterationKey?: string;
  summary?: string;
  evidenceRefs: string[];
}

export interface GuardResultRecord {
  sessionId: string;
  eventId: string;
  timestamp: number;
  guardKey: string;
  status: string;
  source: string;
  iterationKey?: string;
  summary?: string;
  evidenceRefs: string[];
}

export interface SkillCompletionRecord {
  sessionId: string;
  eventId: string;
  timestamp: number;
  skillName: string;
  outputs: Record<string, unknown>;
}

export interface VerificationOutcomeRecord {
  sessionId: string;
  eventId: string;
  timestamp: number;
  outcome: string;
  level?: string;
  failedChecks: string[];
  activeSkill?: string;
  rootCause?: string;
}

export interface TaskSpecObservation {
  sessionId: string;
  eventId: string;
  timestamp: number;
  spec: TaskSpec;
}

export interface SessionMemoryInput {
  sessionId: string;
  targetRoots: string[];
  events: BrewvaEventRecord[];
  workflowArtifacts: WorkflowArtifact[];
  taskSpecs: TaskSpecObservation[];
  truthState: TruthState;
  metricRecords: MetricObservationRecord[];
  guardRecords: GuardResultRecord[];
  skillCompletions: SkillCompletionRecord[];
  verificationOutcomes: VerificationOutcomeRecord[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
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

function titleCaseKind(kind: WorkflowArtifact["kind"]): string {
  return kind
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function renderFrequencyMap(values: ReadonlyMap<string, number>, limit = 4): string[] {
  return [...values.entries()]
    .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value, count]) => `${value} (${count})`);
}

function bumpFrequency(map: Map<string, number>, value: string | undefined): void {
  const normalized = value?.trim();
  if (!normalized) return;
  map.set(normalized, (map.get(normalized) ?? 0) + 1);
}

function dedupeEvidence(
  evidence: readonly DeliberationMemoryEvidenceRef[],
): DeliberationMemoryEvidenceRef[] {
  const byKey = new Map<string, DeliberationMemoryEvidenceRef>();
  for (const entry of evidence) {
    byKey.set(`${entry.sessionId}:${entry.eventId}`, entry);
  }
  return [...byKey.values()].toSorted(
    (left, right) => right.timestamp - left.timestamp || left.eventId.localeCompare(right.eventId),
  );
}

function createArtifact(input: {
  id: string;
  kind: DeliberationMemoryArtifact["kind"];
  title: string;
  summary: string;
  content: string;
  tags?: readonly string[];
  confidenceScore: number;
  firstCapturedAt: number;
  lastValidatedAt: number;
  applicabilityScope: DeliberationMemoryArtifact["applicabilityScope"];
  sessionIds: readonly string[];
  evidence: readonly DeliberationMemoryEvidenceRef[];
  metadata?: Record<string, unknown>;
}): DeliberationMemoryArtifact {
  return {
    id: input.id,
    kind: input.kind,
    title: compactText(input.title, 120),
    summary: compactText(input.summary, 220),
    content: compactText(input.content, 900),
    tags: uniqueStrings(input.tags ?? []).slice(0, 12),
    confidenceScore: clamp(input.confidenceScore, 0, 1),
    firstCapturedAt: input.firstCapturedAt,
    lastValidatedAt: input.lastValidatedAt,
    applicabilityScope: input.applicabilityScope,
    sessionIds: uniqueStrings(input.sessionIds),
    evidence: dedupeEvidence(input.evidence).slice(0, 16),
    metadata: input.metadata,
  };
}

function hashRepositoryRoot(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 12);
}

function resolveScopeRetentionBias(
  scope: DeliberationMemoryArtifact["applicabilityScope"],
): number {
  switch (scope) {
    case "repository":
      return 1;
    case "user":
      return 0.94;
    case "agent":
      return 0.92;
    case "loop":
      return 0.86;
    default:
      return 0.85;
  }
}

function resolveKindRetentionBias(kind: DeliberationMemoryArtifact["kind"]): number {
  switch (kind) {
    case "repository_strategy_memory":
      return 1;
    case "user_collaboration_profile":
      return 0.95;
    case "agent_capability_profile":
      return 0.93;
    case "loop_memory":
      return 0.84;
    default:
      return 0.85;
  }
}

export function resolveDeliberationMemoryRetentionSnapshot(input: {
  artifact: DeliberationMemoryArtifact;
  now?: number;
}): DeliberationMemoryRetentionSnapshot {
  const now = input.now ?? Date.now();
  const artifact = input.artifact;
  const ageDays = Math.max(0, now - artifact.lastValidatedAt) / DAY_MS;
  const decayFactor =
    artifact.kind === "loop_memory"
      ? clamp(1 - ageDays / 180, 0.22, 1)
      : clamp(1 - ageDays / 240, 0.28, 1);
  const evidenceCount = artifact.evidence.length;
  const evidenceScore = clamp(evidenceCount / 10, 0.24, 1);
  const sessionSpan = artifact.sessionIds.length;
  const sessionScore = clamp(sessionSpan / 4, 0.3, 1);
  const scopeBias = resolveScopeRetentionBias(artifact.applicabilityScope);
  const kindBias = resolveKindRetentionBias(artifact.kind);
  const retentionScore = clamp(
    artifact.confidenceScore * 0.36 +
      decayFactor * 0.24 +
      evidenceScore * 0.16 +
      sessionScore * 0.12 +
      scopeBias * 0.07 +
      kindBias * 0.05,
    0,
    1,
  );
  const retrievalBias = clamp(retentionScore * 0.7 + scopeBias * 0.2 + kindBias * 0.1, 0, 1);
  const band = retentionScore >= 0.78 ? "hot" : retentionScore >= 0.58 ? "warm" : "cool";
  return {
    retentionScore,
    retrievalBias,
    decayFactor,
    ageDays,
    evidenceCount,
    sessionSpan,
    band,
  };
}

function annotateArtifactRetention(
  artifact: DeliberationMemoryArtifact,
  now: number,
): DeliberationMemoryArtifact {
  const retention = resolveDeliberationMemoryRetentionSnapshot({
    artifact,
    now,
  });
  return {
    ...artifact,
    metadata: {
      ...artifact.metadata,
      retention,
    },
  };
}

function readRetention(
  artifact: DeliberationMemoryArtifact,
  now: number,
): DeliberationMemoryRetentionSnapshot {
  return (
    artifact.metadata?.retention ?? resolveDeliberationMemoryRetentionSnapshot({ artifact, now })
  );
}

function pruneDeliberationMemoryArtifacts(
  artifacts: readonly DeliberationMemoryArtifact[],
  now: number,
): DeliberationMemoryArtifact[] {
  const annotated = artifacts.map((artifact) => annotateArtifactRetention(artifact, now));
  const selected: DeliberationMemoryArtifact[] = [];
  const kindCounts = new Map<DeliberationMemoryArtifact["kind"], number>();

  for (const artifact of annotated.toSorted((left, right) => {
    const leftRetention = readRetention(left, now);
    const rightRetention = readRetention(right, now);
    return (
      rightRetention.retentionScore - leftRetention.retentionScore ||
      right.lastValidatedAt - left.lastValidatedAt
    );
  })) {
    const count = kindCounts.get(artifact.kind) ?? 0;
    if (count >= DELIBERATION_MEMORY_RETENTION_PER_KIND_CAP[artifact.kind]) {
      continue;
    }
    const retention = readRetention(artifact, now);
    const minScore = DELIBERATION_MEMORY_MIN_RETENTION_SCORE[artifact.kind];
    if (count > 0 && retention.retentionScore < minScore) {
      continue;
    }
    selected.push(artifact);
    kindCounts.set(artifact.kind, count + 1);
    if (selected.length >= DELIBERATION_MEMORY_MAX_ARTIFACTS) {
      break;
    }
  }

  return selected.toSorted((left, right) => {
    const leftRetention = readRetention(left, now);
    const rightRetention = readRetention(right, now);
    return (
      rightRetention.retentionScore - leftRetention.retentionScore ||
      right.lastValidatedAt - left.lastValidatedAt
    );
  });
}

function collectTaskSpecs(events: readonly BrewvaEventRecord[]): TaskSpecObservation[] {
  const result: TaskSpecObservation[] = [];
  for (const event of events) {
    if (event.type !== TASK_EVENT_TYPE) continue;
    const payload = coerceTaskLedgerPayload(event.payload);
    if (!payload || payload.kind !== "spec_set") continue;
    result.push({
      sessionId: event.sessionId,
      eventId: event.id,
      timestamp: event.timestamp,
      spec: payload.spec,
    });
  }
  return result;
}

function collectMetricRecords(events: readonly BrewvaEventRecord[]): MetricObservationRecord[] {
  const records: MetricObservationRecord[] = [];
  for (const event of events) {
    if (event.type !== ITERATION_METRIC_OBSERVED_EVENT_TYPE) continue;
    const payload = coerceMetricObservationPayload(event.payload);
    if (!payload) continue;
    records.push({
      sessionId: event.sessionId,
      eventId: event.id,
      timestamp: event.timestamp,
      metricKey: payload.metricKey,
      value: payload.value,
      source: payload.source,
      iterationKey: payload.iterationKey,
      summary: payload.summary,
      evidenceRefs: payload.evidenceRefs,
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
    records.push({
      sessionId: event.sessionId,
      eventId: event.id,
      timestamp: event.timestamp,
      guardKey: payload.guardKey,
      status: payload.status,
      source: payload.source,
      iterationKey: payload.iterationKey,
      summary: payload.summary,
      evidenceRefs: payload.evidenceRefs,
    });
  }
  return records;
}

function collectSkillCompletions(events: readonly BrewvaEventRecord[]): SkillCompletionRecord[] {
  const result: SkillCompletionRecord[] = [];
  for (const event of events) {
    if (event.type !== SKILL_COMPLETED_EVENT_TYPE) continue;
    if (!isRecord(event.payload)) continue;
    const skillName = readString(event.payload.skillName);
    const outputs = isRecord(event.payload.outputs) ? event.payload.outputs : undefined;
    if (!skillName || !outputs) continue;
    result.push({
      sessionId: event.sessionId,
      eventId: event.id,
      timestamp: event.timestamp,
      skillName,
      outputs,
    });
  }
  return result;
}

function collectVerificationOutcomes(
  events: readonly BrewvaEventRecord[],
): VerificationOutcomeRecord[] {
  const result: VerificationOutcomeRecord[] = [];
  for (const event of events) {
    if (event.type !== VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE) continue;
    if (!isRecord(event.payload)) continue;
    const outcome = readString(event.payload.outcome);
    if (!outcome) continue;
    result.push({
      sessionId: event.sessionId,
      eventId: event.id,
      timestamp: event.timestamp,
      outcome,
      level: readString(event.payload.level),
      failedChecks: readStringArray(event.payload.failedChecks),
      activeSkill: readString(event.payload.activeSkill),
      rootCause: readString(event.payload.rootCause),
    });
  }
  return result;
}

function buildSessionMemoryInput(
  sessionId: string,
  events: BrewvaEventRecord[],
  targetRoots: readonly string[] = [],
): SessionMemoryInput {
  const truthEvents = events.filter((event) => {
    if (event.type !== TRUTH_EVENT_TYPE) return false;
    return Boolean(coerceTruthLedgerPayload(event.payload));
  });
  return {
    sessionId,
    targetRoots: [...targetRoots],
    events,
    workflowArtifacts: deriveWorkflowArtifacts(events),
    taskSpecs: collectTaskSpecs(events),
    truthState: foldTruthLedgerEvents(truthEvents),
    metricRecords: collectMetricRecords(events),
    guardRecords: collectGuardRecords(events),
    skillCompletions: collectSkillCompletions(events),
    verificationOutcomes: collectVerificationOutcomes(events),
  };
}

export type DeliberationMemoryRuntime = Pick<BrewvaRuntime, "workspaceRoot" | "events" | "task">;

function buildRepositoryWorkingContract(
  repositoryRoot: string,
  sessions: readonly SessionMemoryInput[],
): DeliberationMemoryArtifact | undefined {
  const taskSpecs = sessions.flatMap((session) => session.taskSpecs);
  if (taskSpecs.length === 0) {
    return undefined;
  }

  const verificationLevels = new Map<string, number>();
  const verificationCommands = new Map<string, number>();
  const constraints = new Map<string, number>();
  const targetFiles = new Map<string, number>();

  for (const entry of taskSpecs) {
    bumpFrequency(verificationLevels, entry.spec.verification?.level);
    for (const command of entry.spec.verification?.commands ?? []) {
      bumpFrequency(verificationCommands, command);
    }
    for (const constraint of entry.spec.constraints ?? []) {
      bumpFrequency(constraints, constraint);
    }
    for (const file of entry.spec.targets?.files ?? []) {
      bumpFrequency(targetFiles, file);
    }
  }

  const verificationLevelPreview = renderFrequencyMap(verificationLevels, 3);
  const verificationCommandPreview = renderFrequencyMap(verificationCommands, 4);
  const constraintPreview = renderFrequencyMap(constraints, 4);
  const targetFilePreview = renderFrequencyMap(targetFiles, 4);

  const sessionIds = uniqueStrings(taskSpecs.map((entry) => entry.sessionId));
  const evidence = taskSpecs.map((entry) => ({
    sessionId: entry.sessionId,
    eventId: entry.eventId,
    eventType: TASK_EVENT_TYPE,
    timestamp: entry.timestamp,
  }));
  const summaryParts: string[] = [];
  if (verificationLevelPreview.length > 0) {
    summaryParts.push(`Verification posture: ${verificationLevelPreview.join(", ")}.`);
  }
  if (verificationCommandPreview.length > 0) {
    summaryParts.push(`Common commands: ${verificationCommandPreview.join(", ")}.`);
  }
  if (constraintPreview.length > 0) {
    summaryParts.push(`Recurring constraints: ${constraintPreview.join(", ")}.`);
  }
  const summary = summaryParts.join(" ");
  if (!summary) {
    return undefined;
  }

  const lines = [
    `Observed across ${taskSpecs.length} task spec${taskSpecs.length === 1 ? "" : "s"} in ${sessionIds.length} session${sessionIds.length === 1 ? "" : "s"}.`,
  ];
  if (verificationLevelPreview.length > 0) {
    lines.push(`Verification levels: ${verificationLevelPreview.join(", ")}.`);
  }
  if (verificationCommandPreview.length > 0) {
    lines.push(`Verification commands: ${verificationCommandPreview.join(", ")}.`);
  }
  if (constraintPreview.length > 0) {
    lines.push(`Repeated constraints: ${constraintPreview.join(", ")}.`);
  }
  if (targetFilePreview.length > 0) {
    lines.push(`Frequent target files: ${targetFilePreview.join(", ")}.`);
  }

  return createArtifact({
    id: `repository-working-contract:${hashRepositoryRoot(repositoryRoot)}`,
    kind: "repository_strategy_memory",
    title: "Repository Working Contract",
    summary,
    content: [`Repository root: ${repositoryRoot}.`, ...lines].join(" "),
    tags: [
      ...verificationLevelPreview,
      ...verificationCommandPreview,
      ...constraintPreview,
      ...targetFilePreview,
    ],
    confidenceScore: 0.58 + Math.min(0.28, sessionIds.length * 0.06),
    firstCapturedAt: Math.min(...taskSpecs.map((entry) => entry.timestamp)),
    lastValidatedAt: Math.max(...taskSpecs.map((entry) => entry.timestamp)),
    applicabilityScope: "repository",
    sessionIds,
    evidence,
    metadata: {
      repositoryRoot,
      taskSpecCount: taskSpecs.length,
    },
  });
}

function buildRecentWorkflowSignal(
  repositoryRoot: string,
  sessions: readonly SessionMemoryInput[],
): DeliberationMemoryArtifact | undefined {
  const candidates = sessions
    .flatMap((session) => session.workflowArtifacts)
    .filter(
      (artifact) =>
        artifact.freshness === "fresh" &&
        (artifact.kind === "design" ||
          artifact.kind === "execution_plan" ||
          artifact.kind === "review" ||
          artifact.kind === "verification" ||
          artifact.kind === "retro" ||
          artifact.kind === "implementation"),
    )
    .toSorted((left, right) => right.producedAt - left.producedAt)
    .slice(0, 5);
  if (candidates.length === 0) {
    return undefined;
  }
  const lines = candidates.map(
    (artifact) => `${titleCaseKind(artifact.kind)}: ${compactText(artifact.summary, 180)}`,
  );
  return createArtifact({
    id: `repository-recent-workflow-signals:${hashRepositoryRoot(repositoryRoot)}`,
    kind: "repository_strategy_memory",
    title: "Recent Repository Strategy Signals",
    summary: lines.slice(0, 2).join(" "),
    content: [`Repository root: ${repositoryRoot}.`, ...lines].join(" "),
    tags: candidates.flatMap((artifact) => [artifact.kind, ...artifact.sourceSkillNames]),
    confidenceScore: 0.52 + Math.min(0.2, candidates.length * 0.05),
    firstCapturedAt: Math.min(...candidates.map((artifact) => artifact.producedAt)),
    lastValidatedAt: Math.max(...candidates.map((artifact) => artifact.producedAt)),
    applicabilityScope: "repository",
    sessionIds: uniqueStrings(candidates.map((artifact) => artifact.sessionId)),
    evidence: candidates.flatMap((artifact) =>
      artifact.sourceEventIds.map((eventId) => ({
        sessionId: artifact.sessionId,
        eventId,
        eventType: "workflow_artifact",
        timestamp: artifact.producedAt,
      })),
    ),
    metadata: {
      repositoryRoot,
    },
  });
}

function groupSessionsByRepositoryRoot(
  sessions: readonly SessionMemoryInput[],
): Map<string, SessionMemoryInput[]> {
  const grouped = new Map<string, SessionMemoryInput[]>();
  for (const session of sessions) {
    const roots = session.targetRoots.length > 0 ? session.targetRoots : ["(unknown)"];
    for (const root of roots) {
      const current = grouped.get(root) ?? [];
      current.push(session);
      grouped.set(root, current);
    }
  }
  return grouped;
}

function buildRepositoryArtifacts(
  sessions: readonly SessionMemoryInput[],
): DeliberationMemoryArtifact[] {
  const grouped = groupSessionsByRepositoryRoot(sessions);
  const artifacts: DeliberationMemoryArtifact[] = [];
  for (const [repositoryRoot, repositorySessions] of grouped.entries()) {
    const contract = buildRepositoryWorkingContract(repositoryRoot, repositorySessions);
    if (contract) {
      artifacts.push(contract);
    }
    const workflowSignal = buildRecentWorkflowSignal(repositoryRoot, repositorySessions);
    if (workflowSignal) {
      artifacts.push(workflowSignal);
    }
  }
  return artifacts;
}

function buildUserCollaborationProfile(
  sessions: readonly SessionMemoryInput[],
): DeliberationMemoryArtifact | undefined {
  const taskSpecs = sessions.flatMap((session) => session.taskSpecs);
  if (taskSpecs.length < 2) {
    return undefined;
  }
  const verificationHeavy = taskSpecs.filter((entry) => {
    const commands = entry.spec.verification?.commands ?? [];
    return Boolean(entry.spec.verification?.level) || commands.length > 0;
  }).length;
  const constrained = taskSpecs.filter((entry) => (entry.spec.constraints?.length ?? 0) > 0).length;
  const targeted = taskSpecs.filter((entry) => {
    const files = entry.spec.targets?.files ?? [];
    const symbols = entry.spec.targets?.symbols ?? [];
    return files.length > 0 || symbols.length > 0;
  }).length;

  const preferenceLines: string[] = [];
  if (verificationHeavy > 0) {
    preferenceLines.push(
      `Explicit verification expectations appeared in ${verificationHeavy}/${taskSpecs.length} task specs.`,
    );
  }
  if (constrained > 0) {
    preferenceLines.push(
      `Hard constraints were carried in ${constrained}/${taskSpecs.length} task specs.`,
    );
  }
  if (targeted > 0) {
    preferenceLines.push(
      `Scoped file or symbol targets appeared in ${targeted}/${taskSpecs.length} task specs.`,
    );
  }
  if (preferenceLines.length === 0) {
    return undefined;
  }

  return createArtifact({
    id: "user-collaboration-profile",
    kind: "user_collaboration_profile",
    title: "User Collaboration Profile",
    summary: preferenceLines.join(" "),
    content: `Observed collaboration preferences across recent task specs. ${preferenceLines.join(" ")}`,
    tags: ["verification", "constraints", "scoped-work"],
    confidenceScore:
      0.54 + Math.min(0.22, uniqueStrings(taskSpecs.map((entry) => entry.sessionId)).length * 0.05),
    firstCapturedAt: Math.min(...taskSpecs.map((entry) => entry.timestamp)),
    lastValidatedAt: Math.max(...taskSpecs.map((entry) => entry.timestamp)),
    applicabilityScope: "user",
    sessionIds: uniqueStrings(taskSpecs.map((entry) => entry.sessionId)),
    evidence: taskSpecs.map((entry) => ({
      sessionId: entry.sessionId,
      eventId: entry.eventId,
      eventType: TASK_EVENT_TYPE,
      timestamp: entry.timestamp,
    })),
  });
}

function buildAgentCapabilityProfile(
  sessions: readonly SessionMemoryInput[],
): DeliberationMemoryArtifact | undefined {
  const skillCompletions = sessions.flatMap((session) => session.skillCompletions);
  const verificationOutcomes = sessions.flatMap((session) => session.verificationOutcomes);
  if (skillCompletions.length === 0 && verificationOutcomes.length === 0) {
    return undefined;
  }

  const skills = new Map<string, number>();
  for (const completion of skillCompletions) {
    bumpFrequency(skills, completion.skillName);
  }
  const failedChecks = new Map<string, number>();
  let verificationPasses = 0;
  let verificationFails = 0;
  for (const outcome of verificationOutcomes) {
    if (outcome.outcome === "pass") {
      verificationPasses += 1;
    } else if (outcome.outcome === "fail") {
      verificationFails += 1;
    }
    for (const check of outcome.failedChecks) {
      bumpFrequency(failedChecks, check);
    }
  }

  const skillPreview = renderFrequencyMap(skills, 4);
  const failurePreview = renderFrequencyMap(failedChecks, 4);
  const summaryParts: string[] = [];
  if (skillPreview.length > 0) {
    summaryParts.push(`Recent completed skills: ${skillPreview.join(", ")}.`);
  }
  summaryParts.push(
    `Verification outcomes: pass=${verificationPasses}, fail=${verificationFails}.`,
  );
  if (failurePreview.length > 0) {
    summaryParts.push(`Common failed checks: ${failurePreview.join(", ")}.`);
  }

  const timestamps = [
    ...skillCompletions.map((entry) => entry.timestamp),
    ...verificationOutcomes.map((entry) => entry.timestamp),
  ];
  return createArtifact({
    id: "agent-capability-profile",
    kind: "agent_capability_profile",
    title: "Agent Capability Profile",
    summary: summaryParts.join(" "),
    content: summaryParts.join(" "),
    tags: [...skillPreview, ...failurePreview],
    confidenceScore:
      0.5 +
      Math.min(
        0.25,
        uniqueStrings([
          ...skillCompletions.map((entry) => entry.sessionId),
          ...verificationOutcomes.map((entry) => entry.sessionId),
        ]).length * 0.05,
      ),
    firstCapturedAt: Math.min(...timestamps),
    lastValidatedAt: Math.max(...timestamps),
    applicabilityScope: "agent",
    sessionIds: uniqueStrings([
      ...skillCompletions.map((entry) => entry.sessionId),
      ...verificationOutcomes.map((entry) => entry.sessionId),
    ]),
    evidence: [
      ...skillCompletions.map((entry) => ({
        sessionId: entry.sessionId,
        eventId: entry.eventId,
        eventType: SKILL_COMPLETED_EVENT_TYPE,
        timestamp: entry.timestamp,
      })),
      ...verificationOutcomes.map((entry) => ({
        sessionId: entry.sessionId,
        eventId: entry.eventId,
        eventType: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
        timestamp: entry.timestamp,
      })),
    ],
  });
}

function resolveLoopKey(source: string, iterationKey?: string): string | undefined {
  if (source.startsWith("goal-loop:")) {
    return source.slice("goal-loop:".length).trim() || undefined;
  }
  if (iterationKey && iterationKey.includes("/run-")) {
    return iterationKey.slice(0, iterationKey.indexOf("/run-")).trim() || undefined;
  }
  return undefined;
}

function buildLoopMemories(sessions: readonly SessionMemoryInput[]): DeliberationMemoryArtifact[] {
  const groups = new Map<
    string,
    {
      metrics: MetricObservationRecord[];
      guards: GuardResultRecord[];
    }
  >();

  for (const metric of sessions.flatMap((session) => session.metricRecords)) {
    const loopKey = resolveLoopKey(metric.source, metric.iterationKey);
    if (!loopKey) continue;
    const group = groups.get(loopKey) ?? { metrics: [], guards: [] };
    group.metrics.push(metric);
    groups.set(loopKey, group);
  }
  for (const guard of sessions.flatMap((session) => session.guardRecords)) {
    const loopKey = resolveLoopKey(guard.source, guard.iterationKey);
    if (!loopKey) continue;
    const group = groups.get(loopKey) ?? { metrics: [], guards: [] };
    group.guards.push(guard);
    groups.set(loopKey, group);
  }

  return [...groups.entries()]
    .map(([loopKey, group]) => {
      const metrics = group.metrics.toSorted((left, right) => left.timestamp - right.timestamp);
      const guards = group.guards.toSorted((left, right) => left.timestamp - right.timestamp);
      if (metrics.length === 0 && guards.length === 0) {
        return undefined;
      }
      const primaryMetric = metrics[0];
      const latestMetric = metrics[metrics.length - 1];
      const latestGuard = guards[guards.length - 1];
      const summaryParts: string[] = [];
      if (primaryMetric && latestMetric) {
        summaryParts.push(
          `Metric ${primaryMetric.metricKey} moved ${primaryMetric.value} -> ${latestMetric.value}.`,
        );
      }
      if (latestGuard) {
        summaryParts.push(`Latest guard ${latestGuard.guardKey}=${latestGuard.status}.`);
      }
      const notePreview = uniqueStrings(
        metrics
          .map((entry) => entry.summary ?? "")
          .concat(guards.map((entry) => entry.summary ?? "")),
      )
        .slice(0, 3)
        .map((entry) => compactText(entry, 160));
      if (notePreview.length > 0) {
        summaryParts.push(`Recent notes: ${notePreview.join(" | ")}.`);
      }
      const evidence = [
        ...metrics.map((entry) => ({
          sessionId: entry.sessionId,
          eventId: entry.eventId,
          eventType: ITERATION_METRIC_OBSERVED_EVENT_TYPE,
          timestamp: entry.timestamp,
        })),
        ...guards.map((entry) => ({
          sessionId: entry.sessionId,
          eventId: entry.eventId,
          eventType: ITERATION_GUARD_RECORDED_EVENT_TYPE,
          timestamp: entry.timestamp,
        })),
      ];
      const timestamps = evidence.map((entry) => entry.timestamp);
      return createArtifact({
        id: `loop:${loopKey}`,
        kind: "loop_memory",
        title: `Loop Memory: ${loopKey}`,
        summary: summaryParts.join(" "),
        content: summaryParts.join(" "),
        tags: [
          loopKey,
          ...uniqueStrings(metrics.map((entry) => entry.metricKey)),
          ...uniqueStrings(guards.map((entry) => entry.guardKey)),
        ],
        confidenceScore:
          0.58 +
          Math.min(0.24, Math.max(metrics.length, guards.length) * 0.04) +
          (guards.length > 0 ? 0.05 : 0),
        firstCapturedAt: Math.min(...timestamps),
        lastValidatedAt: Math.max(...timestamps),
        applicabilityScope: "loop",
        sessionIds: uniqueStrings(evidence.map((entry) => entry.sessionId)),
        evidence,
        metadata: {
          loopKey,
          metricCount: metrics.length,
          guardCount: guards.length,
        },
      });
    })
    .filter((artifact): artifact is DeliberationMemoryArtifact => Boolean(artifact))
    .toSorted((left, right) => right.lastValidatedAt - left.lastValidatedAt);
}

export function buildDeliberationMemoryState(input: {
  updatedAt?: number;
  sessionDigests: readonly DeliberationMemorySessionDigest[];
  sessions: readonly SessionMemoryInput[];
  now?: number;
}): DeliberationMemoryState {
  const now = input.now ?? input.updatedAt ?? Date.now();
  const artifacts = pruneDeliberationMemoryArtifacts(
    [
      ...buildRepositoryArtifacts(input.sessions),
      buildUserCollaborationProfile(input.sessions),
      buildAgentCapabilityProfile(input.sessions),
      ...buildLoopMemories(input.sessions),
    ]
      .filter((artifact): artifact is DeliberationMemoryArtifact => Boolean(artifact))
      .toSorted((left, right) => right.lastValidatedAt - left.lastValidatedAt),
    now,
  );

  return {
    schema: DELIBERATION_MEMORY_STATE_SCHEMA,
    updatedAt: input.updatedAt ?? now,
    sessionDigests: [...input.sessionDigests],
    artifacts,
  };
}

function resolveScopeWeight(
  artifact: DeliberationMemoryArtifact,
  queryTokens: ReadonlySet<string>,
): number {
  const tokenArray = [...queryTokens];
  if (artifact.kind === "user_collaboration_profile") {
    return tokenArray.some((token) =>
      ["user", "prefer", "style", "expect", "arthur"].includes(token),
    )
      ? 1
      : 0.72;
  }
  if (artifact.kind === "agent_capability_profile") {
    return tokenArray.some((token) =>
      ["agent", "capability", "weakness", "strength"].includes(token),
    )
      ? 1
      : 0.76;
  }
  if (artifact.kind === "loop_memory") {
    return tokenArray.some((token) =>
      ["loop", "metric", "guard", "iteration", "schedule"].includes(token),
    )
      ? 1
      : 0.65;
  }
  return 0.9;
}

export function retrieveDeliberationMemoryArtifacts(input: {
  state: DeliberationMemoryState;
  promptText: string;
  targetRoots?: readonly string[];
  now?: number;
  limit?: number;
}): DeliberationMemoryRetrieval[] {
  const now = input.now ?? Date.now();
  const queryTokens = new Set(tokenize(input.promptText));
  const targetRoots = new Set((input.targetRoots ?? []).map((root) => root.trim()).filter(Boolean));
  const perKindCap: Record<DeliberationMemoryArtifact["kind"], number> = {
    repository_strategy_memory: 2,
    user_collaboration_profile: 1,
    agent_capability_profile: 1,
    loop_memory: 3,
  };
  const scored = input.state.artifacts.map((artifact) => {
    const retention = readRetention(artifact, now);
    const haystack = tokenize(
      [artifact.title, artifact.summary, artifact.content, artifact.tags.join(" ")].join(" "),
    );
    const haystackSet = new Set(haystack);
    const lexicalScore =
      queryTokens.size === 0
        ? 0.58
        : [...queryTokens].filter((token) => haystackSet.has(token)).length / queryTokens.size;
    const tagScore =
      queryTokens.size === 0
        ? 0.52
        : [...queryTokens].filter((token) =>
            artifact.tags.some((tag) => tokenize(tag).includes(token)),
          ).length / queryTokens.size;
    const scopeWeight = resolveScopeWeight(artifact, queryTokens);
    const artifactRepositoryRoot = getArtifactRepositoryRoot(artifact);
    const repositoryScopeWeight =
      artifact.kind !== "repository_strategy_memory" || targetRoots.size === 0
        ? 1
        : artifactRepositoryRoot && targetRoots.has(artifactRepositoryRoot)
          ? 1
          : 0;
    return {
      artifact,
      score:
        lexicalScore * 0.38 +
        tagScore * 0.12 +
        retention.retentionScore * 0.26 +
        retention.retrievalBias * 0.09 +
        scopeWeight * 0.15 +
        repositoryScopeWeight * 0.2,
    };
  });

  const selected: DeliberationMemoryRetrieval[] = [];
  const kindCounts = new Map<DeliberationMemoryArtifact["kind"], number>();
  for (const entry of scored.toSorted((left, right) => right.score - left.score)) {
    const artifactRepositoryRoot = getArtifactRepositoryRoot(entry.artifact);
    if (
      entry.artifact.kind === "repository_strategy_memory" &&
      targetRoots.size > 0 &&
      (!artifactRepositoryRoot || !targetRoots.has(artifactRepositoryRoot))
    ) {
      continue;
    }
    const limit = perKindCap[entry.artifact.kind];
    const currentCount = kindCounts.get(entry.artifact.kind) ?? 0;
    if (currentCount >= limit) continue;
    selected.push(entry);
    kindCounts.set(entry.artifact.kind, currentCount + 1);
    if (selected.length >= Math.max(1, input.limit ?? DEFAULT_MAX_RETRIEVAL)) {
      break;
    }
  }
  return selected;
}

function renderContextEntry(artifact: DeliberationMemoryArtifact): string {
  const retention = artifact.metadata?.retention;
  const repositoryRoot =
    typeof artifact.metadata?.repositoryRoot === "string" ? artifact.metadata.repositoryRoot : null;
  return [
    `[DeliberationMemory:${artifact.kind}:${artifact.id}]`,
    `title: ${artifact.title}`,
    repositoryRoot ? `repository_root: ${repositoryRoot}` : "",
    `summary: ${artifact.summary}`,
    `confidence: ${artifact.confidenceScore.toFixed(2)}`,
    retention ? `retention: ${retention.band} (${retention.retentionScore.toFixed(2)})` : "",
    `evidence_sessions: ${artifact.sessionIds.length}`,
    artifact.content,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

function getArtifactRepositoryRoot(artifact: DeliberationMemoryArtifact): string | null {
  return typeof artifact.metadata?.repositoryRoot === "string"
    ? artifact.metadata.repositoryRoot
    : null;
}

function createEmptyDeliberationMemoryState(
  sessionDigests: readonly DeliberationMemorySessionDigest[] = [],
): DeliberationMemoryState {
  return {
    schema: DELIBERATION_MEMORY_STATE_SCHEMA,
    updatedAt: Date.now(),
    sessionDigests: [...sessionDigests],
    artifacts: [],
  };
}

const planeByRuntime = new WeakMap<object, DeliberationMemoryPlane>();

export class DeliberationMemoryPlane {
  private readonly runtime: DeliberationMemoryRuntime;
  private readonly store: FileDeliberationMemoryStore;
  private readonly minRefreshIntervalMs: number;
  private state: DeliberationMemoryState | undefined;
  private dirty = true;

  constructor(
    runtime: DeliberationMemoryRuntime,
    options: {
      workspaceRoot?: string;
      minRefreshIntervalMs?: number;
    } = {},
  ) {
    this.runtime = runtime;
    this.store = new FileDeliberationMemoryStore(options.workspaceRoot ?? runtime.workspaceRoot);
    this.minRefreshIntervalMs = Math.max(0, options.minRefreshIntervalMs ?? 0);
    this.state = this.store.read();
    this.runtime.events.subscribe((event) => {
      if (DELIBERATION_MEMORY_RELEVANT_EVENT_TYPES.has(event.type)) {
        this.dirty = true;
      }
    });
  }

  getState(): DeliberationMemoryState {
    return this.sync();
  }

  getCachedState(): DeliberationMemoryState {
    return this.state ?? createEmptyDeliberationMemoryState();
  }

  sync(): DeliberationMemoryState {
    return this.reconcile();
  }

  list(
    options: {
      kind?: DeliberationMemoryArtifact["kind"];
      applicabilityScope?: DeliberationMemoryArtifact["applicabilityScope"];
      limit?: number;
    } = {},
  ): DeliberationMemoryArtifact[] {
    return this.filterArtifacts(this.sync().artifacts, options);
  }

  listCached(
    options: {
      kind?: DeliberationMemoryArtifact["kind"];
      applicabilityScope?: DeliberationMemoryArtifact["applicabilityScope"];
      limit?: number;
    } = {},
  ): DeliberationMemoryArtifact[] {
    return this.filterArtifacts(this.state?.artifacts ?? [], options);
  }

  getArtifact(artifactId: string): DeliberationMemoryArtifact | undefined {
    const normalizedId = artifactId.trim();
    if (!normalizedId) return undefined;
    return this.sync().artifacts.find((artifact) => artifact.id === normalizedId);
  }

  getArtifactCached(artifactId: string): DeliberationMemoryArtifact | undefined {
    const normalizedId = artifactId.trim();
    if (!normalizedId) return undefined;
    return this.state?.artifacts.find((artifact) => artifact.id === normalizedId);
  }

  retrieve(
    promptText: string,
    limit = DEFAULT_MAX_RETRIEVAL,
    targetRoots: readonly string[] = [],
  ): DeliberationMemoryRetrieval[] {
    const state = this.sync();
    return retrieveDeliberationMemoryArtifacts({
      state,
      promptText,
      targetRoots,
      limit,
    });
  }

  retrieveCached(
    promptText: string,
    limit = DEFAULT_MAX_RETRIEVAL,
    targetRoots: readonly string[] = [],
  ): DeliberationMemoryRetrieval[] {
    const state = this.state;
    if (!state) {
      return [];
    }
    return retrieveDeliberationMemoryArtifacts({
      state,
      promptText,
      targetRoots,
      limit,
    });
  }

  private filterArtifacts(
    artifacts: readonly DeliberationMemoryArtifact[],
    options: {
      kind?: DeliberationMemoryArtifact["kind"];
      applicabilityScope?: DeliberationMemoryArtifact["applicabilityScope"];
      limit?: number;
    },
  ): DeliberationMemoryArtifact[] {
    return artifacts
      .filter((artifact) => !options.kind || artifact.kind === options.kind)
      .filter(
        (artifact) =>
          !options.applicabilityScope || artifact.applicabilityScope === options.applicabilityScope,
      )
      .slice(0, Math.max(1, options.limit ?? artifacts.length));
  }

  private reconcile(): DeliberationMemoryState {
    const now = Date.now();
    const digests = collectPlaneSessionDigests(this.runtime.events);
    const current = this.store.read() ?? this.state;
    const hasState = Boolean(current);
    const digestsChanged =
      !hasState ||
      !samePlaneSessionDigests(
        current?.sessionDigests ?? [],
        digests as DeliberationMemorySessionDigest[],
      );
    if (!digestsChanged && !this.dirty) {
      this.state = current;
      return current ?? createEmptyDeliberationMemoryState(digests);
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

    const sessions = digests.map((digest) =>
      buildSessionMemoryInput(
        digest.sessionId,
        this.runtime.events.list(digest.sessionId),
        this.runtime.task.getTargetDescriptor(digest.sessionId).roots,
      ),
    );
    const nextState = buildDeliberationMemoryState({
      updatedAt: now,
      sessionDigests: digests,
      sessions,
      now,
    });
    this.store.write(nextState);
    this.state = nextState;
    this.dirty = false;
    return nextState;
  }
}

export function getOrCreateDeliberationMemoryPlane(
  runtime: DeliberationMemoryRuntime,
  options: {
    workspaceRoot?: string;
    minRefreshIntervalMs?: number;
  } = {},
): DeliberationMemoryPlane {
  const key = runtime as unknown as object;
  const existing = planeByRuntime.get(key);
  if (existing) {
    return existing;
  }
  const created = new DeliberationMemoryPlane(runtime, options);
  planeByRuntime.set(key, created);
  return created;
}

export function createDeliberationMemoryContextProvider(input: {
  runtime: BrewvaRuntime;
  maxArtifacts?: number;
  minRefreshIntervalMs?: number;
}): ContextSourceProvider {
  const plane = getOrCreateDeliberationMemoryPlane(input.runtime, {
    minRefreshIntervalMs: input.minRefreshIntervalMs,
  });
  return {
    source: CONTEXT_SOURCES.deliberationMemory,
    category: "narrative",
    order: 15,
    collect: (providerInput) => {
      const retrievals = plane.retrieve(
        providerInput.promptText,
        input.maxArtifacts,
        input.runtime.task.getTargetDescriptor(providerInput.sessionId).roots,
      );
      for (const retrieval of retrievals) {
        providerInput.register({
          id: retrieval.artifact.id,
          content: renderContextEntry(retrieval.artifact),
        });
      }
    },
  };
}
