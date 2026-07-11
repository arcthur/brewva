import type { HostedRuntimeAdapterPort } from "@brewva/brewva-gateway/hosted";
import { isRecord } from "@brewva/brewva-std/unknown";
import { RUNTIME_OPS_SHADOW_DIVERGENCE_RECORDED_KIND } from "@brewva/brewva-vocabulary/events";
import { createCliInspectPort } from "../../runtime/cli-runtime-ports.js";

// RFC R4 Phase 1: the explicit-pull divergence report over the shadow-admission
// receipts Phase 0 drains to the tape. Read-only over evidence — it names where
// the shadow classifier would have allowed a call the real policy asked about
// (the promotion candidates) and, separately, any unsafe-allow divergence
// (shadow allow where real blocked), which is the numeric Phase 2 gate: a
// call-shape promotes only with zero unsafe-allow divergence over the window.

export interface ShadowAdmissionDivergenceGroup {
  readonly toolName: string;
  readonly interceptorId: string;
  readonly realKind: string;
  readonly shadowKind: string;
  readonly realReason: string | null;
  readonly shadowReason: string | null;
  readonly count: number;
  readonly lastTimestamp: number;
}

export interface ShadowAdmissionProjection {
  readonly sideEffectPolicy: "inspect_projection_only";
  readonly totalDivergences: number;
  /** Shadow would allow where real deferred to an ask — the promotion candidates. */
  readonly wouldAllowWhereRealAsked: number;
  /** Shadow would allow where real blocked — any non-zero count fails the gate. */
  readonly unsafeAllowDivergences: number;
  /**
   * Ring-buffer eviction gaps recorded by the drain. A window with gaps lost
   * evidence (possibly unsafe-allow entries) and must not pass a Phase 2 gate.
   */
  readonly evidenceGaps: number;
  readonly groups: readonly ShadowAdmissionDivergenceGroup[];
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readDecision(value: unknown): { kind: string; reason: string | null } | null {
  if (!isRecord(value)) return null;
  const record = value as { kind?: unknown; reason?: unknown };
  const kind = readString(record.kind);
  return kind ? { kind, reason: readString(record.reason) } : null;
}

export function buildShadowAdmissionProjection(
  runtime: HostedRuntimeAdapterPort,
  sessionId: string,
): ShadowAdmissionProjection {
  const inspect = createCliInspectPort(runtime);
  const events = inspect.events.query(sessionId, {
    type: RUNTIME_OPS_SHADOW_DIVERGENCE_RECORDED_KIND,
  });
  const groups = new Map<
    string,
    {
      toolName: string;
      interceptorId: string;
      realKind: string;
      shadowKind: string;
      realReason: string | null;
      shadowReason: string | null;
      count: number;
      lastTimestamp: number;
    }
  >();
  let total = 0;
  let evidenceGaps = 0;
  const seenReceipts = new Set<string>();
  for (const event of events) {
    const payload = event.payload as
      | {
          toolName?: unknown;
          toolCallId?: unknown;
          interceptorId?: unknown;
          real?: unknown;
          shadow?: unknown;
          evidenceGap?: unknown;
        }
      | undefined;
    if (payload?.evidenceGap === true) {
      evidenceGaps += 1;
      continue;
    }
    const toolName = readString(payload?.toolName);
    const interceptorId = readString(payload?.interceptorId);
    const real = readDecision(payload?.real);
    const shadow = readDecision(payload?.shadow);
    if (!toolName || !interceptorId || !real || !shadow) continue;
    // Mid-drain retries can duplicate a receipt; the (interceptor, call) pair
    // identifies the underlying admission decision exactly once.
    const toolCallId = readString(payload?.toolCallId);
    if (toolCallId) {
      const receiptKey = JSON.stringify([interceptorId, toolCallId]);
      if (seenReceipts.has(receiptKey)) continue;
      seenReceipts.add(receiptKey);
    }
    total += 1;
    const key = JSON.stringify([interceptorId, toolName, real.kind, shadow.kind]);
    const timestamp = typeof event.timestamp === "number" ? event.timestamp : 0;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      if (timestamp >= existing.lastTimestamp) {
        existing.lastTimestamp = timestamp;
        existing.realReason = real.reason ?? existing.realReason;
        existing.shadowReason = shadow.reason ?? existing.shadowReason;
      }
    } else {
      groups.set(key, {
        toolName,
        interceptorId,
        realKind: real.kind,
        shadowKind: shadow.kind,
        realReason: real.reason,
        shadowReason: shadow.reason,
        count: 1,
        lastTimestamp: timestamp,
      });
    }
  }
  const ordered = [...groups.values()].toSorted(
    (left, right) =>
      right.count - left.count ||
      right.lastTimestamp - left.lastTimestamp ||
      left.toolName.localeCompare(right.toolName),
  );
  return {
    sideEffectPolicy: "inspect_projection_only",
    totalDivergences: total,
    evidenceGaps,
    wouldAllowWhereRealAsked: ordered
      .filter((group) => group.shadowKind === "allow" && group.realKind === "defer")
      .reduce((sum, group) => sum + group.count, 0),
    unsafeAllowDivergences: ordered
      .filter((group) => group.shadowKind === "allow" && group.realKind === "block")
      .reduce((sum, group) => sum + group.count, 0),
    groups: ordered,
  };
}
