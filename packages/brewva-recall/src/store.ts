import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileAtomic } from "@brewva/brewva-deliberation";
import {
  RECALL_BROKER_STATE_SCHEMA,
  type RecallBrokerState,
  type RecallCurationAggregate,
  type RecallEvidenceIndexEntry,
  type RecallSessionDigest,
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

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => readString(entry) ?? "").filter((entry) => entry.length > 0);
}

function readSessionDigest(value: unknown): RecallSessionDigest | undefined {
  if (!isRecord(value)) return undefined;
  const sessionId = readString(value.sessionId);
  const eventCount = readNumber(value.eventCount);
  const lastEventAt = readNumber(value.lastEventAt);
  const repositoryRoot = readString(value.repositoryRoot);
  const primaryRoot = readString(value.primaryRoot);
  const digestText = readString(value.digestText);
  if (
    !sessionId ||
    eventCount === undefined ||
    lastEventAt === undefined ||
    !repositoryRoot ||
    !primaryRoot ||
    !digestText
  ) {
    return undefined;
  }
  return {
    sessionId,
    eventCount,
    lastEventAt,
    repositoryRoot,
    primaryRoot,
    targetRoots: readStringArray(value.targetRoots),
    taskGoal: readString(value.taskGoal),
    digestText,
  };
}

function readEvidenceIndexEntry(value: unknown): RecallEvidenceIndexEntry | undefined {
  const digest = readSessionDigest(value);
  if (!digest) return undefined;
  return {
    sessionId: digest.sessionId,
    eventCount: digest.eventCount,
    lastEventAt: digest.lastEventAt,
    repositoryRoot: digest.repositoryRoot,
    primaryRoot: digest.primaryRoot,
    targetRoots: digest.targetRoots,
    digestText: digest.digestText,
  };
}

function readCuration(value: unknown): RecallCurationAggregate | undefined {
  if (!isRecord(value)) return undefined;
  const stableId = readString(value.stableId);
  if (!stableId) return undefined;
  return {
    stableId,
    helpfulSignals: readNumber(value.helpfulSignals) ?? 0,
    staleSignals: readNumber(value.staleSignals) ?? 0,
    supersededSignals: readNumber(value.supersededSignals) ?? 0,
    wrongScopeSignals: readNumber(value.wrongScopeSignals) ?? 0,
    misleadingSignals: readNumber(value.misleadingSignals) ?? 0,
    helpfulWeight: readNumber(value.helpfulWeight) ?? 0,
    staleWeight: readNumber(value.staleWeight) ?? 0,
    supersededWeight: readNumber(value.supersededWeight) ?? 0,
    wrongScopeWeight: readNumber(value.wrongScopeWeight) ?? 0,
    misleadingWeight: readNumber(value.misleadingWeight) ?? 0,
    lastSignalAt: readNumber(value.lastSignalAt),
  };
}

function normalizeState(value: unknown): RecallBrokerState | undefined {
  if (!isRecord(value) || value.schema !== RECALL_BROKER_STATE_SCHEMA) {
    return undefined;
  }
  const updatedAt = readNumber(value.updatedAt);
  if (updatedAt === undefined) return undefined;
  const sessionDigests = Array.isArray(value.sessionDigests)
    ? value.sessionDigests
        .map((entry) => readSessionDigest(entry))
        .filter((entry): entry is RecallSessionDigest => Boolean(entry))
    : [];
  const evidenceIndex = Array.isArray(value.evidenceIndex)
    ? value.evidenceIndex
        .map((entry) => readEvidenceIndexEntry(entry))
        .filter((entry): entry is RecallEvidenceIndexEntry => Boolean(entry))
    : [];
  const curation = Array.isArray(value.curation)
    ? value.curation
        .map((entry) => readCuration(entry))
        .filter((entry): entry is RecallCurationAggregate => Boolean(entry))
    : [];
  return {
    schema: RECALL_BROKER_STATE_SCHEMA,
    updatedAt,
    sessionDigests,
    evidenceIndex,
    curation,
  };
}

export function resolveRecallBrokerStatePath(workspaceRoot: string): string {
  return resolve(workspaceRoot, ".brewva", "recall", "broker-state.json");
}

export class FileRecallBrokerStore {
  readonly filePath: string;

  constructor(workspaceRoot: string) {
    this.filePath = resolveRecallBrokerStatePath(workspaceRoot);
  }

  read(): RecallBrokerState | undefined {
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

  write(state: RecallBrokerState): void {
    writeFileAtomic(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}
