import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";
import {
  clusterHarnessTraceSnapshots,
  compareHarnessCandidate,
  executeHarnessCandidateComparison,
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
  stableHarnessId,
  type BuildHarnessManifestInput,
  type HarnessComparisonReport,
  type HarnessManifest,
} from "@brewva/brewva-vocabulary/harness";
import { createCliSessionIndexSources } from "../runtime/runtime-ports.js";

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
  mode: { type: "string" },
  json: { type: "boolean" },
} as const;

type HarnessCommand = "snapshots" | "patrol" | "compare";

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
  const index = await createSessionIndex({
    ...createCliSessionIndexSources(runtime),
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
    `source=${report.sourceSessionId}`,
    `target=${report.targetSessionId ?? "-"}`,
    `divergeAt=${report.divergeAt}`,
    `base=${report.baseManifestId}`,
    `candidate=${report.candidateManifestId}`,
    `sideEffectPolicy=${report.sideEffectPolicy}`,
    `changedFields=${report.changedFields.join(",") || "-"}`,
    report.metrics.execution
      ? `executionFrames=${report.metrics.execution.frameCount}`
      : "executionFrames=-",
    report.metrics.execution
      ? `targetEvents=${report.metrics.execution.targetEventCount}`
      : "targetEvents=-",
    `recommendation=${report.promotion.recommendation}`,
  ].join(" ");
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
      report = await runHarnessReplayCompare({
        runtime,
        options,
        targetSessionId: requiredTargetSessionId,
        baseManifest,
        candidateManifest,
        changedFields,
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
  return 0;
}

async function runHarnessReplayCompare(input: {
  readonly runtime: HostedRuntimeAdapterPort;
  readonly options: HarnessCliOptions;
  readonly targetSessionId: string;
  readonly baseManifest: HarnessManifest;
  readonly candidateManifest: HarnessManifest;
  readonly changedFields: readonly string[];
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
  let hostedSession: HostedSession | undefined;
  try {
    const ports =
      input.options.mode === "real"
        ? await createRealHarnessExecutionPorts({
            runtime: input.runtime,
            options: input.options,
            targetSessionId: input.targetSessionId,
          })
        : undefined;
    hostedSession = ports?.session;
    return await executeHarnessCandidateComparison({
      mode: input.options.mode === "real" ? "real" : "fixture",
      runtime: input.runtime,
      sourceSessionId: input.options.sourceSessionId,
      targetSessionId: input.targetSessionId,
      divergeAt: input.options.divergeAt,
      baseManifest: input.baseManifest,
      candidateManifest: input.candidateManifest,
      sourceEvents,
      changedFields: input.changedFields,
      ...(ports ? { ports: ports.ports } : {}),
    });
  } finally {
    hostedSession?.dispose();
  }
}

async function createRealHarnessExecutionPorts(input: {
  readonly runtime: HostedRuntimeAdapterPort;
  readonly options: HarnessCliOptions;
  readonly targetSessionId: string;
}): Promise<{
  readonly session: HostedSession;
  readonly ports: ReturnType<typeof createHostedHarnessRuntimeExecutionPorts>;
}> {
  const result = await createHostedSession({
    runtime: input.runtime,
    cwd: input.options.cwd,
    configPath: input.options.configPath,
    sessionId: input.targetSessionId,
    deferPersistenceUntilPrompt: true,
  });
  return {
    session: result.session,
    ports: createHostedHarnessRuntimeExecutionPorts(result.session, {
      actionAdmissionOverrides: input.runtime.config.security.actionAdmissionOverrides,
    }),
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

export function diffHarnessManifestFields(
  base: HarnessManifest,
  candidate: HarnessManifest,
): string[] {
  const fields = new Set<string>();
  collectChangedManifestFields("", base, candidate, fields);
  fields.delete("manifestId");
  return [...fields].toSorted();
}

function collectChangedManifestFields(
  path: string,
  base: unknown,
  candidate: unknown,
  fields: Set<string>,
): void {
  if (stableCompareJson(base) === stableCompareJson(candidate)) return;
  if (!isPlainRecord(base) || !isPlainRecord(candidate)) {
    if (path.length > 0) fields.add(path);
    return;
  }
  for (const key of [...new Set([...Object.keys(base), ...Object.keys(candidate)])].toSorted()) {
    collectChangedManifestFields(
      path.length > 0 ? `${path}.${key}` : key,
      base[key],
      candidate[key],
      fields,
    );
  }
}

function stableCompareJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableCompareJson).join(",")}]`;
  }
  if (!isPlainRecord(value)) {
    return JSON.stringify(value === undefined ? null : value);
  }
  return `{${Object.keys(value)
    .toSorted()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableCompareJson(value[key])}`)
    .join(",")}}`;
}

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
  if (!command || !["snapshots", "patrol", "compare"].includes(command)) {
    return {
      kind: "error",
      message: "Error: expected one of: brewva harness snapshots | patrol | compare.",
    };
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
  brewva harness compare --source-session <id> --diverge-at <event-id> [--mode manifest|fixture|real] [--target-session <id>] [--candidate-manifest <path>] [--json]`);
}
