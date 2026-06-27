import { describe, expect, test } from "bun:test";
import { RecallBroker } from "@brewva/brewva-recall/broker";
import type { RecallBrokerRuntime } from "@brewva/brewva-recall/broker";
import type { SessionIndex, SessionIndexDigest } from "@brewva/brewva-session-index";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import { RECALL_CURATION_RECORDED_EVENT_TYPE } from "@brewva/brewva-vocabulary/iteration";
import { sleep } from "../../helpers/process.js";

// Phase 1 of rfc-recall-next-turn-cache-warming: RecallBroker.warm() + the
// single-flight guard. Phase 2: broker self-warm on the turn.ended ops event.
// These tests pin the RFC validation signals (one build, single-flight sharing,
// byte-identical output, no provider/network on the warm path), the never-stale
// invariant from Decision B (an invalidation mid-build re-warms instead of caching
// stale state), and the Phase 2 trigger (turn.ended warms, nothing else does,
// dirty-gated no-op). They inject a counting fake read model through the broker's
// testability seam so a "build" is observable as one listSessionDigests round trip.

const WORKSPACE_ROOT = "/fake/workspace";

interface FakeIndexHandle {
  readonly index: SessionIndex;
  /** How many broker-state builds entered the read model (one per sync build). */
  listCount(): number;
  /** Index methods touched, in call order — proves the warm path stays local. */
  readonly methodLog: string[];
  /** Releases a gated first build so concurrent callers can be observed parked. */
  releaseGate(): void;
}

function createFakeIndex(
  options: { digests?: SessionIndexDigest[]; gateFirstBuild?: boolean } = {},
): FakeIndexHandle {
  const digests = options.digests ?? [];
  const methodLog: string[] = [];
  let listSessionDigestsCalls = 0;
  let releaseGate = (): void => {};
  let gate: Promise<void> | undefined;
  if (options.gateFirstBuild) {
    gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
  }
  const cloneDigests = (): SessionIndexDigest[] => structuredClone(digests);
  // Only the three methods a sync()/search() touches are implemented; any other
  // surface (a provider call would not even live here) is intentionally absent.
  const index = {
    dbPath: ":fake-session-index:",
    async listSessionDigests(): Promise<SessionIndexDigest[]> {
      listSessionDigestsCalls += 1;
      methodLog.push("listSessionDigests");
      if (gate) {
        const pending = gate;
        gate = undefined; // gate only the first build
        await pending;
      }
      return cloneDigests();
    },
    async querySessionDigests(): Promise<SessionIndexDigest[]> {
      methodLog.push("querySessionDigests");
      return cloneDigests();
    },
    async queryTapeEvidence(): Promise<[]> {
      methodLog.push("queryTapeEvidence");
      return [];
    },
  } as unknown as SessionIndex;
  return {
    index,
    listCount: () => listSessionDigestsCalls,
    methodLog,
    releaseGate: () => releaseGate(),
  };
}

interface FakeRuntimeHandle {
  readonly runtime: RecallBrokerRuntime;
  /** Records an event and notifies broker subscribers (an invalidation source). */
  readonly emit: (event: BrewvaEventRecord) => void;
}

function createFakeRuntime(seed: readonly BrewvaEventRecord[] = []): FakeRuntimeHandle {
  const bySession = new Map<string, BrewvaEventRecord[]>();
  const listeners = new Set<(event: BrewvaEventRecord) => void>();
  const append = (event: BrewvaEventRecord): void => {
    const list = bySession.get(event.sessionId) ?? [];
    list.push(event);
    bySession.set(event.sessionId, list);
  };
  for (const event of seed) {
    append(event);
  }
  const runtime: RecallBrokerRuntime = {
    identity: { workspaceRoot: WORKSPACE_ROOT, agentId: "agent-test" },
    events: {
      records: {
        listSessionIds: () => [...bySession.keys()],
        list: (sessionId) => bySession.get(sessionId) ?? [],
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
    task: { target: { getDescriptor: () => ({}) } },
    skills: { catalog: undefined },
  };
  return {
    runtime,
    emit: (event) => {
      append(event);
      for (const listener of listeners) {
        listener(event);
      }
    },
  };
}

function makeDigest(sessionId: string): SessionIndexDigest {
  return {
    sessionId,
    eventCount: 1,
    lastEventAt: 1_700_000_000_000,
    repositoryRoot: WORKSPACE_ROOT,
    primaryRoot: WORKSPACE_ROOT,
    targetRoots: [WORKSPACE_ROOT],
    digestText: `digest text for ${sessionId}`,
    tokenScore: 1,
  };
}

function makeCurationEvent(sessionId: string, stableId: string, signal: string): BrewvaEventRecord {
  return {
    id: `${sessionId}-curation-${stableId}`,
    sessionId,
    turn: 0,
    type: RECALL_CURATION_RECORDED_EVENT_TYPE,
    timestamp: 1_700_000_000_000,
    payload: { signal, stableIds: [stableId] },
  };
}

function makeTurnEndedEvent(sessionId: string): BrewvaEventRecord {
  return {
    id: `${sessionId}-turn-ended`,
    sessionId,
    turn: 0,
    // The hosted gateway's lifecycle.onTurnEnd writes this advisory ops kind at
    // each turn boundary; the broker self-warms on it.
    type: "turn.ended",
    timestamp: 1_700_000_000_000,
    payload: {},
  };
}

const flushMacrotask = (): Promise<void> => sleep(10);

describe("RecallBroker.warm() — next-turn cache warming (Phase 1)", () => {
  test("warm() then search() performs exactly one broker build", async () => {
    const { runtime } = createFakeRuntime();
    const fake = createFakeIndex({ digests: [makeDigest("prior")] });
    const broker = new RecallBroker(runtime, fake.index);

    await broker.warm();
    expect(fake.listCount()).toBe(1);

    // The subsequent explicit pull finds a warm broker and reuses its state — no
    // second build (no extra listSessionDigests round trip).
    await broker.search({ sessionId: "current", query: "anything" });
    expect(fake.listCount()).toBe(1);
  });

  test("concurrent warm() and search() share one in-flight sync", async () => {
    const { runtime } = createFakeRuntime();
    const fake = createFakeIndex({ digests: [makeDigest("prior")], gateFirstBuild: true });
    const broker = new RecallBroker(runtime, fake.index);

    const warmed = broker.warm();
    const searched = broker.search({ sessionId: "current", query: "anything" });

    // Both callers are now parked on the same gated build: single-flight means
    // exactly one build entered the read model, not two racing ones.
    await flushMacrotask();
    expect(fake.listCount()).toBe(1);

    fake.releaseGate();
    await Promise.all([warmed, searched]);
    expect(fake.listCount()).toBe(1);
  });

  test("warm() touches the read model only — no provider or network call", async () => {
    const { runtime } = createFakeRuntime([makeCurationEvent("prior", "tape:prior:e1", "helpful")]);
    const fake = createFakeIndex({ digests: [makeDigest("prior")] });
    const broker = new RecallBroker(runtime, fake.index);

    await broker.warm();

    // A warm folds the local read model and nothing else: it never reaches the
    // search-time tape queries, and the broker exposes no provider/embedding port.
    expect(fake.methodLog).toEqual(["listSessionDigests"]);
  });

  test("warm() does not change search() output or broker state on a fixed index", async () => {
    const seed = [makeCurationEvent("prior", "tape:prior:e1", "helpful")];
    const digests = [makeDigest("prior")];

    const cold = createFakeRuntime(seed);
    const coldBroker = new RecallBroker(cold.runtime, createFakeIndex({ digests }).index);
    const coldOutput = await coldBroker.search({ sessionId: "current", query: "anything" });

    const warm = createFakeRuntime(seed);
    const warmBroker = new RecallBroker(warm.runtime, createFakeIndex({ digests }).index);
    await warmBroker.warm();
    const warmOutput = await warmBroker.search({ sessionId: "current", query: "anything" });

    // Latency-only: a preceding warm leaves the explicit pull byte-identical.
    expect(JSON.stringify(warmOutput)).toBe(JSON.stringify(coldOutput));

    // And the warmed state equals the state a cold search builds (modulo the
    // updatedAt wall-clock stamp), so curation/digests are not perturbed.
    const stable = (broker: RecallBroker): string =>
      JSON.stringify({ ...broker.listCached(), updatedAt: 0 });
    expect(stable(warmBroker)).toBe(stable(coldBroker));
  });

  test("an invalidating event during an in-flight warm rebuilds on the next sync", async () => {
    const { runtime, emit } = createFakeRuntime();
    const fake = createFakeIndex({ digests: [makeDigest("prior")], gateFirstBuild: true });
    const broker = new RecallBroker(runtime, fake.index);

    const warmed = broker.warm(); // build #1 starts and parks on the gate
    await flushMacrotask();
    expect(fake.listCount()).toBe(1);

    // Curation invalidation lands while build #1 is still in flight.
    emit(makeCurationEvent("prior", "tape:prior:e1", "helpful"));

    fake.releaseGate();
    await warmed;

    // build #1 settled, but because an event arrived mid-build the broker stayed
    // dirty; the next sync must rebuild rather than serve the soon-stale state.
    const state = await broker.sync();
    expect(fake.listCount()).toBe(2);
    expect(state.curation.length).toBeGreaterThan(0);
  });

  test("the build owner (not just joiners) rebuilds on a mid-build invalidation", async () => {
    const { runtime, emit } = createFakeRuntime();
    const fake = createFakeIndex({ digests: [makeDigest("prior")], gateFirstBuild: true });
    const broker = new RecallBroker(runtime, fake.index);

    // The owner kicks off build #1 (gated) and awaits this very call.
    const owned = broker.sync();
    await flushMacrotask();
    expect(fake.listCount()).toBe(1);

    // An invalidation lands while build #1 is in flight.
    emit(makeCurationEvent("prior", "tape:prior:e1", "helpful"));

    fake.releaseGate();
    const state = await owned;

    // The owner must not return the superseded build #1; it rebuilds (build #2) so
    // its own result reflects the mid-build invalidation — strong "never stale",
    // symmetric with the joiner branch.
    expect(fake.listCount()).toBe(2);
    expect(state.curation.length).toBeGreaterThan(0);
  });
});

describe("RecallBroker turn.ended self-warm trigger (Phase 2)", () => {
  test("a turn.ended event warms the broker off the critical path", async () => {
    const { runtime, emit } = createFakeRuntime();
    const fake = createFakeIndex({ digests: [makeDigest("prior")] });
    const broker = new RecallBroker(runtime, fake.index);

    // A fresh broker is dirty; the turn boundary warms it with one build.
    emit(makeTurnEndedEvent("current"));
    await flushMacrotask();
    expect(fake.listCount()).toBe(1);
    expect(broker.listCached().sessionDigests.length).toBe(1);
  });

  test("only turn.ended triggers warm — an invalidation alone does not", async () => {
    const { runtime, emit } = createFakeRuntime();
    const fake = createFakeIndex({ digests: [makeDigest("prior")] });
    const broker = new RecallBroker(runtime, fake.index);

    // A curation invalidation marks the broker dirty but must not warm by itself:
    // warming is owned by the turn boundary, never mid-turn.
    emit(makeCurationEvent("current", "tape:current:e1", "helpful"));
    await flushMacrotask();
    expect(fake.listCount()).toBe(0);
    expect(broker.listCached().sessionDigests.length).toBe(0);
  });

  test("turn.ended warm is dirty-gated — a quiet turn folds to a no-op", async () => {
    const { runtime, emit } = createFakeRuntime();
    const fake = createFakeIndex({ digests: [makeDigest("prior")] });
    const broker = new RecallBroker(runtime, fake.index);

    emit(makeTurnEndedEvent("current"));
    await flushMacrotask();
    expect(fake.listCount()).toBe(1);

    // Nothing changed since the warm; the next turn boundary folds to a fast-path
    // no-op rather than rebuilding.
    emit(makeTurnEndedEvent("current"));
    await flushMacrotask();
    expect(fake.listCount()).toBe(1);
    expect(broker.listCached().sessionDigests.length).toBe(1);
  });
});
