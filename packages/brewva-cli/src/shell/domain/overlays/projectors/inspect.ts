import { formatInspectAnalysisText } from "../../../../operator/inspect-analysis.js";
import type { buildSessionInspectReport } from "../../../../operator/inspect.js";
import type { CliInspectOverlayPayload, CliOverlaySection } from "../payloads.js";

type SessionInspectReport = ReturnType<typeof buildSessionInspectReport>;

export function buildInspectSections(report: SessionInspectReport): CliOverlaySection[] {
  const base = report.base;
  const activeRewindTargets = base.rewind.activeTargets
    .slice(0, 5)
    .map(
      (target) =>
        `Active target: turn=${target.turn} checkpoint=${target.checkpointId} patchSetsAfter=${target.patchSetCountAfter} prompt=${target.promptPreview || "n/a"}`,
    );
  const abandonedRewindTargets = base.rewind.abandonedTargets
    .slice(0, 5)
    .map(
      (target) =>
        `Abandoned target: turn=${target.turn} checkpoint=${target.checkpointId} patchSetsAfter=${target.patchSetCountAfter} rewoundBy=${target.rewoundBy} prompt=${target.promptPreview || "n/a"}`,
    );
  const sections: CliOverlaySection[] = [
    {
      id: "summary",
      title: "Summary",
      lines: [
        `Session: ${base.sessionId}`,
        `Workspace: ${base.workspaceRoot}`,
        `Config mode: ${base.configLoad.mode}`,
        `Config paths: ${renderListValue(base.configLoad.paths)}`,
        `Managed tool mode: ${base.bootstrap.managedToolMode ?? "n/a"}`,
      ],
    },
    {
      id: "runtime",
      title: "Runtime",
      lines: [
        `Hydration: ${base.hydration.status} (issues=${base.hydration.issueCount})`,
        `Integrity: ${base.integrity.status} (issues=${base.integrity.issueCount})`,
        `Replay: events=${base.replay.eventCount} anchors=${base.replay.anchorCount} checkpoints=${base.replay.checkpointCount}`,
        `Tape pressure: ${base.replay.tapePressure}`,
        `Entries since anchor: ${base.replay.entriesSinceAnchor}`,
      ],
    },
    {
      id: "rewind",
      title: "Rewind",
      lines: [
        `Checkpoints: ${base.rewind.checkpointCount}`,
        `Targets: total=${base.rewind.targetCount} active=${base.rewind.activeTargetCount} abandoned=${base.rewind.abandonedTargetCount}`,
        `Available: rewind=${base.rewind.rewindAvailable ? "yes" : "no"} redo=${base.rewind.redoAvailable ? "yes" : "no"} redoDepth=${base.rewind.redoDepth}`,
        `Latest checkpoint: ${base.rewind.latestCheckpointId ?? "n/a"} turn=${base.rewind.latestCheckpointTurn ?? "n/a"} status=${base.rewind.latestCheckpointStatus ?? "n/a"}`,
        `Latest rewind: ${
          base.rewind.latestRewind
            ? `${base.rewind.latestRewind.trigger}/${base.rewind.latestRewind.mode}/${base.rewind.latestRewind.summary} -> ${base.rewind.latestRewind.checkpointId}`
            : "none"
        }`,
        `Next redo checkpoint: ${base.rewind.nextRedoCheckpointId ?? "none"}`,
        ...activeRewindTargets,
        ...(base.rewind.activeTargets.length > activeRewindTargets.length
          ? [
              `Active target: +${base.rewind.activeTargets.length - activeRewindTargets.length} more`,
            ]
          : []),
        ...abandonedRewindTargets,
        ...(base.rewind.abandonedTargets.length > abandonedRewindTargets.length
          ? [
              `Abandoned target: +${base.rewind.abandonedTargets.length - abandonedRewindTargets.length} more`,
            ]
          : []),
      ],
    },
    {
      id: "lineage",
      title: "Lineage",
      lines: base.lineage.supported
        ? [
            `Root: ${base.lineage.rootNodeId ?? "n/a"}`,
            `Current: ${base.lineage.currentNodeId ?? "n/a"} kind=${base.lineage.currentKind ?? "n/a"}`,
            `Topology: nodes=${base.lineage.nodeCount} edges=${base.lineage.edgeCount}`,
            `Context records: summaries=${base.lineage.summaryCount} outcomes=${base.lineage.outcomeCount} adopted=${base.lineage.adoptedOutcomeCount}`,
            `Selected channels: ${renderLineageSelectionValue(base.lineage.selectedByChannel)}`,
          ]
        : [`Unsupported: ${base.lineage.unsupportedReason ?? "n/a"}`],
    },
    {
      id: "task",
      title: "Task + Claim",
      lines: [
        `Goal: ${base.task.goal ?? "n/a"}`,
        `Task phase: ${base.task.phase ?? "n/a"}`,
        `Task health: ${base.task.health ?? "n/a"}`,
        `Task items: ${base.task.items}`,
        `Task blockers: ${base.task.blockers}`,
        `Claim: ${base.claim.activeClaims}/${base.claim.totalClaims} active`,
      ],
    },
    {
      id: "verification",
      title: "Verification",
      lines: [
        `Verification outcome: ${base.verification.outcome ?? "n/a"}`,
        `Verification level: ${base.verification.level ?? "n/a"}`,
        `Failed checks: ${renderListValue(base.verification.failedChecks)}`,
        `Missing checks: ${renderListValue(base.verification.missingChecks)}`,
        `Missing evidence: ${renderListValue(base.verification.missingEvidence)}`,
        `Verification reason: ${base.verification.reason ?? "n/a"}`,
      ],
    },
    {
      id: "artifacts",
      title: "Artifacts",
      lines: [
        `Ledger: rows=${base.ledger.rows} integrity=${base.ledger.integrityValid ? "valid" : "invalid"}`,
        `Ledger path: ${base.ledger.path}`,
        `Projection: enabled=${base.projection.enabled ? "yes" : "no"} working=${base.projection.workingExists ? "present" : "missing"}`,
        `Projection path: ${base.projection.workingPath}`,
        `Recovery WAL: enabled=${base.recoveryWal.enabled ? "yes" : "no"} pending=${base.recoveryWal.pendingCount} sessionPending=${base.recoveryWal.pendingSessionCount}`,
        `Recovery WAL path: ${base.recoveryWal.filePath}`,
        `Snapshots: sessionDir=${base.snapshots.sessionDirExists ? "present" : "missing"} patchHistory=${base.snapshots.patchHistoryExists ? "present" : "missing"}`,
        `Patch history path: ${base.snapshots.patchHistoryPath}`,
        `Consistency: ledger=${base.consistency.ledgerIntegrity} pendingRecoveryWal=${base.consistency.pendingRecoveryWal}`,
      ],
    },
    {
      id: "bootstrap",
      title: "Bootstrap",
      lines: [
        `Workspace root: ${base.bootstrap.workspaceRoot ?? "n/a"}`,
        `Config path: ${base.bootstrap.configPath ?? "n/a"}`,
        `Tape dir: ${base.bootstrap.tapeDir ?? "n/a"}`,
        `Recovery WAL dir: ${base.bootstrap.recoveryWalDir ?? "n/a"}`,
        `Projection dir: ${base.bootstrap.projectionDir ?? "n/a"}`,
      ],
    },
    {
      id: "hosted",
      title: "Hosted",
      lines: ["Legacy transition truth: removed", "Source: canonical tape projections"],
    },
  ];

  if (base.hydration.issues.length > 0 || base.integrity.issues.length > 0) {
    sections.push({
      id: "issues",
      title: "Issues",
      lines: [
        ...base.hydration.issues.map(
          (issue) =>
            `Hydration issue #${issue.index}: ${issue.eventType} :: ${issue.reason} (${issue.eventId})`,
        ),
        ...base.integrity.issues.map(
          (issue) =>
            `Integrity issue: ${issue.domain}/${issue.severity} :: ${issue.reason} (${issue.eventId ?? "n/a"})`,
        ),
      ],
    });
  }

  if (base.configLoad.warnings.length > 0) {
    sections.push({
      id: "config",
      title: "Config Warnings",
      lines: base.configLoad.warnings.map(
        (warning) =>
          `${warning.code}: ${warning.message} :: ${warning.configPath} :: ${renderListValue(
            warning.fields,
          )}`,
      ),
    });
  }

  if (base.recoveryWal.pendingRows.length > 0) {
    sections.push({
      id: "recovery",
      title: "Recovery WAL",
      lines: base.recoveryWal.pendingRows.map(
        (row) =>
          `${row.source}/${row.status} turn=${row.turnId} channel=${row.channel} tool=${row.toolName ?? "n/a"} updated=${row.updatedAt ?? "n/a"}`,
      ),
    });
  }

  sections.push({
    id: "analysis",
    title: "Analysis",
    lines: formatInspectAnalysisText(report).split("\n"),
  });

  return sections;
}

export function buildInspectOverlayPayload(report: SessionInspectReport): CliInspectOverlayPayload {
  const sections = buildInspectSections(report);
  return {
    kind: "inspect",
    lines: sections[0]?.lines ?? [],
    sections,
    selectedIndex: 0,
    scrollOffsets: sections.map(() => 0),
  };
}

function renderListValue(values: readonly string[]): string {
  return values.length > 0 ? values.join(", ") : "none";
}

function renderLineageSelectionValue(selectedByChannel: Record<string, string>): string {
  const entries = Object.entries(selectedByChannel).toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  return entries.length > 0
    ? entries.map(([channelId, lineageNodeId]) => `${channelId}:${lineageNodeId}`).join(", ")
    : "none";
}
