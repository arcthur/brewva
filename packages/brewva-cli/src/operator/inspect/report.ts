import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BUILTIN_AGENT_SPECS,
  projectHostedTransitionSnapshot,
  type HostedTransitionSnapshot,
} from "@brewva/brewva-gateway";
import {
  buildContextEvidenceReport,
  type ContextEvidenceAggregateReport,
} from "@brewva/brewva-gateway/hosted";
import type { BrewvaOperatorRuntimePort } from "@brewva/brewva-runtime";
import { foldClaimLedgerEvents } from "@brewva/brewva-runtime/claim";
import type { BrewvaForensicConfigWarning } from "@brewva/brewva-runtime/config";
import { type BrewvaEventRecord } from "@brewva/brewva-runtime/events";
import {
  MODEL_PRESET_SELECT_EVENT_TYPE,
  readVerificationOutcomeRecordedEventPayload,
  TASK_EVENT_TYPE,
  SUBAGENT_RUNNING_EVENT_TYPE,
  SUBAGENT_SPAWNED_EVENT_TYPE,
  TAPE_ANCHOR_EVENT_TYPE,
  TAPE_CHECKPOINT_EVENT_TYPE,
  CLAIM_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-runtime/events";
import { PATCH_HISTORY_FILE } from "@brewva/brewva-runtime/patch-history";
import { createRecoveryWalStore } from "@brewva/brewva-runtime/recovery";
import { foldTaskLedgerEvents } from "@brewva/brewva-runtime/task";
import { formatISO } from "date-fns";
import {
  buildInspectAnalysis,
  resolveInspectDirectory,
  type InspectAnalysisReport,
  type InspectDirectory,
} from "../inspect-analysis.js";

interface InspectBootstrapPayload {
  managedToolMode?: "hosted" | "direct";
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
  modelPreset: {
    activeName: string;
    previousName: string | null;
    source: string | null;
    mainModel: string | null;
    subagentModels: Record<string, string>;
    unmatchedSubagentModelKeys: string[];
    eventId: string | null;
    selectedAt: string | null;
  };
  rewind: {
    checkpointCount: number;
    rewindAvailable: boolean;
    redoAvailable: boolean;
    redoDepth: number;
    latestCheckpointId: string | null;
    latestCheckpointTurn: number | null;
    latestCheckpointStatus: string | null;
    latestRewind: {
      checkpointId: string;
      trigger: string;
      mode: string;
      summary: string;
      timestamp: string | null;
    } | null;
    nextRedoCheckpointId: string | null;
    targetCount: number;
    activeTargetCount: number;
    abandonedTargetCount: number;
    activeTargets: Array<{
      checkpointId: string;
      turn: number;
      promptPreview: string;
      patchSetCountAfter: number;
    }>;
    abandonedTargets: Array<{
      checkpointId: string;
      turn: number;
      promptPreview: string;
      patchSetCountAfter: number;
      rewoundBy: string;
      rewoundAt: string | null;
    }>;
  };
  lineage: {
    supported: boolean;
    rootNodeId: string | null;
    currentNodeId: string | null;
    currentKind: string | null;
    nodeCount: number;
    edgeCount: number;
    summaryCount: number;
    outcomeCount: number;
    adoptedOutcomeCount: number;
    selectedByChannel: Record<string, string>;
    unsupportedReason: string | null;
  };
  bootstrap: {
    managedToolMode: "hosted" | "direct" | null;
    workspaceRoot: string | null;
    configPath: string | null;
    eventsDir: string | null;
    recoveryWalDir: string | null;
    projectionDir: string | null;
    ledgerPath: string | null;
  };
  task: {
    goal: string | null;
    phase: string | null;
    health: string | null;
    items: number;
    blockers: number;
    updatedAt: string | null;
  };
  claim: {
    totalClaims: number;
    activeClaims: number;
    updatedAt: string | null;
  };
  verification: InspectVerification;
  hostedTransitions: HostedTransitionSnapshot;
  contextEvidence: ContextEvidenceAggregateReport & {
    promotionReady: boolean;
    promotionGaps: string[];
  };
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

function encodeSessionIdForPath(sessionId: string): string {
  return Buffer.from(sessionId, "utf8").toString("base64url");
}

function sanitizeSessionIdForPath(sessionId: string): string {
  return sessionId.replaceAll(/[^\w.-]+/g, "_");
}

function toIso(timestamp: number | null | undefined): string | null {
  return typeof timestamp === "number" && Number.isFinite(timestamp) ? formatISO(timestamp) : null;
}

function readPayloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readPayloadStringRecord(payload: unknown, key: string): Record<string, string> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const value = (payload as Record<string, unknown>)[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue === "string" && entryValue.trim().length > 0) {
      record[entryKey] = entryValue;
    }
  }
  return record;
}

function readEventPayloadString(event: BrewvaEventRecord, key: string): string | null {
  if (!event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return null;
  }
  const value = (event.payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function resolveUnmatchedPresetSubagentModelKeys(input: {
  subagentModels: Record<string, string>;
  events: BrewvaEventRecord[];
}): string[] {
  const knownAgentSpecs = new Set(Object.keys(BUILTIN_AGENT_SPECS));
  for (const event of input.events) {
    if (event.type !== SUBAGENT_SPAWNED_EVENT_TYPE && event.type !== SUBAGENT_RUNNING_EVENT_TYPE) {
      continue;
    }
    const agentSpec = readEventPayloadString(event, "agentSpec");
    if (agentSpec) {
      knownAgentSpecs.add(agentSpec);
    }
  }
  return Object.keys(input.subagentModels)
    .filter((key) => !knownAgentSpecs.has(key))
    .toSorted((left, right) => left.localeCompare(right));
}

function readLatestEventPayload<T extends object>(
  runtime: BrewvaOperatorRuntimePort,
  sessionId: string,
  type: string,
  coerce: (payload: Record<string, unknown>) => T = (payload) => payload as T,
): { payload: T; timestamp: number } | null {
  const event = runtime.inspect.events.records.query(sessionId, { type, last: 1 })[0];
  if (!event?.payload) return null;
  return {
    payload: coerce(event.payload as Record<string, unknown>),
    timestamp: event.timestamp,
  };
}

function buildLineageInspection(
  runtime: BrewvaOperatorRuntimePort,
  sessionId: string,
): InspectReport["lineage"] {
  try {
    const tree = runtime.inspect.session.lineage.getTree(sessionId);
    const currentNodeId =
      tree.selectedByChannel["cli"] ?? tree.selectedByChannel["tui"] ?? tree.rootNodeId;
    const currentNode = tree.nodes.find((node) => node.lineageNodeId === currentNodeId) ?? null;
    return {
      supported: true,
      rootNodeId: tree.rootNodeId,
      currentNodeId,
      currentKind: currentNode?.kind ?? null,
      nodeCount: tree.nodes.length,
      edgeCount: tree.edges.length,
      summaryCount: tree.nodes.reduce((count, node) => count + node.summaries.length, 0),
      outcomeCount: tree.nodes.reduce((count, node) => count + node.outcomes.length, 0),
      adoptedOutcomeCount: tree.nodes.reduce(
        (count, node) => count + node.adoptedOutcomes.length,
        0,
      ),
      selectedByChannel: tree.selectedByChannel,
      unsupportedReason: null,
    };
  } catch (error) {
    return {
      supported: false,
      rootNodeId: null,
      currentNodeId: null,
      currentKind: null,
      nodeCount: 0,
      edgeCount: 0,
      summaryCount: 0,
      outcomeCount: 0,
      adoptedOutcomeCount: 0,
      selectedByChannel: {},
      unsupportedReason: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildVerificationInspection(
  runtime: BrewvaOperatorRuntimePort,
  sessionId: string,
): InspectVerification {
  const latestEvent = runtime.inspect.events.records
    .list(sessionId, {
      type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
      last: 1,
    })
    .at(-1);
  const latest = latestEvent ? readVerificationOutcomeRecordedEventPayload(latestEvent) : null;
  if (!latestEvent || !latest) {
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

  return {
    timestamp: toIso(latestEvent.timestamp),
    outcome: latest.outcome,
    level: latest.level,
    failedChecks: latest.failedChecks,
    missingChecks: latest.missingChecks,
    missingEvidence: latest.missingEvidence,
    reason: latest.reason,
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
      ? createRecoveryWalStore({
          workspaceRoot: runtime.identity.workspaceRoot,
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
  return runtime.inspect.events.records.query(sessionId, { type, last: 1 }).length > 0;
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
  return runtime.inspect.events.log.listReplaySessions();
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
  const events = runtime.inspect.events.records.query(sessionId);
  const structuredEvents = runtime.inspect.events.records.queryStructured(sessionId);
  const taskEvents = runtime.inspect.events.records.query(sessionId, { type: TASK_EVENT_TYPE });
  const claimEvents = runtime.inspect.events.records.query(sessionId, { type: CLAIM_EVENT_TYPE });
  const taskState = foldTaskLedgerEvents(taskEvents);
  const claimState = foldClaimLedgerEvents(claimEvents);
  const tapeStatus = runtime.inspect.tape.status.get(sessionId);
  const hydration = runtime.inspect.session.lifecycle.getHydration(sessionId);
  const integrity = runtime.inspect.session.lifecycle.getIntegrity(sessionId);
  const rewindState = runtime.inspect.session.rewind.getState(sessionId);
  const rewindTargets = runtime.inspect.session.rewind.listTargets(sessionId);
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
  const verification = buildVerificationInspection(runtime, sessionId);
  const contextEvidenceReport = buildContextEvidenceReport(runtime, {
    sessionIds: [sessionId],
  });
  const ledgerIntegrity = runtime.inspect.ledger.store.verifyIntegrity(sessionId);
  const ledgerRows = runtime.inspect.ledger.store.listRows(sessionId);
  const latestModelPresetEvent = events
    .toReversed()
    .find((event) => event.type === MODEL_PRESET_SELECT_EVENT_TYPE);
  const modelPresetSubagentModels = readPayloadStringRecord(
    latestModelPresetEvent?.payload,
    "subagentModels",
  );

  const projectionRoot = resolve(runtime.identity.workspaceRoot, effectiveProjectionDir);
  const projectionWorkingPath = join(
    projectionRoot,
    "sessions",
    `sess_${encodeSessionIdForPath(sessionId)}`,
    runtime.config.projection.workingFile,
  );
  const walFilePath = resolve(
    runtime.identity.workspaceRoot,
    effectiveRecoveryWalDir,
    "runtime.jsonl",
  );

  const snapshotSessionDir = resolve(
    runtime.identity.workspaceRoot,
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
      ? createRecoveryWalStore({
          workspaceRoot: runtime.identity.workspaceRoot,
          config: {
            ...runtime.config.infrastructure.recoveryWal,
            dir: effectiveRecoveryWalDir,
          },
          scope: "runtime",
        }).listPending()
      : runtime.inspect.recovery.listPending();

  const report: InspectReport = {
    sessionId,
    workspaceRoot: runtime.identity.workspaceRoot,
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
      anchorCount: runtime.inspect.events.records.query(sessionId, { type: TAPE_ANCHOR_EVENT_TYPE })
        .length,
      checkpointCount: runtime.inspect.events.records.query(sessionId, {
        type: TAPE_CHECKPOINT_EVENT_TYPE,
      }).length,
      tapePressure: tapeStatus.tapePressure,
      entriesSinceAnchor: tapeStatus.entriesSinceAnchor,
    },
    modelPreset: {
      activeName: readPayloadString(latestModelPresetEvent?.payload, "presetName") ?? "Default",
      previousName: readPayloadString(latestModelPresetEvent?.payload, "previousPresetName"),
      source: readPayloadString(latestModelPresetEvent?.payload, "source"),
      mainModel: readPayloadString(latestModelPresetEvent?.payload, "mainModel"),
      subagentModels: modelPresetSubagentModels,
      unmatchedSubagentModelKeys: resolveUnmatchedPresetSubagentModelKeys({
        subagentModels: modelPresetSubagentModels,
        events,
      }),
      eventId: latestModelPresetEvent?.id ?? null,
      selectedAt: toIso(latestModelPresetEvent?.timestamp),
    },
    rewind: {
      checkpointCount: rewindState.checkpoints.length,
      rewindAvailable: rewindState.rewindAvailable,
      redoAvailable: rewindState.redoAvailable,
      redoDepth: rewindState.redoStack.length,
      latestCheckpointId: rewindState.checkpoints.at(-1)?.checkpointId ?? null,
      latestCheckpointTurn: rewindState.checkpoints.at(-1)?.turn ?? null,
      latestCheckpointStatus: rewindState.checkpoints.at(-1)?.status ?? null,
      latestRewind: rewindState.latestRewind
        ? {
            checkpointId: rewindState.latestRewind.checkpointId,
            trigger: rewindState.latestRewind.trigger,
            mode: rewindState.latestRewind.mode,
            summary: rewindState.latestRewind.summary,
            timestamp: toIso(rewindState.latestRewind.timestamp),
          }
        : null,
      nextRedoCheckpointId: rewindState.nextRedoable?.checkpointId ?? null,
      targetCount: rewindTargets.length,
      activeTargetCount: rewindTargets.filter((target) => target.lineage.kind === "active").length,
      abandonedTargetCount: rewindTargets.filter((target) => target.lineage.kind === "abandoned")
        .length,
      activeTargets: rewindTargets.flatMap((target) =>
        target.lineage.kind === "active"
          ? [
              {
                checkpointId: target.checkpointId,
                turn: target.turn,
                promptPreview: target.promptPreview,
                patchSetCountAfter: target.patchSetCountAfter,
              },
            ]
          : [],
      ),
      abandonedTargets: rewindTargets.flatMap((target) =>
        target.lineage.kind === "abandoned"
          ? [
              {
                checkpointId: target.checkpointId,
                turn: target.turn,
                promptPreview: target.promptPreview,
                patchSetCountAfter: target.patchSetCountAfter,
                rewoundBy: target.lineage.rewoundBy,
                rewoundAt: toIso(target.lineage.rewoundAt),
              },
            ]
          : [],
      ),
    },
    lineage: buildLineageInspection(runtime, sessionId),
    bootstrap: {
      managedToolMode:
        bootstrap?.managedToolMode === "hosted" || bootstrap?.managedToolMode === "direct"
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
    },
    task: {
      goal: taskState.spec?.goal ?? null,
      phase: taskState.status?.phase ?? null,
      health: taskState.status?.health ?? null,
      items: taskState.items.length,
      blockers: taskState.blockers.length,
      updatedAt: toIso(taskState.updatedAt),
    },
    claim: {
      totalClaims: claimState.claims.length,
      activeClaims: claimState.claims.filter((claim) => claim.status === "active").length,
      updatedAt: toIso(claimState.updatedAt),
    },
    verification,
    hostedTransitions: projectHostedTransitionSnapshot(structuredEvents),
    contextEvidence: {
      ...contextEvidenceReport.aggregate,
      promotionReady: contextEvidenceReport.promotionReadiness.ready,
      promotionGaps: contextEvidenceReport.promotionReadiness.gaps,
    },
    ledger: {
      path: runtime.inspect.ledger.store.getPath(),
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

export {
  buildInspectReport,
  buildSessionInspectReport,
  resolveInspectDirectory,
  resolveTargetSession,
};
export type { InspectReport, SessionInspectReport };
