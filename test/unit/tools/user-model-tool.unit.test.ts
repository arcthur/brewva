import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrewvaToolRuntime } from "@brewva/brewva-tools/contracts";
import { createUserModelTool } from "@brewva/brewva-tools/memory";
import type { BrewvaEventRecord } from "@brewva/brewva-vocabulary/events";
import { USER_FACT_RECORDED_EVENT_TYPE } from "@brewva/brewva-vocabulary/user-model";
import { toolOutcomePayload } from "../../helpers/tool-outcome.js";

// Phase 3 wiring of rfc-user-model-as-a-tape-folded-advisory-projection: the user_model tool
// pulls the cross-session model the recall broker folds from the session index. These tests
// exercise the real broker + a real (temp) SQLite index over a fake event source — the
// broker's first query catches up the seeded user.fact.recorded events, so the tool renders
// the folded projection. The session-index-unavailable fallback to the session-local
// runtime-ops projection mirrors recall_search's `.catch(isRecallSessionIndexUnavailable)`
// (covered there) and is not re-forced here.

function createToolContext(sessionId = "session-user-model") {
  return {
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
    },
  };
}

function userFactEvent(input: {
  id: string;
  sessionId: string;
  scope: "user" | "project";
  factKey: string;
  value: string;
  timestamp: number;
}): BrewvaEventRecord {
  return {
    id: input.id,
    sessionId: input.sessionId,
    turn: 0,
    type: USER_FACT_RECORDED_EVENT_TYPE,
    timestamp: input.timestamp,
    payload: {
      id: input.id,
      scope: input.scope,
      factKey: input.factKey,
      value: input.value,
      grade: "estimated",
      sourceRefs: ["turn:1"],
      reason: "authored from the conversation",
      createdAt: input.timestamp,
    },
  };
}

function runtimeWith(
  workspaceRoot: string,
  records: readonly BrewvaEventRecord[],
): BrewvaToolRuntime {
  const bySession = new Map<string, BrewvaEventRecord[]>();
  for (const record of records) {
    const list = bySession.get(record.sessionId) ?? [];
    list.push(record);
    bySession.set(record.sessionId, list);
  }
  return {
    identity: { cwd: workspaceRoot, workspaceRoot, agentId: "agent-test" },
    config: {} as BrewvaToolRuntime["config"],
    capabilities: {
      events: {
        records: {
          listSessionIds: () => [...bySession.keys()],
          list: (sessionId: string) => bySession.get(sessionId) ?? [],
          subscribe: () => () => {},
        },
      },
      // Every session shares the workspace repo root, so user_repository_root keeps them all
      // in scope (the cross-session scope rules are pinned in broker-user-model.unit.test.ts).
      task: {
        target: { getDescriptor: () => ({ primaryRoot: workspaceRoot, roots: [workspaceRoot] }) },
      },
      skills: { catalog: undefined },
    } as unknown as BrewvaToolRuntime["capabilities"],
    extensions: {},
  } as unknown as BrewvaToolRuntime;
}

describe("user_model tool", () => {
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), "brewva-user-model-tool-"));
  });

  afterEach(() => {
    rmSync(workspaceRoot, { recursive: true, force: true });
  });

  test("returns the cross-session folded user model as an explicit pull", async () => {
    const tool = createUserModelTool({
      runtime: runtimeWith(workspaceRoot, [
        userFactEvent({
          id: "f1",
          sessionId: "s1",
          scope: "user",
          factKey: "style",
          value: "terse",
          timestamp: 1_000,
        }),
        userFactEvent({
          id: "f2",
          sessionId: "s1",
          scope: "project",
          factKey: "build_tool",
          value: "bun",
          timestamp: 2_000,
        }),
      ]),
    });
    const result = await tool.execute(
      "call-user-model",
      {},
      new AbortController().signal,
      async () => undefined,
      createToolContext() as never,
    );
    const payload = toolOutcomePayload(result) as {
      ok: boolean;
      count: number;
      facts: Array<{
        scope: string;
        factKey: string;
        grade: string;
        reason: string;
        sourceRefs: string[];
        entryId: string;
      }>;
    };
    expect(payload.ok).toBe(true);
    expect(payload.count).toBe(2);
    // Sorted by (scope, factKey): project build_tool, then user style.
    expect(payload.facts.map((entry) => `${entry.scope}/${entry.factKey}`)).toEqual([
      "project/build_tool",
      "user/style",
    ]);
    // A single authoring session grades estimated (the honest floor).
    expect(payload.facts.every((entry) => entry.grade === "estimated")).toBe(true);
    // The structured payload carries provenance for audit (reason, evidence refs, entry id).
    const userStyle = payload.facts.find((entry) => entry.scope === "user");
    expect(userStyle?.reason).toBe("authored from the conversation");
    expect(userStyle?.sourceRefs).toEqual(["turn:1"]);
    expect(userStyle?.entryId).toBe("f1");
  });

  test("filters by scope when provided", async () => {
    const tool = createUserModelTool({
      runtime: runtimeWith(workspaceRoot, [
        userFactEvent({
          id: "f1",
          sessionId: "s1",
          scope: "user",
          factKey: "style",
          value: "terse",
          timestamp: 1_000,
        }),
        userFactEvent({
          id: "f2",
          sessionId: "s1",
          scope: "project",
          factKey: "build_tool",
          value: "bun",
          timestamp: 2_000,
        }),
      ]),
    });
    const result = await tool.execute(
      "call-scope",
      { scope: "project" },
      new AbortController().signal,
      async () => undefined,
      createToolContext() as never,
    );
    const payload = toolOutcomePayload(result) as {
      count: number;
      facts: Array<{ scope: string }>;
    };
    expect(payload.count).toBe(1);
    expect(payload.facts[0]?.scope).toBe("project");
  });

  test("reports an empty model without error", async () => {
    const tool = createUserModelTool({ runtime: runtimeWith(workspaceRoot, []) });
    const result = await tool.execute(
      "call-empty",
      {},
      new AbortController().signal,
      async () => undefined,
      createToolContext() as never,
    );
    expect(toolOutcomePayload(result)).toMatchObject({ ok: true, count: 0 });
  });
});
