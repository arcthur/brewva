import type {
  BrewvaRuntime,
  CanonicalEvent,
  RuntimePhysicsDeclaration,
  RuntimeProviderFrame,
  RuntimeProviderPort,
  RuntimeToolAuthorityResolver,
  RuntimeToolExecutorPort,
  TurnFrame,
} from "@brewva/brewva-runtime";
import { createActionPolicyRegistry, resolveToolAuthority } from "@brewva/brewva-runtime/security";
import {
  HARNESS_EVAL_REPORT_SCHEMA,
  HARNESS_TRACE_SNAPSHOT_SCHEMA,
  buildHarnessTraceSnapshotId,
  type HarnessComparisonReport,
  type HarnessManifest,
  type HarnessTraceSignal,
  type HarnessTraceSnapshot,
} from "@brewva/brewva-vocabulary/harness";

export { clusterHarnessTraceSnapshots } from "@brewva/brewva-vocabulary/harness";

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

export interface HarnessCandidateExecutionPorts {
  readonly provider: RuntimeProviderPort;
  readonly toolExecutor: RuntimeToolExecutorPort;
  readonly resolveToolAuthority?: RuntimeToolAuthorityResolver;
}

export interface ExecuteHarnessCandidateComparisonInput {
  readonly mode: "fixture" | "real";
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly divergeAt: string;
  readonly baseManifest: HarnessManifest;
  readonly candidateManifest: HarnessManifest;
  readonly sourceEvents: readonly CanonicalEvent[];
  readonly runtime: HarnessRuntimeFactory;
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

export const buildHarnessTraceSnapshot = buildPreflightHarnessTraceSnapshot;

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

  const prompt = resolveReplayContinuationPrompt({
    events: input.sourceEvents,
    divergeAt: input.divergeAt,
  });
  const regressions = [...(input.regressions ?? [])];
  const ports = wrapProviderExecutionProbe(
    input.mode === "fixture"
      ? createFixtureHarnessExecutionPorts()
      : requireRealExecutionPorts(input),
  );
  const runtime = input.runtime.createRuntime({
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
  await runtime.start();

  const counters = createExecutionFrameCounters();
  const startedAt = Date.now();
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

  return compareHarnessCandidate({
    mode: input.mode,
    sourceSessionId: input.sourceSessionId,
    targetSessionId: input.targetSessionId,
    divergeAt: input.divergeAt,
    baseManifestId: input.baseManifest.manifestId,
    candidateManifestId: input.candidateManifest.manifestId,
    changedFields: input.changedFields,
    regressions,
    execution: {
      replayEventCount: replayEventCountThroughDivergence(input.sourceEvents, input.divergeAt),
      targetEventCount: runtime.tape.list(input.targetSessionId).length,
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
  const message = error instanceof Error ? error.message : String(error);
  return message.replaceAll(/[^a-zA-Z0-9_.:-]+/gu, "_").slice(0, 120) || "unknown";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
