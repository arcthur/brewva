import { existsSync } from "node:fs";
import { cp, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";
import {
  createIsolatedWorkspace,
  type IsolatedWorkspaceHandle,
} from "@brewva/brewva-gateway/delegation";
import {
  appendHarnessCandidateLifecycleRecord,
  clusterHarnessTraceSnapshots,
  compareHarnessCandidate,
  diffHarnessManifestFields,
  executeHarnessCandidateComparison,
  readHarnessCandidateLifecycleRecords,
  resolveHarnessCandidateMaterialization,
  toHarnessRuntimeFactory,
  type HarnessCandidateMaterialization,
} from "@brewva/brewva-gateway/harness";
import {
  createHostedHarnessRuntimeExecutionPorts,
  createHostedRuntimeAdapter,
  createHostedSession,
  type HostedRuntimeAdapterPort,
  type HostedSession,
} from "@brewva/brewva-gateway/hosted";
import {
  createSessionIndex,
  type SessionIndex,
  type SessionIndexHarnessPatternCandidate,
  type SessionIndexHarnessTraceSnapshot,
} from "@brewva/brewva-session-index";
import {
  buildHarnessManifest,
  HARNESS_CANDIDATE_LIFECYCLE_SCHEMA,
  stableHarnessId,
  type BuildHarnessManifestInput,
  type HarnessCandidateLifecycleAction,
  type HarnessCandidateLifecycleRecord,
  type HarnessComparisonReport,
  type HarnessManifest,
} from "@brewva/brewva-vocabulary/harness";
import { createCliInspectPort } from "../runtime/cli-runtime-ports.js";

const HARNESS_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  cwd: { type: "string" },
  config: { type: "string" },
  session: { type: "string" },
  limit: { type: "string" },
  "min-occurrences": { type: "string" },
  "source-session": { type: "string" },
  "target-session": { type: "string" },
  "diverge-at": { type: "string" },
  "candidate-manifest": { type: "string" },
  candidate: { type: "string" },
  reason: { type: "string" },
  mode: { type: "string" },
  json: { type: "boolean" },
} as const;

type HarnessCommand = "snapshots" | "patrol" | "compare" | "candidate";

interface HarnessCliOptions {
  readonly cwd?: string;
  readonly configPath?: string;
  readonly json: boolean;
  readonly sessionId?: string;
  readonly limit: number;
  readonly minOccurrences: number;
  readonly sourceSessionId?: string;
  readonly targetSessionId?: string;
  readonly divergeAt?: string;
  readonly candidateManifestPath?: string;
  readonly mode: "manifest" | "fixture" | "real";
  readonly candidateId?: string;
  readonly reason?: string;
  readonly candidateAction?: HarnessCandidateLifecycleAction;
}

export interface HarnessCurrentRuntimeIdentity {
  readonly configHash: string;
  readonly runtimeIdentityHash: string;
}

type HarnessCompareBaseSnapshotSelection =
  | {
      readonly status: "selected";
      readonly snapshot: SessionIndexHarnessTraceSnapshot;
    }
  | {
      readonly status: "error";
      readonly message: string;
    };

export async function runHarnessCli(argv: string[]): Promise<number> {
  const parsed = parseHarnessArgs(argv);
  if (parsed.kind === "help") {
    printHarnessHelp();
    return 0;
  }
  if (parsed.kind === "error") {
    console.error(parsed.message);
    return 1;
  }

  const runtime = createHostedRuntimeAdapter({
    cwd: parsed.options.cwd,
    configPath: parsed.options.configPath,
  });
  if (parsed.command === "candidate") {
    // Lifecycle verbs only touch the candidate ledger; no session index spin-up.
    try {
      if (!parsed.options.candidateAction) {
        // Unreachable through parseHarnessArgs; kept as a typed narrowing seam.
        console.error(
          "Error: expected one of: brewva harness candidate accept | reject | archive.",
        );
        return 1;
      }
      // Rooted at the workspace like every other durable store, so receipts
      // land in one ledger regardless of the invocation subdirectory.
      return runHarnessCandidateVerb(runtime.identity.workspaceRoot, {
        ...parsed.options,
        candidateAction: parsed.options.candidateAction,
      });
    } finally {
      await runtime.runtime.close();
    }
  }
  const index = await createSessionIndex({
    ...createCliInspectPort(runtime).sessionIndexSources(),
  });
  try {
    const status = await index.catchUp();
    if (!status.ok) {
      console.error(`Error: session index unavailable: ${status.message}`);
      return 1;
    }
    switch (parsed.command) {
      case "snapshots":
        return await runHarnessSnapshots(index, parsed.options);
      case "patrol":
        return await runHarnessPatrol(index, parsed.options);
      case "compare":
        return await runHarnessCompare(index, runtime, parsed.options, {
          configHash: stableHarnessId("runtime_config", runtime.config),
          runtimeIdentityHash: stableHarnessId("runtime_identity", runtime.identity),
        });
    }
    return 1;
  } finally {
    await index.close();
    await runtime.runtime.close();
  }
}

export function runHarnessCandidateVerb(
  workspaceRoot: string,
  options: Pick<HarnessCliOptions, "candidateId" | "reason" | "json"> & {
    readonly candidateAction: HarnessCandidateLifecycleAction;
  },
): number {
  if (!options.candidateId) {
    console.error("Error: brewva harness candidate requires --candidate <candidateId>.");
    return 1;
  }
  if (!options.reason) {
    console.error(
      "Error: brewva harness candidate requires --reason <text> — the receipt records an accountable decision.",
    );
    return 1;
  }
  // Candidates span checkouts and time (the ledger is per-workspace, and a
  // compare may have run elsewhere or before the ledger existed), so an
  // unknown id warns instead of refusing: the accountable decision stands,
  // the possible typo is flagged on the receipt's context.
  const known = readHarnessCandidateLifecycleRecords(workspaceRoot).some(
    (record) => record.candidateId === options.candidateId,
  );
  if (!known) {
    console.error(
      `Warning: candidate ${options.candidateId} has no ledger records in this workspace (compare may have run in another checkout, or before the ledger existed). Recording the decision anyway — double-check the id against the compare report.`,
    );
  }
  const record: HarnessCandidateLifecycleRecord = {
    schema: HARNESS_CANDIDATE_LIFECYCLE_SCHEMA,
    candidateId: options.candidateId,
    action: options.candidateAction,
    at: new Date().toISOString(),
    actor: "operator_cli",
    reason: options.reason,
  };
  appendHarnessCandidateLifecycleRecord(workspaceRoot, record);
  if (options.json) {
    console.log(JSON.stringify({ record }, null, 2));
  } else {
    console.log(
      `candidate=${record.candidateId} action=${record.action} at=${record.at} reason=${record.reason}`,
    );
  }
  return 0;
}

export function formatHarnessSnapshotsText(
  snapshots: readonly SessionIndexHarnessTraceSnapshot[],
): string {
  return snapshots
    .map((snapshot) =>
      [
        `snapshot=${snapshot.snapshotId}`,
        `session=${snapshot.sessionId}`,
        `turn=${snapshot.turn ?? "-"}`,
        `attempt=${snapshot.attempt}`,
        `manifest=${snapshot.manifestId}`,
        `provider=${snapshot.provider.provider ?? "-"}:${snapshot.provider.model ?? "-"}`,
        `signals=${snapshot.signals.map((signal) => signal.kind).join(",") || "-"}`,
      ].join(" "),
    )
    .join("\n");
}

export function formatHarnessCandidatesText(
  candidates: readonly SessionIndexHarnessPatternCandidate[],
): string {
  return candidates
    .map((candidate) =>
      [
        `candidate=${candidate.candidateId}`,
        `kind=${candidate.kind}`,
        `occurrences=${candidate.occurrenceCount}`,
        `severity=${candidate.severity}`,
        `confidence=${candidate.confidence}`,
        `snapshots=${candidate.sourceSnapshotIds.join(",")}`,
        `manifests=${candidate.manifestIds.join(",")}`,
        `promotion=${candidate.promotionPath}`,
      ].join(" "),
    )
    .join("\n");
}

export function formatHarnessComparisonText(report: HarnessComparisonReport): string {
  return [
    `mode=${report.mode}`,
    `candidateId=${report.candidateId}`,
    `source=${report.sourceSessionId}`,
    `target=${report.targetSessionId ?? "-"}`,
    `divergeAt=${report.divergeAt}`,
    `base=${report.baseManifestId}`,
    `candidate=${report.candidateManifestId}`,
    report.metrics.execution
      ? `executedManifest=${report.metrics.execution.executedManifestId}`
      : "executedManifest=-",
    report.metrics.execution
      ? `workspace=${report.metrics.execution.workspaceMode}`
      : "workspace=-",
    `sideEffectPolicy=${report.sideEffectPolicy}`,
    `changedFields=${report.changedFields.join(",") || "-"}`,
    report.metrics.execution
      ? `executionFrames=${report.metrics.execution.frameCount}`
      : "executionFrames=-",
    report.metrics.execution
      ? `targetEvents=${report.metrics.execution.targetEventCount}`
      : "targetEvents=-",
    report.metrics.execution
      ? `promptSource=${report.metrics.execution.promptSource}`
      : "promptSource=-",
    `recommendation=${report.promotion.recommendation}`,
  ].join(" ");
}

/**
 * Fixture replay executes scripted provider frames and no-op tools — a
 * loaded candidate manifest cannot reach that execution, so fixture mode
 * refuses it. Real mode admits a loaded candidate only through
 * `resolveHarnessCandidateMaterialization`: every changed field must flow
 * through an execution seam or be recomputed-by-definition, else the compare
 * refuses with the blocked fields named. Either way no replay report labels
 * a candidate the fork did not run.
 */
export function harnessReplayCandidateGuardError(
  options: Pick<HarnessCliOptions, "candidateManifestPath" | "mode">,
): string | null {
  if (options.candidateManifestPath && options.mode === "fixture") {
    return (
      "harness_candidate_delta_not_materialized: --candidate-manifest does not support " +
      "--mode fixture; fixture replay executes scripted provider frames and no-op tools, " +
      "so a loaded candidate manifest would label a report it did not execute. Use " +
      "--mode manifest for field diffing or --mode real for materialized execution."
    );
  }
  return null;
}

export function formatHarnessMaterializationRefusal(
  blockedFields: readonly { readonly field: string; readonly reason: string }[],
): string {
  const fields = blockedFields.map((entry) => `${entry.field} (${entry.reason})`).join(", ");
  return `harness_candidate_delta_not_materialized: the candidate changes fields with no execution seam: ${fields}.`;
}

export function harnessBaseStalenessError(
  baseManifest: HarnessManifest,
  currentRuntime: HarnessCurrentRuntimeIdentity,
): string | null {
  const staleParts = [
    baseManifest.runtime?.configHash !== currentRuntime.configHash
      ? `configHash base=${baseManifest.runtime?.configHash ?? "-"} current=${currentRuntime.configHash}`
      : undefined,
    baseManifest.runtime?.runtimeIdentityHash !== currentRuntime.runtimeIdentityHash
      ? `runtimeIdentityHash base=${baseManifest.runtime?.runtimeIdentityHash ?? "-"} current=${currentRuntime.runtimeIdentityHash}`
      : undefined,
  ].filter((entry): entry is string => Boolean(entry));
  if (staleParts.length === 0) {
    return null;
  }
  return (
    "harness_base_manifest_stale_vs_current_runtime: the base manifest no longer describes " +
    `the current runtime (${staleParts.join("; ")}). Re-run the source scenario under the ` +
    "current runtime (or author the candidate against a fresh base snapshot) so the " +
    "materialized execution matches every non-changed field the report will claim."
  );
}

async function runHarnessSnapshots(
  index: SessionIndex,
  options: HarnessCliOptions,
): Promise<number> {
  const snapshots = await index.listHarnessTraceSnapshots({
    sessionId: options.sessionId,
    limit: options.limit,
  });
  if (options.json) {
    console.log(JSON.stringify({ snapshots }, null, 2));
  } else {
    const text = formatHarnessSnapshotsText(snapshots);
    if (text.length > 0) console.log(text);
  }
  return 0;
}

async function runHarnessPatrol(index: SessionIndex, options: HarnessCliOptions): Promise<number> {
  const snapshots = await index.listHarnessTraceSnapshots({
    sessionId: options.sessionId,
    limit: options.limit,
  });
  const candidates = clusterHarnessTraceSnapshots(snapshots, {
    minOccurrences: options.minOccurrences,
  });
  if (options.json) {
    console.log(JSON.stringify({ candidates }, null, 2));
  } else {
    const text = formatHarnessCandidatesText(candidates);
    if (text.length > 0) console.log(text);
  }
  return 0;
}

async function runHarnessCompare(
  index: SessionIndex,
  runtime: HostedRuntimeAdapterPort,
  options: HarnessCliOptions,
  currentRuntime: HarnessCurrentRuntimeIdentity,
): Promise<number> {
  if (!options.sourceSessionId) {
    console.error("Error: brewva harness compare requires --source-session <id>.");
    return 1;
  }
  if (!options.divergeAt) {
    console.error("Error: brewva harness compare requires --diverge-at <event-id>.");
    return 1;
  }
  if (options.mode === "real" && !options.targetSessionId) {
    console.error("Error: --mode real requires --target-session <id>.");
    return 1;
  }
  if (options.mode === "real" && options.targetSessionId === options.sourceSessionId) {
    console.error("Error: --mode real must not target the source session.");
    return 1;
  }
  const candidateGuardError = harnessReplayCandidateGuardError(options);
  if (candidateGuardError) {
    console.error(`Error: ${candidateGuardError}`);
    return 1;
  }

  const snapshots = await index.listHarnessTraceSnapshots({
    sessionId: options.sourceSessionId,
    limit: 500,
  });
  const selectedBaseSnapshot = selectHarnessCompareBaseSnapshot(snapshots, options.divergeAt);
  if (selectedBaseSnapshot.status === "error") {
    console.error(`Error: ${selectedBaseSnapshot.message}`);
    return 1;
  }
  const baseSnapshot = selectedBaseSnapshot.snapshot;
  const baseManifest = baseSnapshot?.manifest;
  if (!baseSnapshot || !baseManifest) {
    console.error(`Error: no Harness manifest snapshot found for ${options.sourceSessionId}.`);
    return 1;
  }
  const candidateManifest = options.candidateManifestPath
    ? await loadHarnessCandidateManifestFromPath({
        path: options.candidateManifestPath,
        cwd: options.cwd,
      })
    : buildCurrentHarnessCandidateManifest({
        baseManifest,
        currentRuntime,
      });
  const changedFields = diffHarnessManifestFields(baseManifest, candidateManifest);
  const targetSessionId = resolveHarnessCompareTargetSession(options);
  const replayTargetSessionId = targetSessionId;
  if (options.mode !== "manifest" && !replayTargetSessionId) {
    console.error("Error: Harness replay compare requires a target session.");
    return 1;
  }
  if (targetSessionId === options.sourceSessionId) {
    console.error("Error: Harness compare target must not be the source session.");
    return 1;
  }

  let report: HarnessComparisonReport;
  try {
    if (options.mode === "manifest") {
      report = compareHarnessCandidate({
        mode: options.mode,
        sourceSessionId: options.sourceSessionId,
        targetSessionId,
        divergeAt: options.divergeAt,
        baseManifestId: baseSnapshot.manifestId,
        candidateManifestId: candidateManifest.manifestId,
        changedFields,
      });
    } else {
      const requiredTargetSessionId = replayTargetSessionId;
      if (!requiredTargetSessionId) {
        throw new Error("Harness replay compare requires a target session.");
      }
      // Materialization proves base→candidate; execution runs CURRENT+delta.
      // For a loaded candidate those only coincide when the base still
      // describes the current runtime, so a drifted operator config refuses
      // instead of labeling the run with a manifest describing a harness
      // that no longer exists.
      if (options.mode === "real" && options.candidateManifestPath) {
        const staleness = harnessBaseStalenessError(baseManifest, currentRuntime);
        if (staleness) {
          console.error(`Error: ${staleness}`);
          return 1;
        }
      }
      const materialization =
        options.mode === "real"
          ? resolveHarnessCandidateMaterialization({
              base: baseManifest,
              candidate: candidateManifest,
              changedFields,
            })
          : undefined;
      if (materialization && !materialization.ok) {
        console.error(
          `Error: ${formatHarnessMaterializationRefusal(materialization.blockedFields)}`,
        );
        return 1;
      }
      report = await runHarnessReplayCompare({
        runtime,
        options,
        targetSessionId: requiredTargetSessionId,
        baseManifest,
        candidateManifest,
        changedFields,
        materialization,
      });
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  if (options.json) {
    console.log(JSON.stringify({ report }, null, 2));
  } else {
    console.log(formatHarnessComparisonText(report));
  }
  // Every compare appends an `evaluated` receipt to the workspace candidate
  // ledger — the shared identity a later accept/reject/archive decision (and
  // any eval report over the same manifest pair) traces back to. The report
  // is already printed: a ledger IO failure must not eat a completed (and
  // possibly expensive) comparison, so it degrades to a warning.
  try {
    appendHarnessCandidateLifecycleRecord(runtime.identity.workspaceRoot, {
      schema: HARNESS_CANDIDATE_LIFECYCLE_SCHEMA,
      candidateId: report.candidateId,
      action: "evaluated",
      at: new Date().toISOString(),
      actor: "operator_cli",
      baseManifestId: report.baseManifestId,
      candidateManifestId: report.candidateManifestId,
      sourceSessionId: report.sourceSessionId,
      ...(report.targetSessionId ? { targetSessionId: report.targetSessionId } : {}),
      mode: report.mode,
      recommendation: report.promotion.recommendation,
      regressionCount: report.metrics.regressions.length,
    });
  } catch (error) {
    console.error(
      `Warning: failed to append the evaluated receipt to the candidate ledger (${
        error instanceof Error ? error.message : String(error)
      }); the report above is complete, but ${report.candidateId} has no evaluated row.`,
    );
  }
  return 0;
}

async function runHarnessReplayCompare(input: {
  readonly runtime: HostedRuntimeAdapterPort;
  readonly options: HarnessCliOptions;
  readonly targetSessionId: string;
  readonly baseManifest: HarnessManifest;
  readonly candidateManifest: HarnessManifest;
  readonly changedFields: readonly string[];
  readonly materialization?: HarnessCandidateMaterialization;
}): Promise<HarnessComparisonReport> {
  if (!input.options.sourceSessionId || !input.options.divergeAt) {
    throw new Error("harness_compare_source_and_divergence_required");
  }
  const sourceEvents = input.runtime.runtime.tape.list(input.options.sourceSessionId);
  if (sourceEvents.length === 0) {
    throw new Error(`No canonical source events found for ${input.options.sourceSessionId}.`);
  }
  if (!sourceEvents.some((event) => event.id === input.options.divergeAt)) {
    throw new Error(`Divergence event ${input.options.divergeAt} was not found in source tape.`);
  }
  const realMode = input.options.mode === "real";
  if (realMode && !input.materialization) {
    throw new Error("harness_real_compare_requires_materialization");
  }
  const requestedModel = input.materialization?.overrides.model;
  let hostedSession: HostedSession | undefined;
  let trialWorld: IsolatedWorkspaceHandle | undefined;
  try {
    // Real mode always runs in a disposable copy-on-write fork of the
    // operator workspace: filesystem tool effects land in the trial world,
    // never the live cwd, and the basis world id records exactly what the
    // fork saw. Durable evidence (tape/ledger) stays in the operator store
    // via the runtime factory's data-root absolutization. NOTE: the fork
    // copy plus basis capture reads and hashes the whole tracked tree —
    // large workspaces pay real IO here, and oversized trees fail closed
    // through the world-store enumeration caps.
    trialWorld = realMode
      ? await createIsolatedWorkspace(input.runtime.identity.cwd, "brewva-harness-trial-")
      : undefined;
    if (trialWorld) {
      // Project settings are config, not run data: the fork copy excludes
      // `.brewva` wholesale, but model presets and routing fallback chains
      // must resolve in the trial session exactly as they would in this
      // workspace, or the comparison measures a configuration that exists
      // nowhere.
      const settingsDir = join(input.runtime.identity.cwd, ".brewva", "agent");
      if (existsSync(settingsDir)) {
        await cp(settingsDir, join(trialWorld.root, ".brewva", "agent"), {
          recursive: true,
          force: true,
        });
      }
    }
    const ports = realMode
      ? await createRealHarnessExecutionPorts({
          runtime: input.runtime,
          options: input.options,
          targetSessionId: input.targetSessionId,
          cwd: trialWorld?.root ?? input.options.cwd,
          model: requestedModel,
        })
      : undefined;
    hostedSession = ports?.session;
    // A materialized model claim is verified, not assumed: session creation
    // may silently fall back when the requested model's provider auth is not
    // connected, which would execute a model the report does not describe.
    if (requestedModel !== undefined && ports) {
      const active = ports.ports.activeModelId();
      if (ports.modelFallbackMessage || active !== requestedModel) {
        throw new Error(
          `harness_materialized_model_unavailable: requested '${requestedModel}' but the trial session resolved '${active ?? "-"}'${
            ports.modelFallbackMessage ? ` (${ports.modelFallbackMessage})` : ""
          }. Connect the model's provider auth or drop the provider.model delta.`,
        );
      }
    }
    const report = await executeHarnessCandidateComparison({
      mode: realMode ? "real" : "fixture",
      runtime: toHarnessRuntimeFactory(input.runtime, trialWorld ? { cwd: trialWorld.root } : {}),
      sourceSessionId: input.options.sourceSessionId,
      targetSessionId: input.targetSessionId,
      divergeAt: input.options.divergeAt,
      baseManifest: input.baseManifest,
      candidateManifest: input.candidateManifest,
      // Fixture mode: the guard rejects loaded manifests, so the candidate
      // always describes the current runtime. Real mode: the materializer
      // proved every changed field flows through a seam or is recomputed by
      // definition (and the API re-derives that proof), so the candidate is
      // what the fork executes.
      executedManifestId: input.candidateManifest.manifestId,
      workspace: trialWorld
        ? {
            mode: "trial_world",
            root: trialWorld.root,
            basisWorldId: trialWorld.basisWorldId,
            source: trialWorld.basisSource,
          }
        : { mode: "shared_operator_cwd" },
      ...(input.materialization && input.materialization.materializedFields.length > 0
        ? { materializedFields: input.materialization.materializedFields }
        : {}),
      sourceEvents,
      changedFields: input.changedFields,
      ...(ports ? { ports: ports.ports } : {}),
    });
    // Mid-turn provider fallback can swap models transparently; a report for
    // a run that finished on a different model is not candidate evidence, so
    // refuse to return it rather than label it.
    if (requestedModel !== undefined && ports) {
      const active = ports.ports.activeModelId();
      if (active !== requestedModel) {
        throw new Error(
          `harness_materialized_model_diverged: the run started on '${requestedModel}' but ended on '${active ?? "-"}' (provider fallback during the turn). The fallback selection is recorded on the target session's tape.`,
        );
      }
    }
    return report;
  } finally {
    try {
      hostedSession?.dispose();
    } finally {
      await trialWorld?.dispose();
    }
  }
}

async function createRealHarnessExecutionPorts(input: {
  readonly runtime: HostedRuntimeAdapterPort;
  readonly options: HarnessCliOptions;
  readonly targetSessionId: string;
  readonly cwd?: string;
  readonly model?: string;
}): Promise<{
  readonly session: HostedSession;
  readonly ports: ReturnType<typeof createHostedHarnessRuntimeExecutionPorts>;
  readonly modelFallbackMessage?: string;
}> {
  const result = await createHostedSession({
    runtime: input.runtime,
    cwd: input.cwd ?? input.options.cwd,
    configPath: input.options.configPath,
    sessionId: input.targetSessionId,
    ...(input.model !== undefined ? { model: input.model } : {}),
    deferPersistenceUntilPrompt: true,
  });
  return {
    session: result.session,
    ports: createHostedHarnessRuntimeExecutionPorts(result.session, {
      actionAdmissionOverrides: input.runtime.config.security.actionAdmissionOverrides,
    }),
    ...(result.modelFallbackMessage ? { modelFallbackMessage: result.modelFallbackMessage } : {}),
  };
}

function resolveHarnessCompareTargetSession(options: HarnessCliOptions): string | undefined {
  if (options.targetSessionId) {
    return options.targetSessionId;
  }
  if (options.mode !== "fixture" || !options.sourceSessionId || !options.divergeAt) {
    return undefined;
  }
  const suffix = stableHarnessId("harness_target", {
    sourceSessionId: options.sourceSessionId,
    divergeAt: options.divergeAt,
    mode: options.mode,
  }).replaceAll(/[^a-zA-Z0-9_-]+/gu, "_");
  return `${options.sourceSessionId}-harness-fixture-${suffix}`;
}

export async function loadHarnessCandidateManifestFromPath(input: {
  readonly path: string;
  readonly cwd?: string;
}): Promise<HarnessManifest> {
  const absolutePath = resolve(input.cwd ?? process.cwd(), input.path);
  const text = await readFile(absolutePath, "utf8");
  const parsed = JSON.parse(text) as unknown;
  if (!isPlainRecord(parsed)) {
    throw new Error("candidate_manifest_must_be_json_object");
  }
  return buildHarnessManifest({
    ...(parsed as BuildHarnessManifestInput),
    manifestId: undefined,
  });
}

export function buildCurrentHarnessCandidateManifest(input: {
  readonly baseManifest: HarnessManifest;
  readonly currentRuntime: HarnessCurrentRuntimeIdentity;
}): HarnessManifest {
  return buildHarnessManifest({
    ...input.baseManifest,
    manifestId: undefined,
    runtime: {
      ...input.baseManifest.runtime,
      configHash: input.currentRuntime.configHash,
      runtimeIdentityHash: input.currentRuntime.runtimeIdentityHash,
    },
  });
}

export function selectHarnessCompareBaseSnapshot(
  snapshots: readonly SessionIndexHarnessTraceSnapshot[],
  divergeAt: string,
): HarnessCompareBaseSnapshotSelection {
  if (snapshots.length === 0) {
    return {
      status: "error",
      message: "no Harness manifest snapshot found for source session.",
    };
  }
  const matching = snapshots.filter((snapshot) => snapshot.eventIds.includes(divergeAt));
  if (matching.length === 1) {
    return { status: "selected", snapshot: firstHarnessSnapshot(matching) };
  }
  if (matching.length > 1) {
    return {
      status: "error",
      message: `divergence event ${divergeAt} matched multiple Harness snapshots; choose a divergence event unique to one snapshot.`,
    };
  }
  if (snapshots.length === 1) {
    return { status: "selected", snapshot: firstHarnessSnapshot(snapshots) };
  }
  return {
    status: "error",
    message: `divergence event ${divergeAt} did not match any Harness snapshot evidence; run brewva harness snapshots --session <id> --json and choose an event id from the intended snapshot.`,
  };
}

function firstHarnessSnapshot(
  snapshots: readonly SessionIndexHarnessTraceSnapshot[],
): SessionIndexHarnessTraceSnapshot {
  const snapshot = snapshots[0];
  if (!snapshot) {
    throw new Error("harness_compare_snapshot_selection_empty");
  }
  return snapshot;
}

// The differ lives with the materialization classifier in the gateway
// harness domain; the CLI re-exports it for existing consumers.
export { diffHarnessManifestFields } from "@brewva/brewva-gateway/harness";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseHarnessArgs(
  argv: string[],
):
  | { readonly kind: "ok"; readonly command: HarnessCommand; readonly options: HarnessCliOptions }
  | { readonly kind: "help" }
  | { readonly kind: "error"; readonly message: string } {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: HARNESS_PARSE_OPTIONS,
      allowPositionals: true,
    });
  } catch (error) {
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
  if (parsed.values.help) {
    return { kind: "help" };
  }
  const command = parsed.positionals[0] as HarnessCommand | undefined;
  if (!command || !["snapshots", "patrol", "compare", "candidate"].includes(command)) {
    return {
      kind: "error",
      message: "Error: expected one of: brewva harness snapshots | patrol | compare | candidate.",
    };
  }
  let candidateAction: HarnessCandidateLifecycleAction | undefined;
  if (command === "candidate") {
    const verb = parsed.positionals[1];
    candidateAction =
      verb === "accept"
        ? "accepted"
        : verb === "reject"
          ? "rejected"
          : verb === "archive"
            ? "archived"
            : undefined;
    if (!candidateAction) {
      return {
        kind: "error",
        message: "Error: expected one of: brewva harness candidate accept | reject | archive.",
      };
    }
  }
  const limit = parsePositiveInteger(parsed.values.limit, 50, "--limit");
  if (!limit.ok) return { kind: "error", message: limit.message };
  const minOccurrences = parsePositiveInteger(
    parsed.values["min-occurrences"],
    2,
    "--min-occurrences",
  );
  if (!minOccurrences.ok) return { kind: "error", message: minOccurrences.message };
  const mode = parseCompareMode(parsed.values.mode);
  if (!mode.ok) return { kind: "error", message: mode.message };

  return {
    kind: "ok",
    command,
    options: {
      cwd: stringValue(parsed.values.cwd),
      configPath: stringValue(parsed.values.config),
      json: parsed.values.json === true,
      sessionId: stringValue(parsed.values.session),
      limit: limit.value,
      minOccurrences: minOccurrences.value,
      sourceSessionId: stringValue(parsed.values["source-session"]),
      targetSessionId: stringValue(parsed.values["target-session"]),
      divergeAt: stringValue(parsed.values["diverge-at"]),
      candidateManifestPath: stringValue(parsed.values["candidate-manifest"]),
      mode: mode.value,
      candidateId: stringValue(parsed.values.candidate),
      reason: stringValue(parsed.values.reason),
      ...(candidateAction ? { candidateAction } : {}),
    },
  };
}

function parsePositiveInteger(
  raw: string | boolean | (string | boolean)[] | undefined,
  fallback: number,
  name: string,
):
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly message: string } {
  if (Array.isArray(raw)) {
    return { ok: false, message: `Error: ${name} may only be provided once.` };
  }
  if (raw === undefined || raw === false) return { ok: true, value: fallback };
  if (typeof raw !== "string" || raw.trim().length === 0) {
    return { ok: false, message: `Error: ${name} must be a positive integer.` };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return { ok: false, message: `Error: ${name} must be a positive integer.` };
  }
  return { ok: true, value };
}

function parseCompareMode(
  raw: string | boolean | (string | boolean)[] | undefined,
):
  | { readonly ok: true; readonly value: HarnessCliOptions["mode"] }
  | { readonly ok: false; readonly message: string } {
  if (Array.isArray(raw)) return { ok: false, message: "Error: --mode may only be provided once." };
  if (raw === undefined || raw === false) return { ok: true, value: "manifest" };
  if (raw === "manifest" || raw === "fixture" || raw === "real") {
    return { ok: true, value: raw };
  }
  return { ok: false, message: "Error: --mode must be manifest, fixture, or real." };
}

function stringValue(
  value: string | boolean | (string | boolean)[] | undefined,
): string | undefined {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" && first.length > 0 ? first : undefined;
  }
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function printHarnessHelp(): void {
  console.log(`Brewva Harness

Usage:
  brewva harness snapshots [--session <id>] [--limit <n>] [--json]
  brewva harness patrol [--limit <n>] [--min-occurrences <n>] [--json]
  brewva harness compare --source-session <id> --diverge-at <event-id> [--mode manifest|fixture|real] [--target-session <id>] [--candidate-manifest <path>] [--json]
  brewva harness candidate accept|reject|archive --candidate <candidateId> --reason <text> [--json]

Replay compare prompt source:
  fixture and real modes continue from the first source turn after divergence, the divergence turn itself, or a synthetic continuation prompt when no recorded turn prompt is available. The selected source is reported as promptSource.

Real mode trial world:
  --mode real always executes in a disposable copy-on-write fork of the workspace (filesystem effects never touch the live cwd; durable tape/ledger evidence stays in the operator store under the target session). Forking copies and hashes the tracked tree — large workspaces pay real IO, oversized trees fail closed. Forks from a linked git worktree are git-less (reported as workspace source "walk"); git-dependent tool calls will fail there for environmental reasons, not candidate ones.

Candidate materialization (--candidate-manifest with --mode real):
  every changed field must flow through an execution seam (today: provider.model) or be a hash the run recomputes; anything else refuses with the field named. The base manifest must still describe the current runtime.

Candidate lifecycle:
  every compare appends an "evaluated" receipt to .brewva/harness/candidates.jsonl under the report's candidateId (stable across compare runs and eval reports over the same base/candidate manifest pair). accept | reject | archive record the operator's decision with a required --reason; the runtime derives no authority from these receipts — promotion stays a human act.`);
}
