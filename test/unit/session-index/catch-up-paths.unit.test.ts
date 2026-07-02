import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionIndex, SESSION_INDEX_SCHEMA_VERSION } from "@brewva/brewva-session-index";
import type {
  SessionIndex,
  SessionIndexEventSource,
  SessionIndexTaskSource,
} from "@brewva/brewva-session-index";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import { TASK_SPEC_SET_EVENT_TYPE } from "@brewva/brewva-vocabulary/task";

// These tests cover the three catch-up / indexSession branches that the
// query-contract guard does not exercise, all engine-transparently through the
// public createSessionIndex API: incremental append, reset-on-shrink, and the
// schema-bump full rebuild. They model their fixtures on query-contract.unit.test.ts.
//
// The factory debounces catchUp unless a subscription notification set
// `catchUpDirty`, so a static event source would make the second catchUp a no-op
// and the append/shrink assertions vacuous. The mutable source below therefore
// NOTIFIES its subscribers on every mutation — that is the load-bearing detail.

function record(input: {
  id: string;
  sessionId: string;
  type: string;
  timestamp: number;
  payload: Record<string, unknown>;
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: input.sessionId,
    turn: 0,
    type: input.type,
    timestamp: input.timestamp,
    payload: input.payload,
  };
}

function taskGoalEvent(
  sessionId: string,
  eventId: string,
  goal: string,
  timestamp: number,
): BrewvaEventRecord {
  return record({
    id: eventId,
    sessionId,
    type: TASK_SPEC_SET_EVENT_TYPE,
    timestamp,
    payload: { spec: { goal, targets: { files: [] } } },
  });
}

interface MutableEventSource extends SessionIndexEventSource {
  /** Append a record to its session AND notify subscribers (sets catchUpDirty). */
  add(entry: BrewvaEventRecord): void;
  /** Replace a session's records wholesale AND notify (used to simulate rewind). */
  setSessionRecords(sessionId: string, entries: readonly BrewvaEventRecord[]): void;
}

// A mutable event source whose mutations actually drive the subscription the
// factory installs in its constructor. Without the notify(), the 5s catch-up
// debounce skips the second catchUp and the appended/removed content is never
// re-projected — every mutation here flips catchUpDirty so catchUp does work.
function mutableEventSource(initial: readonly BrewvaEventRecord[]): MutableEventSource {
  const bySession = new Map<string, BrewvaEventRecord[]>();
  const listeners = new Set<(event: BrewvaEventRecord) => void>();
  const store = (entry: BrewvaEventRecord): void => {
    const list = bySession.get(entry.sessionId) ?? [];
    list.push(entry);
    bySession.set(entry.sessionId, list);
  };
  const notify = (entry: BrewvaEventRecord): void => {
    for (const listener of listeners) {
      listener(entry);
    }
  };
  for (const entry of initial) {
    store(entry);
  }
  return {
    records: {
      listSessionIds: () => [...bySession.keys()],
      list: (sessionId) => bySession.get(sessionId) ?? [],
      subscribe: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    add: (entry) => {
      store(entry);
      notify(entry);
    },
    setSessionRecords: (sessionId, entries) => {
      bySession.set(sessionId, [...entries]);
      // Any record will do; subscribers only use it as a dirty signal.
      notify(
        entries[0] ??
          record({
            id: `${sessionId}-truncated`,
            sessionId,
            type: "noop",
            timestamp: 0,
            payload: {},
          }),
      );
    },
  };
}

const task: SessionIndexTaskSource = {
  target: { getDescriptor: () => ({}) },
};

function digestIds(index: SessionIndex, query: string): Promise<string[]> {
  return index
    .querySessionDigests({
      currentSessionId: "none",
      scope: "workspace_wide",
      targetRoots: [],
      query,
      limit: 10,
    })
    .then((digests) => digests.map((digest) => digest.sessionId));
}

describe("session index catch-up paths (engine-agnostic)", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "session-index-catchup-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("incremental catch-up indexes appended events (indexSession slice branch)", async () => {
    const events = mutableEventSource([
      taskGoalEvent("s1", "s1-task-1", "implement sqlite engine swap", 1_000),
    ]);
    const index = await createSessionIndex({ workspaceRoot, events, task });
    try {
      const first = await index.catchUp();
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.indexedEvents).toBe(1);
      }
      // The appended event is the ONLY source of "postgres", so retrieving the
      // session by that term proves the incremental catch-up re-projected it.
      expect(await digestIds(index, "postgres")).not.toContain("s1");

      events.add(taskGoalEvent("s1", "s1-task-2", "postgres migration note", 2_000));
      const second = await index.catchUp();
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.indexedEvents).toBe(2);
      }
      expect(await digestIds(index, "postgres")).toContain("s1");
      // The original event's content is still retrievable after the incremental pass.
      expect(await digestIds(index, "sqlite")).toContain("s1");
    } finally {
      await index.close();
    }
  });

  test("catch-up resets a session when its tape shrinks (indexSession reset branch)", async () => {
    const firstEvent = taskGoalEvent("s1", "s1-task-1", "implement sqlite engine swap", 1_000);
    const secondEvent = taskGoalEvent("s1", "s1-task-2", "postgres migration note", 2_000);
    const events = mutableEventSource([firstEvent, secondEvent]);
    const index = await createSessionIndex({ workspaceRoot, events, task });
    try {
      const first = await index.catchUp();
      expect(first.ok).toBe(true);
      if (first.ok) {
        expect(first.indexedEvents).toBe(2);
      }
      expect(await digestIds(index, "postgres")).toContain("s1");

      // Simulate a rewind that truncates the tape back to just the first event.
      // previous.indexedEventCount (2) > records.length (1) -> reset + delete rows.
      events.setSessionRecords("s1", [firstEvent]);
      const second = await index.catchUp();
      expect(second.ok).toBe(true);
      if (second.ok) {
        expect(second.indexedEvents).toBe(1);
      }
      // Content unique to the removed event is gone; the surviving event remains.
      expect(await digestIds(index, "postgres")).not.toContain("s1");
      expect(await digestIds(index, "sqlite")).toContain("s1");
    } finally {
      await index.close();
    }
  });

  test("catch-up full-rebuilds when the on-disk schema version is stale (schema-bump branch)", async () => {
    const dbPath = join(workspaceRoot, ".brewva", "session-index", "catchup-schema.sqlite");
    const corpus: readonly BrewvaEventRecord[] = [
      taskGoalEvent("s1", "s1-task", "implement sqlite engine swap", 1_000),
      taskGoalEvent("s2", "s2-task", "duckdb columnar analytics plane", 2_000),
    ];

    // 1. Build the index, then fully close it so the cached/ref-counted instance
    //    drops and the .sqlite is no longer held open by the engine.
    const initial = await createSessionIndex({
      workspaceRoot,
      events: mutableEventSource(corpus),
      task,
      dbPath,
    });
    const initialStatus = await initial.catchUp();
    expect(initialStatus.ok).toBe(true);
    await initial.close();

    // 2. Open the raw .sqlite directly and stamp a stale schema version on every
    //    index_state row, then close the raw handle before re-creating the index.
    const raw = new Database(dbPath, { readwrite: true });
    raw.exec("update index_state set schema_version = 0");
    const staleVersions = raw
      .query("select distinct schema_version as v from index_state")
      .all() as Array<{ v: number }>;
    expect(staleVersions).toEqual([{ v: 0 }]);
    raw.close();

    // 3. Re-create over the SAME events: hasSchemaMismatch sees version 0 != current
    //    and routes catchUp through fullRebuildInTransaction.
    const reopened = await createSessionIndex({
      workspaceRoot,
      events: mutableEventSource(corpus),
      task,
      dbPath,
    });
    try {
      const status = await reopened.catchUp();
      expect(status.ok).toBe(true);
      if (status.ok) {
        expect(status.indexedSessions).toBe(2);
        expect(status.indexedEvents).toBe(2);
        expect(status.schemaVersion).toBe(SESSION_INDEX_SCHEMA_VERSION);
      }

      // Queries work and match a fresh index built from the same corpus.
      expect(await digestIds(reopened, "sqlite")).toEqual(["s1"]);
      expect(await digestIds(reopened, "duckdb")).toEqual(["s2"]);
    } finally {
      await reopened.close();
    }

    // 4. The rebuild rewrote index_state back to the current schema version.
    const verify = new Database(dbPath, { readonly: true });
    try {
      const rows = verify
        .query("select distinct schema_version as v from index_state")
        .all() as Array<{ v: number }>;
      expect(rows).toEqual([{ v: SESSION_INDEX_SCHEMA_VERSION }]);
    } finally {
      verify.close();
    }
  });

  test("concurrent queries coalesce onto one catch-up (no nested-transaction crash)", async () => {
    const events = mutableEventSource([
      taskGoalEvent("s1", "s1-task", "implement sqlite engine swap", 1_000),
      taskGoalEvent("s2", "s2-task", "duckdb columnar analytics plane", 2_000),
    ]);
    const index = await createSessionIndex({ workspaceRoot, events, task });
    try {
      // Cold index => catchUpDirty is true. Two query methods fired concurrently
      // both enter ensureAvailable() -> catchUp(); before the writer-in-flight gate
      // they both passed the debounce and issued BEGIN on the shared connection,
      // and the second rejected with "cannot start a transaction within a
      // transaction". They must now coalesce onto a single catch-up run.
      const [digests, evidence] = await Promise.all([
        index.querySessionDigests({
          currentSessionId: "none",
          scope: "workspace_wide",
          targetRoots: [],
          query: "sqlite",
          limit: 10,
        }),
        index.queryTapeEvidence({ sessionIds: ["s1", "s2"], query: "duckdb", limit: 10 }),
      ]);
      expect(digests.map((digest) => digest.sessionId)).toContain("s1");
      expect(evidence.length).toBeGreaterThan(0);
      expect(evidence.every((entry) => entry.sessionId === "s2")).toBe(true);
    } finally {
      await index.close();
    }
  });
});
