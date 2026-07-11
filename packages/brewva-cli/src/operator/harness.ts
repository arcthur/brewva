import { existsSync } from "node:fs";
import { cp, readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";
import { createIsolatedWorkspace } from "@brewva/brewva-gateway/delegation";
import {
  absolutizeHarnessDataRoots,
  appendHarnessCandidateLifecycleRecord,
  buildHarnessCandidatePatch,
  clusterHarnessTraceSnapshots,
  compareHarnessCandidate,
  diffHarnessManifestFields,
  executeHarnessCandidateComparison,
  readHarnessCandidateLifecycleRecords,
  resolveHarnessCandidatePatchMaterialization,
  toHarnessRuntimeFactory,
  type HarnessAttachedTrialRuntime,
  type HarnessCandidateExecutionPorts,
  type HarnessCandidateMaterialization,
} from "@brewva/brewva-gateway/harness";
import {
  createHostedHarnessRuntimeExecutionPorts,
  createHostedRuntimeAdapter,
  createHostedSession,
  type HostedRuntimeAdapterPort,
  type HostedSession,
} from "@brewva/brewva-gateway/hosted";
import type { CanonicalEvent } from "@brewva/brewva-runtime";
import {
  createSessionIndex,
  type SessionIndex,
  type SessionIndexHarnessPatternCandidate,
  type SessionIndexHarnessTraceSnapshot,
} from "@brewva/brewva-session-index";
import { toErrorMessage, isRecord } from "@brewva/brewva-std/unknown";
import {
  buildHarnessEvaluationId,
  buildHarnessManifest,
  HARNESS_CANDIDATE_ID_PREFIX,
  HARNESS_CANDIDATE_LIFECYCLE_SCHEMA,
  isHarnessCandidateId,
  stableHarnessId,
  type BuildHarnessManifestInput,
  type HarnessCandidateDecisionReceipt,
  type HarnessCandidateEvaluationReceipt,
  type HarnessCandidateLifecycleAction,
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
  // Decisions apply to candidate patches only. Patrol pattern ids
  // (`harness_pattern:`), snapshot ids, and free text refuse instead of
  // minting a decision about something that is not an executable candidate.
  if (!isHarnessCandidateId(options.candidateId)) {
    console.error(
      `Error: '${options.candidateId}' is not a candidate id (expected ${HARNESS_CANDIDATE_ID_PREFIX}<hash>). Patrol patterns are report artifacts — run a compare to mint the candidate this decision is about.`,
    );
    return 1;
  }
  if (options.candidateAction === "evaluated") {
    console.error(
      "Error: 'evaluated' rows are appended by compare runs; the decision verbs are accept | reject | archive.",
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
  const record: HarnessCandidateDecisionReceipt = {
    schema: HARNESS_CANDIDATE_LIFECYCLE_SCHEMA,
    candidateId: options.candidateId,
    action: options.candidateAction,
    at: new Date().toISOString(),
    actor: "cli_invocation",
    reason: options.reason,
  };
  try {
    appendHarnessCandidateLifecycleRecord(workspaceRoot, record);
  } catch (error) {
    // A decision that could not be durably recorded did not happen: unlike a
    // compare (whose expensive report already printed), refusing here is
    // cheap and honest.
    console.error(`Error: failed to record the decision (${toErrorMessage(error)}).`);
    return 1;
  }
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
        `pattern=${candidate.patternId}`,
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
      ? `executedManifest=${report.metrics.execution.executedManifestId ?? "-"}`
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
 * refuses it. Real mode admits a loaded candidate only by reducing it to a
 * patch and materializing that patch
 * (`resolveHarnessCandidatePatchMaterialization`): every editable delta field
 * must flow through an execution seam, else the compare refuses with the
 * blocked fields named. Either way no replay report labels a candidate the
 * fork did not run.
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
        // The candidate PATCH is the lifecycle identity; the full manifests
        // are only the fact snapshots it was derived from. Reuse the diff
        // computed above rather than re-diffing the same pair.
        candidateId: buildHarnessCandidatePatch({
          base: baseManifest,
          candidate: candidateManifest,
          changedFields,
        }).candidateId,
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
      // Real mode: pre-check the candidate patch's materializability so an
      // unbuildable candidate refuses BEFORE the expensive trial-world fork.
      // The API re-derives the patch (its own trust boundary) and re-enforces,
      // so this is a nicer early error, not the authority. Fixture mode builds
      // no patch here — its candidateId is minted inside the comparison.
      const materialization =
        options.mode === "real"
          ? resolveHarnessCandidatePatchMaterialization(
              buildHarnessCandidatePatch({
                base: baseManifest,
                candidate: candidateManifest,
                changedFields,
              }).delta,
            )
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
    console.error(`Error: ${toErrorMessage(error)}`);
    return 1;
  }
  if (options.json) {
    console.log(JSON.stringify({ report }, null, 2));
  } else {
    console.log(formatHarnessComparisonText(report));
  }
  return appendHarnessEvaluationReceipt(runtime.identity.workspaceRoot, report);
}

/**
 * The comparison ran and its report printed, but the durable evaluation
 * receipt could not be appended. Distinct from 1 (the compare itself failed)
 * so scripted callers can retry the receipt without rerunning the compare.
 */
export const HARNESS_EXIT_PARTIAL_RECEIPT_FAILURE = 3;

/**
 * Execution-backed compares (fixture/real) append an evaluation receipt to
 * the workspace candidate ledger — the evidence-bearing row a later
 * accept/reject/archive decision traces back to. Manifest-only diffing
 * executed nothing, so it appends nothing: an `evaluated` row must always
 * point at a run. The report is already printed when this runs; a ledger IO
 * failure must not eat a completed (and possibly expensive) comparison, so
 * the report stands and the exit code reports the partial failure.
 */
export function appendHarnessEvaluationReceipt(
  workspaceRoot: string,
  report: HarnessComparisonReport,
): number {
  if (report.mode === "manifest") {
    return 0;
  }
  try {
    const receipt: HarnessCandidateEvaluationReceipt = {
      schema: HARNESS_CANDIDATE_LIFECYCLE_SCHEMA,
      candidateId: report.candidateId,
      action: "evaluated",
      at: new Date().toISOString(),
      actor: "cli_invocation",
      evaluationId: buildHarnessEvaluationId({
        candidateId: report.candidateId,
        sourceSessionId: report.sourceSessionId,
        divergeAt: report.divergeAt,
        targetSessionId: report.targetSessionId,
        mode: report.mode,
      }),
      baseManifestId: report.baseManifestId,
      candidateManifestId: report.candidateManifestId,
      sourceSessionId: report.sourceSessionId,
      divergeAt: report.divergeAt,
      ...(report.targetSessionId ? { targetSessionId: report.targetSessionId } : {}),
      mode: report.mode,
      executedManifestId: report.metrics.execution?.executedManifestId ?? null,
      ...(report.metrics.execution?.trialWorldBasisId
        ? { trialWorldBasisId: report.metrics.execution.trialWorldBasisId }
        : {}),
      recommendation: report.promotion.recommendation,
      regressionCount: report.metrics.regressions.length,
    };
    appendHarnessCandidateLifecycleRecord(workspaceRoot, receipt);
  } catch (error) {
    console.error(
      `Warning: failed to append the evaluated receipt to the candidate ledger (${toErrorMessage(
        error,
      )}); the report above is complete, but ${report.candidateId} has no evaluated row.`,
    );
    return HARNESS_EXIT_PARTIAL_RECEIPT_FAILURE;
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
  if (!realMode) {
    // No attached runtime → fixture no-op tools, shared_operator_cwd.
    return executeHarnessCandidateComparison({
      mode: "fixture",
      runtime: toHarnessRuntimeFactory(input.runtime),
      sourceSessionId: input.options.sourceSessionId,
      targetSessionId: input.targetSessionId,
      divergeAt: input.options.divergeAt,
      baseManifest: input.baseManifest,
      candidateManifest: input.candidateManifest,
      sourceEvents,
      changedFields: input.changedFields,
    });
  }
  const requestedModel = input.materialization?.overrides.model;
  let trial: HarnessTrialRunOwner | undefined;
  try {
    // One owner for the whole trial run: the trial world, the trial-rooted
    // runtime identity (and with it every tool root), the execution ports,
    // and the single tape writer for the target session all come from
    // `createHarnessTrialRunOwner` as a unit — there is no seam where a
    // second runtime or a live-workspace root can slip in.
    trial = await createHarnessTrialRunOwner({
      runtime: input.runtime,
      configPath: input.options.configPath,
      sourceSessionId: input.options.sourceSessionId,
      sourceEvents,
      divergeAt: input.options.divergeAt,
      targetSessionId: input.targetSessionId,
      forkTag: `harness:${input.candidateManifest.manifestId}`,
      model: requestedModel,
    });
    // A materialized model claim is verified, not assumed: session creation
    // may silently fall back when the requested model's provider auth is not
    // connected, which would execute a model the report does not describe.
    if (requestedModel !== undefined) {
      const active = trial.ports.activeModelId();
      if (trial.modelFallbackMessage || active !== requestedModel) {
        throw new Error(
          `harness_materialized_model_unavailable: requested '${requestedModel}' but the trial session resolved '${active ?? "-"}'${
            trial.modelFallbackMessage ? ` (${trial.modelFallbackMessage})` : ""
          }. Connect the model's provider auth or drop the provider.model delta.`,
        );
      }
    }
    // The trial world rides on the attached runtime (one owner created both),
    // so there is no separate workspace claim to pass or contradict.
    const report = await executeHarnessCandidateComparison({
      mode: "real",
      runtime: toHarnessRuntimeFactory(input.runtime),
      attachedRuntime: trial.attachedRuntime,
      sourceSessionId: input.options.sourceSessionId,
      targetSessionId: input.targetSessionId,
      divergeAt: input.options.divergeAt,
      baseManifest: input.baseManifest,
      candidateManifest: input.candidateManifest,
      sourceEvents,
      changedFields: input.changedFields,
      ports: trial.ports,
    });
    // Mid-turn provider fallback can swap models transparently; a report for
    // a run that finished on a different model is not candidate evidence, so
    // refuse to return it rather than label it.
    if (requestedModel !== undefined) {
      const active = trial.ports.activeModelId();
      if (active !== requestedModel) {
        throw new Error(
          `harness_materialized_model_diverged: the run started on '${requestedModel}' but ended on '${active ?? "-"}' (provider fallback during the turn). The fallback selection is recorded on the target session's tape.`,
        );
      }
    }
    return report;
  } finally {
    await trial?.dispose();
  }
}

interface HarnessTrialRunOwner {
  readonly ports: ReturnType<typeof createHostedHarnessRuntimeExecutionPorts>;
  /** Carries the fork descriptor (`.world`) the comparison reports from. */
  readonly attachedRuntime: HarnessAttachedTrialRuntime;
  readonly modelFallbackMessage?: string;
  dispose(): Promise<void>;
}

/**
 * Assemble the trial run as ONE owner:
 *
 * - The trial world is a disposable copy-on-write fork of the operator
 *   WORKSPACE root (never the invocation subdirectory). The fork copy plus
 *   basis capture reads and hashes the whole tracked tree — large workspaces
 *   pay real IO here, and oversized trees fail closed through the
 *   world-store enumeration caps.
 * - The trial adapter is a fresh hosted runtime rooted at the fork: its
 *   `identity.cwd` and `identity.workspaceRoot` are the trial root, so task
 *   descriptors and tool allowed roots resolve inside the fork, and
 *   `toolTargetRootGrants: "descriptor_only"` seals prompt-derived external
 *   writable roots (replayed prompts routinely cite the operator's real
 *   workspace). Durable data roots are absolutized to the operator store so
 *   the fork's tape/ledger evidence survives the world's disposal.
 * - The trial adapter's physics IS the replay-then-real fork, with provider/
 *   tool/authority thunks late-bound to the hosted session's ports. The
 *   hosted session is created over this same adapter, so the target session
 *   has exactly one tape writer: replayed prefix, provider-manifest
 *   advisories, and turn/tool events share one commit port.
 */
async function createHarnessTrialRunOwner(input: {
  readonly runtime: HostedRuntimeAdapterPort;
  readonly configPath?: string;
  readonly sourceSessionId: string;
  readonly sourceEvents: readonly CanonicalEvent[];
  readonly divergeAt: string;
  readonly targetSessionId: string;
  readonly forkTag: string;
  readonly model?: string;
}): Promise<HarnessTrialRunOwner> {
  const operatorWorkspaceRoot = input.runtime.identity.workspaceRoot;
  const world = await createIsolatedWorkspace(operatorWorkspaceRoot, "brewva-harness-trial-");
  let hostedSession: HostedSession | undefined;
  let trialAdapter: HostedRuntimeAdapterPort | undefined;
  const portCell: { ports?: HarnessCandidateExecutionPorts } = {};
  const requireTrialPorts = (): HarnessCandidateExecutionPorts => {
    if (!portCell.ports) {
      throw new Error("harness_trial_ports_unbound");
    }
    return portCell.ports;
  };
  try {
    // Project settings are config, not run data: the fork copy excludes
    // `.brewva` wholesale, but model presets and routing fallback chains must
    // resolve in the trial session exactly as they would in this workspace,
    // or the comparison measures a configuration that exists nowhere. The
    // basis id excludes data roots by the same rule, so the copied settings
    // are fingerprinted separately — from the tree the fork will actually
    // execute, after the copy — and recorded on the report.
    let settingsHash: string | undefined;
    const settingsDir = join(operatorWorkspaceRoot, ".brewva", "agent");
    if (existsSync(settingsDir)) {
      const copiedSettingsDir = join(world.root, ".brewva", "agent");
      await cp(settingsDir, copiedSettingsDir, {
        recursive: true,
        force: true,
      });
      settingsHash = await hashHarnessTrialSettings(copiedSettingsDir);
    }
    trialAdapter = createHostedRuntimeAdapter({
      cwd: world.root,
      agentId: input.runtime.identity.agentId,
      config: absolutizeHarnessDataRoots(input.runtime),
      toolTargetRootGrants: "descriptor_only",
      physics: {
        mode: "replay-then-real",
        source: {
          sessionId: input.sourceSessionId,
          events: input.sourceEvents,
        },
        divergeAt: input.divergeAt,
        target: {
          sessionId: input.targetSessionId,
          forkTag: input.forkTag,
        },
        provider: {
          stream: (streamInput) => requireTrialPorts().provider.stream(streamInput),
        },
        toolExecutor: {
          execute: (commitment, executorInput) =>
            requireTrialPorts().toolExecutor.execute(commitment, executorInput),
        },
        resolveToolAuthority: (toolName, args, sessionId) => {
          const resolver = requireTrialPorts().resolveToolAuthority;
          if (!resolver) {
            throw new Error("harness_trial_authority_unbound");
          }
          return resolver(toolName, args, sessionId);
        },
      },
    });
    const session = await createHostedSession({
      runtime: trialAdapter,
      cwd: world.root,
      configPath: input.configPath,
      sessionId: input.targetSessionId,
      ...(input.model !== undefined ? { model: input.model } : {}),
      deferPersistenceUntilPrompt: true,
      // No delegation inside a trial: a child session would get a FRESH
      // adapter without this owner's root seal (prompt-mentioned operator
      // paths would become writable again), and candidate evidence must come
      // from the harness under test, not from subagents it spawns.
      enableSubagents: false,
    });
    hostedSession = session.session;
    const ownedAdapter = trialAdapter;
    const ports = createHostedHarnessRuntimeExecutionPorts(session.session, {
      actionAdmissionOverrides: ownedAdapter.config.security.actionAdmissionOverrides,
    });
    return {
      ports,
      attachedRuntime: {
        runtime: ownedAdapter.runtime,
        // The fork descriptor travels WITH the runtime that owns it — the
        // comparison never receives (or could contradict) a separate
        // workspace claim.
        world: {
          root: world.root,
          basisWorldId: world.basisWorldId,
          source: world.basisSource,
          ...(settingsHash ? { settingsHash } : {}),
        },
        bindPorts: (boundPorts) => {
          portCell.ports = boundPorts;
        },
      },
      ...(session.modelFallbackMessage
        ? { modelFallbackMessage: session.modelFallbackMessage }
        : {}),
      async dispose() {
        // Close order: the hosted session first (it feeds the runtime's
        // ports), then the runtime (tape close is idempotent — an unstarted
        // runtime holds no descriptors), then the disposable world.
        try {
          hostedSession?.dispose();
        } finally {
          try {
            await ownedAdapter.runtime.close();
          } finally {
            await world.dispose();
          }
        }
      },
    };
  } catch (error) {
    // Same close discipline on the construction error path; each step runs
    // even when an earlier one throws, and the ORIGINAL error is what
    // propagates (a cleanup failure must not mask the cause).
    try {
      hostedSession?.dispose();
    } catch {
      // Session teardown best-effort; the construction error is the story.
    }
    try {
      await trialAdapter?.runtime.close();
    } catch {
      // An unstarted runtime's close is normally a no-op; ignore.
    }
    try {
      await world.dispose();
    } catch {
      // The OS temp dir reaper collects an undisposed trial world.
    }
    throw error;
  }
}

/**
 * Deterministic content fingerprint of the settings tree copied into the
 * trial world: sorted relative paths mapped to content hashes. Two trial runs
 * with the same basis world id and the same settings hash executed the same
 * environment.
 */
async function hashHarnessTrialSettings(settingsDir: string): Promise<string> {
  const files: Record<string, string> = {};
  const entries = await readdir(settingsDir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const absolute = join(entry.parentPath, entry.name);
    const relativePath = relative(settingsDir, absolute);
    files[relativePath] = stableHarnessId("file", await readFile(absolute, "utf8"));
  }
  return stableHarnessId("harness_trial_settings", files);
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
  return isRecord(value);
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
    return { kind: "error", message: toErrorMessage(error) };
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
  execution-backed compares (fixture/real) append an "evaluated" receipt to .brewva/harness/candidates.jsonl under the report's candidateId — the hash of the candidate's normalized field delta, so the same edit evaluated against different bases stays one candidate. Manifest-only diffing appends nothing. accept | reject | archive record the operator's decision with a required --reason and refuse non-candidate ids (patrol pattern ids are report artifacts); the runtime derives no authority from these receipts — promotion stays a human act. A compare whose receipt append fails still prints its report and exits 3 (partial failure).`);
}
