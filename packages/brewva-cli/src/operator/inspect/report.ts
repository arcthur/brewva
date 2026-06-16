import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createRecoveryWalStore } from "@brewva/brewva-gateway/daemon";
import {
  buildContextEvidenceReport,
  type ContextEvidenceAggregateReport,
} from "@brewva/brewva-gateway/hosted";
import type { HostedRuntimeAdapterPort } from "@brewva/brewva-gateway/hosted";
import type { BrewvaForensicConfigWarning } from "@brewva/brewva-runtime/config";
import { projectDelegationInspectionState } from "@brewva/brewva-session-index";
import type { DelegationInspectionProjection } from "@brewva/brewva-vocabulary/delegation";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import {
  CLAIM_EVENT_TYPE,
  foldClaimLedgerEvents,
  MODEL_PRESET_SELECT_EVENT_TYPE,
  readVerificationOutcomeRecordedEventPayload,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/iteration";
import {
  type ManagedToolMode,
  TAPE_ANCHOR_EVENT_TYPE,
  TAPE_CHECKPOINT_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/session";
import { TASK_EVENT_TYPE } from "@brewva/brewva-vocabulary/task";
import { foldTaskLedgerEvents } from "@brewva/brewva-vocabulary/task";
import { PATCH_HISTORY_FILE } from "@brewva/brewva-vocabulary/workbench";
import { formatISO } from "date-fns";
import { createCliInspectPort, type CliInspectPort } from "../../runtime/cli-runtime-ports.js";
import {
  buildInspectAnalysis,
  resolveInspectDirectory,
  type InspectAnalysisReport,
  type InspectDirectory,
} from "../inspect-analysis.js";
import { buildContextCockpitReport, type ContextCockpitReport } from "./context-cockpit.js";
import { deriveRecoveryCapabilities, type RecoveryCapabilities } from "./recovery-capabilities.js";

interface SessionTransitionSnapshot {
  readonly sequence: number;
  readonly latest: null;
  readonly pendingFamily: null;
  readonly activeAttemptSequence: null;
  readonly activeReasonCounts: Record<string, never>;
  readonly operatorVisibleFactGeneration: number;
}

function createEmptySessionTransitionSnapshot(): SessionTransitionSnapshot {
  return {
    sequence: 0,
    latest: null,
    pendingFamily: null,
    activeAttemptSequence: null,
    activeReasonCounts: {},
    operatorVisibleFactGeneration: 0,
  };
}

interface InspectBootstrapPayload {
  managedToolMode?: ManagedToolMode;
  runtimeConfig?: {
    workspaceRoot?: string;
    configPath?: string | null;
    artifactRoots?: {
      tapeDir?: string;
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
  mode: "merged_default" | "explicit";
  paths: string[];
  warningCount: number;
  warnings: Array<{
    code: BrewvaForensicConfigWarning["code"];
    configPath: string;
    message: string;
    fields: string[];
  }>;
}

interface InspectOperatorSafetyDecision {
  readonly decision: "allow" | "ask" | "deny";
  readonly toolName: string;
  readonly actionClass: string | null;
  readonly requestId: string | null;
  readonly receiptIds: string[];
  readonly reason: string | null;
}

interface InspectReport {
  sessionId: string;
  workspaceRoot: string;
  configLoad: InspectConfigLoadReport;
  analysis?: InspectAnalysisReport;
  hydration: {
    status: "cold" | "ready" | "degraded" | "unavailable";
    hydratedAt: string | null;
    latestEventId: string | null;
    reason: string | null;
    issueCount: number;
    issues: Array<{
      domain: string;
      severity: string;
      eventId: string;
      eventType: string;
      index: number;
      reason: string;
    }>;
  };
  integrity: {
    status: "healthy" | "degraded" | "inconclusive" | "unavailable";
    reason: string | null;
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
  recoveryCapabilities: RecoveryCapabilities;
  replay: {
    eventCount: number;
    firstEventAt: string | null;
    lastEventAt: string | null;
    anchorCount: number;
    checkpointCount: number;
    tapePressure: string;
    entriesSinceAnchor: number;
    lastAnchor: {
      id: string;
      name: string | null;
      summary: string | null;
      nextSteps: string | null;
    } | null;
  };
  modelPreset: {
    activeName: string;
    previousName: string | null;
    source: string | null;
    roles: Record<string, string>;
    unmatchedRoleKeys: string[];
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
    managedToolMode: ManagedToolMode | null;
    workspaceRoot: string | null;
    configPath: string | null;
    tapeDir: string | null;
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
  goalControl: {
    objective: string | null;
    status: string | null;
    tokenBudget: number | null;
    tokensUsed: number;
    elapsedMs: number;
    lastLifecycleEvent: string | null;
    latestContinuationRef: string | null;
    latestCompletionEvidenceRef: string | null;
    latestBlockEvidenceRef: string | null;
  };
  claim: {
    totalClaims: number;
    activeClaims: number;
    updatedAt: string | null;
  };
  verification: InspectVerification;
  delegation: DelegationInspectionProjection;
  operatorSafety: {
    recentDecisions: InspectOperatorSafetyDecision[];
    pendingAsks: number;
    denials: number;
    receiptIds: string[];
  };
  hostedTransitions: SessionTransitionSnapshot;
  contextEvidence: ContextEvidenceAggregateReport & {
    promotionReady: boolean;
    promotionGaps: string[];
  };
  contextCockpit: ContextCockpitReport;
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

function readPayloadObject(payload: unknown, key: string): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return {};
  }
  const value = (payload as Record<string, unknown>)[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function resolveUnmatchedPresetRoleKeys(roles: Record<string, string>): string[] {
  const knownRoles = new Set(["default", "smol", "slow", "plan", "commit", "task"]);
  return Object.keys(roles)
    .filter((key) => !knownRoles.has(key))
    .toSorted((left, right) => left.localeCompare(right));
}

function readLatestEventPayload<T extends object>(
  events: readonly BrewvaEventRecord[],
  type: string,
  coerce: (payload: Record<string, unknown>) => T = (payload) => payload as T,
): { payload: T; timestamp: number } | null {
  const event = events.toReversed().find((candidate) => candidate.type === type);
  if (!event?.payload) return null;
  return {
    payload: coerce(event.payload as Record<string, unknown>),
    timestamp: event.timestamp,
  };
}

function buildLineageInspection(
  inspect: CliInspectPort,
  sessionId: string,
): InspectReport["lineage"] {
  try {
    const tree = inspect.session.lineageTree(sessionId);
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
  inspect: CliInspectPort,
  sessionId: string,
): InspectVerification {
  const latestEvent = inspect.events
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

function buildOperatorSafetyInspection(
  events: readonly BrewvaEventRecord[],
): InspectReport["operatorSafety"] {
  const decisions: InspectOperatorSafetyDecision[] = [];
  const pendingRequestIds = new Set<string>();
  const receiptIds = new Set<string>();
  const requestsById = new Map<
    string,
    { readonly toolName: string; readonly actionClass: string | null }
  >();
  for (const event of events) {
    const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
    const authority = readPayloadObject(payload, "authority");
    const eventId = readText(event.id);
    if (event.type === "tool.proposed") {
      const effectiveAdmission = readText(authority.effectiveAdmission);
      const requiresApproval = authority.requiresApproval === true;
      if (effectiveAdmission === "allow" && !requiresApproval) {
        const call = readPayloadObject(payload, "call");
        if (eventId) {
          receiptIds.add(eventId);
        }
        decisions.push({
          decision: "allow",
          toolName: readText(call.toolName) ?? readText(authority.normalizedToolName) ?? "unknown",
          actionClass: readText(authority.actionClass),
          requestId: null,
          receiptIds: eventId ? [eventId] : [],
          reason: null,
        });
      }
      continue;
    }
    if (event.type === "approval.requested") {
      const requestId = readText((payload as Record<string, unknown>).id);
      const toolName = readText((payload as Record<string, unknown>).toolName) ?? "unknown";
      const actionClass = readText(authority.actionClass);
      if (requestId) {
        pendingRequestIds.add(requestId);
        requestsById.set(requestId, { toolName, actionClass });
      }
      if (eventId) {
        receiptIds.add(eventId);
      }
      decisions.push({
        decision: "ask",
        toolName,
        actionClass,
        requestId,
        receiptIds: eventId ? [eventId] : [],
        reason: readText((payload as Record<string, unknown>).reason),
      });
      continue;
    }
    if (event.type === "approval.decided") {
      if ((payload as Record<string, unknown>).applied === false) {
        // Durable no-op receipt for a request that was already terminal; the
        // first durable decision owns the authority outcome.
        if (eventId) {
          receiptIds.add(eventId);
        }
        continue;
      }
      const requestId =
        readText((payload as Record<string, unknown>).id) ??
        readText((payload as Record<string, unknown>).requestId);
      if (requestId) {
        pendingRequestIds.delete(requestId);
      }
      const rawDecision = (payload as Record<string, unknown>).decision;
      const request = requestId ? requestsById.get(requestId) : undefined;
      const decision = rawDecision === "accept" ? "allow" : "deny";
      if (eventId) {
        receiptIds.add(eventId);
      }
      decisions.push({
        decision,
        toolName: request?.toolName ?? "operator_request",
        actionClass: request?.actionClass ?? null,
        requestId,
        receiptIds: eventId ? [eventId] : [],
        reason:
          readText((payload as Record<string, unknown>).reason) ??
          (rawDecision === "cancel" ? "approval_cancelled" : null),
      });
      continue;
    }
    if (event.type === "tool.aborted") {
      const call = readPayloadObject(payload, "call");
      // A terminal abort closes the approval request bound to the same call
      // identity (denied, cancelled, expired, digest mismatch): the request
      // is no longer pending operator attention.
      const sessionId = readText(call.sessionId);
      const toolCallId = readText(call.toolCallId);
      if (sessionId && toolCallId) {
        const turnId = readText(call.turnId);
        const boundRequestId = turnId
          ? `approval:${encodeURIComponent(sessionId)}:${encodeURIComponent(turnId)}:${encodeURIComponent(toolCallId)}`
          : `approval:${encodeURIComponent(sessionId)}:${encodeURIComponent(toolCallId)}`;
        pendingRequestIds.delete(boundRequestId);
      }
      if (eventId) {
        receiptIds.add(eventId);
      }
      decisions.push({
        decision: "deny",
        toolName: readText(call.toolName) ?? readText(authority.normalizedToolName) ?? "unknown",
        actionClass: readText(authority.actionClass),
        requestId: null,
        receiptIds: eventId ? [eventId] : [],
        reason: readText((payload as Record<string, unknown>).reason),
      });
    }
  }
  return {
    recentDecisions: decisions.slice(-8),
    pendingAsks: pendingRequestIds.size,
    denials: decisions.filter((decision) => decision.decision === "deny").length,
    receiptIds: [...receiptIds].slice(-16),
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
  runtime: HostedRuntimeAdapterPort,
  inspect: CliInspectPort,
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
      : inspect.recovery.listPending();
  return pendingRows
    .filter((row: { sessionId: string }) => row.sessionId === sessionId)
    .map(
      (row: {
        walId: string;
        source: string;
        status: string;
        turnId?: string;
        channel?: string;
        updatedAt: number;
        envelope: { meta?: Record<string, unknown> | null };
      }) => {
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
          turnId: row.turnId ?? "",
          channel: row.channel ?? "",
          updatedAt: toIso(row.updatedAt),
          toolCallId,
          toolName,
        };
      },
    )
    .toSorted(
      (
        left: { updatedAt: string | null; walId: string },
        right: { updatedAt: string | null; walId: string },
      ) =>
        (right.updatedAt ? Date.parse(right.updatedAt) : 0) -
          (left.updatedAt ? Date.parse(left.updatedAt) : 0) ||
        left.walId.localeCompare(right.walId),
    );
}

function scoreDefaultReplaySession(inspect: CliInspectPort, sessionId: string): number {
  const events = inspect.events.query(sessionId);
  if (events.some((event) => event.type === "session_bootstrap")) {
    return 3;
  }
  if (
    events.some(
      (event) =>
        event.type === "message_end" ||
        event.type === "turn_start" ||
        event.type === "agent_end" ||
        event.type === "session_start",
    )
  ) {
    return 2;
  }
  return 1;
}

function listAllReplaySessions(inspect: CliInspectPort): Array<{
  sessionId: string;
  eventCount: number;
  lastEventAt: number;
}> {
  return inspect.events.listReplaySessions();
}

function resolveTargetSession(
  runtime: HostedRuntimeAdapterPort,
  requestedSessionId?: string,
): string | null {
  if (requestedSessionId && requestedSessionId.trim().length > 0) {
    return requestedSessionId.trim();
  }

  const inspect = createCliInspectPort(runtime);
  return (
    listAllReplaySessions(inspect)
      .map((session: { sessionId: string; eventCount: number; lastEventAt: number }) => ({
        sessionId: session.sessionId,
        eventCount: session.eventCount,
        lastEventAt: session.lastEventAt,
        defaultScore: scoreDefaultReplaySession(inspect, session.sessionId),
      }))
      .toSorted(
        (
          left: { defaultScore: number; lastEventAt: number; sessionId: string },
          right: { defaultScore: number; lastEventAt: number; sessionId: string },
        ) =>
          right.defaultScore - left.defaultScore ||
          right.lastEventAt - left.lastEventAt ||
          left.sessionId.localeCompare(right.sessionId),
      )[0]?.sessionId ?? null
  );
}

function buildInspectReport(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
  options: {
    directory?: InspectDirectory;
    configLoad?: InspectConfigLoadReport;
  } = {},
): InspectReport {
  const inspect = createCliInspectPort(runtime);
  const replaySession =
    listAllReplaySessions(inspect).find(
      (entry: { sessionId: string }) => entry.sessionId === sessionId,
    ) ?? null;
  const events = inspect.events.query(sessionId);
  const eventsByType = new Map<string, BrewvaEventRecord[]>();
  for (const event of events) {
    const bucket = eventsByType.get(event.type);
    if (bucket) {
      bucket.push(event);
    } else {
      eventsByType.set(event.type, [event]);
    }
  }
  const taskEvents = eventsByType.get(TASK_EVENT_TYPE) ?? [];
  const claimEvents = eventsByType.get(CLAIM_EVENT_TYPE) ?? [];
  const taskState = foldTaskLedgerEvents(taskEvents);
  const goalControlState = inspect.goal.state(sessionId);
  const claimState = foldClaimLedgerEvents(claimEvents);
  const tapeStatus = inspect.tape.status(sessionId);
  const hydration = inspect.session.lifecycleHydration(sessionId);
  const integrity = inspect.session.lifecycleIntegrity(sessionId);
  const rewindState = inspect.session.rewindState(sessionId);
  const workspaceRewindReadiness = inspect.session.workspaceRewindReadiness(sessionId);
  const rewindTargets = inspect.session.rewindTargets(sessionId);
  const bootstrap = readLatestEventPayload<InspectBootstrapPayload>(
    events,
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
  const verification = buildVerificationInspection(inspect, sessionId);
  const contextEvidenceReport = buildContextEvidenceReport(runtime, {
    sessionIds: [sessionId],
  });
  const ledgerIntegrity = inspect.ledger.verifyIntegrity(sessionId);
  const ledgerRows = inspect.ledger.listRows(sessionId);
  const latestModelPresetEvent = events
    .toReversed()
    .find((event) => event.type === MODEL_PRESET_SELECT_EVENT_TYPE);
  const modelPresetRoles = readPayloadStringRecord(latestModelPresetEvent?.payload, "roles");

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
    inspect,
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
      : inspect.recovery.listPending();

  const report: InspectReport = {
    sessionId,
    workspaceRoot: runtime.identity.workspaceRoot,
    configLoad: options.configLoad ?? {
      mode: "merged_default",
      paths: [],
      warningCount: 0,
      warnings: [],
    },
    hydration: {
      status: hydration.status,
      hydratedAt: toIso(hydration.hydratedAt),
      latestEventId: hydration.cursor?.latestEventId ?? null,
      reason: hydration.reason,
      issueCount: hydration.issues.length,
      issues: hydration.issues.map((issue) => ({
        domain: issue.domain,
        severity: issue.severity,
        eventId: issue.eventId ?? "n/a",
        eventType: issue.eventType ?? "n/a",
        index: issue.index ?? -1,
        reason: issue.reason,
      })),
    },
    integrity: {
      status: integrity.status,
      reason: integrity.reason,
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
    recoveryCapabilities: deriveRecoveryCapabilities({
      hydration,
      integrity,
      rewind: rewindState,
      workspaceRewind: workspaceRewindReadiness,
    }),
    replay: {
      eventCount: replaySession?.eventCount ?? events.length,
      firstEventAt: toIso(events[0]?.timestamp),
      lastEventAt: toIso(replaySession?.lastEventAt ?? events[events.length - 1]?.timestamp),
      anchorCount: inspect.events.query(sessionId, { type: TAPE_ANCHOR_EVENT_TYPE }).length,
      checkpointCount: inspect.events.query(sessionId, {
        type: TAPE_CHECKPOINT_EVENT_TYPE,
      }).length,
      tapePressure: tapeStatus.tapePressure,
      entriesSinceAnchor: tapeStatus.entriesSinceAnchor,
      lastAnchor: tapeStatus.lastAnchor
        ? {
            id: tapeStatus.lastAnchor.id,
            name: tapeStatus.lastAnchor.name ?? null,
            summary: tapeStatus.lastAnchor.summary ?? null,
            nextSteps: tapeStatus.lastAnchor.nextSteps ?? null,
          }
        : null,
    },
    modelPreset: {
      activeName: readPayloadString(latestModelPresetEvent?.payload, "presetName") ?? "Default",
      previousName: readPayloadString(latestModelPresetEvent?.payload, "previousPresetName"),
      source: readPayloadString(latestModelPresetEvent?.payload, "source"),
      roles: modelPresetRoles,
      unmatchedRoleKeys: resolveUnmatchedPresetRoleKeys(modelPresetRoles),
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
      activeTargetCount: rewindTargets.filter(
        (target: { lineage: { kind: string } }) => target.lineage.kind === "active",
      ).length,
      abandonedTargetCount: rewindTargets.filter(
        (target: { lineage: { kind: string } }) => target.lineage.kind === "abandoned",
      ).length,
      activeTargets: rewindTargets.flatMap(
        (target: {
          lineage: { kind: string };
          checkpointId: string;
          turn: number;
          promptPreview: string;
          patchSetCountAfter: number;
        }) =>
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
      abandonedTargets: rewindTargets.flatMap(
        (target: {
          lineage: { kind: string; rewoundBy?: string; rewoundAt?: number };
          checkpointId: string;
          turn: number;
          promptPreview: string;
          patchSetCountAfter: number;
        }) =>
          target.lineage.kind === "abandoned"
            ? [
                {
                  checkpointId: target.checkpointId,
                  turn: target.turn,
                  promptPreview: target.promptPreview,
                  patchSetCountAfter: target.patchSetCountAfter,
                  rewoundBy: target.lineage.rewoundBy ?? "unknown",
                  rewoundAt: toIso(target.lineage.rewoundAt),
                },
              ]
            : [],
      ),
    },
    lineage: buildLineageInspection(inspect, sessionId),
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
      tapeDir:
        typeof bootstrapArtifactRoots?.tapeDir === "string" &&
        bootstrapArtifactRoots.tapeDir.trim().length > 0
          ? bootstrapArtifactRoots.tapeDir
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
    goalControl: {
      objective: goalControlState?.objective ?? null,
      status: goalControlState?.status ?? null,
      tokenBudget: goalControlState?.tokenBudget ?? null,
      tokensUsed: goalControlState?.usage.tokens ?? 0,
      elapsedMs: goalControlState?.usage.elapsedMs ?? 0,
      lastLifecycleEvent: goalControlState?.lastLifecycleEvent ?? null,
      latestContinuationRef: goalControlState?.latestContinuationRef ?? null,
      latestCompletionEvidenceRef: goalControlState?.latestCompletionEvidenceRef ?? null,
      latestBlockEvidenceRef: goalControlState?.latestBlockEvidenceRef ?? null,
    },
    claim: {
      totalClaims: claimState.claims.length,
      activeClaims: claimState.claims.filter((claim) => claim.status === "active").length,
      updatedAt: toIso(claimState.updatedAt),
    },
    verification,
    delegation: projectDelegationInspectionState({ sessionId, records: events }),
    operatorSafety: buildOperatorSafetyInspection(events),
    hostedTransitions: createEmptySessionTransitionSnapshot(),
    contextEvidence: {
      ...contextEvidenceReport.aggregate,
      promotionReady: contextEvidenceReport.promotionReadiness.ready,
      promotionGaps: contextEvidenceReport.promotionReadiness.gaps,
    },
    contextCockpit: buildContextCockpitReport(runtime, sessionId),
    ledger: {
      path: inspect.ledger.getPath(),
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
  runtime: HostedRuntimeAdapterPort;
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
  buildContextCockpitReport,
  buildInspectReport,
  buildSessionInspectReport,
  resolveInspectDirectory,
  resolveTargetSession,
};
export type { ContextCockpitReport, InspectReport, SessionInspectReport };
