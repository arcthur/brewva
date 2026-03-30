import { describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BrewvaRuntime,
  DEFAULT_BREWVA_CONFIG,
  buildTruthFactUpsertedEvent,
  type BrewvaConfig,
} from "@brewva/brewva-runtime";
import { createTestWorkspace } from "../../helpers/workspace.js";

function createConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  return config;
}

type RuntimeInternals = {
  sessionState: {
    getExistingCell: (session: string) => { turn: number; toolCalls: number } | undefined;
  };
  contextBudget: {
    sessions: Map<string, unknown>;
  };
  costTracker: {
    sessions: Map<string, unknown>;
    applyCostUpdateEvent: (
      session: string,
      payload: Record<string, unknown> | null,
      turn: number,
      timestamp: number,
    ) => void;
  };
  verificationGate: {
    stateStore: {
      sessions: Map<string, unknown>;
    };
  };
  eventStore: {
    fileHasContent: Map<string, boolean>;
  };
  turnReplay: {
    hasSession: (session: string) => boolean;
  };
  parallel: {
    sessions: Map<string, unknown>;
  };
  parallelResults: {
    sessions: Map<string, unknown>;
  };
};

describe("session state cleanup", () => {
  test("clearSessionState releases in-memory per-session caches", async () => {
    const workspace = createTestWorkspace("session-clean");
    const runtime = new BrewvaRuntime({ cwd: workspace, config: createConfig() });
    const sessionId = "cleanup-state-1";
    const internals = runtime as unknown as RuntimeInternals;

    runtime.context.onTurnStart(sessionId, 1);
    runtime.tools.markCall(sessionId, "edit");
    runtime.context.observeUsage(sessionId, {
      tokens: 128,
      contextWindow: 4096,
      percent: 0.03125,
    });
    runtime.tools.acquireParallelSlot(sessionId, "run-1");
    runtime.session.recordWorkerResult(sessionId, {
      workerId: "run-1",
      status: "ok",
      summary: "done",
      patches: {
        id: "ps-1",
        createdAt: Date.now(),
        changes: [
          { path: "src/a.ts", action: "modify", diffText: "diff", artifactRef: "artifacts/a.ts" },
        ],
      },
    });
    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo ok" },
      outputText: "ok",
      channelSuccess: true,
    });
    runtime.task.getState(sessionId);
    runtime.truth.getState(sessionId);
    runtime.cost.recordAssistantUsage({
      sessionId,
      model: "test-model",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
      costUsd: 0.0001,
    });

    const cell = internals.sessionState.getExistingCell(sessionId);
    expect(cell?.turn).toBeGreaterThan(0);
    expect(cell?.toolCalls).toBeGreaterThan(0);
    expect(internals.contextBudget.sessions.has(sessionId)).toBe(true);
    expect(internals.costTracker.sessions.has(sessionId)).toBe(true);
    expect(internals.verificationGate.stateStore.sessions.has(sessionId)).toBe(true);
    expect(internals.eventStore.fileHasContent.size).toBe(1);

    runtime.session.clearState(sessionId);

    expect(internals.sessionState.getExistingCell(sessionId)).toBeUndefined();
    expect(internals.turnReplay.hasSession(sessionId)).toBe(false);
    expect(internals.contextBudget.sessions.has(sessionId)).toBe(false);
    expect(internals.costTracker.sessions.has(sessionId)).toBe(false);
    expect(internals.verificationGate.stateStore.sessions.has(sessionId)).toBe(false);
    expect(internals.parallel.sessions.has(sessionId)).toBe(false);
    expect(internals.parallelResults.sessions.has(sessionId)).toBe(false);
    expect(internals.eventStore.fileHasContent.size).toBe(0);
  });

  test("keeps replay cache hot and incrementally updates task replay view", async () => {
    const workspace = createTestWorkspace("replay-view");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "replay-view-1";
    const internals = runtime as unknown as RuntimeInternals;

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Replay view should rebuild after new events",
    });
    runtime.task.getState(sessionId);

    expect(internals.turnReplay.hasSession(sessionId)).toBe(true);

    runtime.task.addItem(sessionId, { text: "item-1" });
    expect(internals.turnReplay.hasSession(sessionId)).toBe(true);

    const updated = runtime.task.getState(sessionId);
    expect(updated.items).toHaveLength(1);
    expect(updated.items[0]?.text).toBe("item-1");
    expect(internals.turnReplay.hasSession(sessionId)).toBe(true);
  });

  test("keeps replay cache for non-folding events and incrementally folds truth updates", async () => {
    const workspace = createTestWorkspace("replay-filter");
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "replay-filter-1";
    const internals = runtime as unknown as RuntimeInternals;

    runtime.task.setSpec(sessionId, {
      schema: "brewva.task.v1",
      goal: "Replay cache should ignore non-folding events",
    });
    runtime.task.getState(sessionId);

    expect(internals.turnReplay.hasSession(sessionId)).toBe(true);

    runtime.events.record({
      sessionId,
      type: "tool_call",
      payload: {
        toolCallId: "tc-1",
        toolName: "look_at",
      },
    });
    expect(internals.turnReplay.hasSession(sessionId)).toBe(true);

    runtime.events.record({
      sessionId,
      type: "truth_event",
      payload: buildTruthFactUpsertedEvent({
        id: "truth-1",
        kind: "test",
        status: "active",
        severity: "warn",
        summary: "truth update",
        evidenceIds: ["led-1"],
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
      }) as unknown as Record<string, unknown>,
    });
    expect(internals.turnReplay.hasSession(sessionId)).toBe(true);

    const truthState = runtime.truth.getState(sessionId);
    expect(truthState.facts).toHaveLength(1);
    expect(truthState.facts[0]?.id).toBe("truth-1");
    expect(internals.turnReplay.hasSession(sessionId)).toBe(true);
  });

  test("marks session hydration degraded when replaying a persisted event fails", () => {
    const workspace = createTestWorkspace("hydration-degraded");
    const sessionId = "hydration-degraded-1";

    const writerRuntime = new BrewvaRuntime({ cwd: workspace });
    writerRuntime.cost.recordAssistantUsage({
      sessionId,
      model: "test-model",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
      costUsd: 0.0001,
    });

    const readerRuntime = new BrewvaRuntime({ cwd: workspace });
    const internals = readerRuntime as unknown as RuntimeInternals;
    internals.costTracker.applyCostUpdateEvent = () => {
      throw new Error("hydration exploded");
    };

    const hydration = readerRuntime.session.getHydration(sessionId);
    expect(hydration.status).toBe("degraded");
    expect(hydration.issues).toHaveLength(1);
    expect(hydration.issues[0]?.domain).toBe("event_tape");
    expect(hydration.issues[0]?.severity).toBe("degraded");
    expect(hydration.issues[0]?.eventType).toBe("cost_update");
    expect(hydration.issues[0]?.reason).toContain("hydration exploded");
    expect(hydration.latestEventId).toBeDefined();

    const integrity = readerRuntime.session.getIntegrity(sessionId);
    expect(integrity.status).toBe("degraded");
    expect(integrity.issues).toHaveLength(1);
  });

  test("marks session hydration degraded when the persisted event tape contains malformed rows", () => {
    const workspace = createTestWorkspace("hydration-corrupt-tape");
    const sessionId = "hydration-corrupt-tape-1";

    const writerRuntime = new BrewvaRuntime({ cwd: workspace });
    writerRuntime.events.record({
      sessionId,
      type: "session_start",
      payload: { cwd: workspace },
    });
    const encoded = Buffer.from(sessionId, "utf8").toString("base64url");
    const eventFilePath = resolve(
      workspace,
      DEFAULT_BREWVA_CONFIG.infrastructure.events.dir,
      `sess_${encoded}.jsonl`,
    );
    appendFileSync(eventFilePath, '\n{"broken":\n', "utf8");

    const readerRuntime = new BrewvaRuntime({ cwd: workspace });
    const hydration = readerRuntime.session.getHydration(sessionId);
    expect(hydration.status).toBe("degraded");
    expect(hydration.issues.some((issue) => issue.reason === "event_store_malformed_row")).toBe(
      true,
    );

    const integrity = readerRuntime.session.getIntegrity(sessionId);
    expect(integrity.status).toBe("degraded");
    expect(integrity.issues.some((issue) => issue.domain === "event_tape")).toBe(true);
  });

  test("refreshes hydration and integrity when tape corruption appears after initial hydration", () => {
    const workspace = createTestWorkspace("hydration-corrupt-after-ready");
    const sessionId = "hydration-corrupt-after-ready-1";

    const runtime = new BrewvaRuntime({ cwd: workspace });
    runtime.events.record({
      sessionId,
      type: "session_start",
      payload: { cwd: workspace },
    });

    const initialHydration = runtime.session.getHydration(sessionId);
    expect(initialHydration.status).toBe("ready");

    const encoded = Buffer.from(sessionId, "utf8").toString("base64url");
    const eventFilePath = resolve(
      workspace,
      DEFAULT_BREWVA_CONFIG.infrastructure.events.dir,
      `sess_${encoded}.jsonl`,
    );
    appendFileSync(eventFilePath, '\n{"broken":\n', "utf8");

    const hydration = runtime.session.getHydration(sessionId);
    expect(hydration.status).toBe("degraded");
    expect(hydration.issues.some((issue) => issue.reason === "event_store_malformed_row")).toBe(
      true,
    );

    const integrity = runtime.session.getIntegrity(sessionId);
    expect(integrity.status).toBe("degraded");
    expect(
      integrity.issues.some(
        (issue) => issue.domain === "event_tape" && issue.reason === "event_store_malformed_row",
      ),
    ).toBe(true);
  });
});
