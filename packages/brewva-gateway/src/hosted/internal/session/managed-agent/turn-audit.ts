import { sha256Hex } from "@brewva/brewva-std/hash";
import type { BrewvaPromptOptions } from "@brewva/brewva-substrate/session";
import {
  STEER_APPLIED_EVENT_TYPE,
  STEER_DROPPED_EVENT_TYPE,
  STEER_QUEUED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/wire";
import type { HostedRuntimeAdapterPort } from "../runtime-ports.js";

export function normalizePromptSource(
  source: BrewvaPromptOptions["source"] | undefined,
): string | undefined {
  if (typeof source !== "string") {
    return undefined;
  }
  const normalized = source.trim();
  return normalized.length > 0 ? normalized : undefined;
}

export function buildSteerAuditPayload(
  text: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    chars: text.length,
    hash: sha256Hex(text),
    ...extra,
  };
}

export function resolveChannelContext(source: string | undefined): { source: string } | "" {
  return source ? { source } : "";
}

export function recordSteeringAuditEvent(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
): void {
  if (!runtime) {
    return;
  }
  const event = {
    sessionId,
    payload,
  };
  if (type === STEER_QUEUED_EVENT_TYPE) {
    runtime.ops.tools.steering.queued(event);
  } else if (type === STEER_APPLIED_EVENT_TYPE) {
    runtime.ops.tools.steering.applied(event);
  } else if (type === STEER_DROPPED_EVENT_TYPE) {
    runtime.ops.tools.steering.dropped(event);
  }
}
