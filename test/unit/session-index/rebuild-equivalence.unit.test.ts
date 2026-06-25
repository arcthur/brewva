import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionIndex } from "@brewva/brewva-session-index";
import type {
  SessionIndex,
  SessionIndexEventSource,
  SessionIndexTaskSource,
} from "@brewva/brewva-session-index";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import { TASK_EVENT_TYPE } from "@brewva/brewva-vocabulary/task";

// WS4 proof: the SQLite + FTS5 index is rebuildable read-model state, not truth.
// Deleting the on-disk .sqlite (and its -wal/-shm siblings) and re-deriving from
// the SAME events MUST reproduce identical query results — this is what makes the
// canonical event tape the single source of truth and the index a disposable
// projection. Driven entirely through the public createSessionIndex API.

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

function taskGoalEvent(sessionId: string, goal: string, timestamp: number): BrewvaEventRecord {
  return record({
    id: `${sessionId}-task`,
    sessionId,
    type: TASK_EVENT_TYPE,
    timestamp,
    payload: { spec: { goal, targets: { files: [] } } },
  });
}

function eventSource(records: readonly BrewvaEventRecord[]): SessionIndexEventSource {
  const bySession = new Map<string, BrewvaEventRecord[]>();
  for (const entry of records) {
    const list = bySession.get(entry.sessionId) ?? [];
    list.push(entry);
    bySession.set(entry.sessionId, list);
  }
  return {
    records: {
      listSessionIds: () => [...bySession.keys()],
      list: (sessionId) => bySession.get(sessionId) ?? [],
      subscribe: () => () => {},
    },
  };
}

const task: SessionIndexTaskSource = {
  target: { getDescriptor: () => ({}) },
};

// A small multi-session corpus shared by both the original index and the
// from-scratch rebuild. Distinct CJK and ASCII goals exercise the surrogate
// codec and bm25 ranking, not just trivial single-token matches.
const CORPUS: readonly BrewvaEventRecord[] = [
  taskGoalEvent("alpha", "implement sqlite engine swap with fts5 ranking", 1_000),
  taskGoalEvent("beta", "duckdb columnar analytics plane removal", 2_000),
  taskGoalEvent("gamma", "知识图谱 检索 over session tapes", 3_000),
];

function captureQueries(index: SessionIndex) {
  return Promise.all([
    index.querySessionDigests({
      currentSessionId: "none",
      scope: "workspace_wide",
      targetRoots: [],
      query: "sqlite",
      limit: 10,
    }),
    index.listSessionDigests({ limit: 10 }),
    index.queryTapeEvidence({ sessionIds: ["alpha"], query: "sqlite", limit: 10 }),
    index.queryTapeEvidence({ sessionIds: ["gamma"], query: "知识图谱", limit: 10 }),
  ] as const);
}

describe("session index rebuild equivalence (index is rebuildable read-model state)", () => {
  let workspaceRoot: string;
  let dbPath: string;
  let original: SessionIndex;

  beforeEach(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "session-index-rebuild-"));
    dbPath = join(workspaceRoot, ".brewva", "session-index", "rebuild.sqlite");
    original = await createSessionIndex({
      workspaceRoot,
      events: eventSource(CORPUS),
      task,
      dbPath,
    });
    const status = await original.catchUp();
    expect(status.ok).toBe(true);
    if (status.ok) {
      expect(status.indexedSessions).toBe(3);
      expect(status.indexedEvents).toBe(3);
    }
  });

  afterEach(async () => {
    await original.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("re-deriving from the same events after deleting the .sqlite reproduces identical results", async () => {
    const [originalDigests, originalListed, originalEvidenceAlpha, originalEvidenceGamma] =
      await captureQueries(original);

    // Release the writer lease + DB handle, then physically delete the on-disk
    // index (file + WAL/SHM siblings) so the rebuild starts from zero cache.
    await original.close();
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
    expect(existsSync(dbPath)).toBe(false);

    const rebuilt = await createSessionIndex({
      workspaceRoot,
      events: eventSource(CORPUS),
      task,
      dbPath,
    });
    try {
      const rebuiltStatus = await rebuilt.catchUp();
      expect(rebuiltStatus.ok).toBe(true);
      // Stable, event-derived counts must match; the only volatile status fields
      // (lastIndexedAt / indexAgeMs) are clock-based and intentionally excluded.
      if (rebuiltStatus.ok) {
        expect(rebuiltStatus.indexedSessions).toBe(3);
        expect(rebuiltStatus.indexedEvents).toBe(3);
      }

      const [rebuiltDigests, rebuiltListed, rebuiltEvidenceAlpha, rebuiltEvidenceGamma] =
        await captureQueries(rebuilt);

      // Query results are pure functions of the source events (no clock / index-age
      // leaks into digests or evidence), so they compare structurally with no
      // normalization — bm25 scoring is deterministic over an identical corpus.
      expect(rebuiltDigests).toEqual(originalDigests);
      expect(rebuiltListed).toEqual(originalListed);
      expect(rebuiltEvidenceAlpha).toEqual(originalEvidenceAlpha);
      expect(rebuiltEvidenceGamma).toEqual(originalEvidenceGamma);

      // Sanity: the rebuilt index is non-empty and well-formed, not vacuously equal.
      expect(rebuiltDigests.map((digest) => digest.sessionId)).toEqual(["alpha"]);
      expect(rebuiltListed.map((digest) => digest.sessionId)).toEqual(["gamma", "beta", "alpha"]);
      expect(rebuiltEvidenceGamma.length).toBeGreaterThan(0);
    } finally {
      await rebuilt.close();
    }
  });
});

describe("session index bm25-vs-coverage spot-check (SQLite engine)", () => {
  let workspaceRoot: string;
  let index: SessionIndex;

  beforeEach(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "session-index-bm25-"));
    index = await createSessionIndex({
      workspaceRoot,
      events: eventSource([
        // Only "delta" carries the query terms; the others share none of them, so
        // a sane bm25 ordering must rank "delta" first and return it alone.
        taskGoalEvent("delta", "fts5 bm25 ranking relevance ordering proof", 1_000),
        taskGoalEvent("epsilon", "unrelated boxlite snapshot lifecycle work", 2_000),
        taskGoalEvent("zeta", "telegram ingress channel bridge wiring", 3_000),
      ]),
      task,
    });
    const status = await index.catchUp();
    expect(status.ok).toBe(true);
  });

  afterEach(async () => {
    await index.close();
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("ranks the session whose task_goal most contains the query terms first", async () => {
    const digests = await index.querySessionDigests({
      currentSessionId: "none",
      scope: "workspace_wide",
      targetRoots: [],
      query: "bm25 ranking relevance",
      limit: 10,
    });
    expect(digests[0]?.sessionId).toBe("delta");
    expect(digests[0]?.tokenScore ?? 0).toBeGreaterThan(0);
    expect(digests.map((digest) => digest.sessionId)).not.toContain("epsilon");
    expect(digests.map((digest) => digest.sessionId)).not.toContain("zeta");
  });

  test("returns nothing for a query that matches no session", async () => {
    const digests = await index.querySessionDigests({
      currentSessionId: "none",
      scope: "workspace_wide",
      targetRoots: [],
      query: "whollyunrelatedterm",
      limit: 10,
    });
    expect(digests).toHaveLength(0);
  });
});
