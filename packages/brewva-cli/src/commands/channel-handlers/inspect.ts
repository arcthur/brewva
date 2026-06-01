import type {
  ChannelInspectCommandInput,
  ChannelInspectCommandResult,
} from "@brewva/brewva-gateway";
import { TASK_WORK_CARD_PROJECTION_SCHEMA_V2 } from "@brewva/brewva-vocabulary/session";
import { resolveInspectDirectory } from "../../operator/inspect-analysis.js";
import {
  buildSessionInspectReport,
  buildTaskWorkCardProjection,
  formatTaskWorkCardText,
} from "../../operator/inspect.js";

const MAX_CHANNEL_INSPECT_LINES = 12;

type InspectReport = ReturnType<typeof buildSessionInspectReport>;

function normalizeDirectoryArg(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function formatInspectChannelText(input: {
  agentId: string;
  focusedAgentId: string;
  report: InspectReport;
}): string {
  const lines = [`Inspect @${input.agentId} - ${input.report.verdict}`];

  if (input.agentId !== input.focusedAgentId) {
    lines.push(`Focus: @${input.focusedAgentId} · explicit target: @${input.agentId}`);
  }

  lines.push(
    ...formatTaskWorkCardText(buildTaskWorkCardProjection(input.report.base), {
      maxLines: MAX_CHANNEL_INSPECT_LINES - lines.length,
    }).split("\n"),
  );

  return lines.slice(0, MAX_CHANNEL_INSPECT_LINES).join("\n");
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
  return {
    text: formatInspectChannelText({
      agentId: input.targetAgentId,
      focusedAgentId: input.focusedAgentId,
      report,
    }),
    meta: {
      command: "inspect",
      agentId: input.targetAgentId,
      agentSessionId: input.targetSession.sessionId,
      directory: report.directory,
      verdict: report.verdict,
      workCardSchema: TASK_WORK_CARD_PROJECTION_SCHEMA_V2,
    },
  };
}
