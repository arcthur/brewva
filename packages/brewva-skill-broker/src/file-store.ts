import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeFileAtomic } from "@brewva/brewva-deliberation";
import { isRecord, readNumber, readString, readStringArray } from "./parse.js";
import {
  SKILL_PROMOTION_STATE_SCHEMA,
  SKILL_PROMOTION_STATUSES,
  SKILL_PROMOTION_TARGET_KINDS,
  type SkillPromotionDraft,
  type SkillPromotionEvidenceRef,
  type SkillPromotionMaterialization,
  type SkillPromotionReview,
  type SkillPromotionSessionDigest,
  type SkillPromotionState,
  type SkillPromotionTarget,
} from "./types.js";

function readEvidenceRef(value: unknown): SkillPromotionEvidenceRef | undefined {
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

function readTarget(value: unknown): SkillPromotionTarget | undefined {
  if (!isRecord(value)) return undefined;
  const kind = readString(value.kind);
  const pathHint = readString(value.pathHint);
  const rationale = readString(value.rationale);
  if (!kind || !pathHint || !rationale) return undefined;
  if (!SKILL_PROMOTION_TARGET_KINDS.includes(kind as SkillPromotionTarget["kind"])) {
    return undefined;
  }
  return {
    kind: kind as SkillPromotionTarget["kind"],
    pathHint,
    rationale,
  };
}

function readReview(value: unknown): SkillPromotionReview | undefined {
  if (!isRecord(value)) return undefined;
  const decision = readString(value.decision);
  const reviewedAt = readNumber(value.reviewedAt);
  if (
    !decision ||
    reviewedAt === undefined ||
    (decision !== "approve" && decision !== "reject" && decision !== "reopen")
  ) {
    return undefined;
  }
  return {
    decision,
    note: readString(value.note),
    reviewedAt,
  };
}

function readMaterialization(value: unknown): SkillPromotionMaterialization | undefined {
  if (!isRecord(value)) return undefined;
  const materializedAt = readNumber(value.materializedAt);
  const directoryPath = readString(value.directoryPath);
  const primaryPath = readString(value.primaryPath);
  const format = readString(value.format);
  if (
    materializedAt === undefined ||
    !directoryPath ||
    !primaryPath ||
    (format !== "markdown_packet" && format !== "skill_scaffold")
  ) {
    return undefined;
  }
  return {
    materializedAt,
    directoryPath,
    primaryPath,
    format,
  };
}

function readDraft(value: unknown): SkillPromotionDraft | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value.id);
  const status = readString(value.status);
  const title = readString(value.title);
  const summary = readString(value.summary);
  const rationale = readString(value.rationale);
  const sourceSkillName = readString(value.sourceSkillName);
  const repeatCount = readNumber(value.repeatCount);
  const confidenceScore = readNumber(value.confidenceScore);
  const firstCapturedAt = readNumber(value.firstCapturedAt);
  const lastValidatedAt = readNumber(value.lastValidatedAt);
  const target = readTarget(value.target);
  const proposalText = readString(value.proposalText);
  if (
    !id ||
    !status ||
    !title ||
    !summary ||
    !rationale ||
    !sourceSkillName ||
    repeatCount === undefined ||
    confidenceScore === undefined ||
    firstCapturedAt === undefined ||
    lastValidatedAt === undefined ||
    !target ||
    !proposalText
  ) {
    return undefined;
  }
  if (!SKILL_PROMOTION_STATUSES.includes(status as SkillPromotionDraft["status"])) {
    return undefined;
  }
  const evidence = Array.isArray(value.evidence)
    ? value.evidence
        .map((entry) => readEvidenceRef(entry))
        .filter((entry): entry is SkillPromotionEvidenceRef => Boolean(entry))
    : [];
  return {
    id,
    status: status as SkillPromotionDraft["status"],
    title,
    summary,
    rationale,
    sourceSkillName,
    target,
    repeatCount,
    confidenceScore,
    firstCapturedAt,
    lastValidatedAt,
    sessionIds: readStringArray(value.sessionIds),
    evidence,
    tags: readStringArray(value.tags),
    proposalText,
    review: readReview(value.review),
    promotion: readMaterialization(value.promotion),
  };
}

function readSessionDigest(value: unknown): SkillPromotionSessionDigest | undefined {
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

function normalizeState(value: unknown): SkillPromotionState | undefined {
  if (!isRecord(value) || value.schema !== SKILL_PROMOTION_STATE_SCHEMA) {
    return undefined;
  }
  const updatedAt = readNumber(value.updatedAt);
  if (updatedAt === undefined) return undefined;
  const drafts = Array.isArray(value.drafts)
    ? value.drafts
        .map((entry) => readDraft(entry))
        .filter((entry): entry is SkillPromotionDraft => Boolean(entry))
    : [];
  const sessionDigests = Array.isArray(value.sessionDigests)
    ? value.sessionDigests
        .map((entry) => readSessionDigest(entry))
        .filter((entry): entry is SkillPromotionSessionDigest => Boolean(entry))
    : [];
  return {
    schema: SKILL_PROMOTION_STATE_SCHEMA,
    updatedAt,
    sessionDigests,
    drafts,
  };
}

export function resolveSkillPromotionStatePath(workspaceRoot: string): string {
  return resolve(workspaceRoot, ".brewva", "skill-broker", "promotion-state.json");
}

export class FileSkillPromotionStore {
  readonly filePath: string;

  constructor(workspaceRoot: string) {
    this.filePath = resolveSkillPromotionStatePath(workspaceRoot);
  }

  read(): SkillPromotionState | undefined {
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

  write(state: SkillPromotionState): void {
    writeFileAtomic(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
  }
}
