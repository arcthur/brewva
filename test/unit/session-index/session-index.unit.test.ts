import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BrewvaRuntime,
  DEFAULT_BREWVA_CONFIG,
  type BrewvaEventRecord,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import { tokenizeSearchText } from "@brewva/brewva-search";
import { createSessionIndex } from "@brewva/brewva-session-index";
import { DuckDBInstance } from "@duckdb/node-api";
import { createTestWorkspace } from "../../helpers/workspace.js";

async function readRows<T extends Record<string, unknown>>(
  dbPath: string,
  sql: string,
): Promise<T[]> {
  const instance = await DuckDBInstance.create(dbPath);
  const connection = await instance.connect();
  try {
    const result = await connection.run(sql);
    return (await result.getRowObjectsJS()) as T[];
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}

function createIndexedRuntime(name: string): { workspace: string; runtime: BrewvaRuntime } {
  const workspace = createTestWorkspace(name);
  mkdirSync(join(workspace, "packages", "gateway"), { recursive: true });
  mkdirSync(join(workspace, "packages", "cli"), { recursive: true });
  mkdirSync(join(workspace, "packages", "gateway", ".brewva"), { recursive: true });
  mkdirSync(join(workspace, "packages", "cli", ".brewva"), { recursive: true });
  writeFileSync(join(workspace, ".brewva", "brewva.json"), "{}\n", "utf8");
  writeFileSync(join(workspace, "packages", "gateway", ".brewva", "brewva.json"), "{}\n", "utf8");
  writeFileSync(join(workspace, "packages", "cli", ".brewva", "brewva.json"), "{}\n", "utf8");
  const runtime = new BrewvaRuntime({
    cwd: workspace,
    config: structuredClone(DEFAULT_BREWVA_CONFIG),
  });
  return { workspace, runtime };
}

function recordTaskSession(
  runtime: BrewvaRuntime,
  input: {
    sessionId: string;
    timestamp: number;
    goal: string;
    targetFile: string;
    evidenceText: string;
  },
): BrewvaEventRecord {
  runtime.maintain.context.onTurnStart(input.sessionId, 1);
  runtime.authority.task.setSpec(input.sessionId, {
    schema: "brewva.task.v1",
    goal: input.goal,
    targets: {
      files: [input.targetFile],
    },
  });
  return recordRuntimeEvent(runtime, {
    sessionId: input.sessionId,
    type: "verification_outcome_recorded",
    timestamp: input.timestamp,
    payload: {
      schema: "brewva.verification.outcome.v1",
      passed: true,
      summary: input.evidenceText,
    },
  }) as BrewvaEventRecord;
}

describe("session index", () => {
  test("creates schema and materializes sessions, target roots, events, and search tokens", async () => {
    const { workspace, runtime } = createIndexedRuntime("session-index-schema");
    const evidence = recordTaskSession(runtime, {
      sessionId: "indexed-prior-gateway",
      timestamp: 1_700_000_000_000,
      goal: "Fix gateway bootstrap flake",
      targetFile: "packages/gateway",
      evidenceText: "中文 网关 bootstrap flake verified by runtime receipt",
    });
    recordTaskSession(runtime, {
      sessionId: "indexed-prior-cli",
      timestamp: 1_700_000_001_000,
      goal: "Update CLI help",
      targetFile: "packages/cli",
      evidenceText: "CLI help update verified",
    });

    const index = await createSessionIndex({
      workspaceRoot: workspace,
      events: runtime.inspect.events,
      task: runtime.inspect.task,
    });
    try {
      await index.catchUp();

      const status = await index.status();
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.schemaVersion).toBe(1);
      expect(status.writer).toBe(true);
      expect(status.indexedSessions).toBe(2);

      const evidenceRows = await index.queryTapeEvidence({
        sessionIds: ["indexed-prior-gateway"],
        queryTokens: tokenizeSearchText("网关 bootstrap"),
        limit: 5,
      });
      expect(evidenceRows[0]).toMatchObject({
        eventId: evidence.id,
        sessionId: "indexed-prior-gateway",
        type: "verification_outcome_recorded",
      });
    } finally {
      await index.close();
    }

    const dbPath = join(workspace, ".brewva", "session-index", "session-index.duckdb");
    expect(existsSync(dbPath)).toBe(true);
    const sessions = await readRows<{ session_id: string; event_count: number }>(
      dbPath,
      "select session_id, event_count from sessions order by session_id",
    );
    expect(sessions).toEqual([
      { session_id: "indexed-prior-cli", event_count: 3 },
      { session_id: "indexed-prior-gateway", event_count: 3 },
    ]);

    const targetRoots = await readRows<{ session_id: string; target_root: string }>(
      dbPath,
      "select session_id, target_root from session_target_roots order by session_id, target_root",
    );
    expect(targetRoots).toEqual(
      expect.arrayContaining([
        {
          session_id: "indexed-prior-gateway",
          target_root: join(workspace, "packages", "gateway"),
        },
      ]),
    );

    const tokenRows = await readRows<{ token: string }>(
      dbPath,
      "select distinct token from event_tokens where session_id = 'indexed-prior-gateway' order by token",
    );
    const tokens = tokenRows.map((row) => row.token);
    expect(tokens).toEqual(expect.arrayContaining(tokenizeSearchText("中文 网关 bootstrap")));
  });

  test("cold catch-up uses byte offsets and does not duplicate indexed events", async () => {
    const { workspace, runtime } = createIndexedRuntime("session-index-catch-up");
    recordTaskSession(runtime, {
      sessionId: "indexed-catch-up",
      timestamp: 1_700_000_000_000,
      goal: "Fix session index catch-up",
      targetFile: "packages/gateway",
      evidenceText: "first indexed receipt",
    });
    const index = await createSessionIndex({
      workspaceRoot: workspace,
      events: runtime.inspect.events,
      task: runtime.inspect.task,
    });
    await index.catchUp();
    await index.catchUp();
    await index.close();

    const dbPath = join(workspace, ".brewva", "session-index", "session-index.duckdb");
    let eventCount = await readRows<{ count: bigint }>(
      dbPath,
      "select count(*) as count from events where session_id = 'indexed-catch-up'",
    );
    expect(eventCount[0]?.count).toBe(3n);

    const firstState = await readRows<{ byte_offset: bigint; indexed_event_count: number }>(
      dbPath,
      "select byte_offset, indexed_event_count from index_state where session_id = 'indexed-catch-up'",
    );
    expect(firstState[0]?.indexed_event_count).toBe(3);

    recordRuntimeEvent(runtime, {
      sessionId: "indexed-catch-up",
      type: "tool_result_recorded",
      timestamp: 1_700_000_002_000,
      payload: {
        toolName: "exec",
        outputText: "second indexed receipt",
        verdict: "success",
      },
    });
    const nextIndex = await createSessionIndex({
      workspaceRoot: workspace,
      events: runtime.inspect.events,
      task: runtime.inspect.task,
    });
    await nextIndex.catchUp();
    await nextIndex.close();

    eventCount = await readRows<{ count: bigint }>(
      dbPath,
      "select count(*) as count from events where session_id = 'indexed-catch-up'",
    );
    expect(eventCount[0]?.count).toBe(4n);
    const secondState = await readRows<{ byte_offset: bigint; indexed_event_count: number }>(
      dbPath,
      "select byte_offset, indexed_event_count from index_state where session_id = 'indexed-catch-up'",
    );
    expect(secondState[0]?.indexed_event_count).toBe(4);
    expect(secondState[0]?.byte_offset ?? 0n).toBeGreaterThan(firstState[0]?.byte_offset ?? 0n);
  });

  test("incremental catch-up does not advance past an incomplete JSONL row", async () => {
    const { workspace, runtime } = createIndexedRuntime("session-index-incomplete-jsonl-row");
    recordTaskSession(runtime, {
      sessionId: "indexed-incomplete-jsonl-row",
      timestamp: 1_700_000_000_000,
      goal: "Avoid skipping partial event tape rows",
      targetFile: "packages/gateway",
      evidenceText: "initial indexed receipt",
    });
    const dbPath = join(workspace, ".brewva", "session-index", "session-index.duckdb");
    const logPath = runtime.inspect.events.getLogPath("indexed-incomplete-jsonl-row");

    const first = await createSessionIndex({
      workspaceRoot: workspace,
      events: runtime.inspect.events,
      task: runtime.inspect.task,
    });
    await first.catchUp();
    await first.close();

    const firstState = await readRows<{ byte_offset: bigint; indexed_event_count: number }>(
      dbPath,
      "select byte_offset, indexed_event_count from index_state where session_id = 'indexed-incomplete-jsonl-row'",
    );
    const partialEvent = {
      id: "incomplete-jsonl-row-event",
      sessionId: "indexed-incomplete-jsonl-row",
      type: "verification_outcome_recorded",
      timestamp: 1_700_000_002_000,
      payload: {
        schema: "brewva.verification.outcome.v1",
        passed: true,
        summary: "complete partial receipt",
      },
    };
    const serialized = `${JSON.stringify(partialEvent)}\n`;
    const splitAt = Math.floor(serialized.length / 2);
    writeFileSync(logPath, serialized.slice(0, splitAt), { flag: "a" });

    const partial = await createSessionIndex({
      workspaceRoot: workspace,
      events: runtime.inspect.events,
      task: runtime.inspect.task,
    });
    await partial.catchUp();
    await partial.close();

    const partialState = await readRows<{ byte_offset: bigint; indexed_event_count: number }>(
      dbPath,
      "select byte_offset, indexed_event_count from index_state where session_id = 'indexed-incomplete-jsonl-row'",
    );
    expect(partialState[0]?.byte_offset).toBe(firstState[0]?.byte_offset);
    expect(partialState[0]?.indexed_event_count).toBe(3);

    writeFileSync(logPath, serialized.slice(splitAt), { flag: "a" });
    const complete = await createSessionIndex({
      workspaceRoot: workspace,
      events: runtime.inspect.events,
      task: runtime.inspect.task,
    });
    try {
      await complete.catchUp();
      const evidence = await complete.queryTapeEvidence({
        sessionIds: ["indexed-incomplete-jsonl-row"],
        queryTokens: tokenizeSearchText("complete partial receipt"),
        limit: 5,
      });
      expect(evidence.map((entry) => entry.eventId)).toContain("incomplete-jsonl-row-event");
    } finally {
      await complete.close();
    }
  });

  test("indexed reads debounce catch-up scans within one process", async () => {
    const { workspace, runtime } = createIndexedRuntime("session-index-catch-up-debounce");
    const evidence = recordTaskSession(runtime, {
      sessionId: "indexed-debounce",
      timestamp: 1_700_000_000_000,
      goal: "Debounce repeated session index reads",
      targetFile: "packages/gateway",
      evidenceText: "debounce indexed receipt",
    });
    let listSessionIdsCalls = 0;
    const index = await createSessionIndex({
      workspaceRoot: workspace,
      events: {
        ...runtime.inspect.events,
        listSessionIds() {
          listSessionIdsCalls += 1;
          return runtime.inspect.events.listSessionIds();
        },
      },
      task: runtime.inspect.task,
    });
    try {
      const queryTokens = tokenizeSearchText("debounce receipt");
      const sessions = await index.querySessionDigests({
        currentSessionId: "indexed-debounce-current",
        scope: "workspace_wide",
        targetRoots: [workspace],
        queryTokens,
        limit: 5,
      });
      const evidenceRows = await index.queryTapeEvidence({
        sessionIds: ["indexed-debounce"],
        queryTokens,
        limit: 5,
      });
      const event = await index.getTapeEvent({
        sessionId: "indexed-debounce",
        eventId: evidence.id,
      });

      expect(sessions.map((entry) => entry.sessionId)).toContain("indexed-debounce");
      expect(evidenceRows.map((entry) => entry.eventId)).toContain(evidence.id);
      expect(event?.eventId).toBe(evidence.id);
      expect(listSessionIdsCalls).toBe(1);
    } finally {
      await index.close();
    }
  });

  test("token query does not return every scoped session when query tokens are empty", async () => {
    const { workspace, runtime } = createIndexedRuntime("session-index-empty-token-query");
    recordTaskSession(runtime, {
      sessionId: "indexed-empty-token-a",
      timestamp: 1_700_000_000_000,
      goal: "First empty token guard session",
      targetFile: "packages/gateway",
      evidenceText: "first indexed receipt",
    });
    recordTaskSession(runtime, {
      sessionId: "indexed-empty-token-b",
      timestamp: 1_700_000_001_000,
      goal: "Second empty token guard session",
      targetFile: "packages/cli",
      evidenceText: "second indexed receipt",
    });

    const index = await createSessionIndex({
      workspaceRoot: workspace,
      events: runtime.inspect.events,
      task: runtime.inspect.task,
    });
    try {
      await index.catchUp();
      const sessions = await index.querySessionDigests({
        currentSessionId: "indexed-empty-token-current",
        scope: "workspace_wide",
        targetRoots: [workspace],
        queryTokens: [],
        limit: 10_000,
      });

      expect(sessions).toEqual([]);
    } finally {
      await index.close();
    }
  });

  test("session candidate tokens include searchable events beyond the digest window", async () => {
    const { workspace, runtime } = createIndexedRuntime("session-index-long-session-candidates");
    recordTaskSession(runtime, {
      sessionId: "indexed-long-session",
      timestamp: 1_700_000_000_000,
      goal: "Run a long generic maintenance session",
      targetFile: "packages/gateway",
      evidenceText: "initial generic indexed receipt",
    });

    let lateEvent: BrewvaEventRecord | undefined;
    for (let index = 0; index < 25; index += 1) {
      const event = recordRuntimeEvent(runtime, {
        sessionId: "indexed-long-session",
        type: "tool_result_recorded",
        timestamp: 1_700_000_001_000 + index,
        payload: {
          toolName: "exec",
          outputText:
            index === 24
              ? "rareanchor durable indexed receipt"
              : `generic maintenance output ${index}`,
          verdict: "success",
        },
      }) as BrewvaEventRecord;
      if (index === 24) {
        lateEvent = event;
      }
    }
    if (!lateEvent) {
      throw new Error("late event was not recorded");
    }

    const index = await createSessionIndex({
      workspaceRoot: workspace,
      events: runtime.inspect.events,
      task: runtime.inspect.task,
    });
    try {
      await index.catchUp();
      const queryTokens = tokenizeSearchText("rareanchor durable indexed receipt");
      const sessions = await index.querySessionDigests({
        currentSessionId: "indexed-long-session-current",
        scope: "workspace_wide",
        targetRoots: [workspace],
        queryTokens,
        limit: 5,
      });
      expect(sessions.map((entry) => entry.sessionId)).toContain("indexed-long-session");

      const evidence = await index.queryTapeEvidence({
        sessionIds: sessions.map((entry) => entry.sessionId),
        queryTokens,
        limit: 5,
      });
      expect(evidence.map((entry) => entry.eventId)).toContain(lateEvent.id);
    } finally {
      await index.close();
    }
  });

  test("single-writer lease prevents concurrent writers while allowing stale reads", async () => {
    const { workspace, runtime } = createIndexedRuntime("session-index-lease");
    recordTaskSession(runtime, {
      sessionId: "indexed-lease",
      timestamp: 1_700_000_000_000,
      goal: "Exercise session index lease",
      targetFile: "packages/gateway",
      evidenceText: "lease indexed receipt",
    });

    const first = await createSessionIndex({
      workspaceRoot: workspace,
      events: runtime.inspect.events,
      task: runtime.inspect.task,
    });
    await first.catchUp();
    const second = await createSessionIndex({
      workspaceRoot: workspace,
      events: runtime.inspect.events,
      task: runtime.inspect.task,
    });
    try {
      await second.catchUp();

      const firstStatus = await first.status();
      const secondStatus = await second.status();
      expect(firstStatus.ok && firstStatus.writer).toBe(true);
      expect(secondStatus.ok && secondStatus.writer).toBe(false);

      const sessions = await second.querySessionDigests({
        currentSessionId: "indexed-lease-current",
        scope: "workspace_wide",
        targetRoots: [workspace],
        queryTokens: tokenizeSearchText("lease receipt"),
        limit: 5,
      });
      expect(sessions.map((entry) => entry.sessionId)).toContain("indexed-lease");
    } finally {
      await second.close();
      await first.close();
    }
  });

  test("non-writers fail closed before any read snapshot is published", async () => {
    const { workspace, runtime } = createIndexedRuntime("session-index-no-snapshot-reader");
    recordTaskSession(runtime, {
      sessionId: "indexed-no-snapshot-reader",
      timestamp: 1_700_000_000_000,
      goal: "Avoid primary DB reads without a writer lease",
      targetFile: "packages/gateway",
      evidenceText: "no snapshot reader receipt",
    });
    const lockPath = join(workspace, ".brewva", "session-index", "write.lock");
    mkdirSync(join(workspace, ".brewva", "session-index"), { recursive: true });
    writeFileSync(lockPath, `${process.pid}\n${Date.now()}\n`, "utf8");

    const index = await createSessionIndex({
      workspaceRoot: workspace,
      events: runtime.inspect.events,
      task: runtime.inspect.task,
    });
    try {
      expect(await index.status()).toMatchObject({
        ok: false,
        error: "session_index_unavailable",
      });
      expect(await index.catchUp()).toMatchObject({
        ok: false,
        error: "session_index_unavailable",
      });
    } finally {
      await index.close();
    }
  });

  test("stale write leases are recovered by the next writer", async () => {
    const { workspace, runtime } = createIndexedRuntime("session-index-stale-lock");
    recordTaskSession(runtime, {
      sessionId: "indexed-stale-lock",
      timestamp: 1_700_000_000_000,
      goal: "Recover stale session index lock",
      targetFile: "packages/gateway",
      evidenceText: "stale lock recovery receipt",
    });
    const lockPath = join(workspace, ".brewva", "session-index", "write.lock");
    mkdirSync(join(workspace, ".brewva", "session-index"), { recursive: true });
    writeFileSync(lockPath, "999999999\n0\n", "utf8");

    const index = await createSessionIndex({
      workspaceRoot: workspace,
      events: runtime.inspect.events,
      task: runtime.inspect.task,
    });
    try {
      const status = await index.catchUp();
      expect(status.ok && status.writer).toBe(true);

      const sessions = await index.querySessionDigests({
        currentSessionId: "indexed-stale-lock-current",
        scope: "workspace_wide",
        targetRoots: [workspace],
        queryTokens: tokenizeSearchText("stale recovery receipt"),
        limit: 5,
      });
      expect(sessions.map((entry) => entry.sessionId)).toContain("indexed-stale-lock");
    } finally {
      await index.close();
    }
  });

  test("stale write leases are recovered even when the stale pid has been reused", async () => {
    const { workspace, runtime } = createIndexedRuntime("session-index-stale-lock-pid-reuse");
    recordTaskSession(runtime, {
      sessionId: "indexed-stale-lock-pid-reuse",
      timestamp: 1_700_000_000_000,
      goal: "Recover stale session index lock with reused pid",
      targetFile: "packages/gateway",
      evidenceText: "stale pid reuse recovery receipt",
    });
    const lockPath = join(workspace, ".brewva", "session-index", "write.lock");
    mkdirSync(join(workspace, ".brewva", "session-index"), { recursive: true });
    writeFileSync(lockPath, `${process.pid}\n0\n`, "utf8");

    const index = await createSessionIndex({
      workspaceRoot: workspace,
      events: runtime.inspect.events,
      task: runtime.inspect.task,
    });
    try {
      const status = await index.catchUp();
      expect(status.ok && status.writer).toBe(true);
    } finally {
      await index.close();
    }
  });

  test("truncated event logs reset indexed rows for the affected session", async () => {
    const { workspace, runtime } = createIndexedRuntime("session-index-truncated-log");
    recordTaskSession(runtime, {
      sessionId: "indexed-truncated-log",
      timestamp: 1_700_000_000_000,
      goal: "Reset session index after log truncation",
      targetFile: "packages/gateway",
      evidenceText: "truncated log indexed receipt",
    });

    const first = await createSessionIndex({
      workspaceRoot: workspace,
      events: runtime.inspect.events,
      task: runtime.inspect.task,
    });
    await first.catchUp();
    await first.close();

    const logPath = runtime.inspect.events.getLogPath("indexed-truncated-log");
    writeFileSync(logPath, "", "utf8");

    const second = await createSessionIndex({
      workspaceRoot: workspace,
      events: runtime.inspect.events,
      task: runtime.inspect.task,
    });
    try {
      const status = await second.catchUp();
      expect(status.ok && status.indexedEvents).toBe(0);
    } finally {
      await second.close();
    }

    const dbPath = join(workspace, ".brewva", "session-index", "session-index.duckdb");
    const eventCount = await readRows<{ count: bigint }>(
      dbPath,
      "select count(*) as count from events where session_id = 'indexed-truncated-log'",
    );
    const sessionCount = await readRows<{ count: bigint }>(
      dbPath,
      "select count(*) as count from sessions where session_id = 'indexed-truncated-log'",
    );
    expect(eventCount[0]?.count).toBe(0n);
    expect(sessionCount[0]?.count).toBe(0n);
  });

  test("rebuild clears and recreates the index from event tape", async () => {
    const { workspace, runtime } = createIndexedRuntime("session-index-rebuild");
    recordTaskSession(runtime, {
      sessionId: "indexed-rebuild",
      timestamp: 1_700_000_000_000,
      goal: "Rebuild session index from event tape",
      targetFile: "packages/gateway",
      evidenceText: "rebuild indexed receipt",
    });

    const index = await createSessionIndex({
      workspaceRoot: workspace,
      events: runtime.inspect.events,
      task: runtime.inspect.task,
    });
    try {
      await index.catchUp();
      const status = await index.rebuild();
      expect(status.ok && status.indexedSessions).toBe(1);

      const sessions = await index.querySessionDigests({
        currentSessionId: "indexed-rebuild-current",
        scope: "workspace_wide",
        targetRoots: [workspace],
        queryTokens: tokenizeSearchText("rebuild receipt"),
        limit: 5,
      });
      expect(sessions.map((entry) => entry.sessionId)).toContain("indexed-rebuild");
    } finally {
      await index.close();
    }
  });

  test("reports session_index_unavailable for corrupted database files", async () => {
    const { workspace, runtime } = createIndexedRuntime("session-index-corrupt");
    const dbPath = join(workspace, ".brewva", "session-index", "session-index.duckdb");
    mkdirSync(join(workspace, ".brewva", "session-index"), { recursive: true });
    writeFileSync(dbPath, "not a duckdb database", "utf8");

    const index = await createSessionIndex({
      workspaceRoot: workspace,
      events: runtime.inspect.events,
      task: runtime.inspect.task,
    });
    try {
      const status = await index.status();
      expect(status).toMatchObject({
        ok: false,
        error: "session_index_unavailable",
      });
      expect(await index.catchUp()).toEqual(status);
    } finally {
      await index.close();
      rmSync(dbPath, { force: true });
    }
  });
});
