import { resolve } from "node:path";
import type {
  BrewvaConfig,
  BrewvaRuntime,
  BrewvaRuntimeIdentity,
  CanonicalEvent,
  DeepReadonly,
  RuntimePhysicsDeclaration,
  RuntimeProviderFrame,
  RuntimeProviderPort,
  RuntimeToolAuthorityResolver,
  RuntimeToolExecutorPort,
  TurnFrame,
} from "@brewva/brewva-runtime";
import { createBrewvaRuntime, isForkReplayEventId } from "@brewva/brewva-runtime";
import { createActionPolicyRegistry, resolveToolAuthority } from "@brewva/brewva-runtime/security";
import { isRecord, toErrorMessage } from "@brewva/brewva-std/unknown";
import {
  HARNESS_EVAL_REPORT_SCHEMA,
  HARNESS_TRACE_SNAPSHOT_SCHEMA,
  buildHarnessTraceSnapshotId,
  readHarnessManifestRecordedAdvisoryEvent,
  type HarnessComparisonReport,
  type HarnessManifest,
  type HarnessTraceSignal,
  type HarnessTraceSnapshot,
} from "@brewva/brewva-vocabulary/harness";
import { buildHarnessCandidatePatch } from "./internal/candidate-patch.js";
import { readManifestFieldValue, stableCompareJson } from "./internal/manifest-diff.js";
import {
  resolveHarnessCandidatePatchMaterialization,
  type HarnessCandidateMaterialization,
} from "./internal/materialize.js";

export { clusterHarnessTraceSnapshots } from "@brewva/brewva-vocabulary/harness";
export {
  appendHarnessCandidateLifecycleRecord,
  readHarnessCandidateLifecycleRecords,
  resolveHarnessCandidateLedgerPath,
} from "./internal/candidate-ledger.js";
export {
  countProposalBacklog,
  unconsumedHarnessCandidates,
} from "./internal/proposal-backpressure.js";
export {
  buildHarnessCandidatePatch,
  type HarnessCandidatePatch,
} from "./internal/candidate-patch.js";
export { diffHarnessManifestFields } from "./internal/manifest-diff.js";
export {
  resolveHarnessCandidatePatchMaterialization,
  type HarnessBlockedFieldReason,
  type HarnessCandidateMaterialization,
  type HarnessCandidateMaterializationRefusal,
  type HarnessCandidateMaterializationResult,
} from "./internal/materialize.js";

export interface BuildHarnessTraceSnapshotInput {
  readonly manifest: HarnessManifest;
  readonly eventIds?: readonly string[];
  readonly updatedAt?: number;
  readonly signals?: readonly HarnessTraceSignal[];
  readonly providerFailures?: number;
  readonly toolCommits?: number;
  readonly toolErrors?: number;
  readonly toolInconclusive?: number;
  readonly requestedUnknownToolNames?: readonly string[];
  readonly contextUsageRatio?: number | null;
  readonly contextGateRequired?: boolean;
  readonly cacheStatus?: string | null;
  readonly cacheUnexpectedBreak?: boolean;
  readonly cacheChangedFields?: readonly string[];
  readonly skillOmittedCount?: number;
  readonly verificationWeakEvidence?: boolean;
  readonly outcomeStatus?: string | null;
}

export type BuildPreflightHarnessTraceSnapshotInput = BuildHarnessTraceSnapshotInput;

export interface CompareHarnessCandidateInput {
  readonly mode?: "manifest" | "fixture" | "real";
  /**
   * Candidate identity minted from the normalized editable delta
   * (`buildHarnessCandidatePatch`). Callers that hold both manifests derive
   * it there; callers with only ids must carry the id produced by the run
   * that had them — there is no pair-of-ids fallback, because a session-bound
   * manifest pair would split one edit into many candidates.
   */
  readonly candidateId: string;
  readonly sourceSessionId: string;
  readonly targetSessionId?: string;
  readonly divergeAt: string;
  readonly baseManifestId: string;
  readonly candidateManifestId: string;
  readonly changedFields?: readonly string[];
  readonly regressions?: readonly string[];
  readonly execution?: HarnessComparisonReport["metrics"]["execution"];
}

export interface HarnessRuntimeFactory {
  readonly runtime?: Pick<BrewvaRuntime, "tape">;
  createRuntime(input: { readonly physics: RuntimePhysicsDeclaration }): BrewvaRuntime;
}

/**
 * Build a harness runtime factory from a hosted adapter's identity/config/tape,
 * creating independent replay runtimes via `createBrewvaRuntime` directly. This
 * keeps replay-fork creation explicit in the harness and lets the hosted adapter
 * drop its general `createRuntime` surface (WS3).
 *
 * Fixture comparisons create their fork from this factory. Real comparisons do
 * NOT — they attach the caller-owned trial runtime (see
 * `ExecuteHarnessCandidateComparisonInput.attachedRuntime`) so the target
 * session has exactly one tape writer.
 */
export function toHarnessRuntimeFactory(adapter: {
  readonly identity: Pick<BrewvaRuntimeIdentity, "cwd" | "agentId">;
  readonly config: DeepReadonly<BrewvaConfig>;
  readonly runtime: Pick<BrewvaRuntime, "tape">;
}): HarnessRuntimeFactory {
  return {
    runtime: { tape: adapter.runtime.tape },
    createRuntime: ({ physics }) =>
      createBrewvaRuntime({
        cwd: adapter.identity.cwd,
        agentId: adapter.identity.agentId,
        config: structuredClone(adapter.config) as BrewvaConfig,
        physics,
      }),
  };
}

/**
 * Clone a hosted adapter's config with every durable data root absolutized
 * against the adapter's WORKSPACE root (config data paths are
 * workspace-relative by contract — `createRuntimeTape` resolves against
 * `identity.workspaceRoot`, so anchoring on `cwd` would silently split the
 * store when the operator runs from a subdirectory). A runtime created over a
 * trial world with this config keeps its tool-path authority at the trial
 * root while its tape/ledger/projection/worlds evidence lands in the operator
 * store — the fork's durable trace survives the trial world's disposal and
 * the target-emptiness guard inspects the same store the fork writes.
 */
export function absolutizeHarnessDataRoots(adapter: {
  readonly identity: Pick<BrewvaRuntimeIdentity, "workspaceRoot">;
  readonly config: DeepReadonly<BrewvaConfig>;
}): BrewvaConfig {
  const config = structuredClone(adapter.config) as BrewvaConfig;
  const operatorRoot = adapter.identity.workspaceRoot;
  config.tape.dir = resolve(operatorRoot, config.tape.dir);
  config.ledger.path = resolve(operatorRoot, config.ledger.path);
  config.projection.dir = resolve(operatorRoot, config.projection.dir);
  config.worlds.dir = resolve(operatorRoot, config.worlds.dir);
  return config;
}

export interface HarnessCandidateExecutionPorts {
  readonly provider: RuntimeProviderPort;
  readonly toolExecutor: RuntimeToolExecutorPort;
  readonly resolveToolAuthority?: RuntimeToolAuthorityResolver;
}

/**
 * The disposable copy-on-write fork a real comparison runs in. It is NOT a
 * caller-declarable field of its own — it rides on {@link
 * HarnessAttachedTrialRuntime} because the runtime and the world it is rooted
 * at are one thing (the trial adapter created both). Fixture mode has no
 * attached runtime and therefore no trial world; its no-op tools touch nothing
 * (`shared_operator_cwd`).
 */
export interface HarnessTrialWorldDescriptor {
  /** Absolute root of the disposable fork the execution runs in. */
  readonly root: string;
  /** Content-addressed world id of what the fork saw at creation. */
  readonly basisWorldId: string;
  /** Enumeration backend the basis capture used. */
  readonly source: "git" | "walk";
  /**
   * Content hash of the operator settings tree copied into the fork
   * (`.brewva/agent`). The basis id excludes runtime data roots by design, so
   * this is the second half of the trial environment's identity.
   */
  readonly settingsHash?: string;
}

/**
 * Real-mode execution substrate: the caller-owned trial runtime AND the trial
 * world it is rooted at, as one object. Coupling them is the point — a real
 * run cannot claim a trial world without the runtime that owns it, and cannot
 * attach a runtime while claiming it ran against the live tree. Its physics
 * already declares the replay-then-real fork, its tape is the ONLY writer for
 * the target session (the hosted session that supplies the execution ports is
 * built over this same runtime, so provider-manifest advisories and turn/tool
 * events share one commit port and one parent chain), and its lifecycle stays
 * with the caller — the comparison starts it and reads its tape, but closing
 * it must outlive the hosted session feeding its ports.
 */
export interface HarnessAttachedTrialRuntime {
  readonly runtime: BrewvaRuntime;
  /** The fork the runtime is rooted at; its containment evidence for the report. */
  readonly world: HarnessTrialWorldDescriptor;
  /**
   * Bind the execution ports the trial runtime's late-bound physics thunks
   * will consume. The comparison calls this exactly once, with its
   * instrumented (execution-probed) view of the caller's ports, before
   * starting the runtime — so instrumentation cannot be skipped by wiring
   * ports around the API.
   */
  bindPorts(ports: HarnessCandidateExecutionPorts): void;
}

export interface ExecuteHarnessCandidateComparisonInput {
  readonly mode: "fixture" | "real";
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly divergeAt: string;
  readonly baseManifest: HarnessManifest;
  readonly candidateManifest: HarnessManifest;
  readonly sourceEvents: readonly CanonicalEvent[];
  /** Fixture-fork creation and operator-store tape reads. */
  readonly runtime: HarnessRuntimeFactory;
  /**
   * Required in real mode, absent in fixture mode: the single-writer trial
   * runtime and its fork. Its presence IS the "ran in a trial world" claim —
   * there is no separate workspace assertion that could contradict it.
   */
  readonly attachedRuntime?: HarnessAttachedTrialRuntime;
  readonly changedFields?: readonly string[];
  readonly regressions?: readonly string[];
  readonly ports?: HarnessCandidateExecutionPorts;
  readonly prompt?: string;
}

// Builds an in-memory preflight snapshot from a manifest and explicit metrics.
// Tape-derived downstream evidence is owned by the session-index projection.
export function buildPreflightHarnessTraceSnapshot(
  input: BuildPreflightHarnessTraceSnapshotInput,
): HarnessTraceSnapshot {
  const manifest = input.manifest;
  const eventIds = [...new Set(input.eventIds ?? manifest.refs?.sourceEventIds ?? [])].toSorted();
  const signals = [...(input.signals ?? [])];
  return {
    schema: HARNESS_TRACE_SNAPSHOT_SCHEMA,
    snapshotId: buildHarnessTraceSnapshotId({
      sessionId: manifest.sessionId,
      ...(manifest.turn === undefined ? {} : { turn: manifest.turn }),
      ...(manifest.turnId === undefined ? {} : { turnId: manifest.turnId }),
      attempt: manifest.attempt,
      manifestId: manifest.manifestId,
    }),
    sessionId: manifest.sessionId,
    ...(manifest.turn === undefined ? {} : { turn: manifest.turn }),
    ...(manifest.turnId === undefined ? {} : { turnId: manifest.turnId }),
    attempt: manifest.attempt,
    manifestId: manifest.manifestId,
    eventIds,
    ...(input.updatedAt === undefined ? {} : { updatedAt: input.updatedAt }),
    manifest,
    provider: {
      provider: manifest.provider?.provider,
      api: manifest.provider?.api,
      model: manifest.provider?.model,
      attempts: 1,
      failures:
        input.providerFailures ??
        signals.filter((signal) => signal.kind === "provider_failure").length,
      fallbackActive: manifest.provider?.providerFallbackActive ?? false,
    },
    context: {
      usageRatio: input.contextUsageRatio ?? null,
      gateRequired: input.contextGateRequired ?? false,
    },
    cache: {
      status: input.cacheStatus ?? null,
      unexpectedBreak: input.cacheUnexpectedBreak ?? false,
      changedFields: input.cacheChangedFields ?? [],
    },
    skills: {
      selectionId: manifest.skillSelection?.selectionId ?? null,
      selectedSkillIds: manifest.skillSelection?.selectedSkillIds ?? [],
      omittedCount: input.skillOmittedCount ?? 0,
    },
    tools: {
      activeToolNames: manifest.tools?.activeToolNames ?? [],
      requestedUnknownToolNames: input.requestedUnknownToolNames ?? [],
      committed: input.toolCommits ?? 0,
      errors: input.toolErrors ?? 0,
      inconclusive: input.toolInconclusive ?? 0,
    },
    verification: {
      weakEvidence: input.verificationWeakEvidence ?? false,
    },
    outcome: {
      status: input.outcomeStatus ?? null,
    },
    signals,
  };
}

export function compareHarnessCandidate(
  input: CompareHarnessCandidateInput,
): HarnessComparisonReport {
  const mode = input.mode ?? "manifest";
  if (mode === "real" && !input.targetSessionId) {
    throw new Error("harness_real_compare_target_session_required");
  }
  if (mode !== "manifest" && input.targetSessionId === input.sourceSessionId) {
    throw new Error("harness_compare_target_must_fork_source");
  }
  const changedFields = [...(input.changedFields ?? [])].toSorted();
  const regressions = [...(input.regressions ?? [])].toSorted();
  const sideEffectPolicy = sideEffectPolicyForMode(mode);
  return {
    schema: HARNESS_EVAL_REPORT_SCHEMA,
    mode,
    candidateId: input.candidateId,
    sourceSessionId: input.sourceSessionId,
    ...(input.targetSessionId === undefined ? {} : { targetSessionId: input.targetSessionId }),
    divergeAt: input.divergeAt,
    baseManifestId: input.baseManifestId,
    candidateManifestId: input.candidateManifestId,
    changedFields,
    sideEffectPolicy,
    metrics: {
      changedFieldCount: changedFields.length,
      regressions,
      ...(input.execution ? { execution: input.execution } : {}),
    },
    promotion: {
      recommendation: regressions.length > 0 ? "reject" : "review_required",
      reason:
        regressions.length > 0
          ? "candidate_has_detected_regressions"
          : "manifest_comparison_requires_explicit_governance",
    },
  };
}

export async function executeHarnessCandidateComparison(
  input: ExecuteHarnessCandidateComparisonInput,
): Promise<HarnessComparisonReport> {
  if (input.targetSessionId.length === 0) {
    throw new Error("harness_compare_target_session_required");
  }
  if (input.targetSessionId === input.sourceSessionId) {
    throw new Error("harness_compare_target_must_fork_source");
  }
  if (!input.sourceEvents.some((event) => event.id === input.divergeAt)) {
    throw new Error("harness_compare_divergence_event_not_found");
  }
  const existingTargetEvents = input.runtime.runtime?.tape.list(input.targetSessionId) ?? [];
  if (existingTargetEvents.length > 0) {
    throw new Error("harness_compare_target_session_must_be_empty");
  }

  const candidatePatch = buildHarnessCandidatePatch({
    base: input.baseManifest,
    candidate: input.candidateManifest,
  });
  const regressions = [...(input.regressions ?? [])];
  // Real mode materializes the candidate PATCH (the delta the API derived
  // above from the manifests it was given — not a caller-supplied field list)
  // and refuses BEFORE any runtime or port exists: a blocked candidate must
  // produce zero provider and tool calls, not a red label on a run that
  // already had side effects. The enforcement therefore holds for every
  // caller, not just the CLI's pre-check.
  // The attached runtime's presence IS the "ran in a trial world" claim, in
  // both directions: real mode demands it, fixture mode forbids it (a fixture
  // run touches nothing, so a trial world would be a lie on the report).
  if (input.mode === "fixture" && input.attachedRuntime) {
    throw new Error("harness_fixture_compare_forbids_attached_runtime");
  }
  let materialization: HarnessCandidateMaterialization | undefined;
  if (input.mode === "real") {
    if (!input.attachedRuntime) {
      throw new Error("harness_real_compare_requires_attached_runtime");
    }
    const enforcement = resolveHarnessCandidatePatchMaterialization(candidatePatch.delta);
    if (!enforcement.ok) {
      throw new Error(
        `harness_candidate_not_materializable:${enforcement.blockedFields
          .map((blocked) => `${blocked.field}(${blocked.reason})`)
          .join(",")}`,
      );
    }
    materialization = enforcement;
  }
  const trialWorld = input.attachedRuntime?.world;

  const prompt = resolveReplayContinuationPrompt({
    events: input.sourceEvents,
    divergeAt: input.divergeAt,
  });
  const ports = wrapProviderExecutionProbe(
    input.mode === "fixture"
      ? createFixtureHarnessExecutionPorts()
      : requireRealExecutionPorts(input),
  );
  let runtime: BrewvaRuntime;
  let ownsRuntime: boolean;
  if (input.mode === "real" && input.attachedRuntime) {
    // Single-writer coupling: the trial runtime's physics thunks resolve to
    // exactly the probed ports bound here, and every event of the target
    // session — replayed prefix, provider-manifest advisory, turn and tool
    // commits — flows through this one runtime's commit port.
    input.attachedRuntime.bindPorts(ports);
    runtime = input.attachedRuntime.runtime;
    ownsRuntime = false;
  } else {
    runtime = input.runtime.createRuntime({
      physics: {
        mode: "replay-then-real",
        source: {
          sessionId: input.sourceSessionId,
          events: input.sourceEvents,
        },
        divergeAt: input.divergeAt,
        target: {
          sessionId: input.targetSessionId,
          forkTag: `harness:${input.candidateManifest.manifestId}`,
        },
        provider: ports.provider,
        toolExecutor: ports.toolExecutor,
        ...(ports.resolveToolAuthority ? { resolveToolAuthority: ports.resolveToolAuthority } : {}),
      },
    });
    ownsRuntime = true;
  }
  const counters = createExecutionFrameCounters();
  const startedAt = Date.now();
  // The harness owns a fixture fork it created above and must close it; an
  // attached trial runtime belongs to the caller, whose close must outlive
  // the hosted session feeding the ports. Either way the report reads
  // `runtime.tape` before this function returns.
  try {
    // NOTE: no post-start emptiness re-check — replay-then-real physics seeds
    // the target fork into the runtime's tape at CREATION (initialEvents), so
    // the pre-start read of the operator store above is the emptiness
    // authority; the fork's own tape is never empty by the time it is
    // observable here.
    await runtime.start();
    try {
      for await (const frame of runtime.turn({
        sessionId: input.targetSessionId,
        prompt: input.prompt ?? prompt.text,
      })) {
        observeExecutionFrame(counters, frame);
      }
    } catch (error) {
      regressions.push(`execution_error:${classifyExecutionError(error)}`);
    }

    const targetEvents = runtime.tape.list(input.targetSessionId);
    // Execution honesty is read back from the target tape, never asserted:
    // the manifest the trial's provider pipeline recorded is the executed
    // identity, and every materialized delta field must verify against it.
    const executedManifest = latestRecordedHarnessManifest(targetEvents, input.targetSessionId);
    const deltaVerifiedFields: string[] = [];
    if (input.mode === "real") {
      for (const field of materialization?.materializedFields ?? []) {
        const claimed = candidatePatch.delta.find((entry) => entry.field === field)?.to ?? null;
        const executed = executedManifest
          ? (readManifestFieldValue(executedManifest, field) ?? null)
          : null;
        if (executedManifest && jsonEquals(claimed, executed)) {
          deltaVerifiedFields.push(field);
        } else {
          regressions.push(`execution_candidate_delta_not_executed:${field}`);
        }
      }
    }

    return compareHarnessCandidate({
      mode: input.mode,
      candidateId: candidatePatch.candidateId,
      sourceSessionId: input.sourceSessionId,
      targetSessionId: input.targetSessionId,
      divergeAt: input.divergeAt,
      baseManifestId: input.baseManifest.manifestId,
      candidateManifestId: input.candidateManifest.manifestId,
      changedFields: input.changedFields,
      regressions,
      execution: {
        executedManifestId: executedManifest?.manifestId ?? null,
        ...(deltaVerifiedFields.length > 0 ? { deltaVerifiedFields } : {}),
        // The workspace is not a caller claim: `trial_world` exactly when a
        // trial runtime is attached, `shared_operator_cwd` otherwise (fixture
        // no-op tools touch nothing).
        workspaceMode: trialWorld ? "trial_world" : "shared_operator_cwd",
        ...(materialization && materialization.materializedFields.length > 0
          ? { materializedFields: materialization.materializedFields }
          : {}),
        ...(trialWorld
          ? {
              trialWorldBasisId: trialWorld.basisWorldId,
              trialWorldSource: trialWorld.source,
              ...(trialWorld.settingsHash ? { trialSettingsHash: trialWorld.settingsHash } : {}),
            }
          : {}),
        replayEventCount: replayEventCountThroughDivergence(input.sourceEvents, input.divergeAt),
        targetEventCount: targetEvents.length,
        frameCount: counters.frameCount,
        runtimeEventFrameCount: counters.runtimeEventFrameCount,
        textFrameCount: counters.textFrameCount,
        reasonFrameCount: counters.reasonFrameCount,
        toolCallFrameCount: counters.toolCallFrameCount,
        toolProgressFrameCount: counters.toolProgressFrameCount,
        suspensionFrameCount: counters.suspensionFrameCount,
        durationMs: Math.max(0, Date.now() - startedAt),
        providerExecuted: ports.providerExecuted(),
        toolExecutorMode: input.mode === "fixture" ? "fixture_noop" : "hosted",
        promptSource: prompt.source,
      },
    });
  } finally {
    if (ownsRuntime) {
      await runtime.close();
    }
  }
}

/**
 * The manifest advisory the trial's provider pipeline recorded for the LAST
 * attempt of the continuation turn — the executed harness identity. Absent
 * when the run never dispatched a provider payload (fixture pipelines and
 * failed-before-dispatch runs record none). The target tape also carries the
 * REPLAYED source prefix (which routinely contains the source session's own
 * manifest advisories); those are history, not this run's record, so events
 * the fork copied (`isForkReplayEventId`) are skipped — otherwise a run that
 * never dispatched would claim the source's manifest as executed. A malformed
 * advisory (schema drift, hand-edited tape) is skipped, never fatal: the
 * comparison already ran, and an unreadable advisory means "nothing recorded",
 * not "throw away the report".
 */
function latestRecordedHarnessManifest(
  events: readonly CanonicalEvent[],
  targetSessionId: string,
): HarnessManifest | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || isForkReplayEventId(event.id, targetSessionId)) continue;
    try {
      const manifest = readHarnessManifestRecordedAdvisoryEvent(event);
      if (manifest) {
        return manifest;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function jsonEquals(left: unknown, right: unknown): boolean {
  return stableCompareJson(left) === stableCompareJson(right);
}

function sideEffectPolicyForMode(
  mode: HarnessComparisonReport["mode"],
): HarnessComparisonReport["sideEffectPolicy"] {
  switch (mode) {
    case "manifest":
      return "no_provider_or_tool_execution";
    case "fixture":
      return "fixture_provider_and_noop_tools";
    case "real":
      return "explicit_real_target_session_only";
  }
  mode satisfies never;
  throw new Error("unknown_harness_compare_mode");
}

function createFixtureHarnessExecutionPorts(): HarnessCandidateExecutionPorts {
  let providerPass = 0;
  const registry = createActionPolicyRegistry();
  return {
    provider: {
      async *stream(): AsyncIterable<RuntimeProviderFrame> {
        providerPass += 1;
        if (providerPass === 1) {
          yield { type: "reason", delta: "Fixture Harness comparison probes tool flow." };
          yield {
            type: "tool",
            call: {
              toolCallId: "harness-fixture-tool-call",
              toolName: "read_file",
              args: { path: "HARNESS_FIXTURE.md" },
            },
          };
          return;
        }
        yield { type: "text", delta: "Fixture Harness comparison completed." };
      },
    },
    toolExecutor: {
      async execute(_commitment, input) {
        await input.onProgress?.({
          outcome: { kind: "ok" as const, value: { fixture: true, phase: "progress" } },
          content: "fixture progress",
        });
        return {
          outcome: { kind: "ok" as const, value: { fixture: true } },
          content: "fixture result",
        };
      },
    },
    resolveToolAuthority: (toolName, args) => resolveToolAuthority(toolName, registry, args),
  };
}

function requireRealExecutionPorts(
  input: ExecuteHarnessCandidateComparisonInput,
): HarnessCandidateExecutionPorts {
  if (!input.ports) {
    throw new Error("harness_real_compare_requires_execution_ports");
  }
  return input.ports;
}

function wrapProviderExecutionProbe(
  ports: HarnessCandidateExecutionPorts,
): HarnessCandidateExecutionPorts & {
  readonly providerExecuted: () => boolean;
} {
  let providerExecuted = false;
  return {
    ...ports,
    provider: {
      async *stream(input) {
        providerExecuted = true;
        yield* ports.provider.stream(input);
      },
    },
    providerExecuted: () => providerExecuted,
  };
}

interface ReplayContinuationPrompt {
  readonly text: string;
  readonly source: "source_turn_after_divergence" | "source_turn_at_divergence" | "synthetic";
}

function resolveReplayContinuationPrompt(input: {
  readonly events: readonly CanonicalEvent[];
  readonly divergeAt: string;
}): ReplayContinuationPrompt {
  const divergeIndex = input.events.findIndex((event) => event.id === input.divergeAt);
  if (divergeIndex < 0) {
    throw new Error("harness_compare_divergence_event_not_found");
  }
  for (const event of input.events.slice(divergeIndex + 1)) {
    if (event.type !== "turn.started") continue;
    const text = promptTextFromTurnStartedEvent(event);
    if (text) {
      return { text, source: "source_turn_after_divergence" };
    }
  }
  const divergeEvent = input.events[divergeIndex];
  if (divergeEvent?.type === "turn.started") {
    const text = promptTextFromTurnStartedEvent(divergeEvent);
    if (text) {
      return { text, source: "source_turn_at_divergence" };
    }
  }
  return {
    text: `Harness candidate replay continuation after ${input.divergeAt}.`,
    source: "synthetic",
  };
}

function promptTextFromTurnStartedEvent(event: CanonicalEvent): string | null {
  const payload = event.payload;
  if (!isRecord(payload)) return null;
  if (typeof payload.prompt === "string" && payload.prompt.trim().length > 0) {
    return payload.prompt;
  }
  if (Array.isArray(payload.content)) {
    const text = payload.content
      .flatMap((part) =>
        isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
      )
      .join("\n")
      .trim();
    return text.length > 0 ? text : null;
  }
  return null;
}

function replayEventCountThroughDivergence(
  events: readonly CanonicalEvent[],
  divergeAt: string,
): number {
  const index = events.findIndex((event) => event.id === divergeAt);
  return index < 0 ? 0 : index + 1;
}

interface ExecutionFrameCounters {
  frameCount: number;
  runtimeEventFrameCount: number;
  textFrameCount: number;
  reasonFrameCount: number;
  toolCallFrameCount: number;
  toolProgressFrameCount: number;
  suspensionFrameCount: number;
}

function createExecutionFrameCounters(): ExecutionFrameCounters {
  return {
    frameCount: 0,
    runtimeEventFrameCount: 0,
    textFrameCount: 0,
    reasonFrameCount: 0,
    toolCallFrameCount: 0,
    toolProgressFrameCount: 0,
    suspensionFrameCount: 0,
  };
}

function observeExecutionFrame(counters: ExecutionFrameCounters, frame: TurnFrame): void {
  counters.frameCount += 1;
  switch (frame.type) {
    case "runtime.event":
      counters.runtimeEventFrameCount += 1;
      if (frame.event.type === "tool.proposed") counters.toolCallFrameCount += 1;
      return;
    case "text":
      counters.textFrameCount += 1;
      return;
    case "reason":
      counters.reasonFrameCount += 1;
      return;
    case "tool.progress":
      counters.toolProgressFrameCount += 1;
      return;
    case "runtime.suspended":
      counters.suspensionFrameCount += 1;
      return;
  }
  frame satisfies never;
}

function classifyExecutionError(error: unknown): string {
  const message = toErrorMessage(error);
  return message.replaceAll(/[^a-zA-Z0-9_.:-]+/gu, "_").slice(0, 120) || "unknown";
}
