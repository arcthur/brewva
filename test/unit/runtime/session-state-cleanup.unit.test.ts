import { describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import type { BrewvaConfig } from "@brewva/brewva-runtime";
import { buildClaimUpsertedEvent } from "@brewva/brewva-runtime/claim";
import { createRuntimeWithInternals } from "../../helpers/runtime-internals.js";
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
    eventCacheByFilePath: Map<string, unknown>;
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
    const { runtimeInstance, internals } = createRuntimeWithInternals({
      cwd: workspace,
      config: createConfig(),
    });
    const runtime = runtimeInstance.hosted;
    const sessionId = "cleanup-state-1";
    const runtimeInternals = internals as RuntimeInternals;

    runtime.operator.context.lifecycle.onTurnStart(sessionId, 1);
    runtime.authority.tools.tracking.markCall(sessionId, "edit");
    runtime.operator.context.usage.observe(sessionId, {
      tokens: 128,
      contextWindow: 4096,
      percent: 0.03125,
    });
    runtime.authority.tools.parallel.acquire(sessionId, "run-1");
    runtime.authority.session.workerResults.record(sessionId, {
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
    runtime.authority.tools.invocation.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo ok" },
      outputText: "ok",
      channelSuccess: true,
    });
    runtime.inspect.task.state.get(sessionId);
    runtime.inspect.claim.state.get(sessionId);
    runtime.authority.cost.usage.recordAssistant({
      sessionId,
      model: "test-model",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
      costUsd: 0.0001,
    });

    const cell = runtimeInternals.sessionState.getExistingCell(sessionId);
    expect(cell?.turn).toBeGreaterThan(0);
    expect(cell?.toolCalls).toBeGreaterThan(0);
    expect(runtimeInternals.contextBudget.sessions.has(sessionId)).toBe(true);
    expect(runtimeInternals.costTracker.sessions.has(sessionId)).toBe(true);
    expect(runtimeInternals.verificationGate.stateStore.sessions.has(sessionId)).toBe(true);
    expect(runtime.inspect.events.records.list(sessionId, { last: 1 })).toHaveLength(1);
    expect(runtimeInternals.eventStore.eventCacheByFilePath.size).toBe(1);

    runtime.operator.session.state.clear(sessionId);

    expect(runtimeInternals.sessionState.getExistingCell(sessionId)).toBeUndefined();
    expect(runtimeInternals.turnReplay.hasSession(sessionId)).toBe(false);
    expect(runtimeInternals.contextBudget.sessions.has(sessionId)).toBe(false);
    expect(runtimeInternals.costTracker.sessions.has(sessionId)).toBe(false);
    expect(runtimeInternals.verificationGate.stateStore.sessions.has(sessionId)).toBe(false);
    expect(runtimeInternals.parallel.sessions.has(sessionId)).toBe(false);
    expect(runtimeInternals.parallelResults.sessions.has(sessionId)).toBe(false);
    expect(runtimeInternals.eventStore.eventCacheByFilePath.size).toBe(0);
  });

  test("keeps replay cache hot and incrementally updates task replay view", async () => {
    const workspace = createTestWorkspace("replay-view");
    const { runtimeInstance, internals } = createRuntimeWithInternals({ cwd: workspace });
    const runtime = runtimeInstance.hosted;
    const sessionId = "replay-view-1";
    const runtimeInternals = internals as RuntimeInternals;

    runtime.authority.task.spec.set(sessionId, {
      schema: "brewva.task.v1",
      goal: "Replay view should rebuild after new events",
    });
    runtime.inspect.task.state.get(sessionId);

    expect(runtimeInternals.turnReplay.hasSession(sessionId)).toBe(true);

    runtime.authority.task.items.add(sessionId, { text: "item-1" });
    expect(runtimeInternals.turnReplay.hasSession(sessionId)).toBe(true);

    const updated = runtime.inspect.task.state.get(sessionId);
    expect(updated.items).toHaveLength(1);
    expect(updated.items[0]?.text).toBe("item-1");
    expect(runtimeInternals.turnReplay.hasSession(sessionId)).toBe(true);
  });

  test("keeps replay cache for non-folding events and incrementally folds claim updates", async () => {
    const workspace = createTestWorkspace("replay-filter");
    const { runtimeInstance, internals } = createRuntimeWithInternals({ cwd: workspace });
    const runtime = runtimeInstance.hosted;
    const sessionId = "replay-filter-1";
    const runtimeInternals = internals as RuntimeInternals;

    runtime.authority.task.spec.set(sessionId, {
      schema: "brewva.task.v1",
      goal: "Replay cache should ignore non-folding events",
    });
    runtime.inspect.task.state.get(sessionId);

    expect(runtimeInternals.turnReplay.hasSession(sessionId)).toBe(true);

    runtime.extensions.hosted.events.record({
      sessionId,
      type: "tool_call",
      payload: {
        toolCallId: "tc-1",
        toolName: "look_at",
      },
    });
    expect(runtimeInternals.turnReplay.hasSession(sessionId)).toBe(true);

    runtime.extensions.hosted.events.record({
      sessionId,
      type: "claim_event",
      payload: buildClaimUpsertedEvent({
        id: "claim-1",
        kind: "test",
        status: "active",
        severity: "warn",
        summary: "claim update",
        evidenceIds: ["led-1"],
        firstSeenAt: Date.now(),
        lastSeenAt: Date.now(),
      }) as unknown as Record<string, unknown>,
    });
    expect(runtimeInternals.turnReplay.hasSession(sessionId)).toBe(true);

    const claimState = runtime.inspect.claim.state.get(sessionId);
    expect(claimState.claims).toHaveLength(1);
    expect(claimState.claims[0]?.id).toBe("claim-1");
    expect(runtimeInternals.turnReplay.hasSession(sessionId)).toBe(true);
  });

  test("marks session hydration degraded when replaying a persisted event fails", () => {
    const workspace = createTestWorkspace("hydration-degraded");
    const sessionId = "hydration-degraded-1";

    const writerRuntime = createBrewvaRuntime({ cwd: workspace }).hosted;
    writerRuntime.authority.cost.usage.recordAssistant({
      sessionId,
      model: "test-model",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
      costUsd: 0.0001,
    });

    const { runtimeInstance: readerRuntimeInstance, internals } = createRuntimeWithInternals({
      cwd: workspace,
    });
    const readerRuntime = readerRuntimeInstance.hosted;
    const runtimeInternals = internals as RuntimeInternals;
    runtimeInternals.costTracker.applyCostUpdateEvent = () => {
      throw new Error("hydration exploded");
    };

    const hydration = readerRuntime.inspect.session.lifecycle.getHydration(sessionId);
    expect(hydration.status).toBe("degraded");
    expect(hydration.issues).toHaveLength(1);
    expect(hydration.issues[0]?.domain).toBe("event_tape");
    expect(hydration.issues[0]?.severity).toBe("degraded");
    expect(hydration.issues[0]?.eventType).toBe("cost_update");
    expect(hydration.issues[0]?.reason).toContain("hydration exploded");
    expect(hydration.latestEventId).toBeDefined();

    const integrity = readerRuntime.inspect.session.lifecycle.getIntegrity(sessionId);
    expect(integrity.status).toBe("degraded");
    expect(integrity.issues).toHaveLength(1);
  });

  test("marks session hydration degraded when the persisted event tape contains malformed rows", () => {
    const workspace = createTestWorkspace("hydration-corrupt-tape");
    const sessionId = "hydration-corrupt-tape-1";

    const writerRuntime = createBrewvaRuntime({ cwd: workspace }).hosted;
    writerRuntime.extensions.hosted.events.record({
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

    const readerRuntime = createBrewvaRuntime({ cwd: workspace }).hosted;
    const hydration = readerRuntime.inspect.session.lifecycle.getHydration(sessionId);
    expect(hydration.status).toBe("degraded");
    expect(hydration.issues.some((issue) => issue.reason === "event_store_malformed_row")).toBe(
      true,
    );

    const integrity = readerRuntime.inspect.session.lifecycle.getIntegrity(sessionId);
    expect(integrity.status).toBe("degraded");
    expect(integrity.issues.some((issue) => issue.domain === "event_tape")).toBe(true);
  });

  test("refreshes hydration and integrity when tape corruption appears after initial hydration", () => {
    const workspace = createTestWorkspace("hydration-corrupt-after-ready");
    const sessionId = "hydration-corrupt-after-ready-1";

    const runtime = createBrewvaRuntime({ cwd: workspace }).hosted;
    runtime.extensions.hosted.events.record({
      sessionId,
      type: "session_start",
      payload: { cwd: workspace },
    });

    const initialHydration = runtime.inspect.session.lifecycle.getHydration(sessionId);
    expect(initialHydration.status).toBe("ready");

    const encoded = Buffer.from(sessionId, "utf8").toString("base64url");
    const eventFilePath = resolve(
      workspace,
      DEFAULT_BREWVA_CONFIG.infrastructure.events.dir,
      `sess_${encoded}.jsonl`,
    );
    appendFileSync(eventFilePath, '\n{"broken":\n', "utf8");

    const hydration = runtime.inspect.session.lifecycle.getHydration(sessionId);
    expect(hydration.status).toBe("degraded");
    expect(hydration.issues.some((issue) => issue.reason === "event_store_malformed_row")).toBe(
      true,
    );

    const integrity = runtime.inspect.session.lifecycle.getIntegrity(sessionId);
    expect(integrity.status).toBe("degraded");
    expect(
      integrity.issues.some(
        (issue) => issue.domain === "event_tape" && issue.reason === "event_store_malformed_row",
      ),
    ).toBe(true);
  });
});
