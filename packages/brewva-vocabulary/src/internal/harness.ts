import { isProtocolRecord } from "./shared.js";

export const HARNESS_MANIFEST_SCHEMA = "brewva.harness.manifest.v1";
export const HARNESS_TRACE_SNAPSHOT_SCHEMA = "brewva.harness.trace_snapshot.v1";
export const HARNESS_PATTERN_CANDIDATE_SCHEMA = "brewva.harness.pattern_candidate.v1";
export const HARNESS_EVAL_REPORT_SCHEMA = "brewva.harness.eval_report.v1";
export const HARNESS_MANIFEST_RECORDED_EVENT_TYPE = "harness.manifest.recorded";
export const HARNESS_MANIFEST_RECORDED_EVENT_NAMESPACE = "runtime.ops";
export const HARNESS_MANIFEST_RECORDED_EVENT_VERSION = 1;
export const HARNESS_MANIFEST_RECORDED_EVENT_AUTHORITY = "advisory";

export type HarnessSeverity = "low" | "medium" | "high";
export type HarnessConfidence = "low" | "medium" | "high";

export type HarnessTraceSignalKind =
  | "provider_failure"
  | "tool_contract"
  | "context_pressure"
  | "skill_surface_miss"
  | "tool_surface_miss"
  | "verification_hygiene"
  | "cache_regression";

export interface HarnessProviderAttempt {
  readonly provider?: string;
  readonly api?: string;
  readonly model?: string;
  readonly transport?: string;
  readonly cachePolicyHash?: string;
  readonly requestHash?: string;
  readonly providerFallbackHash?: string;
  readonly providerFallbackActive?: boolean;
  readonly routeId?: string;
  readonly policyId?: string;
  readonly status?: "prepared" | "sent" | "ok" | "failed";
  readonly failureClass?: string;
}

export interface HarnessManifestRuntimeIdentity {
  readonly configHash?: string;
  readonly buildVersion?: string;
  readonly runtimeIdentityHash?: string;
}

export interface HarnessManifestPromptIdentity {
  readonly systemPromptHash?: string;
  readonly blockHashes?: readonly string[];
  readonly stabilityHash?: string;
}

export interface HarnessManifestToolIdentity {
  readonly activeToolNames?: readonly string[];
  readonly toolSchemaSnapshotHash?: string;
  readonly toolSurfaceEventId?: string;
}

export interface HarnessManifestSkillSelection {
  readonly selectionId?: string;
  readonly mode?: string;
  readonly selectedSkillIds?: readonly string[];
  readonly renderedContextHash?: string;
}

export interface HarnessManifestCapabilitySelection {
  readonly selectionId?: string;
  readonly selectedCapabilityNames?: readonly string[];
}

export interface HarnessManifestContextIdentity {
  readonly materializationPolicyHash?: string;
  readonly compactionPolicyHash?: string;
  readonly promptStablePrefixHash?: string;
  readonly promptDynamicTailHash?: string;
  readonly contextEvidenceHashes?: readonly string[];
}

export interface HarnessManifestPluginIdentity {
  readonly mutatingHookIds?: readonly string[];
}

export interface HarnessManifestSourceRefs {
  readonly sourceEventIds?: readonly string[];
  readonly sourceArtifactRefs?: readonly string[];
}

export interface HarnessManifest {
  readonly schema: typeof HARNESS_MANIFEST_SCHEMA;
  readonly eventType: typeof HARNESS_MANIFEST_RECORDED_EVENT_TYPE;
  readonly manifestId: string;
  readonly sessionId: string;
  readonly turn?: number;
  readonly turnId?: string;
  readonly attempt: number;
  readonly runtime?: HarnessManifestRuntimeIdentity;
  readonly prompt?: HarnessManifestPromptIdentity;
  readonly tools?: HarnessManifestToolIdentity;
  readonly skillSelection?: HarnessManifestSkillSelection;
  readonly capabilitySelection?: HarnessManifestCapabilitySelection;
  readonly context?: HarnessManifestContextIdentity;
  readonly provider?: HarnessProviderAttempt;
  readonly plugins?: HarnessManifestPluginIdentity;
  readonly refs?: HarnessManifestSourceRefs;
}

export type BuildHarnessManifestInput = Omit<
  HarnessManifest,
  "schema" | "eventType" | "manifestId"
> &
  Partial<Pick<HarnessManifest, "schema" | "eventType" | "manifestId">>;

export interface HarnessTraceSignal {
  readonly kind: HarnessTraceSignalKind;
  readonly severity: HarnessSeverity;
  readonly reason: string;
  readonly eventIds: readonly string[];
}

export interface HarnessTraceSnapshot {
  readonly schema: typeof HARNESS_TRACE_SNAPSHOT_SCHEMA;
  readonly snapshotId: string;
  readonly sessionId: string;
  readonly turn?: number;
  readonly turnId?: string;
  readonly attempt: number;
  readonly manifestId: string;
  readonly eventIds: readonly string[];
  readonly updatedAt?: number;
  readonly manifest?: HarnessManifest;
  readonly provider: {
    readonly provider?: string;
    readonly api?: string;
    readonly model?: string;
    readonly attempts: number;
    readonly failures: number;
    readonly fallbackActive: boolean;
  };
  readonly context: {
    readonly usageRatio: number | null;
    readonly gateRequired: boolean;
  };
  readonly cache: {
    readonly status: string | null;
    readonly unexpectedBreak: boolean;
    readonly changedFields: readonly string[];
  };
  readonly skills: {
    readonly selectionId: string | null;
    readonly selectedSkillIds: readonly string[];
    readonly omittedCount: number;
  };
  readonly tools: {
    readonly activeToolNames: readonly string[];
    readonly requestedUnknownToolNames: readonly string[];
    readonly committed: number;
    readonly errors: number;
    readonly inconclusive: number;
  };
  readonly verification: {
    readonly weakEvidence: boolean;
  };
  readonly outcome: {
    readonly status: string | null;
  };
  readonly signals: readonly HarnessTraceSignal[];
}

export interface HarnessPatternCandidate {
  readonly schema: typeof HARNESS_PATTERN_CANDIDATE_SCHEMA;
  readonly candidateId: string;
  readonly kind: HarnessTraceSignalKind;
  readonly sourceSnapshotIds: readonly string[];
  readonly sourceEventIds: readonly string[];
  readonly manifestIds: readonly string[];
  readonly occurrenceCount: number;
  readonly severity: HarnessSeverity;
  readonly confidence: HarnessConfidence;
  readonly reasons: readonly string[];
  readonly promotionPath: "governed_harness_candidate";
}

export interface HarnessComparisonReport {
  readonly schema: typeof HARNESS_EVAL_REPORT_SCHEMA;
  readonly mode: "manifest" | "fixture" | "real";
  readonly sourceSessionId: string;
  readonly targetSessionId?: string;
  readonly divergeAt: string;
  readonly baseManifestId: string;
  readonly candidateManifestId: string;
  readonly changedFields: readonly string[];
  readonly sideEffectPolicy:
    | "no_provider_or_tool_execution"
    | "fixture_provider_and_noop_tools"
    | "explicit_real_target_session_only";
  readonly metrics: {
    readonly changedFieldCount: number;
    readonly regressions: readonly string[];
    readonly execution?: {
      readonly replayEventCount: number;
      readonly targetEventCount: number;
      readonly frameCount: number;
      readonly runtimeEventFrameCount: number;
      readonly textFrameCount: number;
      readonly reasonFrameCount: number;
      readonly toolCallFrameCount: number;
      readonly toolProgressFrameCount: number;
      readonly suspensionFrameCount: number;
      readonly durationMs: number;
      readonly providerExecuted: boolean;
      readonly toolExecutorMode: "fixture_noop" | "hosted";
      readonly promptSource:
        | "source_turn_after_divergence"
        | "source_turn_at_divergence"
        | "synthetic";
    };
  };
  readonly promotion: {
    readonly recommendation: "promote" | "review_required" | "reject";
    readonly reason: string;
  };
}

export interface HarnessEvalTelemetry {
  readonly kind: "harness";
  readonly report: HarnessComparisonReport;
}

export interface ClusterHarnessTraceSnapshotsOptions {
  readonly minOccurrences?: number;
}

export interface HarnessManifestRecordedAdvisoryPayload {
  readonly namespace: typeof HARNESS_MANIFEST_RECORDED_EVENT_NAMESPACE;
  readonly kind: typeof HARNESS_MANIFEST_RECORDED_EVENT_TYPE;
  readonly version: typeof HARNESS_MANIFEST_RECORDED_EVENT_VERSION;
  readonly authority: typeof HARNESS_MANIFEST_RECORDED_EVENT_AUTHORITY;
  readonly payload: HarnessManifest;
}

const UNSAFE_MANIFEST_FIELD_NAMES = new Set([
  "rawPrompt",
  "raw_prompt",
  "rawSystemPrompt",
  "raw_system_prompt",
  "systemPrompt",
  "system_prompt",
  "rawToolSchema",
  "raw_tool_schema",
  "toolSchema",
  "tool_schema",
  "rawPayload",
  "raw_payload",
  "providerPayload",
  "provider_payload",
  "fullProviderPayload",
  "full_provider_payload",
  "credentials",
  "credential",
  "credentialRef",
  "credential_ref",
  "apiKey",
  "api_key",
  "secret",
  "env",
  "environment",
]);

export function buildHarnessManifest(input: BuildHarnessManifestInput): HarnessManifest {
  const redacted = redactHarnessManifest({
    ...input,
    schema: HARNESS_MANIFEST_SCHEMA,
    eventType: HARNESS_MANIFEST_RECORDED_EVENT_TYPE,
    manifestId: input.manifestId ?? "harness_manifest:pending",
  });
  const canonicalForId = stableCanonicalize({
    ...redacted,
    manifestId: undefined,
  });
  const hash = stableDigest(canonicalForId);
  return {
    ...redacted,
    manifestId:
      input.manifestId && input.manifestId.length > 0
        ? input.manifestId
        : `harness_manifest:${hash}`,
  };
}

export function redactHarnessManifest(input: unknown): HarnessManifest {
  assertHarnessManifestPayloadSafe(input);
  if (!isProtocolRecord(input)) {
    throw new Error("harness_manifest_invalid:not_record");
  }
  const sessionId = readRequiredString(input, "sessionId");
  const attempt = readRequiredNumber(input, "attempt");
  const manifestId = readRequiredString(input, "manifestId");
  const runtime = readOptionalRecord(input, "runtime") as
    | HarnessManifestRuntimeIdentity
    | undefined;
  const prompt = readOptionalRecord(input, "prompt") as HarnessManifestPromptIdentity | undefined;
  const tools = readOptionalRecord(input, "tools") as HarnessManifestToolIdentity | undefined;
  const skillSelection = readOptionalRecord(input, "skillSelection") as
    | HarnessManifestSkillSelection
    | undefined;
  const capabilitySelection = readOptionalRecord(input, "capabilitySelection") as
    | HarnessManifestCapabilitySelection
    | undefined;
  const context = readOptionalRecord(input, "context") as
    | HarnessManifestContextIdentity
    | undefined;
  const provider = readOptionalRecord(input, "provider") as HarnessProviderAttempt | undefined;
  const plugins = readOptionalRecord(input, "plugins") as HarnessManifestPluginIdentity | undefined;
  const refs = readOptionalRecord(input, "refs") as HarnessManifestSourceRefs | undefined;
  return {
    schema: HARNESS_MANIFEST_SCHEMA,
    eventType: HARNESS_MANIFEST_RECORDED_EVENT_TYPE,
    manifestId,
    sessionId,
    attempt,
    ...optionalNumberField(input, "turn"),
    ...optionalStringField(input, "turnId"),
    ...(runtime ? { runtime } : {}),
    ...(prompt ? { prompt } : {}),
    ...(tools ? { tools } : {}),
    ...(skillSelection ? { skillSelection } : {}),
    ...(capabilitySelection ? { capabilitySelection } : {}),
    ...(context ? { context } : {}),
    ...(provider ? { provider } : {}),
    ...(plugins ? { plugins } : {}),
    ...(refs ? { refs } : {}),
  };
}

export function wrapHarnessManifestRecordedAdvisoryPayload(
  manifest: HarnessManifest,
): HarnessManifestRecordedAdvisoryPayload {
  return {
    namespace: HARNESS_MANIFEST_RECORDED_EVENT_NAMESPACE,
    kind: HARNESS_MANIFEST_RECORDED_EVENT_TYPE,
    version: HARNESS_MANIFEST_RECORDED_EVENT_VERSION,
    authority: HARNESS_MANIFEST_RECORDED_EVENT_AUTHORITY,
    payload: manifest,
  };
}

export function unwrapHarnessManifestRecordedAdvisoryPayload(input: {
  readonly type?: unknown;
  readonly payload?: unknown;
}): Record<string, unknown> | undefined {
  if (input.type !== "custom") {
    return undefined;
  }
  if (!isProtocolRecord(input.payload)) {
    return undefined;
  }
  if (input.payload.namespace !== HARNESS_MANIFEST_RECORDED_EVENT_NAMESPACE) {
    return undefined;
  }
  if (input.payload.kind !== HARNESS_MANIFEST_RECORDED_EVENT_TYPE) {
    return undefined;
  }
  if (input.payload.version !== HARNESS_MANIFEST_RECORDED_EVENT_VERSION) {
    return undefined;
  }
  if (input.payload.authority !== HARNESS_MANIFEST_RECORDED_EVENT_AUTHORITY) {
    return undefined;
  }
  return isProtocolRecord(input.payload.payload) ? input.payload.payload : undefined;
}

export function clusterHarnessTraceSnapshots(
  snapshots: readonly HarnessTraceSnapshot[],
  options: ClusterHarnessTraceSnapshotsOptions = {},
): HarnessPatternCandidate[] {
  const minOccurrences = Math.max(1, options.minOccurrences ?? 2);
  const grouped = new Map<HarnessTraceSignalKind, HarnessTraceSnapshot[]>();

  for (const snapshot of snapshots) {
    for (const kind of new Set(snapshot.signals.map((signal) => signal.kind))) {
      const bucket = grouped.get(kind) ?? [];
      bucket.push(snapshot);
      grouped.set(kind, bucket);
    }
  }

  const candidates: HarnessPatternCandidate[] = [];
  for (const [kind, sourceSnapshots] of grouped) {
    if (sourceSnapshots.length < minOccurrences) continue;
    const sourceSnapshotIds = sourceSnapshots.map((snapshot) => snapshot.snapshotId).toSorted();
    const sourceEventIds = [
      ...new Set(sourceSnapshots.flatMap((snapshot) => snapshot.eventIds)),
    ].toSorted();
    const manifestIds = [
      ...new Set(sourceSnapshots.map((snapshot) => snapshot.manifestId)),
    ].toSorted();
    const reasons = [
      ...new Set(
        sourceSnapshots.flatMap((snapshot) =>
          snapshot.signals.filter((signal) => signal.kind === kind).map((signal) => signal.reason),
        ),
      ),
    ].toSorted();
    const severity = highestSeverity(
      sourceSnapshots.flatMap((snapshot) =>
        snapshot.signals.filter((signal) => signal.kind === kind).map((signal) => signal.severity),
      ),
    );
    candidates.push({
      schema: HARNESS_PATTERN_CANDIDATE_SCHEMA,
      candidateId: stableHarnessId("harness_candidate", {
        kind,
        sourceSnapshotIds,
        manifestIds,
      }),
      kind,
      sourceSnapshotIds,
      sourceEventIds,
      manifestIds,
      occurrenceCount: sourceSnapshots.length,
      severity,
      confidence: confidenceFor(sourceSnapshots.length, severity),
      reasons,
      promotionPath: "governed_harness_candidate",
    });
  }

  return candidates.toSorted((left, right) => {
    const severityDelta = severityRank(right.severity) - severityRank(left.severity);
    return severityDelta === 0 ? left.kind.localeCompare(right.kind) : severityDelta;
  });
}

export function assertHarnessManifestPayloadSafe(input: unknown): void {
  visitManifestValue(input, []);
}

export function stableHarnessId(prefix: string, value: unknown): string {
  return `${prefix}:${stableDigest(stableCanonicalize(value))}`;
}

export function stableCanonicalize(value: unknown): string {
  return JSON.stringify(normalizeForStableJson(value));
}

function normalizeForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForStableJson);
  }
  if (!isProtocolRecord(value)) {
    return value === undefined ? null : value;
  }
  const output: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) {
    const entry = value[key];
    if (entry === undefined) continue;
    output[key] = normalizeForStableJson(entry);
  }
  return output;
}

function stableDigest(input: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0");
}

function highestSeverity(values: readonly HarnessSeverity[]): HarnessSeverity {
  return values.reduce<HarnessSeverity>(
    (current, value) => (severityRank(value) > severityRank(current) ? value : current),
    "low",
  );
}

function severityRank(value: HarnessSeverity): number {
  switch (value) {
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
  }
  value satisfies never;
  throw new Error("unknown_harness_severity");
}

function confidenceFor(occurrenceCount: number, severity: HarnessSeverity): HarnessConfidence {
  if (occurrenceCount <= 1) return "low";
  if (severity === "low") return "medium";
  return "high";
}

function visitManifestValue(value: unknown, path: readonly string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visitManifestValue(entry, [...path, String(index)]));
    return;
  }
  if (!isProtocolRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (UNSAFE_MANIFEST_FIELD_NAMES.has(key)) {
      throw new Error(`harness_manifest_unsafe_field:${key}`);
    }
    visitManifestValue(entry, [...path, key]);
  }
}

function readRequiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`harness_manifest_invalid:${key}`);
  }
  return value;
}

function readRequiredNumber(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`harness_manifest_invalid:${key}`);
  }
  return value;
}

function optionalStringField<T extends "turnId">(
  record: Record<string, unknown>,
  key: T,
): Partial<Record<T, string>> {
  const value = record[key];
  return typeof value === "string" && value.length > 0
    ? ({ [key]: value } as Partial<Record<T, string>>)
    : {};
}

function optionalNumberField<T extends "turn">(
  record: Record<string, unknown>,
  key: T,
): Partial<Record<T, number>> {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? ({ [key]: value } as Partial<Record<T, number>>)
    : {};
}

function readOptionalRecord(record: Record<string, unknown>, key: string): object | undefined {
  const value = record[key];
  return isProtocolRecord(value) ? value : undefined;
}
