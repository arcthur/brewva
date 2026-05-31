import { differenceInMilliseconds } from "date-fns";
import type { ToolTextOutcomeKind } from "../../../utils/result.js";
import {
  DEFAULT_LOG_TAIL_LINES,
  type ManagedBoxExecFinishedSession,
  type ManagedExecFinishedSession,
} from "../exec-process-registry/api.js";

function formatRuntimeMs(startedAt: number, endedAt = Date.now()): string {
  const value = Math.max(0, differenceInMilliseconds(endedAt, startedAt));
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

export function formatSessionLabel(command: string): string {
  const trimmed = command.trim().replaceAll(/\s+/g, " ");
  if (trimmed.length <= 96) return trimmed;
  return `${trimmed.slice(0, 93)}...`;
}

export function renderListLine(input: {
  sessionId: string;
  status: string;
  startedAt: number;
  endedAt?: number;
  command: string;
}): string {
  return `${input.sessionId} ${input.status.padEnd(9, " ")} ${formatRuntimeMs(
    input.startedAt,
    input.endedAt,
  )} :: ${formatSessionLabel(input.command)}`;
}

export function normalizeOutputText(value: string, fallback: string): string {
  const text = value.trimEnd();
  return text.length > 0 ? text : fallback;
}

export function exitLabel(
  session: ManagedExecFinishedSession | ManagedBoxExecFinishedSession,
): string {
  if (session.exitSignal) return `signal ${session.exitSignal}`;
  return `code ${session.exitCode ?? 0}`;
}

export function defaultTailHint(totalLines: number, usingDefaultTail: boolean): string {
  if (!usingDefaultTail || totalLines <= DEFAULT_LOG_TAIL_LINES) return "";
  return `\n\n[showing last ${DEFAULT_LOG_TAIL_LINES} of ${totalLines} lines; pass offset/limit to page]`;
}

export function resolveProcessOutcomeKind(
  status: "running" | "completed" | "failed",
): ToolTextOutcomeKind {
  if (status === "running") return "inconclusive";
  if (status === "failed") return "err";
  return "ok";
}

export function readDetachedLog(output: string, offset?: number, limit?: number): string {
  const normalized = output.replaceAll("\r\n", "\n");
  const lines = normalized.length === 0 ? [] : normalized.split("\n");
  if (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  const safeOffset =
    typeof offset === "number" && Number.isFinite(offset) ? Math.max(0, Math.trunc(offset)) : 0;
  const safeLimit =
    typeof limit === "number" && Number.isFinite(limit)
      ? Math.max(0, Math.trunc(limit))
      : lines.length;
  return normalizeOutputText(
    lines.slice(safeOffset, safeOffset + safeLimit).join("\n"),
    "(no output recorded)",
  );
}
