import type {
  ChannelInsightsCommandInput,
  ChannelInsightsCommandResult,
} from "@brewva/brewva-gateway";
import { buildProjectInsightsReport } from "./insights.js";
import { clampText, resolveInspectDirectory } from "./inspect-analysis.js";

const MAX_DIRECTORY_SUMMARY = 2;
const MAX_FRICTION_CODES = 3;
const MAX_FAILURE_SUMMARY_CHARS = 96;
const MAX_GUIDANCE_SUMMARY_CHARS = 140;

function normalizeDirectoryArg(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function formatHeader(input: {
  agentId: string;
  focusedAgentId: string;
  report: ReturnType<typeof buildProjectInsightsReport>;
}): string {
  const targetLabel =
    input.agentId === input.focusedAgentId
      ? `Insights @${input.agentId}`
      : `Insights @${input.agentId} (focus @${input.focusedAgentId})`;
  return `${targetLabel} — dir=${input.report.directory || "."} · analyzed=${input.report.window.analyzedSessions} · failed=${input.report.window.failedSessions}`;
}

function formatDirectoriesLine(report: ReturnType<typeof buildProjectInsightsReport>): string {
  if (report.overview.topDirectories.length === 0) {
    return "Dirs: none";
  }
  const visible = report.overview.topDirectories
    .slice(0, MAX_DIRECTORY_SUMMARY)
    .map((entry) => `${entry.path}[s=${entry.sessionCount},w=${entry.writeCount}]`);
  const hiddenCount = report.overview.topDirectories.length - visible.length;
  return hiddenCount > 0
    ? `Dirs: ${visible.join(", ")} … +${hiddenCount}`
    : `Dirs: ${visible.join(", ")}`;
}

function formatFrictionLine(report: ReturnType<typeof buildProjectInsightsReport>): string {
  if (report.overview.topFrictionCodes.length === 0) {
    return "Friction: none";
  }
  const visible = report.overview.topFrictionCodes
    .slice(0, MAX_FRICTION_CODES)
    .map((entry) => `${entry.code}×${entry.count}`);
  const hiddenCount = report.overview.topFrictionCodes.length - visible.length;
  return hiddenCount > 0
    ? `Friction: ${visible.join(", ")} … +${hiddenCount}`
    : `Friction: ${visible.join(", ")}`;
}

function formatVerificationLine(report: ReturnType<typeof buildProjectInsightsReport>): string {
  return [
    `Verification: pass=${report.verificationQuality.passedCount}`,
    `fail=${report.verificationQuality.failedCount}`,
    `missing=${report.verificationQuality.missingCount}`,
    `stale=${report.verificationQuality.sessionsWithStaleVerification}`,
  ].join(" · ");
}

function formatTailLine(report: ReturnType<typeof buildProjectInsightsReport>): string | null {
  const firstFailure = report.analysisFailures[0];
  if (firstFailure) {
    const hiddenCount = report.analysisFailures.length - 1;
    const failureSummary = `${firstFailure.sessionId}: ${clampText(firstFailure.error, MAX_FAILURE_SUMMARY_CHARS)}`;
    return hiddenCount > 0
      ? `Failures: ${failureSummary} … +${hiddenCount}`
      : `Failures: ${failureSummary}`;
  }

  const firstSuggestion = report.guidanceSuggestions[0];
  if (firstSuggestion) {
    return `Next: ${clampText(firstSuggestion.suggestion, MAX_GUIDANCE_SUMMARY_CHARS)}`;
  }

  return null;
}

function formatInsightsChannelText(input: {
  agentId: string;
  focusedAgentId: string;
  report: ReturnType<typeof buildProjectInsightsReport>;
}): string {
  const lines = [
    formatHeader(input),
    formatDirectoriesLine(input.report),
    formatFrictionLine(input.report),
    formatVerificationLine(input.report),
  ];
  const tailLine = formatTailLine(input.report);
  if (tailLine) {
    lines.push(tailLine);
  }
  return lines.join("\n");
}

export async function handleInsightsChannelCommand(
  input: ChannelInsightsCommandInput,
): Promise<ChannelInsightsCommandResult> {
  const directoryArg = normalizeDirectoryArg(input.directory);

  if (directoryArg === "clear") {
    return {
      text: "Channel insights are sent inline and do not persist, so there is nothing to clear.",
      meta: {
        command: "insights",
        mode: "inline",
      },
    };
  }

  if (!input.targetSession) {
    return {
      text: `Insights unavailable: no active session exists for @${input.targetAgentId} in this conversation yet. Send that agent a message first.`,
      meta: {
        command: "insights",
        agentId: input.targetAgentId,
        status: "no_active_session",
      },
    };
  }

  const directory = resolveInspectDirectory(input.targetSession.runtime, directoryArg, undefined);
  const report = buildProjectInsightsReport({
    runtime: input.targetSession.runtime,
    directory,
  });

  if (report.window.analyzedSessions === 0 && report.analysisFailures.length === 0) {
    return {
      text: `Insights unavailable: no analyzable sessions found for @${input.targetAgentId}.`,
      meta: {
        command: "insights",
        agentId: input.targetAgentId,
        status: "no_sessions",
      },
    };
  }

  return {
    text: formatInsightsChannelText({
      agentId: input.targetAgentId,
      focusedAgentId: input.focusedAgentId,
      report,
    }),
    meta: {
      command: "insights",
      agentId: input.targetAgentId,
      agentSessionId: input.targetSession.sessionId,
      directory: directory.workspaceRelativePath,
      analyzedCount: report.window.analyzedSessions,
      failedCount: report.window.failedSessions,
    },
  };
}
