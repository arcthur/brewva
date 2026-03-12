import type {
  VerificationCheckRun,
  VerificationEvidence,
  VerificationEvidenceKind,
  VerificationEvidenceMode,
} from "../types.js";
import { normalizeToolName } from "../utils/tool-name.js";
import type { ToolResultVerdict } from "../utils/tool-result.js";
import { classifyEvidence } from "./classifier.js";

const VERIFICATION_WRITE_MARKED_SCHEMA = "brewva.verification.write_marked.v1" as const;
const VERIFICATION_TOOL_RESULT_PROJECTION_SCHEMA =
  "brewva.verification.tool_result_projection.v1" as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeEvidenceKind(value: unknown): VerificationEvidenceKind | null {
  if (value === "lsp_clean" || value === "test_or_build_passed") {
    return value;
  }
  return null;
}

function normalizeEvidenceMode(value: unknown): VerificationEvidenceMode | undefined {
  if (
    value === "heuristic" ||
    value === "compiler" ||
    value === "command" ||
    value === "lsp_native"
  ) {
    return value;
  }
  return undefined;
}

function coerceVerificationEvidence(value: unknown): VerificationEvidence | null {
  if (!isRecord(value)) return null;
  const kind = normalizeEvidenceKind(value.kind);
  const timestamp =
    typeof value.timestamp === "number" && Number.isFinite(value.timestamp)
      ? Math.max(0, Math.floor(value.timestamp))
      : null;
  const tool = typeof value.tool === "string" ? value.tool.trim() : "";
  if (!kind || timestamp === null || !tool) {
    return null;
  }

  const detail =
    typeof value.detail === "string" && value.detail.trim().length > 0 ? value.detail : undefined;
  const mode = normalizeEvidenceMode(value.mode);
  return {
    kind,
    timestamp,
    tool,
    detail,
    mode,
  };
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
}): Record<string, unknown> {
  return {
    schema: VERIFICATION_WRITE_MARKED_SCHEMA,
    toolName: input.toolName,
  };
}

export function coerceVerificationWriteMarkedPayload(value: unknown): { toolName: string } | null {
  if (!isRecord(value) || value.schema !== VERIFICATION_WRITE_MARKED_SCHEMA) {
    return null;
  }
  const toolName = typeof value.toolName === "string" ? value.toolName.trim() : "";
  if (!toolName) {
    return null;
  }
  return { toolName };
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
  const evidence = classifyEvidence({
    now: input.now,
    toolName: input.toolName,
    args: input.args,
    outputText: input.outputText,
    verdict: input.verdict,
  });

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

  if (evidence.length === 0 && !checkRun) {
    return undefined;
  }

  return {
    schema: VERIFICATION_TOOL_RESULT_PROJECTION_SCHEMA,
    evidence,
    checkRun,
  };
}

export function readVerificationToolResultProjectionPayload(value: unknown): {
  evidence: VerificationEvidence[];
  checkRun?: { checkName: string; run: VerificationCheckRun };
} | null {
  if (!isRecord(value) || value.schema !== VERIFICATION_TOOL_RESULT_PROJECTION_SCHEMA) {
    return null;
  }

  const evidence = Array.isArray(value.evidence)
    ? value.evidence
        .map((entry) => coerceVerificationEvidence(entry))
        .filter((entry): entry is VerificationEvidence => entry !== null)
    : [];

  let checkRun: { checkName: string; run: VerificationCheckRun } | undefined;
  if (isRecord(value.checkRun)) {
    const checkName =
      typeof value.checkRun.checkName === "string" ? value.checkRun.checkName.trim() : "";
    const run = coerceVerificationCheckRun(value.checkRun.run);
    if (checkName && run) {
      checkRun = { checkName, run };
    }
  }

  if (evidence.length === 0 && !checkRun) {
    return null;
  }

  return { evidence, checkRun };
}
