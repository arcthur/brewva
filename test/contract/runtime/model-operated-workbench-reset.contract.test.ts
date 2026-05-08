import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import {
  RUNTIME_CONTRACT_CONFIG_PATH,
  createRuntimeContractConfig as createConfig,
  createRuntimeContractWorkspace as createWorkspace,
  writeRuntimeContractConfig as writeConfig,
} from "./runtime-contract.helpers.js";

describe("model-operated workbench reset", () => {
  test("removes context-source registry and injection from the runtime surface", async () => {
    const runtimeModule = await import("@brewva/brewva-runtime");
    const contextModule = await import("@brewva/brewva-runtime/context");
    const runtime = new BrewvaRuntime();

    expect("defineContextSourceProvider" in runtimeModule).toBe(false);
    expect("ContextSourceProviderRegistry" in runtimeModule).toBe(false);
    expect("ContextInjectionCollector" in contextModule).toBe(false);
    expect("registerProvider" in runtime.maintain.context).toBe(false);
    expect("unregisterProvider" in runtime.maintain.context).toBe(false);
    expect("listProviders" in runtime.inspect.context).toBe(false);
    expect("buildInjection" in runtime.maintain.context).toBe(false);
    expect("appendGuardedSupplementalBlocks" in runtime.maintain.context).toBe(false);
  });

  test("records free-text workbench notes and reversible evictions", () => {
    const runtime = new BrewvaRuntime({ cwd: createWorkspace("workbench-reset-memory") });
    const sessionId = "workbench-reset-1";

    const note = runtime.maintain.workbench.note(sessionId, {
      content: "## Current Work\nRefactor context into a model-authored workbench.",
      sourceRefs: [
        "turn:1",
        "file:docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md",
      ],
      reason: "The model needs this state after compaction.",
    });

    const eviction = runtime.maintain.workbench.evict(sessionId, {
      spanRefs: ["tool:read-large-output"],
      replacementNote: "Large output was inspected; relevant result is the failing import path.",
      reason: "Tool output body is no longer useful in default rendering.",
      preservedQuotes: ["Cannot find module './provider.js'"],
    });

    const entries = runtime.inspect.workbench.list(sessionId);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      id: note.id,
      kind: "note",
      content: "## Current Work\nRefactor context into a model-authored workbench.",
      sourceRefs: [
        "turn:1",
        "file:docs/research/decisions/model-operated-working-memory-and-context-governance-reset.md",
      ],
      reason: "The model needs this state after compaction.",
      baselineCommitted: false,
    });
    expect(entries[1]).toMatchObject({
      id: eviction.id,
      kind: "eviction",
      content: "Large output was inspected; relevant result is the failing import path.",
      sourceRefs: ["tool:read-large-output"],
      reason: "Tool output body is no longer useful in default rendering.",
      preservedQuotes: ["Cannot find module './provider.js'"],
      reversible: true,
      baselineCommitted: false,
    });

    expect(runtime.maintain.workbench.undoEviction(sessionId, eviction.id).undone).toBe(true);
    expect(runtime.inspect.workbench.list(sessionId).map((entry) => entry.id)).toEqual([note.id]);
  });

  test("compaction commits the workbench reversibility baseline", () => {
    const runtime = new BrewvaRuntime({ cwd: createWorkspace("workbench-reset-baseline") });
    const sessionId = "workbench-reset-baseline";

    runtime.maintain.context.onTurnStart(sessionId, 1);
    const note = runtime.maintain.workbench.note(sessionId, {
      content: "Current objective: finish Phase A cleanup.",
      sourceRefs: ["turn:1"],
      reason: "Active objective should survive compaction.",
    });
    const eviction = runtime.maintain.workbench.evict(sessionId, {
      spanRefs: ["tool:large-output"],
      replacementNote: "Large output was inspected; only the import path mattered.",
      reason: "Raw output should not stay in active attention.",
    });

    runtime.authority.session.commitCompaction(sessionId, {
      compactId: "cmp-workbench-baseline",
      sanitizedSummary: "[CompactSummary]\nKeep the active Phase A cleanup objective.",
      summaryDigest: "summary-digest",
      sourceTurn: 1,
      leafEntryId: null,
      referenceContextDigest: null,
      fromTokens: 900,
      toTokens: 240,
      origin: "extension_api",
    });

    expect(runtime.inspect.workbench.list(sessionId)).toEqual([
      expect.objectContaining({
        id: note.id,
        baselineCommitted: true,
        reversible: false,
      }),
      expect.objectContaining({
        id: eviction.id,
        baselineCommitted: true,
        reversible: false,
      }),
    ]);
    expect(runtime.maintain.workbench.undoEviction(sessionId, eviction.id).undone).toBe(false);
    expect(
      runtime.inspect.events.query(sessionId, { type: "workbench_baseline_committed" }),
    ).toEqual([
      expect.objectContaining({
        payload: {
          entryIds: [note.id, eviction.id],
        },
      }),
    ]);
  });

  test("dedupes identical workbench entries inside the same runtime turn", () => {
    const runtime = new BrewvaRuntime({ cwd: createWorkspace("workbench-reset-dedupe") });
    const sessionId = "workbench-reset-dedupe";

    runtime.maintain.context.onTurnStart(sessionId, 4);
    const first = runtime.maintain.workbench.note(sessionId, {
      content: "Current objective: keep the workbench notebook minimal.",
      sourceRefs: ["turn:4"],
      reason: "Same-turn duplicate should collapse by deterministic id.",
    });
    const second = runtime.maintain.workbench.note(sessionId, {
      content: "Current objective: keep the workbench notebook minimal.",
      sourceRefs: ["turn:4"],
      reason: "Same-turn duplicate should collapse by deterministic id.",
    });

    expect(second.id).toBe(first.id);
    expect(runtime.inspect.workbench.list(sessionId).map((entry) => entry.id)).toEqual([first.id]);
  });

  test("rejects non-renderable eviction span refs", () => {
    const runtime = new BrewvaRuntime({ cwd: createWorkspace("workbench-reset-ref-schema") });

    expect(() =>
      runtime.maintain.workbench.evict("workbench-reset-ref-schema", {
        spanRefs: ["topic:provider-registry"],
        reason: "Eviction refs must target renderable context spans.",
      }),
    ).toThrow("invalid_workbench_eviction_span_refs");
  });

  test("exposes numeric context status without pressure levels", () => {
    const workspace = createWorkspace("workbench-context-status");
    writeConfig(
      workspace,
      createConfig({
        infrastructure: {
          contextBudget: {
            enabled: true,
            thresholds: {
              compactionFloorPercent: 0.8,
              compactionCeilingPercent: 0.8,
              compactionHeadroomTokens: 0,
              hardLimitFloorPercent: 0.9,
              hardLimitCeilingPercent: 0.9,
              hardLimitHeadroomTokens: 0,
            },
          },
        },
      }),
    );
    const runtime = new BrewvaRuntime({ cwd: workspace, configPath: RUNTIME_CONTRACT_CONFIG_PATH });
    const sessionId = "workbench-context-status-1";

    runtime.maintain.context.observeUsage(sessionId, {
      tokens: 850,
      contextWindow: 1000,
      percent: 0.85,
    });

    const status = runtime.inspect.context.getStatus(sessionId);
    expect(status).toEqual({
      tokensUsed: 850,
      tokensTotal: 1000,
      tokensRemaining: 150,
      tokensUntilForcedCompact: 50,
      predictedTurnGrowthTokens: 0,
      tokensUntilPredictedOverflow: 50,
      predictedOverflow: false,
      usageRatio: 0.85,
      hardLimitRatio: 0.9,
      compactionThresholdRatio: 0.8,
      compactionAdvised: true,
      forcedCompaction: false,
    });
    expect("level" in status).toBe(false);
    expect("pressure" in status).toBe(false);
  });
});
