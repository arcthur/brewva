import { normalizeToolName } from "../../utils/tool-name.js";
import type { ToolResultVerdict } from "../../utils/tool-result.js";
import type { VerificationCheckRun, VerificationWriteMarkedEventPayload } from "./types.js";
import { VERIFICATION_WRITE_MARKED_SCHEMA } from "./types.js";

const VERIFICATION_TOOL_RESULT_PROJECTION_SCHEMA =
  "brewva.verification.tool_result_projection.v1" as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceVerificationCheckRun(value: unknown): VerificationCheckRun | null {
  if (!isRecord(value)) return null;
  const timestamp =
    typeof value.timestamp === "number" && Number.isFinite(value.timestamp)
      ? Math.max(0, Math.floor(value.timestamp))
      : null;
  const command = typeof value.command === "string" ? value.command.trim() : "";
  const ok = value.ok === true;
  const durationMs =
    typeof value.durationMs === "number" && Number.isFinite(value.durationMs)
      ? Math.max(0, Math.floor(value.durationMs))
      : null;
  const exitCode =
    typeof value.exitCode === "number" && Number.isFinite(value.exitCode)
      ? Math.trunc(value.exitCode)
      : value.exitCode === null
        ? null
        : undefined;
  if (timestamp === null || !command || durationMs === null || exitCode === undefined) {
    return null;
  }

  return {
    timestamp,
    ok,
    command,
    exitCode,
    durationMs,
    ledgerId:
      typeof value.ledgerId === "string" && value.ledgerId.trim().length > 0
        ? value.ledgerId
        : undefined,
    outputSummary:
      typeof value.outputSummary === "string" && value.outputSummary.trim().length > 0
        ? value.outputSummary
        : undefined,
  };
}

export function buildVerificationWriteMarkedPayload(input: {
  toolName: string;
}): VerificationWriteMarkedEventPayload & Record<string, unknown> {
  return {
    schema: VERIFICATION_WRITE_MARKED_SCHEMA,
    toolName: input.toolName,
  };
}

export function buildVerificationToolResultProjectionPayload(input: {
  now: number;
  toolName: string;
  args: Record<string, unknown>;
  outputText: string;
  verdict: ToolResultVerdict;
  metadata?: Record<string, unknown>;
  ledgerId: string;
  outputSummary: string;
}): Record<string, unknown> | undefined {
  const normalizedToolName = normalizeToolName(input.toolName);
  let checkRun: { checkName: string; run: VerificationCheckRun } | undefined;
  if (normalizedToolName === "brewva_verify") {
    const checkName = typeof input.metadata?.check === "string" ? input.metadata.check.trim() : "";
    const command =
      typeof input.metadata?.command === "string" ? input.metadata.command.trim() : "";
    const exitCode =
      typeof input.metadata?.exitCode === "number" && Number.isFinite(input.metadata.exitCode)
        ? Math.trunc(input.metadata.exitCode)
        : input.metadata?.exitCode === null
          ? null
          : undefined;
    const durationMs =
      typeof input.metadata?.durationMs === "number" && Number.isFinite(input.metadata.durationMs)
        ? Math.max(0, Math.floor(input.metadata.durationMs))
        : null;
    if (checkName && command && exitCode !== undefined && durationMs !== null) {
      checkRun = {
        checkName,
        run: {
          timestamp: input.now,
          ok: input.verdict === "pass",
          command,
          exitCode,
          durationMs,
          ledgerId: input.ledgerId,
          outputSummary: input.outputSummary,
        },
      };
    }
  }

  if (!checkRun) {
    return undefined;
  }

  return {
    schema: VERIFICATION_TOOL_RESULT_PROJECTION_SCHEMA,
    checkRun,
  };
}

export function readVerificationToolResultProjectionPayload(value: unknown): {
  checkRun?: { checkName: string; run: VerificationCheckRun };
} | null {
  if (!isRecord(value) || value.schema !== VERIFICATION_TOOL_RESULT_PROJECTION_SCHEMA) {
    return null;
  }

  let checkRun: { checkName: string; run: VerificationCheckRun } | undefined;
  if (isRecord(value.checkRun)) {
    const checkName =
      typeof value.checkRun.checkName === "string" ? value.checkRun.checkName.trim() : "";
    const run = coerceVerificationCheckRun(value.checkRun.run);
    if (checkName && run) {
      checkRun = { checkName, run };
    }
  }

  if (!checkRun) {
    return null;
  }

  return { checkRun };
}
