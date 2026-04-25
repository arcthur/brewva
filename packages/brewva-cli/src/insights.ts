import { parseArgs as parseNodeArgs } from "node:util";
import {
  BrewvaRuntime,
  createOperatorRuntimePort,
  createTrustedLocalGovernancePort,
  type BrewvaOperatorRuntimePort,
} from "@brewva/brewva-runtime";
import {
  createSessionIndex,
  type SessionIndexRecentSession,
  type SessionIndexStatus,
} from "@brewva/brewva-session-index";
import { formatISO } from "date-fns";
import { clampText, resolveInspectDirectory, type InspectFinding } from "./inspect-analysis.js";
import { buildSessionInspectReport, type SessionInspectReport } from "./inspect.js";

const INSIGHTS_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  cwd: { type: "string" },
  config: { type: "string" },
  dir: { type: "string" },
  json: { type: "boolean" },
  limit: { type: "string" },
} as const;

const DEFAULT_SESSION_LIMIT = 20;

interface SessionInspectFacet {
  sessionId: string;
  directory: string;
  verdict: SessionInspectReport["verdict"];
  outcome: "verified_success" | "partial" | "blocked" | "analysis_only" | "insufficient_evidence";
  smoothness: "smooth" | "mixed" | "rough";
  workType: "implementation" | "debugging" | "inspection" | "refactor" | "ops" | "mixed";
  verificationState: "passed" | "failed" | "missing";
  scopeDiscipline: "tight" | "mixed" | "drifted";
  findingCodes: string[];
  findingCounts: Record<string, number>;
  topDirs: Array<{ path: string; touched: number; writes: number; reads: number }>;
  taskGoal: string | null;
  notableFiles: string[];
}

interface ProjectInsightsReport {
  workspaceRoot: string;
  directory: string;
  generatedAt: string;
  window: {
    analyzedSessions: number;
    excludedSessions: number;
    failedSessions: number;
  };
  analysisFailures: Array<{
    sessionId: string;
    error: string;
  }>;
  index: {
    status: "ok" | "unavailable";
    dbPath: string;
    writer?: boolean;
    indexedSessions?: number;
    indexedEvents?: number;
    error?: string;
  };
  overview: {
    verdictDistribution: Record<string, number>;
    smoothnessDistribution: Record<string, number>;
    outcomeDistribution: Record<string, number>;
    topFrictionCodes: Array<{ code: string; count: number }>;
    topDirectories: Array<{ path: string; sessionCount: number; writeCount: number }>;
  };
  frictionHotspots: Array<{
    code: string;
    sessionCount: number;
    severity: "info" | "warn" | "error";
    topDirectories: string[];
    summary: string;
  }>;
  verificationQuality: {
    passedCount: number;
    failedCount: number;
    missingCount: number;
    sessionsWithStaleVerification: number;
  };
  guidanceSuggestions: Array<{
    suggestion: string;
    reason: string;
    relatedFindingCode: string;
    frequency: number;
  }>;
  notableSessions: Array<{
    sessionId: string;
    label: string;
    verdict: string;
    summary: string;
  }>;
  sessions: SessionInspectFacet[];
}

function deriveOutcome(report: SessionInspectReport): SessionInspectFacet["outcome"] {
  if (report.verdict === "insufficient_evidence") return "insufficient_evidence";

  const hasWrites = report.scope.writesInDir > 0 || report.scope.writesOutOfDir > 0;
  const hasBlockingFindings = report.findings.some(
    (finding) => finding.severity === "error" && finding.code === "durability",
  );

  if (hasBlockingFindings) return "blocked";
  if (!hasWrites) return "analysis_only";

  const verificationOutcome = report.base.verification.outcome;
  if (verificationOutcome === "pass") return "verified_success";
  return "partial";
}

function deriveSmoothness(findings: InspectFinding[]): SessionInspectFacet["smoothness"] {
  if (findings.length === 0) return "smooth";
  if (findings.some((finding) => finding.severity === "error")) return "rough";
  return "mixed";
}

function deriveWorkType(report: SessionInspectReport): SessionInspectFacet["workType"] {
  const base = report.base;
  const hasWrites = report.scope.writesInDir > 0 || report.scope.writesOutOfDir > 0;
  const hasScopeActivity = report.scope.touchedInDir + report.scope.touchedOutOfDir > 0;
  const hasTaskGoal = base.task.goal !== null;
  const shellComposition = report.findings.some((finding) => finding.code === "shell_composition");
  const opsEnvironment = report.findings.some((finding) => finding.code === "ops_environment");
  const phase = base.task.phase;
  const goal = base.task.goal?.toLowerCase() ?? "";
  const goalLooksLikeRefactor =
    /\b(refactor|rename|restructure|cleanup|clean up|extract|simplify|reorganize|reorganise)\b/u.test(
      goal,
    );

  if (opsEnvironment && !hasWrites) return "ops";
  if (
    !hasWrites &&
    (!hasTaskGoal || phase === "investigate" || phase === "align") &&
    hasScopeActivity
  ) {
    return "inspection";
  }

  const categories: string[] = [];
  if (hasWrites) {
    categories.push(goalLooksLikeRefactor ? "refactor" : "implementation");
  }
  if (shellComposition || phase === "blocked" || base.verification.outcome === "fail") {
    categories.push("debugging");
  }

  const unique = [...new Set(categories)];
  if (unique.length === 0) return "mixed";
  if (unique.length === 1) return unique[0] as SessionInspectFacet["workType"];
  return "mixed";
}

function deriveVerificationState(
  report: SessionInspectReport,
): SessionInspectFacet["verificationState"] {
  const outcome = report.base.verification.outcome;
  if (outcome === "pass") return "passed";
  if (outcome === "fail") return "failed";
  return "missing";
}

function deriveScopeDiscipline(
  report: SessionInspectReport,
): SessionInspectFacet["scopeDiscipline"] {
  const scopeDrift = report.findings.find((finding) => finding.code === "scope_drift");
  if (!scopeDrift) return "tight";
  if (scopeDrift.severity === "warn" && scopeDrift.confidence === "high") return "drifted";
  return "mixed";
}

function deriveFindingCounts(findings: InspectFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of findings) {
    counts[finding.code] = (counts[finding.code] ?? 0) + 1;
  }
  return counts;
}

function deriveTopDirs(report: SessionInspectReport): SessionInspectFacet["topDirs"] {
  return report.activity.directories.slice(0, 10).map((directory) => ({
    path: directory.path,
    touched: directory.touched,
    writes: directory.writes,
    reads: directory.reads,
  }));
}

function deriveNotableFiles(report: SessionInspectReport): string[] {
  const refs: string[] = [];
  for (const finding of report.findings) {
    for (const ref of finding.evidenceRefs) {
      if (ref.startsWith("path:")) {
        refs.push(ref.slice(5));
      }
    }
  }
  return [...new Set(refs)].slice(0, 10);
}

function extractSessionFacet(report: SessionInspectReport): SessionInspectFacet {
  return {
    sessionId: report.sessionId,
    directory: report.directory,
    verdict: report.verdict,
    outcome: deriveOutcome(report),
    smoothness: deriveSmoothness(report.findings),
    workType: deriveWorkType(report),
    verificationState: deriveVerificationState(report),
    scopeDiscipline: deriveScopeDiscipline(report),
    findingCodes: report.findings.map((finding) => finding.code),
    findingCounts: deriveFindingCounts(report.findings),
    topDirs: deriveTopDirs(report),
    taskGoal: report.base.task.goal ?? null,
    notableFiles: deriveNotableFiles(report),
  };
}

async function listAvailableSessions(
  runtime: BrewvaOperatorRuntimePort,
  limit: number,
): Promise<{ sessions: SessionIndexRecentSession[]; status: SessionIndexStatus }> {
  const index = await createSessionIndex({
    workspaceRoot: runtime.workspaceRoot,
    events: runtime.inspect.events,
    task: runtime.inspect.task,
  });
  try {
    const status = await index.catchUp();
    if (!status.ok) {
      return { sessions: [], status };
    }
    const sessions = await index.listRecentSessions({ limit });
    return { sessions, status };
  } finally {
    await index.close();
  }
}

function countDistribution(
  facets: SessionInspectFacet[],
  key: "verdict" | "smoothness" | "outcome",
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const facet of facets) {
    const value = facet[key];
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}

function aggregateTopFrictionCodes(
  facets: SessionInspectFacet[],
): Array<{ code: string; count: number }> {
  const counts = new Map<string, number>();
  for (const facet of facets) {
    for (const code of facet.findingCodes) {
      counts.set(code, (counts.get(code) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([code, count]) => ({ code, count }))
    .toSorted((left, right) => right.count - left.count || left.code.localeCompare(right.code));
}

function aggregateTopDirectories(
  facets: SessionInspectFacet[],
): Array<{ path: string; sessionCount: number; writeCount: number }> {
  const dirMap = new Map<string, { sessionCount: number; writeCount: number }>();
  for (const facet of facets) {
    for (const dir of facet.topDirs) {
      const existing = dirMap.get(dir.path);
      if (existing) {
        existing.sessionCount += 1;
        existing.writeCount += dir.writes;
      } else {
        dirMap.set(dir.path, { sessionCount: 1, writeCount: dir.writes });
      }
    }
  }
  return [...dirMap.entries()]
    .map(([path, data]) => ({ path, sessionCount: data.sessionCount, writeCount: data.writeCount }))
    .toSorted(
      (left, right) =>
        right.writeCount - left.writeCount ||
        right.sessionCount - left.sessionCount ||
        left.path.localeCompare(right.path),
    )
    .slice(0, 10);
}

function buildFrictionHotspots(
  reports: SessionInspectReport[],
): ProjectInsightsReport["frictionHotspots"] {
  const codeMap = new Map<
    string,
    {
      sessionIds: Set<string>;
      severity: "info" | "warn" | "error";
      directoryCounts: Map<string, number>;
    }
  >();

  for (const report of reports) {
    const sessionDirectories = report.activity.directories.map((directory) => directory.path);
    for (const finding of report.findings) {
      const existing = codeMap.get(finding.code);
      if (existing) {
        existing.sessionIds.add(report.sessionId);
        if (severityRank(finding.severity) > severityRank(existing.severity)) {
          existing.severity = finding.severity;
        }
        for (const directory of sessionDirectories) {
          existing.directoryCounts.set(
            directory,
            (existing.directoryCounts.get(directory) ?? 0) + 1,
          );
        }
      } else {
        const directoryCounts = new Map<string, number>();
        for (const directory of sessionDirectories) {
          directoryCounts.set(directory, 1);
        }
        codeMap.set(finding.code, {
          sessionIds: new Set([report.sessionId]),
          severity: finding.severity,
          directoryCounts,
        });
      }
    }
  }

  return [...codeMap.entries()]
    .map(([code, data]) => ({
      code,
      sessionCount: data.sessionIds.size,
      severity: data.severity,
      topDirectories: [...data.directoryCounts.entries()]
        .toSorted((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 5)
        .map(([path]) => path),
      summary: frictionCodeSummary(code, data.sessionIds.size),
    }))
    .toSorted(
      (left, right) =>
        right.sessionCount - left.sessionCount || left.code.localeCompare(right.code),
    );
}

function severityRank(severity: "info" | "warn" | "error"): number {
  switch (severity) {
    case "info":
      return 0;
    case "warn":
      return 1;
    case "error":
      return 2;
  }

  const exhaustive: never = severity;
  return exhaustive;
}

function frictionCodeSummary(code: string, sessionCount: number): string {
  const sessionLabel = sessionCount === 1 ? "1 session" : `${sessionCount} sessions`;
  switch (code) {
    case "durability":
      return `Durability or replay integrity issues appeared in ${sessionLabel}.`;
    case "tool_contract":
      return `Tool contract warnings or blocked calls appeared in ${sessionLabel}.`;
    case "shell_composition":
      return `Shell or script composition errors appeared in ${sessionLabel}.`;
    case "scope_drift":
      return `Scope drift from target directory detected in ${sessionLabel}.`;
    case "verification_hygiene":
      return `Verification was stale, missing, or failed in ${sessionLabel}.`;
    case "ops_environment":
      return `Operational environment friction appeared in ${sessionLabel}.`;
    case "runtime_pressure":
      return `Runtime pressure signals appeared in ${sessionLabel}.`;
    default:
      return `Finding code '${code}' appeared in ${sessionLabel}.`;
  }
}

function buildVerificationQuality(
  facets: SessionInspectFacet[],
  reports: SessionInspectReport[],
): ProjectInsightsReport["verificationQuality"] {
  let passedCount = 0;
  let failedCount = 0;
  let missingCount = 0;
  let sessionsWithStaleVerification = 0;

  for (const facet of facets) {
    switch (facet.verificationState) {
      case "passed":
        passedCount += 1;
        break;
      case "failed":
        failedCount += 1;
        break;
      case "missing":
        missingCount += 1;
        break;
    }
  }

  for (const report of reports) {
    const stale = report.findings.some(
      (finding) => finding.code === "verification_hygiene" && finding.summary.includes("stale"),
    );
    if (stale) {
      sessionsWithStaleVerification += 1;
    }
  }

  return { passedCount, failedCount, missingCount, sessionsWithStaleVerification };
}

const GUIDANCE_RULES: Array<{
  findingCode: string;
  threshold: number;
  suggestion: string;
  reason: string;
}> = [
  {
    findingCode: "verification_hygiene",
    threshold: 3,
    suggestion: "Add a canonical verification command to your project configuration or AGENTS.md.",
    reason:
      "Verification was stale or missing in multiple sessions, suggesting no consistent check step.",
  },
  {
    findingCode: "scope_drift",
    threshold: 3,
    suggestion:
      "Consider scoping tasks more tightly or adding directory-level guidance to reduce cross-directory mutation.",
    reason: "Scope drift from the target directory recurred across sessions.",
  },
  {
    findingCode: "shell_composition",
    threshold: 2,
    suggestion:
      "Provide shell snippets or Makefile targets for common operations to reduce shell composition errors.",
    reason:
      "Shell composition errors appeared repeatedly, indicating fragile command construction.",
  },
  {
    findingCode: "tool_contract",
    threshold: 3,
    suggestion:
      "Review tool contract definitions and ensure tool access policies match intended usage patterns.",
    reason: "Tool contract friction appeared in multiple sessions.",
  },
  {
    findingCode: "durability",
    threshold: 2,
    suggestion:
      "Investigate replay or ledger integrity issues; consider resetting corrupted session state.",
    reason: "Durability issues in multiple sessions may indicate systemic state corruption.",
  },
  {
    findingCode: "runtime_pressure",
    threshold: 3,
    suggestion: "Review context budget and parallel slot configuration to reduce runtime pressure.",
    reason:
      "Runtime pressure recurred across sessions, suggesting resource configuration may be too tight.",
  },
  {
    findingCode: "ops_environment",
    threshold: 2,
    suggestion:
      "Check execution environment setup (box, isolation) to reduce operational friction.",
    reason: "Operational environment friction appeared repeatedly.",
  },
];

function buildGuidanceSuggestions(
  frictionCodes: Array<{ code: string; count: number }>,
): ProjectInsightsReport["guidanceSuggestions"] {
  const suggestions: ProjectInsightsReport["guidanceSuggestions"] = [];
  for (const rule of GUIDANCE_RULES) {
    const match = frictionCodes.find((entry) => entry.code === rule.findingCode);
    if (match && match.count >= rule.threshold) {
      suggestions.push({
        suggestion: rule.suggestion,
        reason: rule.reason,
        relatedFindingCode: rule.findingCode,
        frequency: match.count,
      });
    }
  }
  return suggestions.toSorted((left, right) => right.frequency - left.frequency);
}

function buildNotableSessions(
  facets: SessionInspectFacet[],
): ProjectInsightsReport["notableSessions"] {
  const notable: ProjectInsightsReport["notableSessions"] = [];

  const cleanest = facets
    .filter((facet) => facet.verdict === "reasonable" && facet.smoothness === "smooth")
    .toSorted((left, right) => left.sessionId.localeCompare(right.sessionId))[0];
  if (cleanest) {
    notable.push({
      sessionId: cleanest.sessionId,
      label: "cleanest",
      verdict: cleanest.verdict,
      summary: cleanest.taskGoal
        ? `Clean session with goal: ${cleanest.taskGoal}`
        : "Clean session with no findings.",
    });
  }

  const roughest = facets
    .filter((facet) => facet.smoothness === "rough")
    .toSorted((left, right) => {
      const leftErrors = left.findingCodes.length;
      const rightErrors = right.findingCodes.length;
      return rightErrors - leftErrors || left.sessionId.localeCompare(right.sessionId);
    })[0];
  if (roughest && roughest.sessionId !== cleanest?.sessionId) {
    notable.push({
      sessionId: roughest.sessionId,
      label: "roughest",
      verdict: roughest.verdict,
      summary: `Rough session with ${roughest.findingCodes.length} finding(s): ${roughest.findingCodes.join(", ")}.`,
    });
  }

  const mostDrift = facets
    .filter((facet) => facet.scopeDiscipline === "drifted")
    .toSorted((left, right) => left.sessionId.localeCompare(right.sessionId))[0];
  if (
    mostDrift &&
    mostDrift.sessionId !== cleanest?.sessionId &&
    mostDrift.sessionId !== roughest?.sessionId
  ) {
    notable.push({
      sessionId: mostDrift.sessionId,
      label: "most scope drift",
      verdict: mostDrift.verdict,
      summary: `Session drifted from target directory.${mostDrift.taskGoal ? ` Goal: ${mostDrift.taskGoal}` : ""}`,
    });
  }

  return notable;
}

async function buildProjectInsightsReport(input: {
  runtime: BrewvaOperatorRuntimePort;
  directory: { absolutePath: string; workspaceRelativePath: string };
  sessionIds?: string[];
  limit?: number;
  analyzeSession?: (input: {
    runtime: BrewvaOperatorRuntimePort;
    sessionId: string;
    directory: { absolutePath: string; workspaceRelativePath: string };
  }) => SessionInspectReport;
}): Promise<ProjectInsightsReport> {
  const limit = input.limit ?? DEFAULT_SESSION_LIMIT;
  const indexed = await listAvailableSessions(input.runtime, 1_000_000);
  const indexDiagnostic = indexed.status.ok
    ? {
        status: "ok" as const,
        dbPath: indexed.status.dbPath,
        writer: indexed.status.writer,
        indexedSessions: indexed.status.indexedSessions,
        indexedEvents: indexed.status.indexedEvents,
      }
    : {
        status: "unavailable" as const,
        dbPath: indexed.status.dbPath,
        error: indexed.status.message,
      };
  const allSessions = indexed.sessions;
  const targetSessionIds = input.sessionIds ?? allSessions.map((session) => session.sessionId);
  const selectedIds = targetSessionIds.slice(0, limit);
  const excludedCount = targetSessionIds.length - selectedIds.length;
  const analyzeSession =
    input.analyzeSession ??
    ((analysisInput: {
      runtime: BrewvaOperatorRuntimePort;
      sessionId: string;
      directory: { absolutePath: string; workspaceRelativePath: string };
    }) => buildSessionInspectReport(analysisInput));

  const reports: SessionInspectReport[] = [];
  const facets: SessionInspectFacet[] = [];
  const analysisFailures: ProjectInsightsReport["analysisFailures"] = [];

  for (const sessionId of selectedIds) {
    try {
      const report = analyzeSession({
        runtime: input.runtime,
        sessionId,
        directory: input.directory,
      });
      reports.push(report);
      facets.push(extractSessionFacet(report));
    } catch (error) {
      analysisFailures.push({
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const topFrictionCodes = aggregateTopFrictionCodes(facets);

  return {
    workspaceRoot: input.runtime.workspaceRoot,
    directory: input.directory.workspaceRelativePath,
    generatedAt: formatISO(Date.now()),
    window: {
      analyzedSessions: facets.length,
      excludedSessions: excludedCount,
      failedSessions: analysisFailures.length,
    },
    analysisFailures,
    index: indexDiagnostic,
    overview: {
      verdictDistribution: countDistribution(facets, "verdict"),
      smoothnessDistribution: countDistribution(facets, "smoothness"),
      outcomeDistribution: countDistribution(facets, "outcome"),
      topFrictionCodes,
      topDirectories: aggregateTopDirectories(facets),
    },
    frictionHotspots: buildFrictionHotspots(reports),
    verificationQuality: buildVerificationQuality(facets, reports),
    guidanceSuggestions: buildGuidanceSuggestions(topFrictionCodes),
    notableSessions: buildNotableSessions(facets),
    sessions: facets,
  };
}

function renderDistribution(distribution: Record<string, number>): string {
  const entries = Object.entries(distribution).toSorted(([, left], [, right]) => right - left);
  if (entries.length === 0) {
    return "none";
  }
  return entries.map(([key, value]) => `${key}=${value}`).join(" ");
}

function formatProjectInsightsText(report: ProjectInsightsReport): string {
  const lines: string[] = [];

  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push("  Brewva Project Insights");
  lines.push("═══════════════════════════════════════════════════════════════");
  lines.push(`  Workspace: ${report.workspaceRoot}`);
  lines.push(`  Directory: ${report.directory || "."}`);
  lines.push(`  Generated: ${report.generatedAt}`);
  lines.push(
    `  Session index: ${report.index.status}${
      report.index.status === "ok"
        ? ` (${report.index.indexedSessions ?? 0} sessions, writer=${String(report.index.writer)})`
        : ` (${report.index.error ?? "unavailable"})`
    }`,
  );
  lines.push(
    `  Sessions analyzed: ${report.window.analyzedSessions} (${report.window.excludedSessions} excluded, ${report.window.failedSessions} failed)`,
  );
  lines.push("");

  lines.push("── Overview ─────────────────────────────────────────────────");
  lines.push(`  Verdicts:   ${renderDistribution(report.overview.verdictDistribution)}`);
  lines.push(`  Smoothness: ${renderDistribution(report.overview.smoothnessDistribution)}`);
  lines.push(`  Outcomes:   ${renderDistribution(report.overview.outcomeDistribution)}`);
  lines.push("");

  if (report.overview.topFrictionCodes.length > 0) {
    lines.push("  Top friction codes:");
    for (const entry of report.overview.topFrictionCodes.slice(0, 5)) {
      lines.push(`    ${entry.code}: ${entry.count} session(s)`);
    }
    lines.push("");
  }

  if (report.overview.topDirectories.length > 0) {
    lines.push("  Top directories:");
    for (const entry of report.overview.topDirectories.slice(0, 5)) {
      lines.push(
        `    ${entry.path}: ${entry.sessionCount} session(s), ${entry.writeCount} write(s)`,
      );
    }
    lines.push("");
  }

  if (report.frictionHotspots.length > 0) {
    lines.push("── Friction Hotspots ────────────────────────────────────────");
    for (const hotspot of report.frictionHotspots) {
      lines.push(`  [${hotspot.severity}] ${hotspot.code} (${hotspot.sessionCount} session(s))`);
      lines.push(`    ${hotspot.summary}`);
      if (hotspot.topDirectories.length > 0) {
        lines.push(`    dirs: ${hotspot.topDirectories.join(", ")}`);
      }
    }
    lines.push("");
  }

  lines.push("── Verification Quality ─────────────────────────────────────");
  lines.push(`  Passed: ${report.verificationQuality.passedCount}`);
  lines.push(`  Failed: ${report.verificationQuality.failedCount}`);
  lines.push(`  Missing: ${report.verificationQuality.missingCount}`);
  lines.push(`  Stale verification: ${report.verificationQuality.sessionsWithStaleVerification}`);
  lines.push("");

  if (report.analysisFailures.length > 0) {
    lines.push("── Analysis Failures ────────────────────────────────────────");
    for (const failure of report.analysisFailures.slice(0, 5)) {
      lines.push(`  ${failure.sessionId}: ${clampText(failure.error, 180)}`);
    }
    const hiddenFailures =
      report.analysisFailures.length - Math.min(report.analysisFailures.length, 5);
    if (hiddenFailures > 0) {
      lines.push(`  ... ${hiddenFailures} more failure(s)`);
    }
    lines.push("");
  }

  if (report.guidanceSuggestions.length > 0) {
    lines.push("── Guidance Suggestions ─────────────────────────────────────");
    for (const [index, suggestion] of report.guidanceSuggestions.entries()) {
      lines.push(`  ${index + 1}. ${suggestion.suggestion}`);
      lines.push(`     reason: ${suggestion.reason}`);
      lines.push(
        `     code: ${suggestion.relatedFindingCode} (${suggestion.frequency} session(s))`,
      );
    }
    lines.push("");
  }

  if (report.notableSessions.length > 0) {
    lines.push("── Notable Sessions ─────────────────────────────────────────");
    for (const entry of report.notableSessions) {
      lines.push(`  [${entry.label}] ${entry.sessionId} (${entry.verdict})`);
      lines.push(`    ${entry.summary}`);
    }
    lines.push("");
  }

  lines.push("═══════════════════════════════════════════════════════════════");
  return lines.join("\n");
}

function printInsightsHelp(): void {
  console.log(`Brewva Insights - multi-session aggregation engine

Usage:
  brewva insights [directory] [options]

Options:
  --cwd <path>       Working directory
  --config <path>    Brewva config path (default: .brewva/brewva.json)
  --dir <path>       Target directory (alternative to positional argument)
  --limit <n>        Max sessions to analyze (default: ${DEFAULT_SESSION_LIMIT})
  --json             Emit JSON output
  -h, --help         Show help

Examples:
  brewva insights
  brewva insights packages/brewva-runtime/src
  brewva insights --limit 50 --dir packages/brewva-cli/src
  brewva insights --json`);
}

async function runInsightsCli(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: INSIGHTS_PARSE_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (parsed.values.help === true) {
    printInsightsHelp();
    return 0;
  }
  if (parsed.positionals.length > 1) {
    console.error(
      `Error: unexpected positional args for insights: ${parsed.positionals.slice(1).join(" ")}`,
    );
    return 1;
  }

  const limitArg =
    typeof parsed.values.limit === "string" ? Number.parseInt(parsed.values.limit, 10) : undefined;
  if (limitArg !== undefined && (!Number.isFinite(limitArg) || limitArg < 1)) {
    console.error("Error: --limit must be a positive integer.");
    return 1;
  }

  const runtime = new BrewvaRuntime({
    cwd: typeof parsed.values.cwd === "string" ? parsed.values.cwd : undefined,
    configPath: typeof parsed.values.config === "string" ? parsed.values.config : undefined,
    governancePort: createTrustedLocalGovernancePort({ profile: "personal" }),
  });
  const operatorRuntime = createOperatorRuntimePort(runtime);

  let directory: ReturnType<typeof resolveInspectDirectory>;
  try {
    directory = resolveInspectDirectory(
      operatorRuntime,
      typeof parsed.positionals[0] === "string" ? parsed.positionals[0] : undefined,
      typeof parsed.values.dir === "string" ? parsed.values.dir : undefined,
    );
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const report = await buildProjectInsightsReport({
    runtime: operatorRuntime,
    directory,
    limit: limitArg ?? DEFAULT_SESSION_LIMIT,
  });

  if (parsed.values.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(formatProjectInsightsText(report));
  }
  return 0;
}

export {
  buildProjectInsightsReport,
  extractSessionFacet,
  formatProjectInsightsText,
  runInsightsCli,
};

export type { SessionInspectFacet, ProjectInsightsReport };
