import { Type } from "@sinclair/typebox";
import type { BrewvaBundledToolRuntime } from "../../../contracts/index.js";
import { buildStringEnumSchema } from "../../../registry/string-enum-contract.js";
import { MAX_POLL_WAIT_MS } from "../exec-process-registry/api.js";

export const PROCESS_ACTION_VALUES = [
  "list",
  "poll",
  "log",
  "write",
  "kill",
  "clear",
  "remove",
] as const;
export type ProcessAction = (typeof PROCESS_ACTION_VALUES)[number];

export const ProcessActionSchema = buildStringEnumSchema(PROCESS_ACTION_VALUES, {
  guidance:
    "Use list to inspect sessions, poll for incremental output, log for stored logs, write for stdin, kill to stop a running session, clear to prune completed sessions, and remove to delete a stored session record.",
});

export const ProcessSchema = Type.Object({
  action: ProcessActionSchema,
  sessionId: Type.Optional(Type.String()),
  boxId: Type.Optional(Type.String()),
  executionId: Type.Optional(Type.String()),
  data: Type.Optional(Type.String()),
  eof: Type.Optional(Type.Boolean()),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  limit: Type.Optional(Type.Integer({ minimum: 0 })),
  timeout: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_POLL_WAIT_MS })),
});

export interface ProcessToolOptions {
  runtime?: BrewvaBundledToolRuntime;
}

export function pickSessionId(params: { sessionId?: unknown }): string | undefined {
  const candidate = params.sessionId;
  if (typeof candidate !== "string") return undefined;
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function pickBoxExecutionIdentity(params: {
  boxId?: unknown;
  executionId?: unknown;
}): { boxId: string; executionId: string } | undefined {
  if (typeof params.boxId !== "string" || typeof params.executionId !== "string") return undefined;
  const boxId = params.boxId.trim();
  const executionId = params.executionId.trim();
  if (!boxId || !executionId) return undefined;
  return { boxId, executionId };
}

export function resolvePollTimeoutMs(params: { timeout?: unknown }): number {
  const raw = params.timeout;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(MAX_POLL_WAIT_MS, Math.trunc(raw)));
}
