import type {
  ChannelInspectCommandInput,
  ChannelInspectCommandResult,
} from "@brewva/brewva-gateway";
import type { EffectCommitmentRequestRecord } from "@brewva/brewva-runtime";
import { clampText, resolveInspectDirectory } from "./inspect-analysis.js";
import { buildSessionInspectReport } from "./inspect.js";

const MAX_FINDINGS = 3;
const MAX_GAPS = 2;
const MAX_SUMMARY_CHARS = 160;
const MAX_REPLAYABLE_APPROVALS = 2;
const MAX_APPROVAL_REASON_CHARS = 96;

type InspectReport = ReturnType<typeof buildSessionInspectReport>;

function normalizeDirectoryArg(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function formatFindingLine(finding: InspectReport["findings"][number]): string {
  return `- ${finding.severity.toUpperCase()} ${finding.code}: ${clampText(finding.summary, MAX_SUMMARY_CHARS)}`;
}

function formatGapLine(gap: string): string {
  return `- ${clampText(gap, MAX_SUMMARY_CHARS)}`;
}

function formatScopeLine(report: InspectReport): string {
  return [
    `Scope: writes ${report.scope.writesInDir}/${report.scope.writesOutOfDir} in/out`,
    `touched ${report.scope.touchedInDir}/${report.scope.touchedOutOfDir} in/out`,
    `reads ${report.scope.readsInDirHeuristic}/${report.scope.readsOutOfDirHeuristic} in/out`,
  ].join(" · ");
}

function formatCoverageLine(report: InspectReport): string {
  return [
    `Mode: ${report.mode}`,
    `ops=${report.coverage.opsTelemetryAvailable ? "yes" : "no"}`,
    `write=${report.coverage.writeAttribution}`,
    `read=${report.coverage.readAttribution}`,
  ].join(" · ");
}

function formatApprovalSummaryLine(requests: EffectCommitmentRequestRecord[]): string {
  const counts = {
    pending: 0,
    accepted: 0,
    rejected: 0,
    consumed: 0,
  };
  for (const request of requests) {
    counts[request.state] += 1;
  }
  return [
    `Approvals: pending=${counts.pending}`,
    `accepted=${counts.accepted}`,
    `rejected=${counts.rejected}`,
    `consumed=${counts.consumed}`,
  ].join(" · ");
}

function formatReplayableApprovalLine(request: EffectCommitmentRequestRecord): string {
  const details = [`tool=${request.toolName}`];
  if (request.actor) {
    details.push(`actor=${request.actor}`);
  }
  if (request.reason) {
    details.push(`reason=${clampText(request.reason, MAX_APPROVAL_REASON_CHARS)}`);
  }
  return `- ${request.state} ${request.requestId} · ${details.join(" · ")}`;
}

function formatInspectChannelText(input: {
  agentId: string;
  focusedAgentId: string;
  report: InspectReport;
  approvalRequests: EffectCommitmentRequestRecord[];
}): string {
  const lines = [`Inspect @${input.agentId} — ${input.report.verdict}`];

  if (input.agentId !== input.focusedAgentId) {
    lines.push(`Focus: @${input.focusedAgentId} · explicit target: @${input.agentId}`);
  }

  lines.push(`Dir: ${input.report.directory}`);
  lines.push(formatCoverageLine(input.report));
  lines.push(formatScopeLine(input.report));
  lines.push(formatApprovalSummaryLine(input.approvalRequests));

  const replayableRequests = input.approvalRequests.filter(
    (request) => request.state === "pending" || request.state === "accepted",
  );
  if (replayableRequests.length > 0) {
    lines.push("Replayable approvals:");
    for (const request of replayableRequests.slice(0, MAX_REPLAYABLE_APPROVALS)) {
      lines.push(formatReplayableApprovalLine(request));
    }
    const hiddenCount =
      replayableRequests.length - Math.min(replayableRequests.length, MAX_REPLAYABLE_APPROVALS);
    if (hiddenCount > 0) {
      lines.push(`- ... ${hiddenCount} more replayable approval(s)`);
    }
  }

  if (input.report.findings.length === 0) {
    lines.push("Findings: none.");
  } else {
    lines.push("Findings:");
    for (const finding of input.report.findings.slice(0, MAX_FINDINGS)) {
      lines.push(formatFindingLine(finding));
    }
    const hiddenFindings =
      input.report.findings.length - Math.min(input.report.findings.length, MAX_FINDINGS);
    if (hiddenFindings > 0) {
      lines.push(`- ... ${hiddenFindings} more finding(s)`);
    }
  }

  if (input.report.evidenceGaps.length > 0) {
    lines.push("Evidence gaps:");
    for (const gap of input.report.evidenceGaps.slice(0, MAX_GAPS)) {
      lines.push(formatGapLine(gap));
    }
    const hiddenGaps =
      input.report.evidenceGaps.length - Math.min(input.report.evidenceGaps.length, MAX_GAPS);
    if (hiddenGaps > 0) {
      lines.push(`- ... ${hiddenGaps} more gap(s)`);
    }
  }

  return lines.join("\n");
}

export async function handleInspectChannelCommand(
  input: ChannelInspectCommandInput,
): Promise<ChannelInspectCommandResult> {
  const directoryArg = normalizeDirectoryArg(input.directory);

  if (directoryArg === "clear") {
    return {
      text: "Channel inspect output is sent inline and does not persist, so there is nothing to clear.",
      meta: {
        command: "inspect",
        mode: "inline",
      },
    };
  }

  if (!input.targetSession) {
    return {
      text: `Inspect unavailable: no active session exists for @${input.targetAgentId} in this conversation yet. Send that agent a message first.`,
      meta: {
        command: "inspect",
        agentId: input.targetAgentId,
        status: "no_active_session",
      },
    };
  }

  const directory = resolveInspectDirectory(input.targetSession.runtime, directoryArg, undefined);
  const report = buildSessionInspectReport({
    runtime: input.targetSession.runtime,
    sessionId: input.targetSession.sessionId,
    directory,
  });
  const approvalRequests = input.targetSession.runtime.proposals.listEffectCommitmentRequests(
    input.targetSession.sessionId,
  );

  return {
    text: formatInspectChannelText({
      agentId: input.targetAgentId,
      focusedAgentId: input.focusedAgentId,
      report,
      approvalRequests,
    }),
    meta: {
      command: "inspect",
      agentId: input.targetAgentId,
      agentSessionId: input.targetSession.sessionId,
      directory: report.directory,
      verdict: report.verdict,
      approvalRequestCount: approvalRequests.length,
      replayableApprovalCount: approvalRequests.filter(
        (request) => request.state === "pending" || request.state === "accepted",
      ).length,
    },
  };
}
