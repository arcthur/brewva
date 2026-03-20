import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE } from "@brewva/brewva-runtime";
import {
  createCostViewTool,
  createObsQueryTool,
  createObsSloAssertTool,
  createObsSnapshotTool,
} from "@brewva/brewva-tools";
import { createRuntimeConfig } from "../../helpers/runtime.js";
import { extractTextContent, fakeContext } from "./tools-flow.helpers.js";

function createCleanRuntime(cwd = process.cwd()): BrewvaRuntime {
  return new BrewvaRuntime({
    cwd,
    config: createRuntimeConfig(),
  });
}

describe("observability tool contracts", () => {
  test("cost_view returns session, skill, and tool breakdowns", async () => {
    const runtime = createCleanRuntime();
    const sessionId = "s10";
    runtime.context.onTurnStart(sessionId, 1);
    runtime.tools.markCall(sessionId, "read");
    runtime.cost.recordAssistantUsage({
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
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-obs-query-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s10-obs-query";

    runtime.events.record({
      sessionId,
      type: "latency_sample",
      payload: {
        service: "api",
        latencyMs: 810,
      },
    });
    runtime.events.record({
      sessionId,
      type: "latency_sample",
      payload: {
        service: "api",
        latencyMs: 790,
      },
    });

    const tool = createObsQueryTool({ runtime });
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
    expect(readFileSync(join(workspace, artifactOverride?.artifactRef ?? ""), "utf8")).toContain(
      '"schema": "brewva.observability.query.v1"',
    );
  });

  test("obs_slo_assert returns a fail verdict and obs_snapshot exposes runtime health", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "brewva-tools-obs-snapshot-"));
    const runtime = new BrewvaRuntime({ cwd: workspace });
    const sessionId = "s10-obs-snapshot";

    runtime.events.record({
      sessionId,
      type: "startup_sample",
      payload: {
        service: "api",
        startupMs: 920,
      },
    });
    runtime.events.record({
      sessionId,
      type: VERIFICATION_OUTCOME_RECORDED_EVENT_TYPE,
      payload: {
        level: "standard",
        outcome: "passed",
      },
    });

    const assertTool = createObsSloAssertTool({ runtime });
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
    expect(snapshotText).toContain("verification_level: targeted");
  });
});
