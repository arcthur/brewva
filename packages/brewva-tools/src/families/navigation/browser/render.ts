import { errTextResult } from "../../../utils/result.js";
import { buildInvocationMetadata } from "./command.js";
import type { BrowserCommandExecution, BrowserCommandFailure } from "./types.js";

export function formatBrowserLabel(toolName: string): string {
  const stripped = toolName.replace(/^browser_/u, "");
  const words = stripped.split("_").filter(Boolean);
  return words.map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(" ");
}

function formatFailureOutput(result: BrowserCommandFailure): string {
  const sections = [result.stderr.trim(), result.stdout.trim()].filter((value) => value.length > 0);
  const combined = sections.join("\n").trim();
  if (combined.length === 0) {
    return result.failureKind === "spawn_error"
      ? (result.errorMessage ?? "agent-browser command could not be launched.")
      : "agent-browser command failed with no output.";
  }
  if (combined.length <= 2000) {
    return combined;
  }
  return `${combined.slice(0, 1997)}...`;
}

export function buildFailureResult(
  toolName: string,
  result: BrowserCommandFailure,
  extraDetails: Record<string, unknown> = {},
) {
  const label = formatBrowserLabel(toolName);
  return errTextResult(
    [
      `[${label}]`,
      `status: failed`,
      `session: ${result.sessionName}`,
      `reason: ${result.failureKind}`,
      result.exitCode === null ? "exit_code: n/a" : `exit_code: ${result.exitCode}`,
      `details: ${formatFailureOutput(result)}`,
    ].join("\n"),
    {
      ok: false,
      status: "failed",
      ...buildInvocationMetadata(result),
      ...extraDetails,
    },
  );
}

export function buildTextPayload(input: {
  header: string;
  sessionName: string;
  artifactRef?: string | null;
  bodyLabel: string;
  bodyText: string;
  extra?: string[];
}): string {
  const lines = [input.header, `session: ${input.sessionName}`];
  if (input.artifactRef) {
    lines.push(`artifact: ${input.artifactRef}`);
  }
  if (input.extra) {
    lines.push(...input.extra);
  }
  lines.push(`${input.bodyLabel}:`);
  lines.push(input.bodyText.trim().length > 0 ? input.bodyText : "(empty)");
  return lines.join("\n");
}

export function buildStatusPayload(input: {
  header: string;
  sessionName: string;
  status: string;
  extra?: string[];
}): string {
  return [
    input.header,
    `session: ${input.sessionName}`,
    `status: ${input.status}`,
    ...(input.extra ?? []),
  ].join("\n");
}

export function buildSuccessDetails(result: BrowserCommandExecution): Record<string, unknown> {
  return buildInvocationMetadata(result);
}
