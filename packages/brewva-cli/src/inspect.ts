import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs as parseNodeArgs } from "node:util";
import {
  projectHostedTransitionSnapshot,
  type HostedTransitionSnapshot,
} from "@brewva/brewva-gateway";
import {
  BrewvaRuntime,
  createOperatorRuntimePort,
  loadBrewvaInspectConfigResolution,
  TASK_EVENT_TYPE,
  TAPE_ANCHOR_EVENT_TYPE,
  TAPE_CHECKPOINT_EVENT_TYPE,
  TRUTH_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  createTrustedLocalGovernancePort,
  foldTaskLedgerEvents,
  foldTruthLedgerEvents,
  type BrewvaForensicConfigWarning,
  type BrewvaEventRecord,
  type BrewvaOperatorRuntimePort,
} from "@brewva/brewva-runtime";
import { PATCH_HISTORY_FILE, RecoveryWalStore } from "@brewva/brewva-runtime/internal";
import { formatISO } from "date-fns";
import {
  buildInspectAnalysis,
  formatInspectAnalysisText,
  resolveInspectDirectory,
  type InspectAnalysisReport,
  type InspectDirectory,
} from "./inspect-analysis.js";

const INSPECT_PARSE_OPTIONS = {
  help: { type: "boolean", short: "h" },
  cwd: { type: "string" },
  config: { type: "string" },
  session: { type: "string" },
  dir: { type: "string" },
  json: { type: "boolean" },
} as const;

interface InspectBootstrapPayload {
  managedToolMode?: "runtime_plugin" | "direct";
  runtimeConfig?: {
    workspaceRoot?: string;
    configPath?: string | null;
    artifactRoots?: {
      eventsDir?: string;
      recoveryWalDir?: string;
      projectionDir?: string;
      ledgerPath?: string;
    };
  };
  skillLoad?: {
    routingEnabled?: boolean;
    routingScopes?: string[];
    routableSkills?: string[];
    hiddenSkills?: string[];
  };
}

interface InspectVerification {
  timestamp: string | null;
  outcome: string | null;
  level: string | null;
  failedChecks: string[];
  missingChecks: string[];
  missingEvidence: string[];
  reason: string | null;
}

interface InspectConfigLoadReport {
  mode: "forensic_default" | "explicit";
  paths: string[];
  warningCount: number;
  warnings: Array<{
    code: BrewvaForensicConfigWarning["code"];
    configPath: string;
    message: string;
    fields: string[];
  }>;
}

interface InspectReport {
  sessionId: string;
  workspaceRoot: string;
  configLoad: InspectConfigLoadReport;
  analysis?: InspectAnalysisReport;
  hydration: {
    status: "cold" | "ready" | "degraded";
    hydratedAt: string | null;
    latestEventId: string | null;
    issueCount: number;
    issues: Array<{
      eventId: string;
      eventType: string;
      index: number;
      reason: string;
    }>;
  };
  integrity: {
    status: "healthy" | "degraded" | "unavailable";
    issueCount: number;
    issues: Array<{
      domain: string;
      severity: string;
      sessionId: string | null;
      eventId: string | null;
      eventType: string | null;
      index: number | null;
      reason: string;
    }>;
  };
  replay: {
    eventCount: number;
    firstEventAt: string | null;
    lastEventAt: string | null;
    anchorCount: number;
    checkpointCount: number;
    tapePressure: string;
    entriesSinceAnchor: number;
  };
  bootstrap: {
    managedToolMode: "runtime_plugin" | "direct" | null;
    workspaceRoot: string | null;
    configPath: string | null;
    eventsDir: string | null;
    recoveryWalDir: string | null;
    projectionDir: string | null;
    ledgerPath: string | null;
    routingEnabled: boolean | null;
    routingScopes: string[];
    routableSkills: string[];
    hiddenSkills: string[];
  };
  task: {
    goal: string | null;
    phase: string | null;
    health: string | null;
    items: number;
    blockers: number;
    updatedAt: string | null;
  };
  truth: {
    totalFacts: number;
    activeFacts: number;
    updatedAt: string | null;
  };
  skills: {
    activeSkill: string | null;
    completedSkills: string[];
  };
  verification: InspectVerification;
  hostedTransitions: HostedTransitionSnapshot;
  ledger: {
    path: string;
    rows: number;
    integrityValid: boolean;
    integrityReason: string | null;
  };
  projection: {
    enabled: boolean;
    rootDir: string;
    workingPath: string;
    workingExists: boolean;
  };
  recoveryWal: {
    enabled: boolean;
    filePath: string;
    pendingCount: number;
    pendingSessionCount: number;
    pendingRows: Array<{
      walId: string;
      source: string;
      status: string;
      turnId: string;
      channel: string;
      updatedAt: string | null;
      toolCallId: string | null;
      toolName: string | null;
    }>;
  };
  snapshots: {
    sessionDir: string;
    sessionDirExists: boolean;
    patchHistoryPath: string;
    patchHistoryExists: boolean;
  };
  consistency: {
    ledgerIntegrity: "ok" | "invalid";
    pendingRecoveryWal: number;
  };
}

interface SessionInspectReport extends InspectAnalysisReport {
  sessionId: string;
  base: InspectReport;
}

function printInspectHelp(): void {
  console.log(`Brewva Inspect - replay-first session inspection with deterministic analysis

Usage:
  brewva inspect [directory] [options]

Options:
  --cwd <path>       Working directory
  --config <path>    Brewva config path (default: forensic merge of global + workspace config)
  --session <id>     Inspect a specific replay session
  --dir <path>       Target directory for deterministic analysis (alternative to positional argument)
  --json             Emit JSON output
  -h, --help         Show help

Examples:
  brewva inspect
  brewva inspect packages/brewva-runtime/src
  brewva inspect --dir packages/brewva-cli/src
  brewva inspect --session <session-id>
  brewva inspect --json --session <session-id>`);
}

function encodeSessionIdForPath(sessionId: string): string {
  return Buffer.from(sessionId, "utf8").toString("base64url");
}

function sanitizeSessionIdForPath(sessionId: string): string {
  return sessionId.replaceAll(/[^\w.-]+/g, "_");
}

function toIso(timestamp: number | null | undefined): string | null {
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? formatISO(timestamp) : null;
}

function readLatestEventPayload<T extends object>(
  runtime: BrewvaOperatorRuntimePort,
  sessionId: string,
  type: string,
  coerce: (payload: Record<string, unknown>) => T = (payload) => payload as T,
): { payload: T; timestamp: number } | null {
  const event = runtime.inspect.events.query(sessionId, { type, last: 1 })[0];
  if (!event?.payload) return null;
  return {
    payload: coerce(event.payload as Record<string, unknown>),
    timestamp: event.timestamp,
  };
}

function buildSkillInspection(events: BrewvaEventRecord[]): InspectReport["skills"] {
  let activeSkill: string | null = null;
  const completedSkills = new Set<string>();

  for (const event of events) {
    const payload = event.payload;
    if (event.type === "skill_activated" && typeof payload?.skillName === "string") {
      activeSkill = payload.skillName;
      continue;
    }
    if (event.type === "skill_completed" && typeof payload?.skillName === "string") {
      completedSkills.add(payload.skillName);
      if (activeSkill === payload.skillName) {
        activeSkill = null;
      }
    }
  }

  return {
    activeSkill,
    completedSkills: [...completedSkills].toSorted((left, right) => left.localeCompare(right)),
  };
}

function buildVerificationInspection(
  runtime: BrewvaOperatorRuntimePort,
  sessionId: string,
): InspectVerification {
  const latest = readLatestEventPayload<Record<string, unknown>>(
    runtime,
    sessionId,
    VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
  );
  if (!latest) {
    return {
      timestamp: null,
      outcome: null,
      level: null,
      failedChecks: [],
      missingChecks: [],
      missingEvidence: [],
      reason: null,
    };
  }

  const failedChecks = Array.isArray(latest.payload.failedChecks)
    ? latest.payload.failedChecks.filter((value): value is string => typeof value === "string")
    : [];
  const missingChecks = Array.isArray(latest.payload.missingChecks)
    ? latest.payload.missingChecks.filter((value): value is string => typeof value === "string")
    : [];
  const missingEvidence = Array.isArray(latest.payload.missingEvidence)
    ? latest.payload.missingEvidence.filter((value): value is string => typeof value === "string")
    : [];

  return {
    timestamp: toIso(latest.timestamp),
    outcome: typeof latest.payload.outcome === "string" ? latest.payload.outcome : null,
    level: typeof latest.payload.level === "string" ? latest.payload.level : null,
    failedChecks,
    missingChecks,
    missingEvidence,
    reason:
      typeof latest.payload.reason === "string" && latest.payload.reason.trim().length > 0
        ? latest.payload.reason
        : null,
  };
}

function pathExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function listSessionPendingRecoveryWal(
  runtime: BrewvaOperatorRuntimePort,
  sessionId: string,
  recoveryWalDir?: string | null,
): InspectReport["recoveryWal"]["pendingRows"] {
  const pendingRows =
    typeof recoveryWalDir === "string" &&
    recoveryWalDir.trim().length > 0 &&
    recoveryWalDir !== runtime.config.infrastructure.recoveryWal.dir
      ? new RecoveryWalStore({
          workspaceRoot: runtime.workspaceRoot,
          config: {
            ...runtime.config.infrastructure.recoveryWal,
            dir: recoveryWalDir,
          },
          scope: "runtime",
        }).listPending()
      : runtime.inspect.recovery.listPending();
  return pendingRows
    .filter((row) => row.sessionId === sessionId)
    .map((row) => {
      const meta =
        row.envelope.meta &&
        typeof row.envelope.meta === "object" &&
        !Array.isArray(row.envelope.meta)
          ? row.envelope.meta
          : null;
      const toolCallId =
        typeof meta?.toolCallId === "string" && meta.toolCallId.trim().length > 0
          ? meta.toolCallId
          : null;
      const toolName =
        typeof meta?.toolName === "string" && meta.toolName.trim().length > 0
          ? meta.toolName
          : null;
      return {
        walId: row.walId,
        source: row.source,
        status: row.status,
        turnId: row.turnId,
        channel: row.channel,
        updatedAt: toIso(row.updatedAt),
        toolCallId,
        toolName,
      };
    })
    .toSorted(
      (left, right) =>
        (right.updatedAt ? Date.parse(right.updatedAt) : 0) -
          (left.updatedAt ? Date.parse(left.updatedAt) : 0) ||
        left.walId.localeCompare(right.walId),
    );
}

function hasReplayEvent(
  runtime: BrewvaOperatorRuntimePort,
  sessionId: string,
  type: string,
): boolean {
  return runtime.inspect.events.query(sessionId, { type, last: 1 }).length > 0;
}

function scoreDefaultReplaySession(runtime: BrewvaOperatorRuntimePort, sessionId: string): number {
  if (hasReplayEvent(runtime, sessionId, "session_bootstrap")) {
    return 3;
  }
  if (
    hasReplayEvent(runtime, sessionId, "message_end") ||
    hasReplayEvent(runtime, sessionId, "turn_start") ||
    hasReplayEvent(runtime, sessionId, "agent_end") ||
    hasReplayEvent(runtime, sessionId, "session_start")
  ) {
    return 2;
  }
  return 1;
}

function listAllReplaySessions(runtime: BrewvaOperatorRuntimePort) {
  return runtime.inspect.events.listReplaySessions();
}

function resolveTargetSession(
  runtime: BrewvaOperatorRuntimePort,
  requestedSessionId?: string,
): string | null {
  if (requestedSessionId && requestedSessionId.trim().length > 0) {
    return requestedSessionId.trim();
  }

  return (
    listAllReplaySessions(runtime)
      .map((session) => ({
        sessionId: session.sessionId,
        eventCount: session.eventCount,
        lastEventAt: session.lastEventAt,
        defaultScore: scoreDefaultReplaySession(runtime, session.sessionId),
      }))
      .toSorted(
        (left, right) =>
          right.defaultScore - left.defaultScore ||
          right.lastEventAt - left.lastEventAt ||
          left.sessionId.localeCompare(right.sessionId),
      )[0]?.sessionId ?? null
  );
}

function buildInspectReport(
  runtime: BrewvaOperatorRuntimePort,
  sessionId: string,
  options: {
    directory?: InspectDirectory;
    configLoad?: InspectConfigLoadReport;
  } = {},
): InspectReport {
  const replaySession =
    listAllReplaySessions(runtime).find((entry) => entry.sessionId === sessionId) ?? null;
  const events = runtime.inspect.events.query(sessionId);
  const structuredEvents = runtime.inspect.events.queryStructured(sessionId);
  const taskEvents = runtime.inspect.events.query(sessionId, { type: TASK_EVENT_TYPE });
  const truthEvents = runtime.inspect.events.query(sessionId, { type: TRUTH_EVENT_TYPE });
  const taskState = foldTaskLedgerEvents(taskEvents);
  const truthState = foldTruthLedgerEvents(truthEvents);
  const tapeStatus = runtime.inspect.events.getTapeStatus(sessionId);
  const hydration = runtime.inspect.session.getHydration(sessionId);
  const integrity = runtime.inspect.session.getIntegrity(sessionId);
  const bootstrap = readLatestEventPayload<InspectBootstrapPayload>(
    runtime,
    sessionId,
    "session_bootstrap",
  )?.payload;
  const bootstrapArtifactRoots =
    bootstrap?.runtimeConfig?.artifactRoots &&
    typeof bootstrap.runtimeConfig.artifactRoots === "object" &&
    !Array.isArray(bootstrap.runtimeConfig.artifactRoots)
      ? bootstrap.runtimeConfig.artifactRoots
      : null;
  const effectiveProjectionDir =
    typeof bootstrapArtifactRoots?.projectionDir === "string" &&
    bootstrapArtifactRoots.projectionDir.trim().length > 0
      ? bootstrapArtifactRoots.projectionDir
      : runtime.config.projection.dir;
  const effectiveRecoveryWalDir =
    typeof bootstrapArtifactRoots?.recoveryWalDir === "string" &&
    bootstrapArtifactRoots.recoveryWalDir.trim().length > 0
      ? bootstrapArtifactRoots.recoveryWalDir
      : runtime.config.infrastructure.recoveryWal.dir;
  const skillState = buildSkillInspection(events);
  const verification = buildVerificationInspection(runtime, sessionId);
  const ledgerIntegrity = runtime.inspect.ledger.verifyIntegrity(sessionId);
  const ledgerRows = runtime.inspect.ledger.listRows(sessionId);

  const projectionRoot = resolve(runtime.workspaceRoot, effectiveProjectionDir);
  const projectionWorkingPath = join(
    projectionRoot,
    "sessions",
    `sess_${encodeSessionIdForPath(sessionId)}`,
    runtime.config.projection.workingFile,
  );
  const walFilePath = resolve(runtime.workspaceRoot, effectiveRecoveryWalDir, "runtime.jsonl");

  const snapshotSessionDir = resolve(
    runtime.workspaceRoot,
    ".orchestrator/snapshots",
    sanitizeSessionIdForPath(sessionId),
  );
  const patchHistoryPath = join(snapshotSessionDir, PATCH_HISTORY_FILE);
  const sessionPendingRecoveryWal = listSessionPendingRecoveryWal(
    runtime,
    sessionId,
    effectiveRecoveryWalDir,
  );
  const recoveryWalPendingRows =
    typeof effectiveRecoveryWalDir === "string" &&
    effectiveRecoveryWalDir !== runtime.config.infrastructure.recoveryWal.dir
      ? new RecoveryWalStore({
          workspaceRoot: runtime.workspaceRoot,
          config: {
            ...runtime.config.infrastructure.recoveryWal,
            dir: effectiveRecoveryWalDir,
          },
          scope: "runtime",
        }).listPending()
      : runtime.inspect.recovery.listPending();

  const report: InspectReport = {
    sessionId,
    workspaceRoot: runtime.workspaceRoot,
    configLoad: options.configLoad ?? {
      mode: "forensic_default",
      paths: [],
      warningCount: 0,
      warnings: [],
    },
    hydration: {
      status: hydration.status,
      hydratedAt: toIso(hydration.hydratedAt),
      latestEventId: hydration.latestEventId ?? null,
      issueCount: hydration.issues.length,
      issues: hydration.issues.map((issue) => ({
        eventId: issue.eventId ?? "n/a",
        eventType: issue.eventType ?? "n/a",
        index: issue.index ?? -1,
        reason: issue.reason,
      })),
    },
    integrity: {
      status: integrity.status,
      issueCount: integrity.issues.length,
      issues: integrity.issues.map((issue) => ({
        domain: issue.domain,
        severity: issue.severity,
        sessionId: issue.sessionId ?? null,
        eventId: issue.eventId ?? null,
        eventType: issue.eventType ?? null,
        index: typeof issue.index === "number" ? issue.index : null,
        reason: issue.reason,
      })),
    },
    replay: {
      eventCount: replaySession?.eventCount ?? events.length,
      firstEventAt: toIso(events[0]?.timestamp),
      lastEventAt: toIso(replaySession?.lastEventAt ?? events[events.length - 1]?.timestamp),
      anchorCount: runtime.inspect.events.query(sessionId, { type: TAPE_ANCHOR_EVENT_TYPE }).length,
      checkpointCount: runtime.inspect.events.query(sessionId, { type: TAPE_CHECKPOINT_EVENT_TYPE })
        .length,
      tapePressure: tapeStatus.tapePressure,
      entriesSinceAnchor: tapeStatus.entriesSinceAnchor,
    },
    bootstrap: {
      managedToolMode:
        bootstrap?.managedToolMode === "runtime_plugin" || bootstrap?.managedToolMode === "direct"
          ? bootstrap.managedToolMode
          : null,
      workspaceRoot:
        typeof bootstrap?.runtimeConfig?.workspaceRoot === "string" &&
        bootstrap.runtimeConfig.workspaceRoot.trim().length > 0
          ? bootstrap.runtimeConfig.workspaceRoot
          : null,
      configPath:
        typeof bootstrap?.runtimeConfig?.configPath === "string" &&
        bootstrap.runtimeConfig.configPath.trim().length > 0
          ? bootstrap.runtimeConfig.configPath
          : null,
      eventsDir:
        typeof bootstrapArtifactRoots?.eventsDir === "string" &&
        bootstrapArtifactRoots.eventsDir.trim().length > 0
          ? bootstrapArtifactRoots.eventsDir
          : null,
      recoveryWalDir:
        typeof bootstrapArtifactRoots?.recoveryWalDir === "string" &&
        bootstrapArtifactRoots.recoveryWalDir.trim().length > 0
          ? bootstrapArtifactRoots.recoveryWalDir
          : null,
      projectionDir:
        typeof bootstrapArtifactRoots?.projectionDir === "string" &&
        bootstrapArtifactRoots.projectionDir.trim().length > 0
          ? bootstrapArtifactRoots.projectionDir
          : null,
      ledgerPath:
        typeof bootstrapArtifactRoots?.ledgerPath === "string" &&
        bootstrapArtifactRoots.ledgerPath.trim().length > 0
          ? bootstrapArtifactRoots.ledgerPath
          : null,
      routingEnabled:
        typeof bootstrap?.skillLoad?.routingEnabled === "boolean"
          ? bootstrap.skillLoad.routingEnabled
          : null,
      routingScopes: Array.isArray(bootstrap?.skillLoad?.routingScopes)
        ? bootstrap.skillLoad.routingScopes.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      routableSkills: Array.isArray(bootstrap?.skillLoad?.routableSkills)
        ? bootstrap.skillLoad.routableSkills.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      hiddenSkills: Array.isArray(bootstrap?.skillLoad?.hiddenSkills)
        ? bootstrap.skillLoad.hiddenSkills.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
    },
    task: {
      goal: taskState.spec?.goal ?? null,
      phase: taskState.status?.phase ?? null,
      health: taskState.status?.health ?? null,
      items: taskState.items.length,
      blockers: taskState.blockers.length,
      updatedAt: toIso(taskState.updatedAt),
    },
    truth: {
      totalFacts: truthState.facts.length,
      activeFacts: truthState.facts.filter((fact) => fact.status === "active").length,
      updatedAt: toIso(truthState.updatedAt),
    },
    skills: skillState,
    verification,
    hostedTransitions: projectHostedTransitionSnapshot(structuredEvents),
    ledger: {
      path: runtime.inspect.ledger.getPath(),
      rows: ledgerRows.length,
      integrityValid: ledgerIntegrity.valid,
      integrityReason: ledgerIntegrity.reason ?? null,
    },
    projection: {
      enabled: runtime.config.projection.enabled,
      rootDir: projectionRoot,
      workingPath: projectionWorkingPath,
      workingExists: pathExists(projectionWorkingPath),
    },
    recoveryWal: {
      enabled: runtime.config.infrastructure.recoveryWal.enabled,
      filePath: walFilePath,
      pendingCount: recoveryWalPendingRows.length,
      pendingSessionCount: sessionPendingRecoveryWal.length,
      pendingRows: sessionPendingRecoveryWal,
    },
    snapshots: {
      sessionDir: snapshotSessionDir,
      sessionDirExists: pathExists(snapshotSessionDir),
      patchHistoryPath,
      patchHistoryExists: pathExists(patchHistoryPath),
    },
    consistency: {
      ledgerIntegrity: ledgerIntegrity.valid ? "ok" : "invalid",
      pendingRecoveryWal: sessionPendingRecoveryWal.length,
    },
  };

  if (options.directory) {
    report.analysis = buildInspectAnalysis({
      runtime,
      sessionId,
      directory: options.directory,
      base: report,
    });
  }

  return report;
}

function buildSessionInspectReport(input: {
  runtime: BrewvaOperatorRuntimePort;
  sessionId: string;
  directory: InspectDirectory;
}): SessionInspectReport {
  const base = buildInspectReport(input.runtime, input.sessionId, {
    directory: input.directory,
  });
  if (!base.analysis) {
    throw new Error("inspect analysis was not attached to the session report");
  }
  return {
    ...base.analysis,
    sessionId: input.sessionId,
    base,
  };
}

function formatInspectText(report: InspectReport): string {
  const lines = [
    `Session: ${report.sessionId}`,
    `Workspace: ${report.workspaceRoot}`,
    `Config: mode=${report.configLoad.mode} paths=${renderList(report.configLoad.paths)} warnings=${report.configLoad.warningCount}`,
    "",
    `Hydration: status=${report.hydration.status} issues=${report.hydration.issueCount} hydratedAt=${report.hydration.hydratedAt ?? "n/a"}`,
    `Integrity: status=${report.integrity.status} issues=${report.integrity.issueCount}`,
    `Replay: events=${report.replay.eventCount} first=${report.replay.firstEventAt ?? "n/a"} last=${report.replay.lastEventAt ?? "n/a"}`,
    `Replay: anchors=${report.replay.anchorCount} checkpoints=${report.replay.checkpointCount} tapePressure=${report.replay.tapePressure} entriesSinceAnchor=${report.replay.entriesSinceAnchor}`,
    `Bootstrap: routingEnabled=${renderNullableBoolean(report.bootstrap.routingEnabled)} scopes=${renderList(report.bootstrap.routingScopes)}`,
    `Task: phase=${report.task.phase ?? "n/a"} health=${report.task.health ?? "n/a"} items=${report.task.items} blockers=${report.task.blockers} updatedAt=${report.task.updatedAt ?? "n/a"}`,
    `Task: goal=${report.task.goal ?? "n/a"}`,
    `Truth: active=${report.truth.activeFacts}/${report.truth.totalFacts} updatedAt=${report.truth.updatedAt ?? "n/a"}`,
    `Skills: active=${report.skills.activeSkill ?? "none"} completed=${renderList(report.skills.completedSkills)}`,
    `Verification: outcome=${report.verification.outcome ?? "n/a"} level=${report.verification.level ?? "n/a"} failed=${renderList(report.verification.failedChecks)} missing_checks=${renderList(report.verification.missingChecks)} missing_evidence=${renderList(report.verification.missingEvidence)}`,
    `Hosted transitions: sequence=${report.hostedTransitions.sequence} latest=${renderHostedLatest(report.hostedTransitions.latest)} pending=${report.hostedTransitions.pendingFamily ?? "none"} operatorVisible=${report.hostedTransitions.operatorVisibleFactGeneration}`,
    `Hosted breakers: compaction_retry=${renderHostedBreaker(report.hostedTransitions, "compaction_retry")} provider_fallback_retry=${renderHostedBreaker(report.hostedTransitions, "provider_fallback_retry")} max_output_recovery=${renderHostedBreaker(report.hostedTransitions, "max_output_recovery")}`,
    `Ledger: rows=${report.ledger.rows} integrity=${report.ledger.integrityValid ? "valid" : "invalid"} path=${report.ledger.path}`,
    `Projection: enabled=${report.projection.enabled ? "yes" : "no"} working=${report.projection.workingExists ? "present" : "missing"} path=${report.projection.workingPath}`,
    `Recovery WAL: enabled=${report.recoveryWal.enabled ? "yes" : "no"} pending=${report.recoveryWal.pendingCount} sessionPending=${report.recoveryWal.pendingSessionCount} file=${report.recoveryWal.filePath}`,
    `Snapshots: sessionDir=${report.snapshots.sessionDirExists ? "present" : "missing"} patchHistory=${report.snapshots.patchHistoryExists ? "present" : "missing"} path=${report.snapshots.patchHistoryPath}`,
    `Consistency: ledger=${report.consistency.ledgerIntegrity} pendingRecoveryWal=${report.consistency.pendingRecoveryWal}`,
  ];

  if (report.ledger.integrityReason) {
    lines.push(`Ledger reason: ${report.ledger.integrityReason}`);
  }
  if (report.hydration.latestEventId) {
    lines.push(`Hydration latestEventId: ${report.hydration.latestEventId}`);
  }
  if (report.hydration.issues.length > 0) {
    for (const issue of report.hydration.issues.slice(0, 5)) {
      lines.push(
        `Hydration issue: index=${issue.index} type=${issue.eventType} event=${issue.eventId} reason=${issue.reason}`,
      );
    }
  }
  if (report.integrity.issues.length > 0) {
    for (const issue of report.integrity.issues.slice(0, 5)) {
      lines.push(
        `Integrity issue: domain=${issue.domain} severity=${issue.severity} event=${issue.eventId ?? "n/a"} reason=${issue.reason}`,
      );
    }
  }
  if (report.bootstrap.routableSkills.length > 0) {
    lines.push(`Routable skills: ${report.bootstrap.routableSkills.join(", ")}`);
  }
  if (report.bootstrap.hiddenSkills.length > 0) {
    lines.push(`Hidden skills: ${report.bootstrap.hiddenSkills.join(", ")}`);
  }
  if (
    report.bootstrap.configPath ||
    report.bootstrap.eventsDir ||
    report.bootstrap.recoveryWalDir ||
    report.bootstrap.projectionDir ||
    report.bootstrap.ledgerPath
  ) {
    lines.push(
      `Bootstrap config: path=${report.bootstrap.configPath ?? "n/a"} events=${report.bootstrap.eventsDir ?? "n/a"} recoveryWal=${report.bootstrap.recoveryWalDir ?? "n/a"} projection=${report.bootstrap.projectionDir ?? "n/a"} ledger=${report.bootstrap.ledgerPath ?? "n/a"}`,
    );
  }
  if (report.verification.reason) {
    lines.push(`Verification reason: ${report.verification.reason}`);
  }
  if (report.recoveryWal.pendingRows.length > 0) {
    for (const row of report.recoveryWal.pendingRows.slice(0, 5)) {
      lines.push(
        `Recovery WAL row: source=${row.source} status=${row.status} turnId=${row.turnId} channel=${row.channel} tool=${row.toolName ?? "n/a"} toolCallId=${row.toolCallId ?? "n/a"} updatedAt=${row.updatedAt ?? "n/a"}`,
      );
    }
  }
  if (report.configLoad.warnings.length > 0) {
    for (const warning of report.configLoad.warnings.slice(0, 5)) {
      lines.push(
        `Config warning: code=${warning.code} path=${warning.configPath} fields=${renderList(warning.fields)} message=${warning.message}`,
      );
    }
  }
  if (report.analysis) {
    lines.push("", formatInspectAnalysisText(report.analysis));
  }

  return lines.join("\n");
}

function printInspectText(report: InspectReport): void {
  console.log(formatInspectText(report));
}

function renderNullableBoolean(value: boolean | null): string {
  if (value === null) return "n/a";
  return value ? "yes" : "no";
}

function renderList(values: string[]): string {
  return values.length > 0 ? values.join(",") : "none";
}

function renderHostedLatest(latest: HostedTransitionSnapshot["latest"]): string {
  if (!latest) {
    return "none";
  }
  const parts = [`${latest.reason}:${latest.status}`];
  if (typeof latest.attempt === "number") {
    parts.push(`attempt=${latest.attempt}`);
  }
  if (latest.breakerOpen) {
    parts.push("breaker=open");
  }
  return parts.join(" ");
}

function renderHostedBreaker(
  snapshot: HostedTransitionSnapshot,
  reason: keyof HostedTransitionSnapshot["breakerOpenByReason"],
): string {
  const failures = snapshot.consecutiveFailuresByReason[reason] ?? 0;
  const breaker = snapshot.breakerOpenByReason[reason] === true ? "open" : "closed";
  return `${failures}/${breaker}`;
}

export async function runInspectCli(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseNodeArgs>;
  try {
    parsed = parseNodeArgs({
      args: argv,
      options: INSPECT_PARSE_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  if (parsed.values.help === true) {
    printInspectHelp();
    return 0;
  }
  if (parsed.positionals.length > 1) {
    console.error(
      `Error: unexpected positional args for inspect: ${parsed.positionals.slice(1).join(" ")}`,
    );
    return 1;
  }

  const configPath = typeof parsed.values.config === "string" ? parsed.values.config : undefined;
  const configLoad = loadBrewvaInspectConfigResolution({
    cwd: typeof parsed.values.cwd === "string" ? parsed.values.cwd : undefined,
    configPath,
  });
  const runtime = new BrewvaRuntime({
    cwd: typeof parsed.values.cwd === "string" ? parsed.values.cwd : undefined,
    config: configLoad.config,
    governancePort: createTrustedLocalGovernancePort({ profile: "personal" }),
  });
  const operatorRuntime = createOperatorRuntimePort(runtime);
  const targetSessionId = resolveTargetSession(
    operatorRuntime,
    typeof parsed.values.session === "string" ? parsed.values.session : undefined,
  );
  if (!targetSessionId) {
    console.error("Error: no replayable session found.");
    return 1;
  }

  let directory: InspectDirectory;
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

  const report = buildInspectReport(operatorRuntime, targetSessionId, {
    directory,
    configLoad: {
      mode: typeof parsed.values.config === "string" ? "explicit" : "forensic_default",
      paths: [...configLoad.consultedPaths],
      warningCount: configLoad.warnings.length,
      warnings: configLoad.warnings.map((warning) => ({
        code: warning.code,
        configPath: warning.configPath,
        message: warning.message,
        fields: [...(warning.fields ?? [])],
      })),
    },
  });
  if (parsed.values.json === true) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printInspectText(report);
  }
  return 0;
}

export {
  buildInspectReport,
  buildSessionInspectReport,
  formatInspectText,
  resolveInspectDirectory,
  resolveTargetSession,
};
export type { InspectReport, SessionInspectReport };
