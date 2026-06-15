import type { HostedRuntimeAdapterPort } from "@brewva/brewva-gateway/hosted";
import { isRecord } from "@brewva/brewva-std/unknown";
import { resolveCachePosture, type CachePosture } from "@brewva/brewva-token-estimation";
import { RUNTIME_OPS_SESSION_COMPACTION_COMMITTED_KIND } from "@brewva/brewva-vocabulary/events";
import { RECALL_RESULTS_SURFACED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import {
  SESSION_COMPACTION_INPUT_PROVENANCE_SCHEMA_V2,
  type SessionCompactionInputProvenance,
  type SkillInvocationRecord,
  type SkillResourceRef,
} from "@brewva/brewva-vocabulary/session";
import type { WorkbenchEntry } from "@brewva/brewva-vocabulary/workbench";
import { createCliInspectPort, type CliInspectPort } from "../../runtime/cli-runtime-ports.js";

interface ContextCockpitRecallResult {
  readonly stableId: string;
  readonly sourceFamily: "tape_evidence" | "repository_precedent";
  readonly sessionScope: "current_session" | "prior_session" | "cross_workspace";
  readonly rootRef: string;
}

export interface ContextCockpitCapabilityProjection {
  readonly selectionId: string | null;
  readonly selectedCapabilities: readonly string[];
}

export interface ContextCockpitCompactionBaselineProjection {
  readonly compactId: string | null;
  readonly reason: string | null;
  readonly caller: string | null;
  readonly fromTokens: number | null;
  readonly toTokens: number | null;
  readonly firstKeptEntryId: string | null;
  readonly summaryDigest: string | null;
  readonly inputProvenance: SessionCompactionInputProvenance | null;
  readonly cacheImpact: unknown;
  readonly summaryGeneration: unknown;
  readonly droppedDigestStatus: string | null;
  readonly resumeOutcome: string | null;
  readonly gateClearOutcome: string | null;
}

export interface ContextCockpitReport {
  readonly sideEffectPolicy: "inspect_projection_only";
  readonly context: {
    readonly usage: ReturnType<CliInspectPort["context"]["usage"]>;
    readonly status: ReturnType<CliInspectPort["context"]["status"]>;
    readonly gate: ReturnType<CliInspectPort["context"]["compactionGateStatus"]>;
    readonly pendingCompactionReason: string | null;
    readonly visibleReadEpoch: ReturnType<CliInspectPort["context"]["visibleReadEpoch"]>;
    readonly historyBaseline: ReturnType<CliInspectPort["context"]["historyViewBaseline"]>;
  };
  readonly workbench: {
    readonly activeCount: number;
    readonly entries: readonly WorkbenchEntry[];
  };
  readonly skills: {
    readonly selectionId: string | null;
    readonly invocationRecords: readonly SkillInvocationRecord[];
    readonly resourceRefs: readonly SkillResourceRef[];
  };
  readonly capabilities: {
    readonly receiptRefs: readonly string[];
    readonly latest: ContextCockpitCapabilityProjection | null;
  };
  readonly recall: {
    readonly results: readonly ContextCockpitRecallResult[];
  };
  readonly compaction: {
    readonly timeline: readonly ContextCockpitCompactionBaselineProjection[];
    readonly latestBaseline: ContextCockpitCompactionBaselineProjection | null;
    readonly inputProvenance: SessionCompactionInputProvenance | null;
  };
  readonly cachePosture: CachePosture;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readRecallSourceFamily(value: unknown): ContextCockpitRecallResult["sourceFamily"] | null {
  const normalized = readString(value);
  return normalized === "tape_evidence" || normalized === "repository_precedent"
    ? normalized
    : null;
}

function readRecallSessionScope(value: unknown): ContextCockpitRecallResult["sessionScope"] | null {
  const normalized = readString(value);
  return normalized === "current_session" ||
    normalized === "prior_session" ||
    normalized === "cross_workspace"
    ? normalized
    : null;
}

function readSkillResourceRef(value: unknown): SkillResourceRef | null {
  if (!isRecord(value)) {
    return null;
  }
  const kind = readString(value.kind);
  const path = readString(value.path);
  if ((kind !== "reference" && kind !== "script" && kind !== "invariant") || path === null) {
    return null;
  }
  return { kind, path };
}

function readSkillInvocationRecords(value: unknown): SkillInvocationRecord[] {
  if (!isRecord(value) || !Array.isArray(value.skillInvocationRecords)) {
    return [];
  }
  return value.skillInvocationRecords.flatMap((entry) => {
    if (!isRecord(entry)) {
      return [];
    }
    const skillName = readString(entry.skillName);
    const invocationId = readString(entry.invocationId);
    if (!skillName || !invocationId) {
      return [];
    }
    return [
      {
        ...entry,
        invocationId,
        skillName,
        category: readString(entry.category) ?? "unknown",
        sourcePath: readString(entry.sourcePath) ?? "",
        sourcePackage: readString(entry.sourcePackage),
        selectionTrigger:
          entry.selectionTrigger === "explicit_command" ||
          entry.selectionTrigger === "suggested" ||
          entry.selectionTrigger === "delegated" ||
          entry.selectionTrigger === "discover_only"
            ? entry.selectionTrigger
            : "suggested",
        invocationMode:
          entry.invocationMode === "prompt_visible" ||
          entry.invocationMode === "delegated" ||
          entry.invocationMode === "inspect_only"
            ? entry.invocationMode
            : "prompt_visible",
        resourceRefs: Array.isArray(entry.resourceRefs)
          ? entry.resourceRefs
              .map(readSkillResourceRef)
              .filter((ref): ref is SkillResourceRef => ref !== null)
          : [],
        estimatedTokens:
          typeof entry.estimatedTokens === "number" && Number.isFinite(entry.estimatedTokens)
            ? Math.max(0, Math.trunc(entry.estimatedTokens))
            : 0,
        tokenEncoding: readString(entry.tokenEncoding) ?? "unknown",
        tokenEstimateMethod: readString(entry.tokenEstimateMethod) ?? "unknown",
        tokenEstimateApproximation: entry.tokenEstimateApproximation === true,
        capabilityRefs: Array.isArray(entry.capabilityRefs)
          ? entry.capabilityRefs.map(readString).filter((ref): ref is string => ref !== null)
          : [],
        requestedOutputArtifacts: Array.isArray(entry.requestedOutputArtifacts)
          ? entry.requestedOutputArtifacts
              .map(readString)
              .filter((artifact): artifact is string => artifact !== null)
          : [],
        argumentHints: Array.isArray(entry.argumentHints)
          ? entry.argumentHints.map(readString).filter((hint): hint is string => hint !== null)
          : [],
      },
    ];
  });
}

function readSkillSelectionId(value: unknown): string | null {
  return isRecord(value) ? readString(value.selectionId) : null;
}

function dedupeResourceRefs(records: readonly SkillInvocationRecord[]): SkillResourceRef[] {
  const deduped = new Map<string, SkillResourceRef>();
  for (const record of records) {
    for (const ref of record.resourceRefs) {
      const key = `${ref.kind}:${ref.path}`;
      if (!deduped.has(key)) {
        deduped.set(key, ref);
      }
    }
  }
  return [...deduped.values()];
}

function readCapabilityReceiptRefs(value: unknown): string[] {
  if (!isRecord(value)) {
    return [];
  }
  const selectionId = readString(value.selectionId);
  if (selectionId) {
    return [selectionId];
  }
  return [];
}

function readCapabilityProjection(value: unknown): ContextCockpitCapabilityProjection | null {
  if (!isRecord(value)) {
    return null;
  }
  const selectionId = readString(value.selectionId);
  const selectedCapabilities = Array.isArray(value.selectedCapabilities)
    ? value.selectedCapabilities.map(readString).filter((entry): entry is string => entry !== null)
    : [];
  return { selectionId, selectedCapabilities };
}

function readRecallResult(value: unknown): ContextCockpitRecallResult | null {
  if (!isRecord(value)) {
    return null;
  }
  const stableId = readString(value.stableId);
  const sourceFamily = readRecallSourceFamily(value.sourceFamily);
  const sessionScope = readRecallSessionScope(value.sessionScope);
  const rootRef = readString(value.rootRef);
  if (!stableId || !sourceFamily || !sessionScope || !rootRef) {
    return null;
  }
  return { stableId, sourceFamily, sessionScope, rootRef };
}

function readRecallResults(payload: unknown): ContextCockpitRecallResult[] {
  if (!isRecord(payload) || !Array.isArray(payload.results)) {
    return [];
  }
  return payload.results
    .map(readRecallResult)
    .filter((entry): entry is ContextCockpitRecallResult => entry !== null);
}

function readCompactionInputProvenance(value: unknown): SessionCompactionInputProvenance | null {
  return isRecord(value) &&
    value.schema === SESSION_COMPACTION_INPUT_PROVENANCE_SCHEMA_V2 &&
    value.hiddenRecallSearch === false
    ? (value as unknown as SessionCompactionInputProvenance)
    : null;
}

function dedupeRecallResults(
  results: readonly ContextCockpitRecallResult[],
): ContextCockpitRecallResult[] {
  const deduped = new Map<string, ContextCockpitRecallResult>();
  for (const result of results) {
    deduped.set(result.stableId, result);
  }
  return [...deduped.values()];
}

function projectCompactionEvent(event: {
  readonly payload?: unknown;
}): ContextCockpitCompactionBaselineProjection | null {
  const payload = event.payload;
  if (!isRecord(payload)) {
    return null;
  }
  return {
    compactId: readString(payload.compactId),
    reason: readString(payload.reason),
    caller: readString(payload.origin) ?? readString(payload.caller),
    fromTokens: typeof payload.fromTokens === "number" ? payload.fromTokens : null,
    toTokens: typeof payload.toTokens === "number" ? payload.toTokens : null,
    firstKeptEntryId: readString(payload.firstKeptEntryId),
    summaryDigest: readString(payload.summaryDigest),
    inputProvenance: readCompactionInputProvenance(payload.inputProvenance),
    cacheImpact: payload.cacheImpact ?? null,
    summaryGeneration: payload.summaryGeneration ?? null,
    droppedDigestStatus: readString(payload.droppedDigestStatus),
    resumeOutcome: readString(payload.resumeOutcome),
    gateClearOutcome: readString(payload.gateClearOutcome),
  };
}

function readCompactionTimeline(events: readonly { readonly payload?: unknown }[]): {
  readonly timeline: readonly ContextCockpitCompactionBaselineProjection[];
  readonly latestBaseline: ContextCockpitCompactionBaselineProjection | null;
  readonly inputProvenance: SessionCompactionInputProvenance | null;
} {
  const timeline = events
    .map(projectCompactionEvent)
    .filter((entry): entry is ContextCockpitCompactionBaselineProjection => entry !== null);
  const latestBaseline = timeline.at(-1) ?? null;
  return {
    timeline,
    latestBaseline,
    inputProvenance: latestBaseline?.inputProvenance ?? null,
  };
}

export interface ContextCockpitFormatOptions {
  readonly separator?: string;
}

function formatCockpitList(
  values: readonly string[],
  options?: ContextCockpitFormatOptions,
): string {
  return values.length > 0 ? values.join(options?.separator ?? ",") : "none";
}

export function formatCockpitSkillInvocations(
  records: readonly { readonly skillName: string }[],
  options?: ContextCockpitFormatOptions,
): string {
  return formatCockpitList(
    records.map((record) => record.skillName),
    options,
  );
}

export function formatCockpitRecallResults(
  results: readonly { readonly stableId: string }[],
  options?: ContextCockpitFormatOptions,
): string {
  return formatCockpitList(
    results.map((result) => result.stableId),
    options,
  );
}

export function formatCockpitResourceRefs(
  refs: readonly { readonly kind: string; readonly path: string }[],
  options?: ContextCockpitFormatOptions,
): string {
  return formatCockpitList(
    refs.map((ref) => `${ref.kind}:${ref.path}`),
    options,
  );
}

export function formatCockpitCompactionBaseline(
  value: ContextCockpitCompactionBaselineProjection | null,
): string {
  if (!value) {
    return "none";
  }
  return value.compactId ?? "present";
}

export function formatCockpitCompactionProvenance(value: unknown): string {
  if (!isRecord(value)) {
    return "none";
  }
  const schema = typeof value.schema === "string" ? value.schema : "unknown";
  const hiddenRecallSearch = value.hiddenRecallSearch === false ? "false" : "unknown";
  const attention = isRecord(value.attention) ? value.attention : null;
  const consumed = Array.isArray(attention?.consumedRefs) ? attention.consumedRefs.length : 0;
  const pinned = Array.isArray(attention?.pinnedRefs) ? attention.pinnedRefs.length : 0;
  const ignored = Array.isArray(attention?.ignoredRefs) ? attention.ignoredRefs.length : 0;
  const verifyPlans = Array.isArray(attention?.verifyPlanRefs)
    ? attention.verifyPlanRefs.length
    : 0;
  return `${schema}:hiddenRecallSearch=${hiddenRecallSearch}:attention=${consumed}/${pinned}/${ignored}/${verifyPlans}`;
}

export function buildContextCockpitReport(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
): ContextCockpitReport {
  const inspect = createCliInspectPort(runtime);
  const usage = inspect.context.usage(sessionId);
  const status = inspect.context.status(sessionId, usage);
  const skillSelection = inspect.skills.latestSelection(sessionId);
  const skillInvocationRecords = readSkillInvocationRecords(skillSelection);
  const capabilitySelection = inspect.skills.latestCapabilitySelection(sessionId);
  const recallResults = dedupeRecallResults(
    inspect.events
      .query(sessionId, { type: RECALL_RESULTS_SURFACED_EVENT_TYPE })
      .flatMap((event) => readRecallResults(event.payload)),
  );
  const workbenchEntries = inspect.workbench.list(sessionId);
  const compaction = readCompactionTimeline(
    inspect.events.query(sessionId, {
      type: RUNTIME_OPS_SESSION_COMPACTION_COMMITTED_KIND,
    }),
  );
  const cacheObservation = inspect.context.evidenceLatest(sessionId, "provider_cache_observation");

  return {
    sideEffectPolicy: "inspect_projection_only",
    context: {
      usage,
      status,
      gate: inspect.context.compactionGateStatus(sessionId, usage),
      pendingCompactionReason: inspect.context.pendingCompactionReason(sessionId),
      visibleReadEpoch: inspect.context.visibleReadEpoch(sessionId),
      historyBaseline: inspect.context.historyViewBaseline(sessionId),
    },
    workbench: {
      activeCount: workbenchEntries.length,
      entries: workbenchEntries,
    },
    skills: {
      selectionId: readSkillSelectionId(skillSelection),
      invocationRecords: skillInvocationRecords,
      resourceRefs: dedupeResourceRefs(skillInvocationRecords),
    },
    capabilities: {
      receiptRefs: readCapabilityReceiptRefs(capabilitySelection),
      latest: readCapabilityProjection(capabilitySelection),
    },
    recall: {
      results: recallResults,
    },
    compaction,
    cachePosture: resolveCachePosture(
      isRecord(cacheObservation?.payload) ? cacheObservation.payload : undefined,
    ),
  };
}
