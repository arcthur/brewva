import {
  deriveParallelBudgetStateFromEvents,
  isWaitableParallelSlotRejection,
  SUBAGENT_SLOT_ACQUIRED_EVENT_TYPE,
  SUBAGENT_SLOT_REJECTED_EVENT_TYPE,
  SUBAGENT_SLOT_RELEASED_EVENT_TYPE,
  SUBAGENT_SLOT_WAITING_EVENT_TYPE,
  SUBAGENT_SPAWNED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/delegation";
import type {
  ParallelSlotAcquireOptions,
  ParallelSlotDecision,
  ParallelSlotEventPayload,
  ParallelSlotKind,
  ParallelSlotPort,
  ParallelSlotRejectionReason,
} from "@brewva/brewva-vocabulary/delegation";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import type { ResourceLeaseRecord } from "@brewva/brewva-vocabulary/iteration";

const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
// Backstop re-evaluation cadence for a waiting acquirer, to catch cross-process
// (detached) slot frees that do not emit a local release signal.
const WAIT_POLL_INTERVAL_MS = 1_000;

/**
 * Narrow, injectable dependencies. The admission decision is a pure function of
 * durable tape state plus config plus active leases; the only process-local
 * state is the reservation/transient/waiter bookkeeping that bridges the gap
 * between an accepted acquire and the durable `subagent_spawned` event, which is
 * performance-only and safe to lose across restart.
 */
export interface ParallelAdmissionDeps {
  parallelConfig(): { enabled: boolean; maxConcurrent: number; maxTotalPerSession: number };
  queryEvents(sessionId: string): readonly BrewvaEventRecord[];
  activeLeases(sessionId: string): readonly ResourceLeaseRecord[];
  emit(sessionId: string, type: string, payload: ParallelSlotEventPayload): void;
  now(): number;
}

interface AdmissionEvaluation {
  readonly accepted: boolean;
  readonly reason?: ParallelSlotRejectionReason;
  readonly ceiling: number;
  readonly activeCount: number;
  readonly totalStarted: number;
  readonly leaseRaisedCeiling: boolean;
}

function ensure<K, V>(map: Map<K, V>, key: K, factory: () => V): V {
  const existing = map.get(key);
  if (existing) {
    return existing;
  }
  const created = factory();
  map.set(key, created);
  return created;
}

function leaseRaisesCeiling(lease: ResourceLeaseRecord, now: number): boolean {
  if (lease.status !== "active") {
    return false;
  }
  if (typeof lease.expiresAt === "string" && lease.expiresAt.length > 0) {
    // Wall-clock bound: honor the lease until it elapses.
    const expiry = Date.parse(lease.expiresAt);
    return !(Number.isFinite(expiry) && expiry <= now);
  }
  // No wall-clock bound. A turn-bounded lease (`expiresAfterTurn`) declares an
  // expiry the admission gate cannot enforce — turn expiry is not wired into
  // lease status anywhere — so honoring it would inflate the ceiling forever.
  // Only a lease with no declared expiry at all is treated as an indefinite
  // active lease (the operator can still cancel it). A turn-bounded lease must
  // use a wall-clock TTL (`ttlMs`) to raise the parallel ceiling.
  if (lease.expiresAfterTurn != null) {
    return false;
  }
  return true;
}

export function createParallelAdmissionController(deps: ParallelAdmissionDeps): ParallelSlotPort {
  // runId sets that have acquired but not yet released, per session. `reserved`
  // is for delegation slots (durable membership is the tape; this only bridges
  // acquire -> spawn-event), `transient` is for best-effort in-process slots.
  const reserved = new Map<string, Set<string>>();
  const transient = new Map<string, Set<string>>();
  const waiters = new Map<string, Set<() => void>>();

  const resolveCeiling = (
    sessionId: string,
    baseCeiling: number,
  ): { ceiling: number; leaseRaised: boolean } => {
    const now = deps.now();
    let ceiling = baseCeiling;
    for (const lease of deps.activeLeases(sessionId)) {
      if (!leaseRaisesCeiling(lease, now)) {
        continue;
      }
      const leaseMax = lease.budget.maxParallel;
      if (typeof leaseMax === "number" && Number.isFinite(leaseMax) && leaseMax > ceiling) {
        ceiling = Math.trunc(leaseMax);
      }
    }
    return { ceiling, leaseRaised: ceiling > baseCeiling };
  };

  const measure = (sessionId: string) => {
    const events = deps.queryEvents(sessionId);
    const tape = deriveParallelBudgetStateFromEvents(events);
    // A reserved runId only bridges the window before its `subagent_spawned`
    // event lands on the tape. Once the tape has seen the spawn (whether the run
    // is still active or already terminal), the tape is authoritative and the
    // reservation contributes nothing. This is what makes the count self-heal
    // even when a release is never delivered (e.g. a detached run that completes
    // in its own process), so a finished run can never leak a slot.
    const spawnedRunIds = new Set<string>();
    for (const event of events) {
      if (event.type !== SUBAGENT_SPAWNED_EVENT_TYPE) {
        continue;
      }
      const runId = event.payload?.runId;
      if (typeof runId === "string") {
        spawnedRunIds.add(runId);
      }
    }
    const delegationActive = new Set(tape.activeRunIds);
    let preSpawnReserved = 0;
    const reservedRuns = reserved.get(sessionId);
    if (reservedRuns) {
      const settled: string[] = [];
      for (const runId of reservedRuns) {
        if (spawnedRunIds.has(runId)) {
          // The tape has seen the spawn and is authoritative. If the run is also
          // terminal, the reservation is dead weight — prune it so a detached run
          // whose release is never delivered cannot accumulate forever.
          if (!tape.activeRunIds.includes(runId)) {
            settled.push(runId);
          }
          continue;
        }
        delegationActive.add(runId);
        preSpawnReserved += 1;
      }
      for (const runId of settled) {
        reservedRuns.delete(runId);
      }
      if (reservedRuns.size === 0) {
        reserved.delete(sessionId);
      }
    }
    const transientHeld = transient.get(sessionId)?.size ?? 0;
    return {
      activeCount: delegationActive.size + transientHeld,
      lifetimeUsed: tape.totalStarted + preSpawnReserved,
      totalStarted: tape.totalStarted,
    };
  };

  const evaluate = (sessionId: string, kind: ParallelSlotKind): AdmissionEvaluation => {
    const config = deps.parallelConfig();
    const { ceiling, leaseRaised } = resolveCeiling(sessionId, config.maxConcurrent);
    const { activeCount, lifetimeUsed, totalStarted } = measure(sessionId);

    if (!config.enabled) {
      return {
        accepted: true,
        ceiling,
        activeCount,
        totalStarted,
        leaseRaisedCeiling: leaseRaised,
      };
    }
    if (kind === "delegation" && lifetimeUsed >= config.maxTotalPerSession) {
      return {
        accepted: false,
        reason: "session_total_exhausted",
        ceiling,
        activeCount,
        totalStarted,
        leaseRaisedCeiling: leaseRaised,
      };
    }
    if (activeCount >= ceiling) {
      return {
        accepted: false,
        reason: "max_concurrent_reached",
        ceiling,
        activeCount,
        totalStarted,
        leaseRaisedCeiling: leaseRaised,
      };
    }
    return { accepted: true, ceiling, activeCount, totalStarted, leaseRaisedCeiling: leaseRaised };
  };

  const emitReceipt = (
    sessionId: string,
    type: string,
    runId: string,
    kind: ParallelSlotKind,
    ev: AdmissionEvaluation,
    extra: { reason?: ParallelSlotRejectionReason; waited?: boolean } = {},
  ): void => {
    const config = deps.parallelConfig();
    deps.emit(sessionId, type, {
      runId,
      kind,
      activeCount: ev.activeCount,
      ceiling: ev.ceiling,
      totalStarted: ev.totalStarted,
      maxTotalPerSession: config.maxTotalPerSession,
      leaseRaisedCeiling: ev.leaseRaisedCeiling,
      ...(extra.reason ? { reason: extra.reason } : {}),
      ...(extra.waited ? { waited: extra.waited } : {}),
    });
  };

  const commit = (
    sessionId: string,
    runId: string,
    kind: ParallelSlotKind,
    ev: AdmissionEvaluation,
    waited: boolean,
  ): void => {
    const pool = kind === "delegation" ? reserved : transient;
    ensure(pool, sessionId, () => new Set<string>()).add(runId);
    emitReceipt(
      sessionId,
      SUBAGENT_SLOT_ACQUIRED_EVENT_TYPE,
      runId,
      kind,
      ev,
      waited ? { waited: true } : {},
    );
  };

  const signalWaiters = (sessionId: string): void => {
    const sessionWaiters = waiters.get(sessionId);
    if (!sessionWaiters || sessionWaiters.size === 0) {
      return;
    }
    // Copy before iterating: a woken waiter may acquire and deregister itself.
    for (const wake of Array.from(sessionWaiters)) {
      wake();
    }
  };

  const acquire = (
    sessionId: string,
    runId: string,
    options?: ParallelSlotAcquireOptions,
  ): ParallelSlotDecision => {
    const kind = options?.kind ?? "transient";
    const ev = evaluate(sessionId, kind);
    if (ev.accepted) {
      commit(sessionId, runId, kind, ev, false);
      return { accepted: true };
    }
    emitReceipt(sessionId, SUBAGENT_SLOT_REJECTED_EVENT_TYPE, runId, kind, ev, {
      reason: ev.reason,
    });
    return { accepted: false, reason: ev.reason ?? "max_concurrent_reached" };
  };

  const waitForSlot = (
    sessionId: string,
    runId: string,
    kind: ParallelSlotKind,
    timeoutMs: number,
  ): Promise<ParallelSlotDecision> =>
    new Promise<ParallelSlotDecision>((resolve) => {
      let settled = false;
      const sessionWaiters = ensure(waiters, sessionId, () => new Set<() => void>());

      const finish = (decision: ParallelSlotDecision): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        clearInterval(poll);
        sessionWaiters.delete(wake);
        if (sessionWaiters.size === 0) {
          waiters.delete(sessionId);
        }
        resolve(decision);
      };

      const attempt = (): void => {
        if (settled) {
          return;
        }
        const ev = evaluate(sessionId, kind);
        if (ev.accepted) {
          commit(sessionId, runId, kind, ev, true);
          finish({ accepted: true, waited: true });
          return;
        }
        if (ev.reason && !isWaitableParallelSlotRejection(ev.reason)) {
          emitReceipt(sessionId, SUBAGENT_SLOT_REJECTED_EVENT_TYPE, runId, kind, ev, {
            reason: ev.reason,
            waited: true,
          });
          finish({ accepted: false, reason: ev.reason, waited: true });
        }
      };

      const wake = (): void => attempt();

      const timer = setTimeout(
        () => {
          if (settled) {
            return;
          }
          const ev = evaluate(sessionId, kind);
          emitReceipt(sessionId, SUBAGENT_SLOT_REJECTED_EVENT_TYPE, runId, kind, ev, {
            reason: "wait_timeout",
            waited: true,
          });
          finish({ accepted: false, reason: "wait_timeout", waited: true });
        },
        Math.max(0, timeoutMs),
      );
      timer.unref?.();

      // The release signal only fires for in-process slot frees. A detached run
      // completing in its own process frees a slot on the durable tape without
      // calling release here, so poll periodically to re-evaluate tape-derived
      // state and pick up cross-process frees within a bounded latency.
      const poll = setInterval(attempt, Math.min(WAIT_POLL_INTERVAL_MS, Math.max(1, timeoutMs)));
      poll.unref?.();

      sessionWaiters.add(wake);
      // A slot may have freed between the caller's evaluate and registration.
      attempt();
    });

  const acquireAsync = async (
    sessionId: string,
    runId: string,
    options?: ParallelSlotAcquireOptions,
  ): Promise<ParallelSlotDecision> => {
    const kind = options?.kind ?? "transient";
    const ev = evaluate(sessionId, kind);
    if (ev.accepted) {
      commit(sessionId, runId, kind, ev, false);
      return { accepted: true };
    }
    if (ev.reason && !isWaitableParallelSlotRejection(ev.reason)) {
      emitReceipt(sessionId, SUBAGENT_SLOT_REJECTED_EVENT_TYPE, runId, kind, ev, {
        reason: ev.reason,
      });
      return { accepted: false, reason: ev.reason };
    }
    emitReceipt(sessionId, SUBAGENT_SLOT_WAITING_EVENT_TYPE, runId, kind, ev, {
      reason: ev.reason,
    });
    const timeoutMs =
      typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
        ? Math.max(0, Math.trunc(options.timeoutMs))
        : DEFAULT_WAIT_TIMEOUT_MS;
    return waitForSlot(sessionId, runId, kind, timeoutMs);
  };

  const release = (sessionId: string, runId: string): void => {
    const transientRuns = transient.get(sessionId);
    const reservedRuns = reserved.get(sessionId);
    let kind: ParallelSlotKind | undefined;
    if (transientRuns?.delete(runId)) {
      kind = "transient";
      if (transientRuns.size === 0) {
        transient.delete(sessionId);
      }
    } else if (reservedRuns?.delete(runId)) {
      kind = "delegation";
      if (reservedRuns.size === 0) {
        reserved.delete(sessionId);
      }
    }
    if (!kind) {
      // Idempotent: already released, or a rejected acquire that never held a
      // slot (e.g. terminal-failure cleanup). No receipt, no signal.
      return;
    }
    const ev = evaluate(sessionId, kind);
    emitReceipt(sessionId, SUBAGENT_SLOT_RELEASED_EVENT_TYPE, runId, kind, ev);
    signalWaiters(sessionId);
  };

  return { acquire, acquireAsync, release };
}
