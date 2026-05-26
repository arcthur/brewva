import { formatInspectAnalysisText } from "../inspect-analysis.js";
import {
  formatCockpitCompactionBaseline,
  formatCockpitCompactionProvenance,
  formatCockpitRecallResults,
  formatCockpitResourceRefs,
  formatCockpitSkillInvocations,
} from "./context-cockpit.js";
import type { InspectReport } from "./report.js";

export function formatInspectText(report: InspectReport): string {
  const lines = [
    `Session: ${report.sessionId}`,
    `Workspace: ${report.workspaceRoot}`,
    `Config: mode=${report.configLoad.mode} paths=${renderList(report.configLoad.paths)} warnings=${report.configLoad.warningCount}`,
    "",
    `Hydration: status=${report.hydration.status} issues=${report.hydration.issueCount} hydratedAt=${report.hydration.hydratedAt ?? "n/a"}`,
    `Integrity: status=${report.integrity.status} issues=${report.integrity.issueCount}`,
    `Replay: events=${report.replay.eventCount} first=${report.replay.firstEventAt ?? "n/a"} last=${report.replay.lastEventAt ?? "n/a"}`,
    `Replay: anchors=${report.replay.anchorCount} checkpoints=${report.replay.checkpointCount} tapePressure=${report.replay.tapePressure} entriesSinceAnchor=${report.replay.entriesSinceAnchor}`,
    `Model preset: active=${report.modelPreset.activeName} roles=${renderList(Object.keys(report.modelPreset.roles))} source=${report.modelPreset.source ?? "synthetic"} selectedAt=${report.modelPreset.selectedAt ?? "n/a"}`,
    `Rewind: checkpoints=${report.rewind.checkpointCount} targets=${report.rewind.targetCount} active=${report.rewind.activeTargetCount} abandoned=${report.rewind.abandonedTargetCount}`,
    `Rewind: available=${report.rewind.rewindAvailable ? "yes" : "no"} redo=${report.rewind.redoAvailable ? "yes" : "no"} redoDepth=${report.rewind.redoDepth} latestCheckpoint=${report.rewind.latestCheckpointId ?? "n/a"} status=${report.rewind.latestCheckpointStatus ?? "n/a"}`,
    report.lineage.supported
      ? `Lineage: root=${report.lineage.rootNodeId ?? "n/a"} current=${report.lineage.currentNodeId ?? "n/a"} nodes=${report.lineage.nodeCount} edges=${report.lineage.edgeCount}`
      : `Lineage: unsupported reason=${report.lineage.unsupportedReason ?? "n/a"}`,
    report.lineage.supported
      ? `Lineage: selected=${renderSelectedLineageChannels(report.lineage.selectedByChannel)} summaries=${report.lineage.summaryCount} outcomes=${report.lineage.outcomeCount} adopted=${report.lineage.adoptedOutcomeCount}`
      : "Lineage: selected=none summaries=0 outcomes=0 adopted=0",
    `Bootstrap: workspaceRoot=${report.bootstrap.workspaceRoot ?? "n/a"} config=${report.bootstrap.configPath ?? "n/a"}`,
    `Task: phase=${report.task.phase ?? "n/a"} health=${report.task.health ?? "n/a"} items=${report.task.items} blockers=${report.task.blockers} updatedAt=${report.task.updatedAt ?? "n/a"}`,
    `Task: goal=${report.task.goal ?? "n/a"}`,
    `Claim: active=${report.claim.activeClaims}/${report.claim.totalClaims} updatedAt=${report.claim.updatedAt ?? "n/a"}`,
    `Verification: outcome=${report.verification.outcome ?? "n/a"} level=${report.verification.level ?? "n/a"} failed=${renderList(report.verification.failedChecks)} missing_checks=${renderList(report.verification.missingChecks)} missing_evidence=${renderList(report.verification.missingEvidence)}`,
    "Hosted transitions: removed source=canonical_tape",
    `Context evidence: ready=${report.contextEvidence.promotionReady ? "yes" : "no"} gaps=${renderList(report.contextEvidence.promotionGaps)} compactions=${report.contextEvidence.totalCompactionEvents} generation=${report.contextEvidence.totalCompactionGenerationEvents} llmPrimary=${report.contextEvidence.totalLlmPrimaryCompactionEvents} deterministicEmergency=${report.contextEvidence.totalDeterministicEmergencyCompactionEvents} genTokens=${report.contextEvidence.totalCompactionGenerationTokens} genCacheRead=${report.contextEvidence.totalCompactionGenerationCacheReadTokens} genCacheWrite=${report.contextEvidence.totalCompactionGenerationCacheWriteTokens} genCost=$${report.contextEvidence.totalCompactionGenerationCostUsd.toFixed(6)}`,
    `Context cockpit: policy=${report.contextCockpit.sideEffectPolicy} workbench=${report.contextCockpit.workbench.activeCount} visibleReadEpoch=${report.contextCockpit.context.visibleReadEpoch}`,
    `Context cockpit skills: invocations=${formatCockpitSkillInvocations(report.contextCockpit.skills.invocationRecords)}`,
    `Context cockpit resources: refs=${formatCockpitResourceRefs(report.contextCockpit.skills.resourceRefs)}`,
    `Context cockpit capabilities: receipts=${renderList([...report.contextCockpit.capabilities.receiptRefs])}`,
    `Context cockpit recall: results=${formatCockpitRecallResults(report.contextCockpit.recall.results)}`,
    `Context cockpit compaction: baseline=${formatCockpitCompactionBaseline(report.contextCockpit.compaction.latestBaseline)} provenance=${formatCockpitCompactionProvenance(report.contextCockpit.compaction.inputProvenance)}`,
    `Context cockpit cache: status=${report.contextCockpit.cachePosture.status} read=${report.contextCockpit.cachePosture.cacheReadTokens} write=${report.contextCockpit.cachePosture.cacheWriteTokens}`,
    `Ledger: rows=${report.ledger.rows} integrity=${report.ledger.integrityValid ? "valid" : "invalid"} path=${report.ledger.path}`,
    `Projection: enabled=${report.projection.enabled ? "yes" : "no"} working=${report.projection.workingExists ? "present" : "missing"} path=${report.projection.workingPath}`,
    `Recovery WAL: enabled=${report.recoveryWal.enabled ? "yes" : "no"} pending=${report.recoveryWal.pendingCount} sessionPending=${report.recoveryWal.pendingSessionCount} file=${report.recoveryWal.filePath}`,
    `Snapshots: sessionDir=${report.snapshots.sessionDirExists ? "present" : "missing"} patchHistory=${report.snapshots.patchHistoryExists ? "present" : "missing"} path=${report.snapshots.patchHistoryPath}`,
    `Consistency: ledger=${report.consistency.ledgerIntegrity} pendingRecoveryWal=${report.consistency.pendingRecoveryWal}`,
  ];

  if (report.modelPreset.unmatchedRoleKeys.length > 0) {
    lines.push(
      `Model preset diagnostic: unmatchedRoles=${renderList(report.modelPreset.unmatchedRoleKeys)}`,
    );
  }
  if (report.ledger.integrityReason) {
    lines.push(`Ledger reason: ${report.ledger.integrityReason}`);
  }
  if (report.hydration.latestEventId) {
    lines.push(`Hydration latestEventId: ${report.hydration.latestEventId}`);
  }
  if (report.rewind.latestRewind) {
    lines.push(
      `Latest rewind: checkpoint=${report.rewind.latestRewind.checkpointId} trigger=${report.rewind.latestRewind.trigger} mode=${report.rewind.latestRewind.mode} summary=${report.rewind.latestRewind.summary} at=${report.rewind.latestRewind.timestamp ?? "n/a"}`,
    );
  }
  if (report.rewind.nextRedoCheckpointId) {
    lines.push(`Next redo checkpoint: ${report.rewind.nextRedoCheckpointId}`);
  }
  for (const target of report.rewind.activeTargets.slice(0, 5)) {
    lines.push(
      `Rewind target: active turn=${target.turn} checkpoint=${target.checkpointId} patchSetsAfter=${target.patchSetCountAfter} prompt=${target.promptPreview || "n/a"}`,
    );
  }
  for (const target of report.rewind.abandonedTargets.slice(0, 5)) {
    lines.push(
      `Rewind target: abandoned turn=${target.turn} checkpoint=${target.checkpointId} patchSetsAfter=${target.patchSetCountAfter} rewoundBy=${target.rewoundBy} rewoundAt=${target.rewoundAt ?? "n/a"} prompt=${target.promptPreview || "n/a"}`,
    );
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
  if (
    report.bootstrap.configPath ||
    report.bootstrap.tapeDir ||
    report.bootstrap.recoveryWalDir ||
    report.bootstrap.projectionDir ||
    report.bootstrap.ledgerPath
  ) {
    lines.push(
      `Bootstrap config: path=${report.bootstrap.configPath ?? "n/a"} tape=${report.bootstrap.tapeDir ?? "n/a"} recoveryWal=${report.bootstrap.recoveryWalDir ?? "n/a"} projection=${report.bootstrap.projectionDir ?? "n/a"} ledger=${report.bootstrap.ledgerPath ?? "n/a"}`,
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

export function printInspectText(report: InspectReport): void {
  console.log(formatInspectText(report));
}

function renderList(values: string[]): string {
  return values.length > 0 ? values.join(",") : "none";
}

function renderSelectedLineageChannels(selectedByChannel: Record<string, string>): string {
  const entries = Object.entries(selectedByChannel).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  return entries.length > 0
    ? entries.map(([channelId, lineageNodeId]) => `${channelId}:${lineageNodeId}`).join(",")
    : "none";
}
