import { optionalStringField, stringField } from "./shared.js";
import type { ProtocolRecord } from "./types/foundation.js";

export type { ProtocolRecord } from "./types/foundation.js";

export interface BrewvaEventRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly turnId?: string;
  readonly turn?: number;
  readonly type: string;
  readonly category?: string;
  readonly timestamp: number;
  readonly isoTime?: string;
  readonly payload?: ProtocolRecord;
  readonly schema?: string;
  readonly source?: string;
  readonly [key: string]: unknown;
}

export interface BrewvaStructuredEvent extends BrewvaEventRecord {}

export interface BrewvaEventQuery {
  readonly sessionId?: string;
  readonly type?: string;
  readonly category?: string;
  readonly since?: number;
  readonly limit?: number;
  readonly after?: number;
  readonly before?: number;
  readonly offset?: number;
  readonly last?: number;
  readonly [key: string]: unknown;
}

export const RUNTIME_OPS_EVENT_NAMESPACE = "runtime.ops" as const;

export const RUNTIME_OPS_REASONING_CHECKPOINT_RECORDED_KIND =
  "reasoning_checkpoint_recorded" as const;
export const RUNTIME_OPS_REASONING_REVERT_RECORDED_KIND = "reasoning_revert_recorded" as const;
export const RUNTIME_OPS_SESSION_COMPACTION_COMMITTED_KIND =
  "session.compaction.committed" as const;
export const RUNTIME_OPS_TOOL_INVOCATION_STARTED_KIND = "tool.invocation.started" as const;
export const RUNTIME_OPS_TOOL_INVOCATION_FINISHED_KIND = "tool.invocation.finished" as const;
export const RUNTIME_OPS_TOOL_RESULT_RECORDED_KIND = "tool.result.recorded" as const;
export const RUNTIME_OPS_TOOL_CALL_OBSERVED_KIND = "tool_call_observed" as const;
export const RUNTIME_OPS_TOOL_CALL_STARTED_KIND = "tool_call_started" as const;
export const RUNTIME_OPS_TOOL_CALL_ENDED_KIND = "tool_call_ended" as const;

export const RUNTIME_OPS_TO_TAPE_EVENT_TYPE = {
  [RUNTIME_OPS_REASONING_CHECKPOINT_RECORDED_KIND]: "reasoning.checkpoint",
  [RUNTIME_OPS_REASONING_REVERT_RECORDED_KIND]: "reasoning.revert",
  [RUNTIME_OPS_SESSION_COMPACTION_COMMITTED_KIND]: "session.compact",
  [RUNTIME_OPS_TOOL_RESULT_RECORDED_KIND]: "tool.result.recorded",
} as const;

export type RuntimeOpsEventKind =
  | typeof RUNTIME_OPS_REASONING_CHECKPOINT_RECORDED_KIND
  | typeof RUNTIME_OPS_REASONING_REVERT_RECORDED_KIND
  | typeof RUNTIME_OPS_SESSION_COMPACTION_COMMITTED_KIND
  | typeof RUNTIME_OPS_TOOL_INVOCATION_STARTED_KIND
  | typeof RUNTIME_OPS_TOOL_INVOCATION_FINISHED_KIND
  | typeof RUNTIME_OPS_TOOL_RESULT_RECORDED_KIND
  | typeof RUNTIME_OPS_TOOL_CALL_OBSERVED_KIND
  | typeof RUNTIME_OPS_TOOL_CALL_STARTED_KIND
  | typeof RUNTIME_OPS_TOOL_CALL_ENDED_KIND;

export type RuntimeOpsMappedTapeEventType =
  (typeof RUNTIME_OPS_TO_TAPE_EVENT_TYPE)[keyof typeof RUNTIME_OPS_TO_TAPE_EVENT_TYPE];

export function payloadOf(
  inputEvent: { readonly payload?: ProtocolRecord; readonly [key: string]: unknown },
  ..._rest: readonly unknown[]
): ProtocolRecord {
  return inputEvent.payload ?? {};
}

export function makeEvent(
  type: string,
  payload: ProtocolRecord = {},
  extra: ProtocolRecord = {},
): BrewvaEventRecord {
  const timestamp = Date.now();
  return Object.freeze({
    id: stringField(extra, "id", `${type}:${timestamp}`),
    sessionId:
      optionalStringField(extra, "sessionId") ??
      optionalStringField(payload, "sessionId") ??
      "default",
    type,
    payload,
    timestamp,
    isoTime: new Date(timestamp).toISOString(),
    ...extra,
  });
}
