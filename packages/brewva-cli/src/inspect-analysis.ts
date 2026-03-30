import { existsSync, statSync } from "node:fs";
import { posix as pathPosix, resolve } from "node:path";
import {
  CONTEXT_COMPACTION_GATE_BLOCKED_TOOL_EVENT_TYPE,
  EXEC_BLOCKED_ISOLATION_EVENT_TYPE,
  EXEC_FALLBACK_HOST_EVENT_TYPE,
  EXEC_SANDBOX_ERROR_EVENT_TYPE,
  FILE_SNAPSHOT_CAPTURED_EVENT_TYPE,
  SKILL_BUDGET_WARNING_EVENT_TYPE,
  SKILL_PARALLEL_WARNING_EVENT_TYPE,
  TOOL_CALL_BLOCKED_EVENT_TYPE,
  TOOL_CONTRACT_WARNING_EVENT_TYPE,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
  collectPathCandidates,
  collectPersistedPatchPaths,
  listPersistedPatchSets,
  resolveWorkspacePath,
  toWorkspaceRelativePath,
  type BrewvaEventRecord,
  type BrewvaRuntime,
  type EvidenceLedgerRow,
  type PersistedPatchSet,
} from "@brewva/brewva-runtime";
import { formatISO } from "date-fns";

const IGNORED_WORKSPACE_PREFIXES = [".orchestrator/", ".brewva/", "node_modules/"] as const;
const PARALLEL_SLOT_REJECTED_EVENT_TYPE = "parallel_slot_rejected";
const OPS_INSIGHT_EVENT_TYPES = new Set<string>([
  EXEC_BLOCKED_ISOLATION_EVENT_TYPE,
  EXEC_FALLBACK_HOST_EVENT_TYPE,
  EXEC_SANDBOX_ERROR_EVENT_TYPE,
]);
const RUNTIME_PRESSURE_EVENT_TYPES = new Set<string>([
  CONTEXT_COMPACTION_GATE_BLOCKED_TOOL_EVENT_TYPE,
  PARALLEL_SLOT_REJECTED_EVENT_TYPE,
  SKILL_BUDGET_WARNING_EVENT_TYPE,
  SKILL_PARALLEL_WARNING_EVENT_TYPE,
]);

type InspectAnalysisMode = "audit" | "ops_if_available";
type InspectVerdict = "reasonable" | "mixed" | "questionable" | "insufficient_evidence";
type InspectFindingCode =
  | "durability"
  | "tool_contract"
  | "shell_composition"
  | "scope_drift"
  | "verification_hygiene"
  | "ops_environment"
  | "runtime_pressure";
type InspectFindingSeverity = "info" | "warn" | "error";
type InspectFindingConfidence = "low" | "medium" | "high";

interface InspectCutoff {
  latestEventId: string | null;
  timestamp: string | null;
}

interface InspectCoverage {
  writeAttribution: "strong";
  readAttribution: "heuristic";
  opsTelemetryAvailable: boolean;
}

interface InspectScope {
  touchedInDir: number;
  touchedOutOfDir: number;
  writesInDir: number;
  writesOutOfDir: number;
  readsInDirHeuristic: number;
  readsOutOfDirHeuristic: number;
}

interface InspectActivityDirectory {
  path: string;
  touched: number;
  writes: number;
  reads: number;
}

interface InspectFinding {
  code: InspectFindingCode;
  severity: InspectFindingSeverity;
  confidence: InspectFindingConfidence;
  summary: string;
  evidenceRefs: string[];
}

interface InspectDirectory {
  absolutePath: string;
  workspaceRelativePath: string;
}

interface InspectBaseReportForAnalysis {
  hydration: {
    status: "cold" | "ready" | "degraded";
    issueCount: number;
    issues: Array<{
      eventId: string;
    }>;
  };
  integrity: {
    status: "healthy" | "degraded" | "unavailable";
    issueCount: number;
    issues: Array<{
      eventId: string | null;
    }>;
  };
  task: {
    goal: string | null;
  };
  verification: {
    outcome: string | null;
    reason: string | null;
  };
  ledger: {
    path: string;
    integrityReason: string | null;
  };
  turnWal: {
    filePath: string;
  };
  snapshots: {
    patchHistoryPath: string;
    patchHistoryExists: boolean;
  };
  consistency: {
    ledgerIntegrity: "ok" | "invalid";
    pendingTurnWal: number;
  };
}

interface InspectAnalysisReport {
  directory: string;
  cutoff: InspectCutoff;
  mode: InspectAnalysisMode;
  coverage: InspectCoverage;
  scope: InspectScope;
  activity: {
    directories: InspectActivityDirectory[];
  };
  findings: InspectFinding[];
  evidenceGaps: string[];
  verdict: InspectVerdict;
}

function toIso(timestamp: number | null | undefined): string | null {
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? formatISO(timestamp) : null;
}

function normalizePathForDisplay(path: string): string {
  const normalized = path.replaceAll("\\", "/").trim();
  return normalized.length > 0 ? normalized : ".";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pathExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function isRelativePathInsideDir(path: string, directory: string): boolean {
  const normalizedPath = normalizePathForDisplay(path);
  const normalizedDir = normalizePathForDisplay(directory);
  if (normalizedDir === ".") return true;
  return normalizedPath === normalizedDir || normalizedPath.startsWith(`${normalizedDir}/`);
}

function isWorkspacePathIgnored(path: string): boolean {
  const normalized = normalizePathForDisplay(path);
  return IGNORED_WORKSPACE_PREFIXES.some(
    (prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix),
  );
}

function directoryFromWorkspacePath(path: string): string {
  const normalized = normalizePathForDisplay(path);
  if (normalized === ".") {
    return ".";
  }
  const directory = pathPosix.dirname(normalized);
  return directory === "" ? "." : directory;
}

function resolveCandidatePathToWorkspace(input: {
  candidate: string;
  cwd: string;
  workspaceRoot: string;
}): string | null {
  const resolved = resolveWorkspacePath({
    candidate: input.candidate,
    cwd: input.cwd,
    workspaceRoot: input.workspaceRoot,
    allowWorkspaceRoot: true,
    ignoredPrefixes: IGNORED_WORKSPACE_PREFIXES,
  });
  if (!resolved) {
    return null;
  }
  return resolved.relativePath;
}

function parseArgsSummary(argsSummary: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(argsSummary) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function collectHeuristicReadPaths(input: {
  rows: EvidenceLedgerRow[];
  cwd: string;
  workspaceRoot: string;
}): Set<string> {
  const collected = new Set<string>();

  for (const row of input.rows) {
    const args = parseArgsSummary(row.argsSummary);
    if (!args) {
      continue;
    }

    const candidates = collectPathCandidates(args, {
      allowUnkeyedString: true,
    });
    for (const candidate of candidates) {
      const resolved = resolveCandidatePathToWorkspace({
        candidate,
        cwd: input.cwd,
        workspaceRoot: input.workspaceRoot,
      });
      if (resolved) {
        collected.add(resolved);
      }
    }
  }

  return collected;
}

function collectStrongTouchedPaths(events: BrewvaEventRecord[]): Set<string> {
  const collected = new Set<string>();
  for (const event of events) {
    if (event.type !== FILE_SNAPSHOT_CAPTURED_EVENT_TYPE) {
      continue;
    }
    const files = Array.isArray(event.payload?.files)
      ? event.payload.files.filter((value): value is string => typeof value === "string")
      : [];
    for (const path of files) {
      const normalized = normalizePathForDisplay(path);
      if (!isWorkspacePathIgnored(normalized)) {
        collected.add(normalized);
      }
    }
  }
  return collected;
}

function collectWritePaths(patchSets: PersistedPatchSet[]): Set<string> {
  return collectPersistedPatchPaths(patchSets, {
    ignoredPrefixes: IGNORED_WORKSPACE_PREFIXES,
  });
}

function countPathsInDirectory(paths: Iterable<string>, directory: string): number {
  let count = 0;
  for (const path of paths) {
    if (isRelativePathInsideDir(path, directory)) {
      count += 1;
    }
  }
  return count;
}

function buildActivityDirectories(input: {
  touchedPaths: Iterable<string>;
  writePaths: Iterable<string>;
  heuristicReadPaths: Iterable<string>;
}): InspectActivityDirectory[] {
  const buckets = new Map<
    string,
    { touchedPaths: Set<string>; writePaths: Set<string>; readPaths: Set<string> }
  >();

  const ensureBucket = (path: string) => {
    const directory = directoryFromWorkspacePath(path);
    const existing = buckets.get(directory);
    if (existing) {
      return existing;
    }
    const created = {
      touchedPaths: new Set<string>(),
      writePaths: new Set<string>(),
      readPaths: new Set<string>(),
    };
    buckets.set(directory, created);
    return created;
  };

  for (const path of input.touchedPaths) {
    ensureBucket(path).touchedPaths.add(path);
  }
  for (const path of input.writePaths) {
    ensureBucket(path).writePaths.add(path);
  }
  for (const path of input.heuristicReadPaths) {
    ensureBucket(path).readPaths.add(path);
  }

  return [...buckets.entries()]
    .map(([path, bucket]) => ({
      path,
      touched: bucket.touchedPaths.size,
      writes: bucket.writePaths.size,
      reads: bucket.readPaths.size,
    }))
    .toSorted(
      (left, right) =>
        right.writes - left.writes ||
        right.touched - left.touched ||
        right.reads - left.reads ||
        left.path.localeCompare(right.path),
    );
}

function topEvidenceRefs(input: {
  eventIds?: string[];
  ledgerIds?: string[];
  patchIds?: string[];
  paths?: string[];
}): string[] {
  const refs = [
    ...(input.eventIds ?? []).map((value) => `event:${value}`),
    ...(input.ledgerIds ?? []).map((value) => `ledger:${value}`),
    ...(input.patchIds ?? []).map((value) => `patch:${value}`),
    ...(input.paths ?? []).map((value) => `path:${value}`),
  ];
  return uniqueStrings(refs).slice(0, 8);
}

function formatEventTypeCounts(events: BrewvaEventRecord[]): string {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .toSorted((left, right) => left[0].localeCompare(right[0]))
    .map(([type, count]) => `${type}=${count}`)
    .join(", ");
}

function collectPayloadStringValues(
  events: BrewvaEventRecord[],
  key: string,
  maxItems: number,
): string[] {
  return uniqueStrings(
    events
      .map((event) => (typeof event.payload?.[key] === "string" ? event.payload[key] : ""))
      .filter((value) => value.length > 0),
  ).slice(0, maxItems);
}

function buildDurabilityFinding(base: InspectBaseReportForAnalysis): InspectFinding | null {
  const issues: string[] = [];
  const eventIds: string[] = [];

  if (base.integrity.status !== "healthy") {
    issues.push(`integrity ${base.integrity.status} (${base.integrity.issueCount} issue(s))`);
    eventIds.push(
      ...base.integrity.issues
        .map((issue) => issue.eventId)
        .filter((issue): issue is string => typeof issue === "string" && issue.length > 0),
    );
  }
  if (base.consistency.ledgerIntegrity === "invalid") {
    issues.push(
      `ledger integrity invalid${base.ledger.integrityReason ? `: ${base.ledger.integrityReason}` : ""}`,
    );
  }
  if (base.consistency.pendingTurnWal > 0) {
    issues.push(`pending turn WAL entries=${base.consistency.pendingTurnWal}`);
  }

  if (issues.length === 0) {
    return null;
  }

  return {
    code: "durability",
    severity: issues.some((issue) => issue.includes("invalid") || issue.includes("degraded"))
      ? "error"
      : "warn",
    confidence: "high",
    summary: `Durability and replay consistency issues detected: ${issues.join("; ")}.`,
    evidenceRefs: topEvidenceRefs({ eventIds, paths: [base.ledger.path, base.turnWal.filePath] }),
  };
}

function buildToolContractFinding(events: BrewvaEventRecord[]): InspectFinding | null {
  const warnings = events.filter((event) => event.type === TOOL_CONTRACT_WARNING_EVENT_TYPE);
  const blocked = events.filter((event) => event.type === TOOL_CALL_BLOCKED_EVENT_TYPE);
  if (warnings.length === 0 && blocked.length === 0) {
    return null;
  }

  const reasons = uniqueStrings(
    [...warnings, ...blocked]
      .map((event) =>
        typeof event.payload?.reason === "string" ? event.payload.reason.trim() : "",
      )
      .filter((value) => value.length > 0),
  ).slice(0, 3);

  const reasonText = reasons.length > 0 ? ` Reasons: ${reasons.join(" | ")}.` : "";
  return {
    code: "tool_contract",
    severity: blocked.length > 0 ? "warn" : "info",
    confidence: "high",
    summary: `Observed ${warnings.length} tool contract warning(s) and ${blocked.length} blocked tool call(s), which points to tool-access or contract friction rather than raw model capability.${reasonText}`,
    evidenceRefs: topEvidenceRefs({
      eventIds: [...warnings, ...blocked].map((event) => event.id),
    }),
  };
}

function buildShellCompositionFinding(events: BrewvaEventRecord[]): InspectFinding | null {
  const matches = events.filter((event) => {
    if (event.type !== TOOL_RESULT_RECORDED_EVENT_TYPE) return false;
    return (
      event.payload?.failureClass === "shell_syntax" ||
      event.payload?.failureClass === "script_composition"
    );
  });
  if (matches.length === 0) {
    return null;
  }

  const shellSyntax = matches.filter(
    (event) => event.payload?.failureClass === "shell_syntax",
  ).length;
  const scriptComposition = matches.filter(
    (event) => event.payload?.failureClass === "script_composition",
  ).length;
  const tools = uniqueStrings(
    matches
      .map((event) => (typeof event.payload?.toolName === "string" ? event.payload.toolName : ""))
      .filter((value) => value.length > 0),
  );

  return {
    code: "shell_composition",
    severity: "error",
    confidence: "high",
    summary: `Command construction problems detected: shell_syntax=${shellSyntax}, script_composition=${scriptComposition}. Tools involved: ${tools.length > 0 ? tools.join(", ") : "unknown"}.`,
    evidenceRefs: topEvidenceRefs({
      eventIds: matches.map((event) => event.id),
      ledgerIds: matches
        .map((event) => (typeof event.payload?.ledgerId === "string" ? event.payload.ledgerId : ""))
        .filter((value) => value.length > 0),
    }),
  };
}

function buildScopeDriftFinding(input: {
  directory: InspectDirectory;
  strongTouchedPaths: Set<string>;
  writePaths: Set<string>;
  heuristicReadPaths: Set<string>;
  scope: InspectScope;
}): InspectFinding | null {
  const strongTouchedInDir = countPathsInDirectory(
    input.strongTouchedPaths,
    input.directory.workspaceRelativePath,
  );
  const strongTouchedOutOfDir = input.strongTouchedPaths.size - strongTouchedInDir;
  if (
    input.writePaths.size === 0 &&
    input.strongTouchedPaths.size === 0 &&
    input.heuristicReadPaths.size === 0
  ) {
    return null;
  }

  let summary: string | null = null;
  let severity: InspectFindingSeverity = "warn";
  let confidence: InspectFindingConfidence = "medium";

  if (input.scope.writesInDir === 0 && input.scope.writesOutOfDir > 0) {
    summary = `No persisted writes landed in target directory '${input.directory.workspaceRelativePath}', but ${input.scope.writesOutOfDir} write path(s) landed outside it.`;
    confidence = "high";
  } else if (strongTouchedInDir === 0 && strongTouchedOutOfDir > 0) {
    summary = `Mutation preparation touched ${strongTouchedOutOfDir} path(s) outside target directory '${input.directory.workspaceRelativePath}' and none inside it.`;
    confidence = "high";
  } else if (
    input.scope.writesOutOfDir > input.scope.writesInDir &&
    input.scope.writesOutOfDir > 0
  ) {
    summary = `More persisted writes landed outside target directory '${input.directory.workspaceRelativePath}' (${input.scope.writesOutOfDir}) than inside it (${input.scope.writesInDir}).`;
  } else if (
    input.scope.touchedInDir === 0 &&
    input.scope.touchedOutOfDir > 0 &&
    input.scope.readsInDirHeuristic === 0
  ) {
    summary = `Session activity was attributable outside target directory '${input.directory.workspaceRelativePath}', with no directory-attributable read or write evidence inside it.`;
    confidence = "low";
  }

  if (!summary) {
    return null;
  }

  return {
    code: "scope_drift",
    severity,
    confidence,
    summary,
    evidenceRefs: topEvidenceRefs({
      paths: [...input.writePaths, ...input.strongTouchedPaths, ...input.heuristicReadPaths],
    }),
  };
}

function buildVerificationHygieneFinding(input: {
  events: BrewvaEventRecord[];
  scope: InspectScope;
  base: InspectBaseReportForAnalysis;
}): InspectFinding | null {
  const writes = input.events.filter(
    (event) => event.type === VERIFICATION_WRITE_MARKED_EVENT_TYPE,
  );
  const verifications = input.events.filter(
    (event) => event.type === VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  );
  const latestWrite = writes[writes.length - 1];
  const latestVerification = verifications[verifications.length - 1];

  if (!latestWrite && input.base.verification.outcome !== "fail") {
    return null;
  }

  if (
    latestWrite &&
    (!latestVerification || latestVerification.timestamp < latestWrite.timestamp)
  ) {
    return {
      code: "verification_hygiene",
      severity: input.scope.writesInDir > 0 || input.scope.writesOutOfDir > 0 ? "warn" : "info",
      confidence: "high",
      summary:
        "A write was recorded after the latest verification evidence, so verification is stale or missing for the latest mutation attempt.",
      evidenceRefs: topEvidenceRefs({
        eventIds: [latestWrite.id, latestVerification?.id].filter(
          (value): value is string => typeof value === "string",
        ),
      }),
    };
  }

  if (input.base.verification.outcome === "fail") {
    return {
      code: "verification_hygiene",
      severity: "warn",
      confidence: "high",
      summary: `Latest verification outcome is fail${input.base.verification.reason ? ` (${input.base.verification.reason})` : ""}.`,
      evidenceRefs: topEvidenceRefs({
        eventIds: latestVerification ? [latestVerification.id] : [],
      }),
    };
  }

  return null;
}

function buildOpsEnvironmentFinding(events: BrewvaEventRecord[]): InspectFinding | null {
  const opsEvents = events.filter((event) => OPS_INSIGHT_EVENT_TYPES.has(event.type));
  if (opsEvents.length === 0) {
    return null;
  }

  const details = formatEventTypeCounts(opsEvents);
  const reasons = collectPayloadStringValues(opsEvents, "reason", 3);
  const errors = collectPayloadStringValues(opsEvents, "error", 2);
  const notes = [
    reasons.length > 0 ? `reasons=${reasons.join("|")}` : null,
    errors.length > 0 ? `errors=${errors.join("|")}` : null,
  ]
    .filter((value): value is string => value !== null)
    .join("; ");

  const severity = opsEvents.some(
    (event) =>
      event.type === EXEC_SANDBOX_ERROR_EVENT_TYPE ||
      event.type === EXEC_BLOCKED_ISOLATION_EVENT_TYPE,
  )
    ? "error"
    : "warn";
  return {
    code: "ops_environment",
    severity,
    confidence: "high",
    summary: `Operational telemetry indicates execution-environment friction: ${details}.${notes ? ` ${notes}.` : ""}`,
    evidenceRefs: topEvidenceRefs({
      eventIds: opsEvents.map((event) => event.id),
    }),
  };
}

function buildRuntimePressureFinding(events: BrewvaEventRecord[]): InspectFinding | null {
  const pressureEvents = events.filter((event) => RUNTIME_PRESSURE_EVENT_TYPES.has(event.type));
  if (pressureEvents.length === 0) {
    return null;
  }

  const details = formatEventTypeCounts(pressureEvents);
  const blockedTools = collectPayloadStringValues(pressureEvents, "blockedTool", 3);
  const reasons = collectPayloadStringValues(pressureEvents, "reason", 3);
  const budgetKinds = collectPayloadStringValues(pressureEvents, "budget", 3);
  const notes = [
    blockedTools.length > 0 ? `blockedTools=${blockedTools.join("|")}` : null,
    reasons.length > 0 ? `reasons=${reasons.join("|")}` : null,
    budgetKinds.length > 0 ? `budgets=${budgetKinds.join("|")}` : null,
  ]
    .filter((value): value is string => value !== null)
    .join("; ");

  const severity = pressureEvents.some(
    (event) =>
      event.type === CONTEXT_COMPACTION_GATE_BLOCKED_TOOL_EVENT_TYPE ||
      event.type === PARALLEL_SLOT_REJECTED_EVENT_TYPE,
  )
    ? "error"
    : "warn";
  return {
    code: "runtime_pressure",
    severity,
    confidence: "high",
    summary: `Runtime pressure signals indicate execution constraints unrelated to model capability: ${details}.${notes ? ` ${notes}.` : ""}`,
    evidenceRefs: topEvidenceRefs({
      eventIds: pressureEvents.map((event) => event.id),
    }),
  };
}

function resolveVerdict(findings: InspectFinding[], eventCount: number): InspectVerdict {
  if (eventCount === 0) return "insufficient_evidence";
  if (findings.some((finding) => finding.severity === "error")) {
    return "questionable";
  }
  if (findings.some((finding) => finding.severity === "warn")) {
    return "mixed";
  }
  return findings.length === 0 ? "reasonable" : "mixed";
}

function renderFinding(finding: InspectFinding, index: number): string[] {
  const lines = [
    `${index + 1}. [${finding.severity}] code=${finding.code} confidence=${finding.confidence}`,
    `   ${finding.summary}`,
  ];
  if (finding.evidenceRefs.length > 0) {
    lines.push(`   evidence: ${finding.evidenceRefs.join(", ")}`);
  }
  return lines;
}

export function clampText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(1, maxChars - 3))}...`;
}

export function resolveInspectDirectory(
  runtime: BrewvaRuntime,
  positionalDir: string | undefined,
  optionDir: string | undefined,
): InspectDirectory {
  if (positionalDir && optionDir) {
    throw new Error("use either a positional directory or --dir, not both");
  }

  const requested = positionalDir ?? optionDir;
  const absolutePath = requested ? resolve(runtime.cwd, requested) : resolve(runtime.cwd);
  if (!pathExists(absolutePath)) {
    throw new Error(`directory does not exist: ${absolutePath}`);
  }

  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(absolutePath);
  } catch (error) {
    throw new Error(
      `failed to stat inspect directory (${absolutePath}): ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(`inspect target must be a directory: ${absolutePath}`);
  }

  const workspaceRelativePath = toWorkspaceRelativePath(runtime.workspaceRoot, absolutePath);
  if (workspaceRelativePath === null) {
    throw new Error(`inspect directory must stay inside workspace root: ${runtime.workspaceRoot}`);
  }

  return {
    absolutePath,
    workspaceRelativePath,
  };
}

export function buildInspectAnalysis(input: {
  runtime: BrewvaRuntime;
  sessionId: string;
  directory: InspectDirectory;
  base: InspectBaseReportForAnalysis;
}): InspectAnalysisReport {
  const snapshotEvents = input.runtime.events.query(input.sessionId);
  const cutoffEvent = snapshotEvents[snapshotEvents.length - 1] ?? null;
  const cutoffTimestamp = cutoffEvent?.timestamp ?? null;
  const ledgerRows = input.runtime.ledger
    .listRows(input.sessionId)
    .filter((row) => cutoffTimestamp === null || row.timestamp <= cutoffTimestamp);
  const patchSets = listPersistedPatchSets({
    path: input.base.snapshots.patchHistoryPath,
    sessionId: input.sessionId,
    cutoffTimestamp,
  });
  const strongTouchedPaths = collectStrongTouchedPaths(snapshotEvents);
  const writePaths = collectWritePaths(patchSets);
  const heuristicReadPaths = collectHeuristicReadPaths({
    rows: ledgerRows,
    cwd: input.runtime.cwd,
    workspaceRoot: input.runtime.workspaceRoot,
  });
  const touchedPaths = new Set<string>([
    ...strongTouchedPaths,
    ...writePaths,
    ...heuristicReadPaths,
  ]);

  const scope: InspectScope = {
    touchedInDir: countPathsInDirectory(touchedPaths, input.directory.workspaceRelativePath),
    touchedOutOfDir:
      touchedPaths.size -
      countPathsInDirectory(touchedPaths, input.directory.workspaceRelativePath),
    writesInDir: countPathsInDirectory(writePaths, input.directory.workspaceRelativePath),
    writesOutOfDir:
      writePaths.size - countPathsInDirectory(writePaths, input.directory.workspaceRelativePath),
    readsInDirHeuristic: countPathsInDirectory(
      heuristicReadPaths,
      input.directory.workspaceRelativePath,
    ),
    readsOutOfDirHeuristic:
      heuristicReadPaths.size -
      countPathsInDirectory(heuristicReadPaths, input.directory.workspaceRelativePath),
  };
  const activityDirectories = buildActivityDirectories({
    touchedPaths,
    writePaths,
    heuristicReadPaths,
  });

  const opsTelemetryAvailable = input.runtime.config.infrastructure.events.level !== "audit";
  const findings = [
    buildDurabilityFinding(input.base),
    buildToolContractFinding(snapshotEvents),
    buildShellCompositionFinding(snapshotEvents),
    buildScopeDriftFinding({
      directory: input.directory,
      strongTouchedPaths,
      writePaths,
      heuristicReadPaths,
      scope,
    }),
    buildVerificationHygieneFinding({
      events: snapshotEvents,
      scope,
      base: input.base,
    }),
    opsTelemetryAvailable ? buildOpsEnvironmentFinding(snapshotEvents) : null,
    opsTelemetryAvailable ? buildRuntimePressureFinding(snapshotEvents) : null,
  ].filter((finding): finding is InspectFinding => finding !== null);

  const evidenceGaps: string[] = [
    "Read attribution is heuristic and derived primarily from persisted tool argument summaries.",
  ];
  if (!opsTelemetryAvailable) {
    evidenceGaps.push(
      "Current session recorded audit-level events only; ops-only telemetry such as exec backend routing and tool-call normalization failures is unavailable.",
    );
  }
  if (!input.base.snapshots.patchHistoryExists && writePaths.size === 0) {
    evidenceGaps.push(
      "No persisted patch history was available for the target session, so write-scope analysis may undercount mutation attempts.",
    );
  }
  if (heuristicReadPaths.size === 0) {
    evidenceGaps.push(
      "No directory-attributable read arguments were recovered from persisted ledger rows for this session snapshot.",
    );
  }

  return {
    directory: input.directory.workspaceRelativePath,
    cutoff: {
      latestEventId: cutoffEvent?.id ?? null,
      timestamp: toIso(cutoffTimestamp),
    },
    mode: opsTelemetryAvailable ? "ops_if_available" : "audit",
    coverage: {
      writeAttribution: "strong",
      readAttribution: "heuristic",
      opsTelemetryAvailable,
    },
    scope,
    activity: {
      directories: activityDirectories,
    },
    findings,
    evidenceGaps: uniqueStrings(evidenceGaps),
    verdict: resolveVerdict(findings, snapshotEvents.length),
  };
}

export function formatInspectAnalysisText(report: InspectAnalysisReport): string {
  const lines = [
    `Analysis: directory=${report.directory} verdict=${report.verdict} mode=${report.mode}`,
    `Analysis cutoff: event=${report.cutoff.latestEventId ?? "n/a"} timestamp=${report.cutoff.timestamp ?? "n/a"}`,
    `Analysis coverage: write=${report.coverage.writeAttribution} read=${report.coverage.readAttribution} ops=${report.coverage.opsTelemetryAvailable ? "yes" : "no"}`,
    `Analysis scope: touchedIn=${report.scope.touchedInDir} touchedOut=${report.scope.touchedOutOfDir} writesIn=${report.scope.writesInDir} writesOut=${report.scope.writesOutOfDir} readsIn=${report.scope.readsInDirHeuristic} readsOut=${report.scope.readsOutOfDirHeuristic}`,
  ];

  if (report.activity.directories.length > 0) {
    lines.push(
      `Analysis directories: ${report.activity.directories
        .slice(0, 5)
        .map(
          (directory) =>
            `${directory.path}[writes=${directory.writes},touched=${directory.touched},reads=${directory.reads}]`,
        )
        .join(" ")}`,
    );
  }

  lines.push("", "Analysis findings:");
  if (report.findings.length === 0) {
    lines.push("- none");
  } else {
    for (const [index, finding] of report.findings.entries()) {
      lines.push(...renderFinding(finding, index));
    }
  }

  lines.push("", "Analysis evidence gaps:");
  if (report.evidenceGaps.length === 0) {
    lines.push("- none");
  } else {
    for (const gap of report.evidenceGaps) {
      lines.push(`- ${gap}`);
    }
  }

  return lines.join("\n");
}

export type {
  InspectActivityDirectory,
  InspectAnalysisReport,
  InspectCoverage,
  InspectCutoff,
  InspectDirectory,
  InspectFinding,
  InspectFindingCode,
  InspectFindingConfidence,
  InspectFindingSeverity,
  InspectAnalysisMode,
  InspectScope,
  InspectVerdict,
  InspectBaseReportForAnalysis,
};
