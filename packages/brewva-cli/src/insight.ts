import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";
import {
  BrewvaRuntime,
  CONTEXT_COMPACTION_GATE_BLOCKED_TOOL_EVENT_TYPE,
  EXEC_BLOCKED_ISOLATION_EVENT_TYPE,
  EXEC_FALLBACK_HOST_EVENT_TYPE,
  EXEC_SANDBOX_ERROR_EVENT_TYPE,
  FILE_SNAPSHOT_CAPTURED_EVENT_TYPE,
  SKILL_BUDGET_WARNING_EVENT_TYPE,
  SKILL_PARALLEL_WARNING_EVENT_TYPE,
  TOOL_CALL_BLOCKED_EVENT_TYPE,
  TOOL_CALL_NORMALIZATION_FAILED_EVENT_TYPE,
  TOOL_CONTRACT_WARNING_EVENT_TYPE,
  TOOL_RESULT_RECORDED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  VERIFICATION_WRITE_MARKED_EVENT_TYPE,
  createTrustedLocalGovernancePort,
  type BrewvaEventRecord,
  type EvidenceLedgerRow,
} from "@brewva/brewva-runtime";
import { formatISO } from "date-fns";
import { buildInspectReport, resolveTargetSession } from "./inspect.js";

const INSIGHT_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  cwd: { type: "string" },
  config: { type: "string" },
  session: { type: "string" },
  dir: { type: "string" },
  json: { type: "boolean" },
} as const;

const PATHISH_KEY_PATTERN = /(path|paths|file|files|cwd|workdir|dir|directory)/i;
const IGNORED_WORKSPACE_PREFIXES = [".orchestrator/", ".brewva/", "node_modules/"] as const;
const PARALLEL_SLOT_REJECTED_EVENT_TYPE = "parallel_slot_rejected";
const OPS_INSIGHT_EVENT_TYPES = new Set<string>([
  EXEC_BLOCKED_ISOLATION_EVENT_TYPE,
  EXEC_FALLBACK_HOST_EVENT_TYPE,
  EXEC_SANDBOX_ERROR_EVENT_TYPE,
  TOOL_CALL_NORMALIZATION_FAILED_EVENT_TYPE,
]);
const RUNTIME_PRESSURE_EVENT_TYPES = new Set<string>([
  CONTEXT_COMPACTION_GATE_BLOCKED_TOOL_EVENT_TYPE,
  PARALLEL_SLOT_REJECTED_EVENT_TYPE,
  SKILL_BUDGET_WARNING_EVENT_TYPE,
  SKILL_PARALLEL_WARNING_EVENT_TYPE,
]);

type InspectReport = ReturnType<typeof buildInspectReport>;
type InsightMode = "audit" | "ops_if_available";
type InsightVerdict = "reasonable" | "mixed" | "questionable" | "insufficient_evidence";
type InsightFindingCode =
  | "durability"
  | "tool_contract"
  | "shell_composition"
  | "scope_drift"
  | "verification_hygiene"
  | "ops_environment"
  | "runtime_pressure";
type InsightFindingSeverity = "info" | "warn" | "error";
type InsightFindingConfidence = "low" | "medium" | "high";

interface InsightCutoff {
  latestEventId: string | null;
  timestamp: string | null;
}

interface InsightCoverage {
  writeAttribution: "strong";
  readAttribution: "heuristic";
  opsTelemetryAvailable: boolean;
}

interface InsightScope {
  touchedInDir: number;
  touchedOutOfDir: number;
  writesInDir: number;
  writesOutOfDir: number;
  readsInDirHeuristic: number;
  readsOutOfDirHeuristic: number;
}

interface InsightFinding {
  code: InsightFindingCode;
  severity: InsightFindingSeverity;
  confidence: InsightFindingConfidence;
  summary: string;
  evidenceRefs: string[];
}

interface SessionInsightReport {
  sessionId: string;
  directory: string;
  cutoff: InsightCutoff;
  mode: InsightMode;
  base: InspectReport;
  coverage: InsightCoverage;
  scope: InsightScope;
  findings: InsightFinding[];
  evidenceGaps: string[];
  verdict: InsightVerdict;
}

interface InsightDirectory {
  absolutePath: string;
  workspaceRelativePath: string;
}

interface PersistedPatchHistory {
  version: 1;
  sessionId: string;
  updatedAt: number;
  patchSets: PersistedPatchSet[];
}

interface PersistedPatchSet {
  id: string;
  createdAt: number;
  summary?: string;
  toolName: string;
  appliedAt: number;
  changes: PersistedPatchChange[];
}

interface PersistedPatchChange {
  path: string;
  action: string;
}

interface InsightBuildInput {
  runtime: BrewvaRuntime;
  sessionId: string;
  directory: InsightDirectory;
}

function printInsightHelp(): void {
  console.log(`Brewva Insight - cutoff-aware session review for a directory

Usage:
  brewva insight [directory] [options]

Options:
  --cwd <path>       Working directory
  --config <path>    Brewva config path (default: .brewva/brewva.json)
  --session <id>     Inspect a specific replay session
  --dir <path>       Target directory (alternative to positional argument)
  --json             Emit JSON output
  -h, --help         Show help

Examples:
  brewva insight
  brewva insight packages/brewva-runtime/src
  brewva insight --session <session-id> --dir packages/brewva-cli/src
  brewva insight --json packages/brewva-runtime/src`);
}

export function clampText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(1, maxChars - 3))}...`;
}

function toIso(timestamp: number | null | undefined): string | null {
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? formatISO(timestamp) : null;
}

function normalizeRelativePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function normalizePathForDisplay(path: string): string {
  const normalized = normalizeRelativePath(path).trim();
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

function toWorkspaceRelativePath(workspaceRoot: string, absolutePath: string): string | null {
  const normalizedRoot = resolve(workspaceRoot);
  const normalizedPath = resolve(absolutePath);
  const rel = normalizeRelativePath(relative(normalizedRoot, normalizedPath));
  if (!rel) return ".";
  if (rel === ".") return ".";
  if (rel.startsWith("../") || rel === "..") {
    return null;
  }
  return rel;
}

export function resolveInsightDirectory(
  runtime: BrewvaRuntime,
  positionalDir: string | undefined,
  optionDir: string | undefined,
): InsightDirectory {
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
      `failed to stat insight directory (${absolutePath}): ${error instanceof Error ? error.message : String(error)}`,
      {
        cause: error,
      },
    );
  }
  if (!stats.isDirectory()) {
    throw new Error(`insight target must be a directory: ${absolutePath}`);
  }

  const workspaceRelativePath = toWorkspaceRelativePath(runtime.workspaceRoot, absolutePath);
  if (workspaceRelativePath === null) {
    throw new Error(`insight directory must stay inside workspace root: ${runtime.workspaceRoot}`);
  }

  return {
    absolutePath,
    workspaceRelativePath,
  };
}

function readPatchHistory(
  path: string,
  sessionId: string,
  cutoffTimestamp: number | null,
): PersistedPatchSet[] {
  if (!pathExists(path)) return [];

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as PersistedPatchHistory;
    if (
      !parsed ||
      parsed.version !== 1 ||
      parsed.sessionId !== sessionId ||
      !Array.isArray(parsed.patchSets)
    ) {
      return [];
    }

    return parsed.patchSets.filter((patchSet) => {
      if (!patchSet || typeof patchSet.id !== "string" || !Array.isArray(patchSet.changes)) {
        return false;
      }
      if (cutoffTimestamp === null) return true;
      return typeof patchSet.appliedAt === "number" && patchSet.appliedAt <= cutoffTimestamp;
    });
  } catch {
    return [];
  }
}

function collectPathCandidates(value: unknown, keyHint?: string, output: string[] = []): string[] {
  if (typeof value === "string") {
    if (!keyHint || PATHISH_KEY_PATTERN.test(keyHint)) {
      output.push(value);
    }
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectPathCandidates(item, keyHint, output);
    }
    return output;
  }

  if (!isRecord(value)) {
    return output;
  }

  for (const [key, child] of Object.entries(value)) {
    collectPathCandidates(child, key, output);
  }
  return output;
}

function resolveCandidatePathToWorkspace(input: {
  candidate: string;
  cwd: string;
  workspaceRoot: string;
}): string | null {
  const trimmed = input.candidate.trim();
  if (!trimmed || trimmed.includes("\0")) {
    return null;
  }

  const absolutePath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(input.cwd, trimmed);
  const workspaceRelativePath = toWorkspaceRelativePath(input.workspaceRoot, absolutePath);
  if (!workspaceRelativePath || isWorkspacePathIgnored(workspaceRelativePath)) {
    return null;
  }
  return workspaceRelativePath;
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

    const candidates = collectPathCandidates(args);
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
  const collected = new Set<string>();
  for (const patchSet of patchSets) {
    for (const change of patchSet.changes) {
      if (!change || typeof change.path !== "string") continue;
      const normalized = normalizePathForDisplay(change.path);
      if (!isWorkspacePathIgnored(normalized)) {
        collected.add(normalized);
      }
    }
  }
  return collected;
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

function buildDurabilityFinding(base: InspectReport): InsightFinding | null {
  const issues: string[] = [];
  const eventIds: string[] = [];

  if (base.hydration.status === "degraded") {
    issues.push(`hydration degraded (${base.hydration.issueCount} issue(s))`);
    eventIds.push(...base.hydration.issues.map((issue) => issue.eventId));
  }
  if (base.consistency.ledgerChain === "invalid") {
    issues.push(
      `ledger chain invalid${base.ledger.chainReason ? `: ${base.ledger.chainReason}` : ""}`,
    );
  }
  if (base.consistency.projectionWorking === "missing") {
    issues.push("projection working snapshot missing while projection is enabled");
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
    evidenceRefs: topEvidenceRefs({
      eventIds,
      paths: [base.ledger.path, base.projection.workingPath, base.turnWal.filePath],
    }),
  };
}

function buildToolContractFinding(events: BrewvaEventRecord[]): InsightFinding | null {
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

function buildShellCompositionFinding(events: BrewvaEventRecord[]): InsightFinding | null {
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
  directory: InsightDirectory;
  strongTouchedPaths: Set<string>;
  writePaths: Set<string>;
  heuristicReadPaths: Set<string>;
  scope: InsightScope;
}): InsightFinding | null {
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
  let severity: InsightFindingSeverity = "warn";
  let confidence: InsightFindingConfidence = "medium";

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
  scope: InsightScope;
  base: InspectReport;
}): InsightFinding | null {
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

function buildOpsEnvironmentFinding(events: BrewvaEventRecord[]): InsightFinding | null {
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
      event.type === EXEC_BLOCKED_ISOLATION_EVENT_TYPE ||
      event.type === TOOL_CALL_NORMALIZATION_FAILED_EVENT_TYPE,
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

function buildRuntimePressureFinding(events: BrewvaEventRecord[]): InsightFinding | null {
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

function resolveVerdict(findings: InsightFinding[], eventCount: number): InsightVerdict {
  if (eventCount === 0) return "insufficient_evidence";
  if (findings.some((finding) => finding.severity === "error")) {
    return "questionable";
  }
  if (findings.some((finding) => finding.severity === "warn")) {
    return "mixed";
  }
  return findings.length === 0 ? "reasonable" : "mixed";
}

export function buildInsightReport(input: InsightBuildInput): SessionInsightReport {
  const snapshotEvents = input.runtime.events.query(input.sessionId);
  const cutoffEvent = snapshotEvents[snapshotEvents.length - 1] ?? null;
  const cutoffTimestamp = cutoffEvent?.timestamp ?? null;
  const base = buildInspectReport(input.runtime, input.sessionId);
  const ledgerRows = input.runtime.ledger
    .listRows(input.sessionId)
    .filter((row) => cutoffTimestamp === null || row.timestamp <= cutoffTimestamp);
  const patchSets = readPatchHistory(
    base.snapshots.patchHistoryPath,
    input.sessionId,
    cutoffTimestamp,
  );
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

  const scope: InsightScope = {
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

  const opsTelemetryAvailable = input.runtime.config.infrastructure.events.level !== "audit";
  const findings = [
    buildDurabilityFinding(base),
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
      base,
    }),
    opsTelemetryAvailable ? buildOpsEnvironmentFinding(snapshotEvents) : null,
    opsTelemetryAvailable ? buildRuntimePressureFinding(snapshotEvents) : null,
  ].filter((finding): finding is InsightFinding => finding !== null);

  const evidenceGaps: string[] = [
    "Read attribution is heuristic and derived primarily from persisted tool argument summaries.",
  ];
  if (!opsTelemetryAvailable) {
    evidenceGaps.push(
      "Current session recorded audit-level events only; ops-only telemetry such as exec backend routing and tool-call normalization failures is unavailable.",
    );
  }
  if (!base.snapshots.patchHistoryExists && writePaths.size === 0) {
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
    sessionId: input.sessionId,
    directory: input.directory.workspaceRelativePath,
    cutoff: {
      latestEventId: cutoffEvent?.id ?? null,
      timestamp: toIso(cutoffTimestamp),
    },
    mode: opsTelemetryAvailable ? "ops_if_available" : "audit",
    base,
    coverage: {
      writeAttribution: "strong",
      readAttribution: "heuristic",
      opsTelemetryAvailable,
    },
    scope,
    findings,
    evidenceGaps: uniqueStrings(evidenceGaps),
    verdict: resolveVerdict(findings, snapshotEvents.length),
  };
}

function renderFinding(finding: InsightFinding, index: number): string[] {
  const lines = [
    `${index + 1}. [${finding.severity}] code=${finding.code} confidence=${finding.confidence}`,
    `   ${finding.summary}`,
  ];
  if (finding.evidenceRefs.length > 0) {
    lines.push(`   evidence: ${finding.evidenceRefs.join(", ")}`);
  }
  return lines;
}

export function formatInsightText(report: SessionInsightReport): string {
  const lines = [
    `Session: ${report.sessionId}`,
    `Directory: ${report.directory}`,
    `Cutoff: event=${report.cutoff.latestEventId ?? "n/a"} timestamp=${report.cutoff.timestamp ?? "n/a"}`,
    `Mode: ${report.mode}`,
    `Verdict: ${report.verdict}`,
    `Coverage: write=${report.coverage.writeAttribution} read=${report.coverage.readAttribution} ops=${report.coverage.opsTelemetryAvailable ? "yes" : "no"}`,
    `Scope: touchedIn=${report.scope.touchedInDir} touchedOut=${report.scope.touchedOutOfDir} writesIn=${report.scope.writesInDir} writesOut=${report.scope.writesOutOfDir} readsIn=${report.scope.readsInDirHeuristic} readsOut=${report.scope.readsOutOfDirHeuristic}`,
    `Base: hydration=${report.base.hydration.status} verification=${report.base.verification.outcome ?? "n/a"} ledger=${report.base.consistency.ledgerChain} projection=${report.base.consistency.projectionWorking} pendingTurnWal=${report.base.consistency.pendingTurnWal}`,
    "",
    "Findings:",
  ];

  if (report.findings.length === 0) {
    lines.push("- none");
  } else {
    for (const [index, finding] of report.findings.entries()) {
      lines.push(...renderFinding(finding, index));
    }
  }

  lines.push("", "Evidence gaps:");
  if (report.evidenceGaps.length === 0) {
    lines.push("- none");
  } else {
    for (const gap of report.evidenceGaps) {
      lines.push(`- ${gap}`);
    }
  }

  return lines.join("\n");
}

function printInsightText(report: SessionInsightReport): void {
  console.log(formatInsightText(report));
}

export async function runInsightCli(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: INSIGHT_PARSE_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (parsed.values.help === true) {
    printInsightHelp();
    return 0;
  }
  if (parsed.positionals.length > 1) {
    console.error(
      `Error: unexpected positional args for insight: ${parsed.positionals.slice(1).join(" ")}`,
    );
    return 1;
  }

  const runtime = new BrewvaRuntime({
    cwd: typeof parsed.values.cwd === "string" ? parsed.values.cwd : undefined,
    configPath: typeof parsed.values.config === "string" ? parsed.values.config : undefined,
    governancePort: createTrustedLocalGovernancePort({ profile: "personal" }),
  });
  const targetSessionId = resolveTargetSession(
    runtime,
    typeof parsed.values.session === "string" ? parsed.values.session : undefined,
  );
  if (!targetSessionId) {
    console.error("Error: no replayable session found.");
    return 1;
  }

  let directory: InsightDirectory;
  try {
    directory = resolveInsightDirectory(
      runtime,
      typeof parsed.positionals[0] === "string" ? parsed.positionals[0] : undefined,
      typeof parsed.values.dir === "string" ? parsed.values.dir : undefined,
    );
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const report = buildInsightReport({
    runtime,
    sessionId: targetSessionId,
    directory,
  });

  if (parsed.values.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printInsightText(report);
  }
  return 0;
}

export type { SessionInsightReport, InsightFinding };
