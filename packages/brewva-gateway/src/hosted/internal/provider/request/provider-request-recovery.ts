import { asLossy } from "@brewva/brewva-std/honesty";
import { isRecord } from "@brewva/brewva-std/unknown";
import type { InternalHostPluginApi } from "@brewva/brewva-substrate/host-api";
import { MESSAGE_END_EVENT_TYPE } from "@brewva/brewva-vocabulary/session";
import {
  getRuntimeContextUsage,
  queryStructuredRuntimeEvents,
  type HostedRuntimeAdapterPort,
} from "../../session/runtime-ports.js";

const OUTPUT_BUDGET_ESCALATION_FACTOR = 2;

const OUTPUT_BUDGET_PATHS = [
  ["max_tokens"],
  ["max_output_tokens"],
  ["max_completion_tokens"],
  ["maxOutputTokens"],
  ["maxCompletionTokens"],
  ["generationConfig", "maxOutputTokens"],
  ["generationConfig", "max_output_tokens"],
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readPositiveNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function getNestedNumber(payload: Record<string, unknown>, path: readonly string[]): number | null {
  let current: unknown = payload;
  for (const segment of path) {
    const record = asRecord(current);
    if (!record) {
      return null;
    }
    current = record[segment];
  }
  return readPositiveNumber(current);
}

function setNestedNumber(
  payload: Record<string, unknown>,
  path: readonly string[],
  value: number,
): boolean {
  let current: Record<string, unknown> | null = payload;
  const leafKey = path[path.length - 1];
  if (!leafKey) {
    return false;
  }
  for (let index = 0; index < path.length - 1; index += 1) {
    if (!current) {
      return false;
    }
    const segment = path[index];
    if (!segment) {
      return false;
    }
    const next = asRecord(current[segment]);
    if (!next) {
      return false;
    }
    current = next;
  }
  if (!current) {
    return false;
  }
  current[leafKey] = value;
  return true;
}

export function applyOutputBudgetEscalationToPayload(
  payload: unknown,
  targetMaxTokens: number,
): {
  payload: unknown;
  status: "completed" | "skipped";
  detail: string | null;
} {
  const record = asRecord(payload);
  if (!record) {
    return {
      payload,
      status: "skipped",
      detail: "provider payload is not an object",
    };
  }

  const cloned = structuredClone(record);
  let seenSupportedField = false;
  let patched = false;

  for (const path of OUTPUT_BUDGET_PATHS) {
    const current = getNestedNumber(cloned, path);
    if (current === null) {
      continue;
    }
    seenSupportedField = true;
    if (current < targetMaxTokens) {
      patched = setNestedNumber(cloned, path, targetMaxTokens) || patched;
    }
  }

  if (patched) {
    return {
      payload: cloned,
      status: "completed",
      detail: null,
    };
  }

  return {
    payload,
    status: "skipped",
    detail: seenSupportedField
      ? "provider payload already uses the maximum configured output budget"
      : "provider payload does not expose a supported output-budget field",
  };
}

export function readCurrentOutputBudget(payload: unknown): number | null {
  const record = asRecord(payload);
  if (!record) {
    return null;
  }
  let current: number | null = null;
  for (const path of OUTPUT_BUDGET_PATHS) {
    const value = getNestedNumber(record, path);
    if (value !== null && (current === null || value > current)) {
      current = value;
    }
  }
  return current;
}

interface LatestAssistantStop {
  readonly stopReason: string | null;
  readonly eventKey: string;
}

function latestAssistantStop(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
): LatestAssistantStop | null {
  const events = queryStructuredRuntimeEvents(runtime, sessionId, {
    type: MESSAGE_END_EVENT_TYPE,
    last: 8,
  });
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const payload = asRecord(event?.payload);
    if (!event || !payload || payload.role !== "assistant") {
      continue;
    }
    return {
      stopReason: typeof payload.stopReason === "string" ? payload.stopReason : null,
      eventKey: typeof event.id === "string" && event.id ? event.id : `ts:${event.timestamp}`,
    };
  }
  return null;
}

export function resolveOutputBudgetEscalationTarget(input: {
  readonly currentBudget: number | null;
  readonly maxOutputTokens: number | null;
}): number | null {
  const current = readPositiveNumber(input.currentBudget);
  const ceiling = readPositiveNumber(input.maxOutputTokens);
  if (current === null || ceiling === null || current >= ceiling) {
    return null;
  }
  return Math.min(current * OUTPUT_BUDGET_ESCALATION_FACTOR, ceiling);
}

const escalatedPayloads = new WeakSet<object>();
const consumedLengthStopBySession = new Map<string, string>();

/**
 * True when the payload was produced by a one-shot output-budget escalation.
 * Such requests carry a full-fidelity retry contract: transient outbound
 * reduction must skip them.
 */
export function isOutputBudgetEscalatedPayload(payload: unknown): boolean {
  const key = asRecord(payload);
  return key !== null && escalatedPayloads.has(key);
}

export function registerProviderRequestRecovery(
  extensionApi: InternalHostPluginApi,
  runtime: HostedRuntimeAdapterPort,
): void {
  extensionApi.on("before_provider_request", (event, ctx) => {
    const sessionId = ctx.sessionManager.getSessionId().trim();
    if (!sessionId) {
      return undefined;
    }
    const stop = latestAssistantStop(runtime, sessionId);
    if (!stop || stop.stopReason !== "length") {
      return undefined;
    }
    if (consumedLengthStopBySession.get(sessionId) === stop.eventKey) {
      return undefined;
    }
    const usage = getRuntimeContextUsage(runtime, sessionId);
    const target = resolveOutputBudgetEscalationTarget({
      currentBudget: readCurrentOutputBudget(event.payload),
      maxOutputTokens: usage?.maxOutputTokens ?? null,
    });
    if (target === null) {
      return undefined;
    }
    consumedLengthStopBySession.set(sessionId, stop.eventKey);
    const result = applyOutputBudgetEscalationToPayload(event.payload, Math.trunc(target));
    runtime.ops.context.evidence.append(
      sessionId,
      asLossy({
        kind: "output_budget_escalation",
        timestamp: Date.now(),
        payload: {
          status: result.status,
          targetMaxTokens: Math.trunc(target),
          triggerEventKey: stop.eventKey,
          detail: result.detail,
        },
      }),
    );
    if (result.status !== "completed") {
      return undefined;
    }
    const escalated = asRecord(result.payload);
    if (escalated) {
      escalatedPayloads.add(escalated);
    }
    return result.payload;
  });
}

export const PROVIDER_REQUEST_RECOVERY_TEST_ONLY = {
  applyOutputBudgetEscalationToPayload,
  isOutputBudgetEscalatedPayload,
  readCurrentOutputBudget,
  resolveOutputBudgetEscalationTarget,
};
