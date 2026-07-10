import { redactedStableJsonSha256Hex } from "@brewva/brewva-std/hash";
import { isProtocolRecord } from "./shared.js";

export const HARNESS_MANIFEST_SCHEMA = "brewva.harness.manifest.v1";
export const HARNESS_TRACE_SNAPSHOT_SCHEMA = "brewva.harness.trace_snapshot.v1";
export const HARNESS_PATTERN_CANDIDATE_SCHEMA = "brewva.harness.pattern_candidate.v1";
export const HARNESS_EVAL_REPORT_SCHEMA = "brewva.harness.eval_report.v1";
export const HARNESS_MANIFEST_RECORDED_EVENT_TYPE = "harness.manifest.recorded";
export const HARNESS_MANIFEST_RECORDED_EVENT_NAMESPACE = "runtime.ops";
export const HARNESS_MANIFEST_RECORDED_EVENT_VERSION = 1;
export const HARNESS_MANIFEST_RECORDED_EVENT_AUTHORITY = "advisory";

/**
 * Advisory runtime-ops event kinds emitted by the hosted gateway runtime-ops
 * builders. Each literal is referenced at multiple sites — the emit call, any
 * latest-payload read, and (for the folded kinds) the session-index harness
 * switch — which must all agree. When sites spelled the literal independently
 * they drifted (e.g. `skill_selection_recorded` vs `skill.selection.recorded`),
 * silently turning the harness fold into dead code. Centralizing each literal
 * here gives every site one source of truth, mirroring
 * `VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE` in `iteration`.
 *
 * Folded by `foldHarnessEvidence`: skill-selection, context-evidence, and
 * tool-surface. `CAPABILITY_SELECTION_RECORDED_EVENT_TYPE` is not folded — it is
 * emitted and read back co-located in the tools builder — but is centralized for
 * the same reason (two in-file references that must not drift).
 *
 * `CONTEXT_EVIDENCE_APPENDED_EVENT_TYPE` intentionally keeps its snake_case wire
 * value: it is persisted on the tape, so dotting it would break replay of
 * existing records for no functional gain. Canonical kernel kinds folded by the
 * same switch (`tool.committed`, `runtime.suspended`, `turn.ended`) are not
 * redefined here — their single source of truth is `CANONICAL_EVENT_TYPES` in
 * `@brewva/brewva-runtime`, which this package does not depend on.
 */
export const SKILL_SELECTION_RECORDED_EVENT_TYPE = "skill.selection.recorded" as const;
export const CAPABILITY_SELECTION_RECORDED_EVENT_TYPE = "tool.capability.selected" as const;
export const CONTEXT_EVIDENCE_APPENDED_EVENT_TYPE = "context_evidence_appended" as const;
export const TOOL_SURFACE_RESOLVED_EVENT_TYPE = "tool.surface.resolved" as const;

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

export interface HarnessManifestPerToolIdentity {
  readonly name: string;
  /** hash(name + description + parameters) for the tool as advertised. */
  readonly identityHash: string;
}

export interface HarnessManifestToolIdentity {
  readonly activeToolNames?: readonly string[];
  readonly toolSchemaSnapshotHash?: string;
  readonly toolSurfaceEventId?: string;
  /**
   * Per-tool identity for the surface advertised in this attempt: each entry's
   * `identityHash` = hash(name + description + parameters). Unlike
   * `toolSchemaSnapshotHash` (whole-surface, schema-only) this pins each tool's
   * full advertised identity — including the description the model actually saw —
   * so a commitment that references this manifest can be verified per tool at
   * execution time. Modeled as a list, not a keyed record, so tool names stay
   * values (like `activeToolNames`) and never become manifest keys subject to the
   * field-name redaction check.
   */
  readonly perToolIdentity?: readonly HarnessManifestPerToolIdentity[];
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

export const HARNESS_CANDIDATE_LIFECYCLE_SCHEMA = "brewva.harness.candidate_lifecycle.v1";

export const HARNESS_CANDIDATE_LIFECYCLE_ACTIONS = [
  "evaluated",
  "accepted",
  "rejected",
  "archived",
] as const;

export type HarnessCandidateLifecycleAction = (typeof HARNESS_CANDIDATE_LIFECYCLE_ACTIONS)[number];

/**
 * One append-only lifecycle receipt for a harness candidate. `evaluated`
 * records are appended by compare runs and carry the report's key facts;
 * `accepted`/`rejected`/`archived` are accountable operator decisions
 * (`brewva harness candidate <verb>`) and carry the operator's reason. The
 * runtime holds no promotion authority: these records are the audit trail of
 * human decisions, never an input to any gate.
 */
export interface HarnessCandidateLifecycleRecord {
  readonly schema: typeof HARNESS_CANDIDATE_LIFECYCLE_SCHEMA;
  readonly candidateId: string;
  readonly action: HarnessCandidateLifecycleAction;
  readonly at: string;
  readonly actor: "operator_cli";
  readonly baseManifestId?: string;
  readonly candidateManifestId?: string;
  readonly sourceSessionId?: string;
  readonly targetSessionId?: string;
  readonly mode?: HarnessComparisonReport["mode"];
  readonly recommendation?: HarnessComparisonReport["promotion"]["recommendation"];
  readonly regressionCount?: number;
  readonly reason?: string;
}

/**
 * Guard for ledger lines: the schema owner decides what counts as a record so
 * readers never drift from the vocabulary. The action check derives from the
 * const action list — an unknown action (newer writer, hand edit) is not a
 * record rather than a lie to the type system.
 */
export function isHarnessCandidateLifecycleRecord(
  value: unknown,
): value is HarnessCandidateLifecycleRecord {
  if (!isProtocolRecord(value)) {
    return false;
  }
  const record = value as Partial<HarnessCandidateLifecycleRecord>;
  return (
    record.schema === HARNESS_CANDIDATE_LIFECYCLE_SCHEMA &&
    typeof record.candidateId === "string" &&
    record.candidateId.length > 0 &&
    typeof record.action === "string" &&
    (HARNESS_CANDIDATE_LIFECYCLE_ACTIONS as readonly string[]).includes(record.action) &&
    typeof record.at === "string" &&
    record.actor === "operator_cli"
  );
}

/**
 * The candidate identity is the (base, candidate) manifest pair — both ids
 * are content hashes, so the same delta authored twice collapses to one
 * candidate across compare runs, eval reports, and lifecycle receipts.
 */
export function buildHarnessCandidateId(input: {
  readonly baseManifestId: string;
  readonly candidateManifestId: string;
}): string {
  return stableHarnessId("harness_candidate_pair", {
    baseManifestId: input.baseManifestId,
    candidateManifestId: input.candidateManifestId,
  });
}

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

export interface HarnessTraceSnapshotIdentityInput {
  readonly sessionId: string;
  readonly turn?: number;
  readonly turnId?: string;
  readonly attempt: number;
  readonly manifestId: string;
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
  /**
   * Stable candidate identity across the improvement workflows: the same
   * (base, candidate) manifest pair yields the same id in a harness compare,
   * an eval A/B report, and a lifecycle accept/reject/archive receipt.
   */
  readonly candidateId: string;
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
      /**
       * Manifest describing the harness that actually executed the fork. A
       * replay report is candidate evidence only when this equals
       * `candidateManifestId`; a mismatch is recorded as an execution
       * regression and must never promote.
       */
      readonly executedManifestId: string;
      /**
       * Where the fork's tool effects landed: `trial_world` is a disposable
       * copy-on-write fork of the workspace (real mode, always), while
       * `shared_operator_cwd` marks executions whose tool executor never
       * touches the filesystem (fixture no-op tools).
       */
      readonly workspaceMode: "trial_world" | "shared_operator_cwd";
      /** Candidate fields applied through an execution seam (materialization). */
      readonly materializedFields?: readonly string[];
      /** Content-addressed world id of what the trial fork saw at creation. */
      readonly trialWorldBasisId?: string;
      /**
       * Enumeration backend the trial-world basis used: `git` forks carry a
       * usable `.git`; `walk` forks (linked worktrees) are git-less, which
       * explains environment-caused divergence git tooling would otherwise
       * mask as a candidate regression.
       */
      readonly trialWorldSource?: "git" | "walk";
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
  return {
    ...redacted,
    manifestId:
      input.manifestId && input.manifestId.length > 0
        ? input.manifestId
        : stableHarnessId("harness_manifest", {
            ...redacted,
            manifestId: undefined,
          }),
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

export function readHarnessManifestRecordedAdvisoryEvent(input: {
  readonly type?: unknown;
  readonly payload?: unknown;
}): HarnessManifest | undefined {
  const payload = unwrapHarnessManifestRecordedAdvisoryPayload(input);
  return payload ? redactHarnessManifest(payload) : undefined;
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
  return `${prefix}:${redactedStableJsonSha256Hex(value).slice(0, 32)}`;
}

export function buildHarnessTraceSnapshotId(input: HarnessTraceSnapshotIdentityInput): string {
  return stableHarnessId("harness_snapshot", {
    sessionId: input.sessionId,
    ...(input.turn === undefined ? {} : { turn: input.turn }),
    ...(input.turnId === undefined ? {} : { turnId: input.turnId }),
    attempt: input.attempt,
    manifestId: input.manifestId,
  });
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
