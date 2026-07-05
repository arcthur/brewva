import { TOOL_COMMITTED_EVENT_TYPE } from "@brewva/brewva-vocabulary/tool-invocations";

/**
 * Build a `tool.committed` event in the exact shape the hosted managed-session
 * path emits (`payload.call.{toolName,args,toolCallId}` + `payload.result.
 * outcome.kind`). THE test-side definition of "a tool ran," matching what the
 * attention/feedback projections read in production.
 *
 * Fixtures used to feed the runtime-ops `tool.invocation.started` annotation,
 * which the hosted path never emits — so the projections shipped green on
 * synthetic events and ran dead on every real tape. Tests build commitment
 * events through this one helper so the shape can never drift from production.
 */
export interface CommittedToolEvent {
  readonly type: string;
  readonly timestamp: number;
  readonly payload: Record<string, unknown>;
}

export function committedToolEvent(input: {
  readonly toolName: string;
  readonly args?: Record<string, unknown>;
  readonly timestamp?: number;
  readonly outcome?: "ok" | "err" | "inconclusive";
  readonly toolCallId?: string;
  readonly sessionId?: string;
}): CommittedToolEvent {
  return {
    type: TOOL_COMMITTED_EVENT_TYPE,
    timestamp: input.timestamp ?? 0,
    payload: {
      call: {
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        toolCallId: input.toolCallId ?? `call-${input.toolName}-${input.timestamp ?? 0}`,
        toolName: input.toolName,
        args: input.args ?? {},
      },
      result: { outcome: { kind: input.outcome ?? "ok" } },
    },
  };
}

interface SeamRecord {
  readonly type: string;
  readonly timestamp?: number;
  readonly payload?: unknown;
}

const seededByRuntime = new WeakMap<object, SeamRecord[]>();

/**
 * Seed committed tool runs onto a LIVE runtime instance's tape.
 *
 * The hosted runtime exposes no raw event-append, and `tool.committed` is a
 * kernel commitment (not a runtime-ops method), so a unit test cannot emit one
 * through the ops surface the way it emits `tool.invocation.started`. This
 * installs — once per runtime — a delegating wrapper over `ops.events.records`
 * that MERGES seeded commitments into `query()`/`list()` results; every other
 * read passes through to the real store, so receipts/findings the tool emits
 * stay authoritative. `createCliInspectPort` and the bundled tool runtime both
 * read `ops.events.records` dynamically, so a wrapper installed before the
 * projection runs is seen by it.
 *
 * FIDELITY LIMITS — this is a narrow test double, NOT a faithful port:
 *   - It filters ONLY by `query.type`; it does NOT honor the real port's
 *     `after`/`before`/`last`/`offset`/`limit` windows. A test that drives a
 *     WINDOWED query (e.g. `{ type, last: 60 }`) through the seam would
 *     over-inject seeded events past the window — do not seed for such a path.
 *   - It timestamp-SORTS the merged result, whereas the real tape port returns
 *     insertion/tape order. Callers must therefore stamp seeded events with
 *     timestamps strictly AFTER every real event and strictly monotonic (as
 *     `seedCommittedWrite` does) so the sorted order equals real tape order;
 *     a same-timestamp seed would order nondeterministically vs a real event.
 */
export function seedCommittedToolEvents(
  runtime: { ops: { events: { records: Record<string, unknown> } } },
  events: readonly SeamRecord[],
): void {
  const port = runtime.ops.events;
  const existing = seededByRuntime.get(runtime);
  if (existing) {
    existing.push(...events);
    return;
  }
  const store: SeamRecord[] = [...events];
  seededByRuntime.set(runtime, store);
  const real = port.records as Record<string, unknown> & {
    query: (sessionId: string, query?: unknown) => SeamRecord[];
    list: (sessionId: string, query?: unknown) => SeamRecord[];
  };
  const requestedType = (query: unknown): string | undefined =>
    query && typeof query === "object" ? (query as { type?: string }).type : undefined;
  const merge = (base: SeamRecord[], query: unknown): SeamRecord[] => {
    const type = requestedType(query);
    const matching = type ? store.filter((event) => event.type === type) : store;
    return [...base, ...matching].toSorted(
      (left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0),
    );
  };
  const wrap =
    (method: "query" | "list") =>
    (sessionId: string, query?: unknown): SeamRecord[] =>
      merge((real[method] as (s: string, q?: unknown) => SeamRecord[])(sessionId, query), query);
  port.records = { ...real, query: wrap("query"), list: wrap("list") };
}
