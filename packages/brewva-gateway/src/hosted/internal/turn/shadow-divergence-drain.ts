import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import { recordFourPortRuntimeOpsEvent } from "@brewva/brewva-tools/runtime-port";
import { RUNTIME_OPS_SHADOW_DIVERGENCE_RECORDED_KIND } from "@brewva/brewva-vocabulary/events";

// RFC R4 Phase 0, durability half: the kernel's shadow-authority evidence lives
// in an in-memory ring buffer that dies with the process, but Phase 1's
// explicit-pull inspect view runs in a separate process over the tape. After
// each turn the gateway drains NEW divergent entries (shadow decided
// differently than real) into bounded `kernel.shadow.divergence.recorded`
// runtime-ops receipts. Evidence only — the real decision already happened and
// is never altered; agreements are not persisted (the buffer keeps them for
// live debugging, the tape records only what the promotion gate needs).
//
// Honesty guarantees the promotion gate depends on:
//  - the per-session watermark advances entry by entry, so a mid-drain commit
//    failure re-attempts the remaining entries instead of skipping them;
//  - ring-buffer evictions observed since the previous drain produce an
//    `evidenceGap` receipt — a window that lost entries (possibly unsafe-allow
//    ones) must be visibly gapped, never silently clean.

interface DrainState {
  readonly drainedSequenceBySession: Map<string, number>;
  /**
   * Per-session view of the kernel's GLOBAL eviction counter. Evicted entries
   * are unattributable, so after any eviction every session's next drain must
   * record a gap receipt — conservative over-marking is the honest choice; a
   * single shared watermark would let all but the first-draining session claim
   * a clean Phase 2 window.
   */
  readonly lastEvictedCountBySession: Map<string, number>;
}

const drainStateByRuntime = new WeakMap<object, DrainState>();

export function drainShadowDivergenceEvidence(runtime: BrewvaRuntime, sessionId: string): number {
  try {
    return drainNewDivergences(runtime, sessionId);
  } catch {
    // Evidence must never break a turn; the kernel ring buffer still holds the
    // entries for live reads and the next drain retries from the watermark.
    return 0;
  }
}

function drainNewDivergences(runtime: BrewvaRuntime, sessionId: string): number {
  const intercept = runtime.kernel?.intercept;
  if (!intercept) {
    return 0;
  }
  let state = drainStateByRuntime.get(runtime);
  if (!state) {
    state = {
      drainedSequenceBySession: new Map<string, number>(),
      lastEvictedCountBySession: new Map<string, number>(),
    };
    drainStateByRuntime.set(runtime, state);
  }

  const evictedCount = intercept.evidence.evictedCount();
  const lastEvicted = state.lastEvictedCountBySession.get(sessionId) ?? 0;
  if (evictedCount > lastEvicted) {
    recordFourPortRuntimeOpsEvent(
      { runtime },
      {
        sessionId,
        kind: RUNTIME_OPS_SHADOW_DIVERGENCE_RECORDED_KIND,
        payload: {
          evidenceGap: true,
          evictedCount,
          evictedSinceLastDrain: evictedCount - lastEvicted,
        },
      },
    );
    state.lastEvictedCountBySession.set(sessionId, evictedCount);
  }

  const lastDrained = state.drainedSequenceBySession.get(sessionId) ?? -1;
  let drained = 0;
  for (const entry of intercept.evidence.list({ sessionId })) {
    if (entry.sequence <= lastDrained) {
      continue;
    }
    if (!entry.error && entry.shadow && entry.shadow.kind !== entry.real.kind) {
      recordFourPortRuntimeOpsEvent(
        { runtime },
        {
          sessionId,
          kind: RUNTIME_OPS_SHADOW_DIVERGENCE_RECORDED_KIND,
          timestamp: entry.timestamp,
          payload: {
            interceptorId: entry.interceptorId,
            toolCallId: entry.toolCallId,
            toolName: entry.toolName,
            ...(entry.turnId ? { turnId: entry.turnId } : {}),
            real: {
              kind: entry.real.kind,
              ...(entry.real.reason ? { reason: entry.real.reason } : {}),
            },
            shadow: {
              kind: entry.shadow.kind,
              ...(entry.shadow.reason ? { reason: entry.shadow.reason } : {}),
            },
          },
        },
      );
      drained += 1;
    }
    // Advance only after the entry is handled so a mid-drain commit failure
    // retries from the failed entry on the next drain (duplicates are deduped
    // by (interceptorId, toolCallId) at projection time).
    state.drainedSequenceBySession.set(sessionId, entry.sequence);
  }
  return drained;
}
