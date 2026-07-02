import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionIndex } from "@brewva/brewva-session-index";
import type {
  SessionIndex,
  SessionIndexEventSource,
  SessionIndexTaskSource,
} from "@brewva/brewva-session-index";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import { TASK_SPEC_SET_EVENT_TYPE } from "@brewva/brewva-vocabulary/task";
import { USER_FACT_RECORDED_EVENT_TYPE } from "@brewva/brewva-vocabulary/user-model";

// These tests exercise the SessionIndex query contract through the public
// createSessionIndex API only — they never import the engine layer (duckdb/),
// so the WS1 engine swap (DuckDB -> SQLite + FTS5) MUST keep them green. They are
// the migration regression guard and the bm25-vs-coverage spot-check baseline.

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
    type: TASK_SPEC_SET_EVENT_TYPE,
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

describe("session index query contract (engine-agnostic)", () => {
  let workspaceRoot: string;
  let index: SessionIndex;

  beforeEach(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "session-index-contract-"));
    index = await createSessionIndex({
      workspaceRoot,
      events: eventSource([
        taskGoalEvent("s1", "implement sqlite engine swap", 1_000),
        taskGoalEvent("s2", "duckdb columnar analytics plane", 2_000),
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

  test("querySessionDigests returns sessions whose tokens match the query", async () => {
    const digests = await index.querySessionDigests({
      currentSessionId: "none",
      scope: "workspace_wide",
      targetRoots: [],
      query: "sqlite",
      limit: 10,
    });
    const ids = digests.map((digest) => digest.sessionId);
    expect(ids).toContain("s1");
    expect(ids).not.toContain("s2");
    expect(digests[0]?.tokenScore ?? 0).toBeGreaterThan(0);
  });

  test("querySessionDigests excludes everything for a non-matching query", async () => {
    const digests = await index.querySessionDigests({
      currentSessionId: "none",
      scope: "workspace_wide",
      targetRoots: [],
      query: "whollyunrelatedterm",
      limit: 10,
    });
    expect(digests).toHaveLength(0);
  });

  test("getSessionDigest returns the indexed digest for a known session", async () => {
    const digest = await index.getSessionDigest({ sessionId: "s1" });
    expect(digest?.sessionId).toBe("s1");
    expect(digest?.taskGoal).toContain("sqlite");
  });

  test("getSessionDigest returns undefined for an unknown session", async () => {
    const digest = await index.getSessionDigest({ sessionId: "missing" });
    expect(digest).toBe(undefined);
  });

  test("listSessionDigests lists indexed sessions newest-first", async () => {
    const digests = await index.listSessionDigests({ limit: 10 });
    expect(digests.map((digest) => digest.sessionId)).toEqual(["s2", "s1"]);
  });

  test("filterSessionIdsByScope keeps only indexed sessions under workspace_wide", async () => {
    const filtered = await index.filterSessionIdsByScope({
      currentSessionId: "none",
      scope: "workspace_wide",
      targetRoots: [],
      sessionIds: ["s1", "s2", "missing"],
    });
    expect(filtered.toSorted()).toEqual(["s1", "s2"]);
  });

  test("queryTapeEvidence returns matching events scoped to the given sessions", async () => {
    const evidence = await index.queryTapeEvidence({
      sessionIds: ["s1"],
      query: "sqlite",
      limit: 10,
    });
    expect(evidence.length).toBeGreaterThan(0);
    expect(evidence.every((entry) => entry.sessionId === "s1")).toBe(true);
    expect(evidence[0]?.tokenScore ?? 0).toBeGreaterThan(0);
  });
});

function userFactRecord(input: {
  id: string;
  sessionId: string;
  factKey: string;
  value: string;
  timestamp: number;
}): BrewvaEventRecord {
  return record({
    id: input.id,
    sessionId: input.sessionId,
    type: USER_FACT_RECORDED_EVENT_TYPE,
    timestamp: input.timestamp,
    payload: {
      id: input.id,
      scope: "user",
      factKey: input.factKey,
      value: input.value,
      grade: "estimated",
      sourceRefs: ["turn:1"],
      reason: "authored from the conversation",
      createdAt: input.timestamp,
    },
  });
}

describe("session index listTapeEventsByType", () => {
  let workspaceRoot: string;
  let index: SessionIndex;

  beforeEach(async () => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "session-index-list-by-type-"));
    index = await createSessionIndex({
      workspaceRoot,
      events: eventSource([
        taskGoalEvent("s1", "unrelated task goal", 500),
        userFactRecord({
          id: "f1",
          sessionId: "s1",
          factKey: "style",
          value: "terse",
          timestamp: 1_000,
        }),
        userFactRecord({
          id: "f2",
          sessionId: "s2",
          factKey: "style",
          value: "terse",
          timestamp: 2_000,
        }),
        userFactRecord({
          id: "f3",
          sessionId: "s3",
          factKey: "lang",
          value: "ts",
          timestamp: 3_000,
        }),
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

  test("omitting sessionIds lists every event of the type, chronologically", async () => {
    const events = await index.listTapeEventsByType({ type: USER_FACT_RECORDED_EVENT_TYPE });
    expect(events.map((event) => event.eventId)).toEqual(["f1", "f2", "f3"]);
    expect(events.every((event) => event.type === USER_FACT_RECORDED_EVENT_TYPE)).toBe(true);
  });

  test("an explicit sessionIds list narrows to those sessions", async () => {
    const events = await index.listTapeEventsByType({
      type: USER_FACT_RECORDED_EVENT_TYPE,
      sessionIds: ["s1", "s3"],
    });
    expect(events.map((event) => event.eventId)).toEqual(["f1", "f3"]);
  });

  test("an explicit empty sessionIds list returns nothing, not everything", async () => {
    const events = await index.listTapeEventsByType({
      type: USER_FACT_RECORDED_EVENT_TYPE,
      sessionIds: [],
    });
    expect(events).toEqual([]);
  });

  test("the type filter excludes other event types", async () => {
    const events = await index.listTapeEventsByType({ type: TASK_SPEC_SET_EVENT_TYPE });
    expect(events.map((event) => event.sessionId)).toEqual(["s1"]);
  });
});
