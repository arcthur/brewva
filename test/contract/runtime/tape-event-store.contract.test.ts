import { describe, expect, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_BREWVA_CONFIG,
  BrewvaEventStore,
  buildTapeAnchorPayload,
  buildTapeCheckpointPayload,
} from "@brewva/brewva-runtime";
import { requireDefined } from "../../helpers/assertions.js";
import { createTestWorkspace } from "../../helpers/workspace.js";

describe("BrewvaEventStore tape helpers", () => {
  test("writes and queries anchor/checkpoint events via dedicated methods", () => {
    const workspace = createTestWorkspace("tape-store");
    const store = new BrewvaEventStore(DEFAULT_BREWVA_CONFIG.infrastructure.events, workspace);
    const sessionId = "tape-store-1";

    store.appendAnchor({
      sessionId,
      payload: buildTapeAnchorPayload({
        name: "investigation-done",
        summary: "root cause isolated",
        nextSteps: "apply patch",
      }),
      turn: 3,
    });
    store.appendCheckpoint({
      sessionId,
      payload: buildTapeCheckpointPayload({
        taskState: {
          items: [],
          blockers: [],
          updatedAt: null,
        },
        truthState: {
          facts: [],
          updatedAt: null,
        },
        costSummary: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          totalCostUsd: 0,
          models: {},
          skills: {},
          tools: {},
          alerts: [],
          budget: {
            action: "warn",
            sessionExceeded: false,
            blocked: false,
          },
        },
        evidenceState: {
          totalRecords: 0,
          failureRecords: 0,
          anchorEpoch: 0,
          recentFailures: [],
        },
        projectionState: {
          updatedAt: null,
          unitCount: 0,
        },
        reason: "unit_test",
      }),
      turn: 3,
    });

    const anchors = store.listAnchors(sessionId);
    const checkpoints = store.listCheckpoints(sessionId);
    expect(anchors).toHaveLength(1);
    expect(checkpoints).toHaveLength(1);
    expect(anchors[0]?.type).toBe("anchor");
    expect(checkpoints[0]?.type).toBe("checkpoint");
  });

  test("keeps incremental cache synchronized for external append and file truncation", () => {
    const workspace = createTestWorkspace("tape-store-incremental");
    const store = new BrewvaEventStore(DEFAULT_BREWVA_CONFIG.infrastructure.events, workspace);
    const sessionId = "tape-store-incremental-1";
    store.append({
      sessionId,
      type: "session_start",
      payload: { source: "test" },
      timestamp: 100,
    });
    expect(store.list(sessionId)).toHaveLength(1);

    const eventsDir = DEFAULT_BREWVA_CONFIG.infrastructure.events.dir;
    const eventsRoot = join(workspace, eventsDir);
    const files = readdirSync(eventsRoot).filter((name) => name.endsWith(".jsonl"));
    expect(files).toHaveLength(1);
    const eventFilePath = join(eventsRoot, files[0] ?? "missing.jsonl");
    const externalRow = {
      id: "evt_external_1",
      sessionId,
      type: "tool_call",
      timestamp: 101,
      payload: { toolName: "look_at" },
    };
    writeFileSync(eventFilePath, `\n${JSON.stringify(externalRow)}`, { flag: "a" });

    const afterExternalAppend = store.list(sessionId);
    expect(afterExternalAppend).toHaveLength(2);
    expect(afterExternalAppend[1]?.id).toBe("evt_external_1");

    const rewrittenRow = {
      id: "evt_rewritten_1",
      sessionId,
      type: "session_restart",
      timestamp: 102,
      payload: { reason: "manual-truncate" },
    };
    writeFileSync(eventFilePath, JSON.stringify(rewrittenRow), "utf8");

    const afterTruncate = store.list(sessionId);
    expect(afterTruncate).toHaveLength(1);
    expect(afterTruncate[0]?.id).toBe("evt_rewritten_1");
  });

  test("generates unique event ids for high-frequency appends", () => {
    const workspace = createTestWorkspace("tape-store-id");
    const store = new BrewvaEventStore(DEFAULT_BREWVA_CONFIG.infrastructure.events, workspace);
    const sessionId = "tape-store-id-1";

    const ids = new Set<string>();
    for (let index = 0; index < 200; index += 1) {
      const row = requireDefined(
        store.append({
          sessionId,
          type: "test_event",
          payload: { index },
          timestamp: 1735689600000,
        }),
        `expected event row for index ${index}`,
      );
      ids.add(row.id);
    }

    expect(ids.size).toBe(200);
    for (const id of ids.values()) {
      expect(id).toMatch(/^evt_1735689600000_/);
    }
  });

  test("skips malformed rows with non-record payloads during cache sync", () => {
    const workspace = createTestWorkspace("tape-store-malformed-payload");
    const store = new BrewvaEventStore(DEFAULT_BREWVA_CONFIG.infrastructure.events, workspace);
    const sessionId = "tape-store-malformed-payload-1";

    store.append({
      sessionId,
      type: "session_start",
      payload: { source: "test" },
      timestamp: 100,
    });

    const eventsRoot = join(workspace, DEFAULT_BREWVA_CONFIG.infrastructure.events.dir);
    const fileName = requireDefined(
      readdirSync(eventsRoot).find((name) => name.endsWith(".jsonl")),
      "expected event file for malformed payload test",
    );
    const eventFilePath = join(eventsRoot, fileName);
    writeFileSync(
      eventFilePath,
      `\n${JSON.stringify({
        id: "evt_bad_payload",
        sessionId,
        type: "broken_event",
        timestamp: 101,
        payload: ["not", "a", "record"],
      })}`,
      { flag: "a" },
    );

    const rows = store.list(sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.type).toBe("session_start");
  });

  test("returns immutable cached event rows", () => {
    const workspace = createTestWorkspace("tape-store-immutable");
    const store = new BrewvaEventStore(DEFAULT_BREWVA_CONFIG.infrastructure.events, workspace);
    const sessionId = "tape-store-immutable-1";

    store.append({
      sessionId,
      type: "tool_call",
      payload: {
        toolName: "exec",
        nested: {
          command: "echo ok",
        },
      },
      timestamp: 100,
    });

    const row = requireDefined(store.list(sessionId)[0], "expected cached event row");

    expect(Object.isFrozen(row)).toBe(true);
    expect(Object.isFrozen(row.payload)).toBe(true);
    expect(Object.isFrozen(row.payload?.nested)).toBe(true);
  });

  test("supports time-range, tail, offset, and limit filters together", () => {
    const workspace = createTestWorkspace("tape-store-query-window");
    const store = new BrewvaEventStore(DEFAULT_BREWVA_CONFIG.infrastructure.events, workspace);
    const sessionId = "tape-store-query-window-1";

    store.append({
      sessionId,
      type: "task_event",
      timestamp: 100,
      payload: { index: 1 },
    });
    store.append({
      sessionId,
      type: "tool_result_recorded",
      timestamp: 200,
      payload: { index: 2 },
    });
    store.append({
      sessionId,
      type: "tool_result_recorded",
      timestamp: 300,
      payload: { index: 3 },
    });
    store.append({
      sessionId,
      type: "tool_result_recorded",
      timestamp: 400,
      payload: { index: 4 },
    });
    store.append({
      sessionId,
      type: "task_event",
      timestamp: 500,
      payload: { index: 5 },
    });

    const rows = store.list(sessionId, {
      type: "tool_result_recorded",
      after: 150,
      before: 450,
      last: 2,
      offset: 1,
      limit: 1,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.timestamp).toBe(400);
    expect(rows[0]?.payload).toEqual({ index: 4 });
  });

  test("falls back to scan semantics when timestamps are not monotonic", () => {
    const workspace = createTestWorkspace("tape-store-query-non-monotonic");
    const store = new BrewvaEventStore(DEFAULT_BREWVA_CONFIG.infrastructure.events, workspace);
    const sessionId = "tape-store-query-non-monotonic-1";

    store.append({
      sessionId,
      type: "tool_result_recorded",
      timestamp: 300,
      payload: { index: 1 },
    });
    store.append({
      sessionId,
      type: "tool_result_recorded",
      timestamp: 100,
      payload: { index: 2 },
    });
    store.append({
      sessionId,
      type: "tool_result_recorded",
      timestamp: 200,
      payload: { index: 3 },
    });

    const rows = store.list(sessionId, {
      type: "tool_result_recorded",
      after: 150,
      before: 250,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]?.timestamp).toBe(200);
    expect(rows[0]?.payload).toEqual({ index: 3 });
  });

  test("treats zero limit and empty time windows as empty results", () => {
    const workspace = createTestWorkspace("tape-store-query-empty");
    const store = new BrewvaEventStore(DEFAULT_BREWVA_CONFIG.infrastructure.events, workspace);
    const sessionId = "tape-store-query-empty-1";

    store.append({
      sessionId,
      type: "tool_result_recorded",
      timestamp: 100,
      payload: { index: 1 },
    });
    store.append({
      sessionId,
      type: "tool_result_recorded",
      timestamp: 200,
      payload: { index: 2 },
    });

    expect(
      store.list(sessionId, {
        type: "tool_result_recorded",
        limit: 0,
      }),
    ).toEqual([]);

    expect(
      store.list(sessionId, {
        type: "tool_result_recorded",
        after: 200,
        before: 200,
      }),
    ).toEqual([]);
  });
});
