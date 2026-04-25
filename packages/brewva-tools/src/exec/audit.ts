import {
  BOX_ACQUIRED_EVENT_TYPE,
  BOX_BOOTSTRAP_COMPLETED_EVENT_TYPE,
  BOX_BOOTSTRAP_FAILED_EVENT_TYPE,
  BOX_BOOTSTRAP_PROGRESS_EVENT_TYPE,
  BOX_BOOTSTRAP_STARTED_EVENT_TYPE,
  BOX_EXEC_COMPLETED_EVENT_TYPE,
  BOX_EXEC_FAILED_EVENT_TYPE,
  BOX_EXEC_STARTED_EVENT_TYPE,
  BOX_RELEASED_EVENT_TYPE,
  BOX_SNAPSHOT_CREATED_EVENT_TYPE,
  EXEC_FAILED_EVENT_TYPE,
  EXEC_STARTED_EVENT_TYPE,
  summarizeShellCommandAnalysis,
  summarizeVirtualReadonlyEligibility,
  type CommandPolicySummary,
  type ShellCommandAnalysis,
  type VirtualReadonlyEligibility,
} from "@brewva/brewva-runtime";
import { recordToolRuntimeEvent } from "../runtime-internal.js";
import type { BrewvaBundledToolRuntime } from "../types.js";
import type { ResolvedExecutionPolicy } from "./policy.js";
import { DEFAULT_AUDIT_COMMAND_PREVIEW_LENGTH, hashText } from "./shared.js";

export type RecordedExecEvent =
  | typeof BOX_BOOTSTRAP_STARTED_EVENT_TYPE
  | typeof BOX_BOOTSTRAP_PROGRESS_EVENT_TYPE
  | typeof BOX_BOOTSTRAP_COMPLETED_EVENT_TYPE
  | typeof BOX_BOOTSTRAP_FAILED_EVENT_TYPE
  | typeof BOX_ACQUIRED_EVENT_TYPE
  | typeof BOX_EXEC_STARTED_EVENT_TYPE
  | typeof BOX_EXEC_COMPLETED_EVENT_TYPE
  | typeof BOX_EXEC_FAILED_EVENT_TYPE
  | typeof BOX_SNAPSHOT_CREATED_EVENT_TYPE
  | typeof BOX_RELEASED_EVENT_TYPE
  | typeof EXEC_STARTED_EVENT_TYPE
  | typeof EXEC_FAILED_EVENT_TYPE;

export function redactCommandForAudit(command: string): string {
  const redacted = command
    .replace(
      /\b(authorization\s*[:=]\s*bearer\s+)[^\s"'`]+/giu,
      (_match, prefix: string) => `${prefix}<redacted>`,
    )
    .replace(/\b(Bearer\s+)[^\s"'`]+/gu, (_match, prefix: string) => `${prefix}<redacted>`)
    .replace(
      /\b((?:api[_-]?key|token|secret|password)\s*[=:]\s*)(['"]?)[^'"\s]+(\2)/giu,
      (_match, prefix: string, quote: string) => `${prefix}${quote}<redacted>${quote}`,
    )
    .replace(
      /\b(x-api-key\s*[:=]\s*)(['"]?)[^'"\s]+(\2)/giu,
      (_match, prefix: string, quote: string) => `${prefix}${quote}<redacted>${quote}`,
    )
    .replace(
      /(-{1,2}(?:password|token|secret|api-key)\s+)([^\s"'`]+)/giu,
      (_match, prefix: string) => `${prefix}<redacted>`,
    );

  if (redacted.length <= DEFAULT_AUDIT_COMMAND_PREVIEW_LENGTH) {
    return redacted;
  }
  return `${redacted.slice(0, DEFAULT_AUDIT_COMMAND_PREVIEW_LENGTH)}...`;
}

export function redactTextForAudit(value: string): string {
  return redactCommandForAudit(value);
}

export function hashCommandForAudit(command: string): string {
  return hashText(command);
}

export function buildCommandAuditPayload(command: string): Record<string, unknown> {
  return {
    commandHash: hashCommandForAudit(command),
    commandRedacted: redactCommandForAudit(command),
  };
}

export function buildCommandPolicyAuditPayload(commandPolicy: ShellCommandAnalysis | undefined): {
  commandPolicy?: CommandPolicySummary;
} {
  return commandPolicy ? { commandPolicy: summarizeShellCommandAnalysis(commandPolicy) } : {};
}

export function buildVirtualReadonlyAuditPayload(
  virtualReadonly: VirtualReadonlyEligibility | undefined,
): {
  virtualReadonly?: ReturnType<typeof summarizeVirtualReadonlyEligibility>;
} {
  return virtualReadonly
    ? { virtualReadonly: summarizeVirtualReadonlyEligibility(virtualReadonly) }
    : {};
}

export function buildExecAuditPayload(input: {
  toolCallId: string;
  policy: ResolvedExecutionPolicy;
  command: string;
  payload?: object;
}): Record<string, unknown> {
  return {
    toolCallId: input.toolCallId,
    mode: input.policy.mode,
    routingPolicy: input.policy.routingPolicy,
    configuredBackend: input.policy.configuredBackend,
    denyListBestEffort: input.policy.denyListBestEffort,
    ...buildCommandAuditPayload(input.command),
    ...input.payload,
  };
}

export function recordExecEvent(
  runtime: BrewvaBundledToolRuntime | undefined,
  sessionId: string,
  type: RecordedExecEvent,
  payload: Record<string, unknown>,
): void {
  recordToolRuntimeEvent(runtime, {
    sessionId,
    type,
    payload,
  });
}
