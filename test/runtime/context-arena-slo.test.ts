import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrewvaRuntime,
  ContextArena,
  DEFAULT_BREWVA_CONFIG,
  type BrewvaConfig,
} from "@brewva/brewva-runtime";

function createRuntimeSloConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.infrastructure.contextBudget.maxInjectionTokens = 4_000;
  config.infrastructure.contextBudget.arena.maxEntriesPerSession = 1;
  config.infrastructure.toolFailureInjection.enabled = false;
  config.memory.enabled = false;
  return config;
}

describe("ContextArena SLO enforcement", () => {
  const sessionId = "context-arena-slo-session";

  test("drop_recall policy evicts recall entries when arena is full", () => {
    const arena = new ContextArena({
      maxEntriesPerSession: 5,
    });

    arena.append(sessionId, {
      source: "brewva.identity",
      id: "id-1",
      content: "identity entry 1",
      priority: "critical",
    });
    arena.append(sessionId, {
      source: "brewva.identity",
      id: "id-2",
      content: "identity entry 2",
      priority: "critical",
    });
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-1",
      content: "truth entry 1",
      priority: "high",
    });
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-2",
      content: "truth entry 2",
      priority: "high",
    });
    arena.append(sessionId, {
      source: "brewva.memory-recall",
      id: "recall-1",
      content: "recall entry 1",
      priority: "normal",
    });

    const result = arena.append(sessionId, {
      source: "brewva.identity",
      id: "id-3",
      content: "identity entry 3",
      priority: "critical",
    });

    expect(result.accepted).toBe(true);
    expect(result.sloEnforced).toBeDefined();
    expect(result.sloEnforced?.dropped).toBe(false);
    expect(result.sloEnforced?.entriesBefore).toBe(5);
    expect(result.sloEnforced?.entriesAfter).toBeLessThan(5);
  });

  test("drop_recall policy drops incoming recall when arena is full with no recall to evict", () => {
    const arena = new ContextArena({
      maxEntriesPerSession: 5,
    });

    arena.append(sessionId, {
      source: "brewva.identity",
      id: "id-1",
      content: "identity entry 1",
      priority: "critical",
    });
    arena.append(sessionId, {
      source: "brewva.identity",
      id: "id-2",
      content: "identity entry 2",
      priority: "critical",
    });
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-1",
      content: "truth entry 1",
      priority: "high",
    });
    arena.append(sessionId, {
      source: "brewva.truth-facts",
      id: "truth-2",
      content: "truth entry 2",
      priority: "high",
    });
    arena.append(sessionId, {
      source: "brewva.task-state",
      id: "task-1",
      content: "task entry 1",
      priority: "high",
    });

    const result = arena.append(sessionId, {
      source: "brewva.memory-recall",
      id: "recall-1",
      content: "recall entry 1",
      priority: "normal",
    });

    expect(result.accepted).toBe(false);
    expect(result.sloEnforced).toBeDefined();
    expect(result.sloEnforced?.dropped).toBe(true);
  });

  test("runtime emits drop_recall SLO event payload when maxEntriesPerSession is hit", async () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-context-slo-drop-recall-")),
      config: createRuntimeSloConfig(),
    });
    const runtimeSessionId = "context-slo-drop-recall-event";
    runtime.context.onTurnStart(runtimeSessionId, 1);
    runtime.task.setSpec(runtimeSessionId, {
      schema: "brewva.task.v1",
      goal: "Verify drop_recall SLO event payload shape",
    });
    runtime.truth.upsertFact(runtimeSessionId, {
      id: "truth:slo:drop_recall",
      kind: "diagnostic",
      severity: "warn",
      summary: "SLO payload probe",
    });

    await runtime.context.buildInjection(runtimeSessionId, "trigger drop_recall");

    const event = runtime.events.query(runtimeSessionId, {
      type: "context_arena_slo_enforced",
      last: 1,
    })[0];
    expect(event).toBeDefined();
    const payload = event?.payload as
      | {
          entriesBefore?: number;
          entriesAfter?: number;
          dropped?: boolean;
          source?: string;
        }
      | undefined;
    expect(typeof payload?.entriesBefore).toBe("number");
    expect(typeof payload?.entriesAfter).toBe("number");
    expect((payload?.entriesBefore ?? 0) >= 1).toBe(true);
    expect((payload?.entriesAfter ?? 0) <= (payload?.entriesBefore ?? 0)).toBe(true);
    expect(typeof payload?.dropped).toBe("boolean");
    expect(typeof payload?.source).toBe("string");
  });
});
