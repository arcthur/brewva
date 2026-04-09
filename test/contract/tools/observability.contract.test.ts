import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BrewvaRuntime,
  ITERATION_METRIC_OBSERVED_EVENT_TYPE,
  VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
} from "@brewva/brewva-runtime";
import { recordRuntimeEvent } from "@brewva/brewva-runtime/internal";
import {
  createCostViewTool,
  createObsQueryTool,
  createObsSloAssertTool,
  createObsSnapshotTool,
} from "@brewva/brewva-tools";
import { createBundledToolRuntime, createRuntimeConfig } from "../../helpers/runtime.js";
import { cleanupWorkspace, createTestWorkspace } from "../../helpers/workspace.js";
import { extractTextContent, fakeContext } from "./tools-flow.helpers.js";

let workspace = "";

beforeEach(() => {
  workspace = createTestWorkspace("observability-tools-contract");
});

afterEach(() => {
  if (workspace) cleanupWorkspace(workspace);
});

function createCleanRuntime(cwd = workspace): BrewvaRuntime {
  return new BrewvaRuntime({
    cwd,
    config: createRuntimeConfig(),
  });
}

describe("observability tool contracts", () => {
  test("cost_view returns session, skill, and tool breakdowns", async () => {
    const runtime = createCleanRuntime();
    const sessionId = "s10";
    runtime.maintain.context.onTurnStart(sessionId, 1);
    runtime.authority.tools.markCall(sessionId, "read");
    runtime.authority.cost.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 15,
      costUsd: 0.001,
    });

    const tool = createCostViewTool({ runtime });
    const result = await tool.execute(
      "tc-cost",
      { top: 3 },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const text = extractTextContent(result);
    expect(text).toContain("# Cost View");
    expect(text).toContain("Top Skills");
    expect(text).toContain("Top Tools");
  });

  test("obs_query persists a raw artifact and returns a compact summary", async () => {
    const obsQueryWorkspace = mkdtempSync(join(tmpdir(), "brewva-tools-obs-query-"));
    const runtime = new BrewvaRuntime({ cwd: obsQueryWorkspace });
    const sessionId = "s10-obs-query";

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "latency_sample",
      payload: {
        service: "api",
        latencyMs: 810,
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: "latency_sample",
      payload: {
        service: "api",
        latencyMs: 790,
      },
    });

    const tool = createObsQueryTool({ runtime: createBundledToolRuntime(runtime) });
    const result = await tool.execute(
      "tc-obs-query",
      {
        types: ["latency_sample"],
        where: { service: "api" },
        metric: "latencyMs",
        aggregation: "p95",
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );

    const text = extractTextContent(result);
    expect(text).toContain("[ObsQuery]");
    expect(text).toContain("query_ref:");
    expect(text).toContain("observed_value:");

    const artifactOverride = (result.details as { artifactOverride?: { artifactRef?: string } })
      ?.artifactOverride;
    expect(typeof artifactOverride?.artifactRef).toBe("string");
    expect(
      readFileSync(join(obsQueryWorkspace, artifactOverride?.artifactRef ?? ""), "utf8"),
    ).toContain('"schema": "brewva.observability.query.v1"');
  });

  test("obs_slo_assert returns a fail verdict and obs_snapshot exposes runtime health", async () => {
    const obsSnapshotWorkspace = mkdtempSync(join(tmpdir(), "brewva-tools-obs-snapshot-"));
    const runtime = new BrewvaRuntime({ cwd: obsSnapshotWorkspace });
    const sessionId = "s10-obs-snapshot";

    recordRuntimeEvent(runtime, {
      sessionId,
      type: "startup_sample",
      payload: {
        service: "api",
        startupMs: 920,
      },
    });
    recordRuntimeEvent(runtime, {
      sessionId,
      type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
      payload: {
        level: "standard",
        outcome: "passed",
      },
    });
    runtime.maintain.context.observePromptStability(sessionId, {
      stablePrefixHash: "prefix-1",
      dynamicTailHash: "tail-1",
      injectionScopeId: "leaf-1",
      turn: 1,
      timestamp: 1_740_000_000_100,
    });
    runtime.maintain.context.observeTransientReduction(sessionId, {
      status: "completed",
      reason: null,
      eligibleToolResults: 6,
      clearedToolResults: 2,
      clearedChars: 2048,
      estimatedTokenSavings: 580,
      pressureLevel: "high",
      turn: 1,
      timestamp: 1_740_000_000_101,
    });
    runtime.authority.cost.recordAssistantUsage({
      sessionId,
      model: "test/model",
      inputTokens: 20,
      outputTokens: 5,
      cacheReadTokens: 30,
      cacheWriteTokens: 12,
      totalTokens: 55,
      costUsd: 0.001,
    });

    const assertTool = createObsSloAssertTool({ runtime: createBundledToolRuntime(runtime) });
    const assertResult = await assertTool.execute(
      "tc-obs-assert",
      {
        types: ["startup_sample"],
        where: { service: "api" },
        metric: "startupMs",
        aggregation: "p95",
        operator: "<=",
        threshold: 800,
      },
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const assertText = extractTextContent(assertResult);
    expect(assertText).toContain("verdict: fail");

    const snapshotTool = createObsSnapshotTool({ runtime });
    const snapshotResult = await snapshotTool.execute(
      "tc-obs-snapshot",
      {},
      undefined,
      undefined,
      fakeContext(sessionId),
    );
    const snapshotText = extractTextContent(snapshotResult);
    expect(snapshotText).toContain("[ObsSnapshot]");
    expect(snapshotText).toContain("tape_pressure:");
    expect(snapshotText).toContain("context_pressure:");
    expect(snapshotText).toContain("prompt_prefix_stable: true");
    expect(snapshotText).toContain("dynamic_tail_stable: true");
    expect(snapshotText).toContain(`prompt_scope_key: ${sessionId}::leaf-1`);
    expect(snapshotText).toContain("transient_reduction_status: completed");
    expect(snapshotText).toContain("transient_reduction_reason: none");
    expect(snapshotText).toContain("transient_reduction_cleared_tool_results: 2");
    expect(snapshotText).toContain("transient_reduction_estimated_token_savings: 580");
    expect(snapshotText).toContain("cache_read_tokens: 30");
    expect(snapshotText).toContain("cache_write_tokens: 12");
    expect(snapshotText).toContain("verification_level: standard");
    expect(
      runtime.inspect.events.query(sessionId, { type: ITERATION_METRIC_OBSERVED_EVENT_TYPE }),
    ).toHaveLength(0);
  });
});
