import { normalizeJsonRecord, type JsonValue } from "@brewva/brewva-std/json";

export type EvidenceSourceType =
  | "event"
  | "ledger"
  | "task"
  | "claim"
  | "workspace_artifact"
  | "operator_note"
  | "verification"
  | "tool_result"
  | "convention";

export type EvidenceTrustLevel = "untrusted" | "observed" | "verified" | "operator_attested";

export type EvidencePolarity = "support" | "contradict" | "neutral";

export interface EvidenceRef {
  id: string;
  sourceType: EvidenceSourceType;
  locator: string;
  hash?: string;
  createdAt: number;
  sessionId?: string;
  userId?: string;
  repoId?: string;
  scope?: string;
  modelVersion?: string;
  toolVersion?: string;
  originatingRuleIds?: string[];
  trustLevel?: EvidenceTrustLevel;
  polarity?: EvidencePolarity;
  metadata?: Record<string, JsonValue>;
}

export interface EvidenceDiversityCluster {
  key: string;
  evidenceIds: string[];
  sessionId: string;
  modelVersion: string;
  toolVersion: string;
  scope: string;
  originatingRuleIds: string[];
  polarity: EvidencePolarity;
}

export interface EvidenceDiversitySummary {
  clusters: EvidenceDiversityCluster[];
  supportClusterCount: number;
  contradictionClusterCount: number;
  neutralClusterCount: number;
  score: number;
}

const EVIDENCE_SOURCE_TYPES: readonly EvidenceSourceType[] = [
  "event",
  "ledger",
  "task",
  "claim",
  "workspace_artifact",
  "operator_note",
  "verification",
  "tool_result",
  "convention",
];

const EVIDENCE_SOURCE_TYPE_SET: ReadonlySet<EvidenceSourceType> = new Set(EVIDENCE_SOURCE_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isEvidenceSourceType(value: unknown): value is EvidenceSourceType {
  return typeof value === "string" && EVIDENCE_SOURCE_TYPE_SET.has(value as EvidenceSourceType);
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeRuleIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ].toSorted();
  return out.length > 0 ? out : undefined;
}

function normalizeTrustLevel(value: unknown): EvidenceTrustLevel | undefined {
  if (
    value === "untrusted" ||
    value === "observed" ||
    value === "verified" ||
    value === "operator_attested"
  ) {
    return value;
  }
  return undefined;
}

function normalizePolarity(value: unknown): EvidencePolarity | undefined {
  if (value === "support" || value === "contradict" || value === "neutral") {
    return value;
  }
  return undefined;
}

export function normalizeEvidenceRef(value: unknown): EvidenceRef | null {
  if (!isRecord(value)) return null;
  const id = normalizeOptionalString(value.id);
  const sourceType = value.sourceType;
  const locator = normalizeOptionalString(value.locator);
  const createdAt =
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
      ? Math.max(0, Math.floor(value.createdAt))
      : null;
  if (!id || !isEvidenceSourceType(sourceType) || !locator || createdAt === null) {
    return null;
  }
  const metadata = isRecord(value.metadata) ? normalizeJsonRecord(value.metadata) : undefined;

  return {
    id,
    sourceType,
    locator,
    ...(normalizeOptionalString(value.hash) ? { hash: normalizeOptionalString(value.hash) } : {}),
    createdAt,
    ...(normalizeOptionalString(value.sessionId)
      ? { sessionId: normalizeOptionalString(value.sessionId) }
      : {}),
    ...(normalizeOptionalString(value.userId)
      ? { userId: normalizeOptionalString(value.userId) }
      : {}),
    ...(normalizeOptionalString(value.repoId)
      ? { repoId: normalizeOptionalString(value.repoId) }
      : {}),
    ...(normalizeOptionalString(value.scope)
      ? { scope: normalizeOptionalString(value.scope) }
      : {}),
    ...(normalizeOptionalString(value.modelVersion)
      ? { modelVersion: normalizeOptionalString(value.modelVersion) }
      : {}),
    ...(normalizeOptionalString(value.toolVersion)
      ? { toolVersion: normalizeOptionalString(value.toolVersion) }
      : {}),
    ...(normalizeRuleIds(value.originatingRuleIds)
      ? { originatingRuleIds: normalizeRuleIds(value.originatingRuleIds) }
      : {}),
    ...(normalizeTrustLevel(value.trustLevel)
      ? { trustLevel: normalizeTrustLevel(value.trustLevel) }
      : {}),
    ...(normalizePolarity(value.polarity) ? { polarity: normalizePolarity(value.polarity) } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

export function normalizeEvidenceRefs(values: readonly unknown[]): EvidenceRef[] {
  return values.flatMap((value) => {
    const normalized = normalizeEvidenceRef(value);
    return normalized ? [normalized] : [];
  });
}

function clusterDimension(value: string | undefined): string {
  return value && value.trim().length > 0 ? value.trim() : "unknown";
}

function buildClusterKey(ref: EvidenceRef): string {
  const originatingRuleIds = ref.originatingRuleIds?.length
    ? ref.originatingRuleIds.toSorted().join(",")
    : "unknown";
  return [
    clusterDimension(ref.sessionId),
    clusterDimension(ref.modelVersion),
    clusterDimension(ref.toolVersion),
    clusterDimension(ref.scope),
    originatingRuleIds,
    ref.polarity ?? "support",
  ].join("|");
}

export function computeEvidenceDiversity(refs: readonly EvidenceRef[]): EvidenceDiversitySummary {
  const clustersByKey = new Map<string, EvidenceDiversityCluster>();
  for (const ref of refs) {
    const polarity = ref.polarity ?? "support";
    const key = buildClusterKey(ref);
    const existing = clustersByKey.get(key);
    if (existing) {
      existing.evidenceIds.push(ref.id);
      continue;
    }
    clustersByKey.set(key, {
      key,
      evidenceIds: [ref.id],
      sessionId: clusterDimension(ref.sessionId),
      modelVersion: clusterDimension(ref.modelVersion),
      toolVersion: clusterDimension(ref.toolVersion),
      scope: clusterDimension(ref.scope),
      originatingRuleIds: ref.originatingRuleIds?.length
        ? ref.originatingRuleIds.toSorted()
        : ["unknown"],
      polarity,
    });
  }
  const clusters = [...clustersByKey.values()].toSorted((left, right) =>
    left.key.localeCompare(right.key),
  );
  const supportClusterCount = clusters.filter((cluster) => cluster.polarity === "support").length;
  const contradictionClusterCount = clusters.filter(
    (cluster) => cluster.polarity === "contradict",
  ).length;
  const neutralClusterCount = clusters.filter((cluster) => cluster.polarity === "neutral").length;
  return {
    clusters,
    supportClusterCount,
    contradictionClusterCount,
    neutralClusterCount,
    score: Math.max(0, supportClusterCount - contradictionClusterCount),
  };
}
