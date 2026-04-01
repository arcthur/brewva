import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  NARRATIVE_MEMORY_EVIDENCE_KINDS,
  NARRATIVE_MEMORY_PROVENANCE_ACTORS,
  NARRATIVE_MEMORY_PROVENANCE_SOURCES,
  NARRATIVE_MEMORY_RECORD_CLASSES,
  NARRATIVE_MEMORY_RECORD_STATUSES,
  NARRATIVE_MEMORY_SCOPE_VALUES,
  NARRATIVE_MEMORY_STATE_SCHEMA,
  type NarrativeMemoryApplicabilityScope,
  type NarrativeMemoryEvidence,
  type NarrativeMemoryPromotionTarget,
  type NarrativeMemoryProvenance,
  type NarrativeMemoryRecord,
  type NarrativeMemoryState,
} from "./narrative-types.js";
import { writeFileAtomic } from "./plane-substrate.js";

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

function readPromotionTarget(value: unknown): NarrativeMemoryPromotionTarget | undefined {
  if (!isRecord(value)) return undefined;
  const agentId = readString(value.agentId);
  const path = readString(value.path);
  const heading = readString(value.heading);
  const promotedAt = readNumber(value.promotedAt);
  if (!agentId || !path || !heading || promotedAt === undefined) {
    return undefined;
  }
  return {
    agentId,
    path,
    heading,
    promotedAt,
  };
}

function readEvidence(value: unknown): NarrativeMemoryEvidence | undefined {
  if (!isRecord(value)) return undefined;
  const kind = readString(value.kind);
  const summary = readString(value.summary);
  const sessionId = readString(value.sessionId);
  const timestamp = readNumber(value.timestamp);
  if (!kind || !summary || !sessionId || timestamp === undefined) {
    return undefined;
  }
  if (
    !NARRATIVE_MEMORY_EVIDENCE_KINDS.includes(
      kind as (typeof NARRATIVE_MEMORY_EVIDENCE_KINDS)[number],
    )
  ) {
    return undefined;
  }
  return {
    kind: kind as NarrativeMemoryEvidence["kind"],
    summary,
    sessionId,
    timestamp,
    eventId: readString(value.eventId),
    eventType: readString(value.eventType),
    toolName: readString(value.toolName),
  };
}

function readProvenance(value: unknown): NarrativeMemoryProvenance | undefined {
  if (!isRecord(value)) return undefined;
  const source = readString(value.source);
  const actor = readString(value.actor);
  if (!source || !actor) {
    return undefined;
  }
  if (
    !NARRATIVE_MEMORY_PROVENANCE_SOURCES.includes(
      source as (typeof NARRATIVE_MEMORY_PROVENANCE_SOURCES)[number],
    )
  ) {
    return undefined;
  }
  if (
    !NARRATIVE_MEMORY_PROVENANCE_ACTORS.includes(
      actor as (typeof NARRATIVE_MEMORY_PROVENANCE_ACTORS)[number],
    )
  ) {
    return undefined;
  }
  return {
    source: source as NarrativeMemoryProvenance["source"],
    actor: actor as NarrativeMemoryProvenance["actor"],
    sessionId: readString(value.sessionId),
    agentId: readString(value.agentId),
    turn: readNumber(value.turn),
    targetRoots: readStringArray(value.targetRoots),
  };
}

function readRecord(value: unknown): NarrativeMemoryRecord | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value.id);
  const recordClass = readString(value.class);
  const title = readString(value.title);
  const summary = readString(value.summary);
  const content = readString(value.content);
  const applicabilityScope = readString(value.applicabilityScope);
  const confidenceScore = readNumber(value.confidenceScore);
  const status = readString(value.status);
  const createdAt = readNumber(value.createdAt);
  const updatedAt = readNumber(value.updatedAt);
  const retrievalCount = readNumber(value.retrievalCount);
  const provenance = readProvenance(value.provenance);
  if (
    !id ||
    !recordClass ||
    !title ||
    !summary ||
    !content ||
    !applicabilityScope ||
    confidenceScore === undefined ||
    !status ||
    createdAt === undefined ||
    updatedAt === undefined ||
    retrievalCount === undefined ||
    !provenance
  ) {
    return undefined;
  }
  if (
    !NARRATIVE_MEMORY_RECORD_CLASSES.includes(
      recordClass as (typeof NARRATIVE_MEMORY_RECORD_CLASSES)[number],
    )
  ) {
    return undefined;
  }
  if (
    !NARRATIVE_MEMORY_RECORD_STATUSES.includes(
      status as (typeof NARRATIVE_MEMORY_RECORD_STATUSES)[number],
    )
  ) {
    return undefined;
  }
  if (
    !NARRATIVE_MEMORY_SCOPE_VALUES.includes(
      applicabilityScope as (typeof NARRATIVE_MEMORY_SCOPE_VALUES)[number],
    )
  ) {
    return undefined;
  }
  const evidence = Array.isArray(value.evidence)
    ? value.evidence
        .map((entry) => readEvidence(entry))
        .filter((entry): entry is NarrativeMemoryEvidence => Boolean(entry))
    : [];
  const lastRetrievedAt = readNumber(value.lastRetrievedAt);
  const promotionTarget = readPromotionTarget(value.promotionTarget);
  const metadata = isRecord(value.metadata) ? value.metadata : undefined;
  return {
    id,
    class: recordClass as NarrativeMemoryRecord["class"],
    title,
    summary,
    content,
    applicabilityScope: applicabilityScope as NarrativeMemoryApplicabilityScope,
    confidenceScore,
    status: status as NarrativeMemoryRecord["status"],
    createdAt,
    updatedAt,
    retrievalCount,
    lastRetrievedAt,
    provenance,
    evidence,
    promotionTarget,
    metadata,
  };
}

function normalizeState(value: unknown): NarrativeMemoryState | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schema !== NARRATIVE_MEMORY_STATE_SCHEMA) return undefined;
  const updatedAt = readNumber(value.updatedAt);
  if (updatedAt === undefined) return undefined;
  const records = Array.isArray(value.records)
    ? value.records
        .map((entry) => readRecord(entry))
        .filter((entry): entry is NarrativeMemoryRecord => Boolean(entry))
    : [];
  return {
    schema: NARRATIVE_MEMORY_STATE_SCHEMA,
    updatedAt,
    records,
  };
}

export function resolveNarrativeMemoryStatePath(workspaceRoot: string): string {
  return resolve(workspaceRoot, ".brewva", "deliberation", "narrative-memory-state.json");
}

export class FileNarrativeMemoryStore {
  readonly filePath: string;

  constructor(workspaceRoot: string) {
    this.filePath = resolveNarrativeMemoryStatePath(workspaceRoot);
  }

  read(): NarrativeMemoryState | undefined {
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

  write(state: NarrativeMemoryState): void {
    writeFileAtomic(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}
