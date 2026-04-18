import { resolve } from "node:path";
import { readNormalizedJsonFile, writeNormalizedJsonFile } from "./plane-substrate.js";
import {
  DELIBERATION_MEMORY_ARTIFACT_KINDS,
  DELIBERATION_MEMORY_RETENTION_BANDS,
  DELIBERATION_MEMORY_SCOPE_VALUES,
  DELIBERATION_MEMORY_STATE_SCHEMA,
  type DeliberationMemoryArtifact,
  type DeliberationMemoryArtifactMetadata,
  type DeliberationMemoryEvidenceRef,
  type DeliberationMemoryRetentionSnapshot,
  type DeliberationMemorySessionDigest,
  type DeliberationMemoryState,
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

function readLiteral<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const normalized = readString(value);
  return normalized && allowed.includes(normalized as T) ? (normalized as T) : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => readString(entry) ?? "").filter((entry) => entry.length > 0);
}

function readRetention(value: unknown): DeliberationMemoryRetentionSnapshot | undefined {
  if (!isRecord(value)) return undefined;
  const retentionScore = readNumber(value.retentionScore);
  const retrievalBias = readNumber(value.retrievalBias);
  const decayFactor = readNumber(value.decayFactor);
  const ageDays = readNumber(value.ageDays);
  const evidenceCount = readNumber(value.evidenceCount);
  const sessionSpan = readNumber(value.sessionSpan);
  const band = readLiteral(value.band, DELIBERATION_MEMORY_RETENTION_BANDS);
  if (
    retentionScore === undefined ||
    retrievalBias === undefined ||
    decayFactor === undefined ||
    ageDays === undefined ||
    evidenceCount === undefined ||
    sessionSpan === undefined ||
    !band
  ) {
    return undefined;
  }
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

function readArtifactMetadata(value: unknown): DeliberationMemoryArtifactMetadata | undefined {
  if (!isRecord(value)) return undefined;
  const metadata: DeliberationMemoryArtifactMetadata = {};
  const retention = readRetention(value.retention);
  if (retention) {
    metadata.retention = retention;
  }
  const repositoryRoot = readString(value.repositoryRoot);
  if (repositoryRoot) {
    metadata.repositoryRoot = repositoryRoot;
  }
  const taskSpecCount = readNumber(value.taskSpecCount);
  if (taskSpecCount !== undefined) {
    metadata.taskSpecCount = taskSpecCount;
  }
  const loopKey = readString(value.loopKey);
  if (loopKey) {
    metadata.loopKey = loopKey;
  }
  const metricCount = readNumber(value.metricCount);
  if (metricCount !== undefined) {
    metadata.metricCount = metricCount;
  }
  const guardCount = readNumber(value.guardCount);
  if (guardCount !== undefined) {
    metadata.guardCount = guardCount;
  }
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function readEvidence(value: unknown): DeliberationMemoryEvidenceRef | undefined {
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

function readArtifact(value: unknown): DeliberationMemoryArtifact | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value.id);
  const kind = readLiteral(value.kind, DELIBERATION_MEMORY_ARTIFACT_KINDS);
  const title = readString(value.title);
  const summary = readString(value.summary);
  const content = readString(value.content);
  const confidenceScore = readNumber(value.confidenceScore);
  const firstCapturedAt = readNumber(value.firstCapturedAt);
  const lastValidatedAt = readNumber(value.lastValidatedAt);
  const applicabilityScope = readLiteral(
    value.applicabilityScope,
    DELIBERATION_MEMORY_SCOPE_VALUES,
  );
  if (
    !id ||
    !kind ||
    !title ||
    !summary ||
    !content ||
    confidenceScore === undefined ||
    firstCapturedAt === undefined ||
    lastValidatedAt === undefined ||
    !applicabilityScope
  ) {
    return undefined;
  }
  const evidence = Array.isArray(value.evidence)
    ? value.evidence
        .map((entry) => readEvidence(entry))
        .filter((entry): entry is DeliberationMemoryEvidenceRef => Boolean(entry))
    : [];
  const sessionIds = readStringArray(value.sessionIds);
  const tags = readStringArray(value.tags);
  const metadata = readArtifactMetadata(value.metadata);
  return {
    id,
    kind,
    title,
    summary,
    content,
    confidenceScore,
    firstCapturedAt,
    lastValidatedAt,
    applicabilityScope,
    evidence,
    sessionIds,
    tags,
    metadata,
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

function normalizeState(value: unknown): DeliberationMemoryState | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schema !== DELIBERATION_MEMORY_STATE_SCHEMA) return undefined;
  const updatedAt = readNumber(value.updatedAt);
  if (updatedAt === undefined) return undefined;
  const artifacts = Array.isArray(value.artifacts)
    ? value.artifacts
        .map((entry) => readArtifact(entry))
        .filter((entry): entry is DeliberationMemoryArtifact => Boolean(entry))
    : [];
  const sessionDigests = Array.isArray(value.sessionDigests)
    ? value.sessionDigests
        .map((entry) => readSessionDigest(entry))
        .filter((entry): entry is DeliberationMemorySessionDigest => Boolean(entry))
    : [];
  return {
    schema: DELIBERATION_MEMORY_STATE_SCHEMA,
    updatedAt,
    artifacts,
    sessionDigests,
  };
}

export function resolveDeliberationMemoryStatePath(workspaceRoot: string): string {
  return resolve(workspaceRoot, ".brewva", "deliberation", "memory-state.json");
}

export class FileDeliberationMemoryStore {
  readonly filePath: string;

  constructor(workspaceRoot: string) {
    this.filePath = resolveDeliberationMemoryStatePath(workspaceRoot);
  }

  read(): DeliberationMemoryState | undefined {
    return readNormalizedJsonFile(this.filePath, normalizeState);
  }

  write(state: DeliberationMemoryState): void {
    writeNormalizedJsonFile(this.filePath, state);
  }
}
