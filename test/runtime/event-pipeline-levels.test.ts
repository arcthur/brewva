import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, DEFAULT_BREWVA_CONFIG, type BrewvaConfig } from "@brewva/brewva-runtime";

function createAuditConfig(): BrewvaConfig {
  const config = structuredClone(DEFAULT_BREWVA_CONFIG);
  config.infrastructure.events.level = "audit";
  return config;
}

describe("event pipeline level classification", () => {
  test("keeps tool_output_observed visible at audit level", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-events-audit-")),
      config: createAuditConfig(),
    });
    const sessionId = "audit-level-session";

    runtime.events.record({
      sessionId,
      type: "tool_output_observed",
      payload: {
        toolName: "exec",
        rawTokens: 3,
      },
    });
    runtime.events.record({
      sessionId,
      type: "tool_execution_end",
      payload: {
        toolName: "exec",
      },
    });
    runtime.events.record({
      sessionId,
      type: "tool_output_distilled",
      payload: {
        toolName: "exec",
        strategy: "exec_heuristic",
      },
    });
    runtime.events.record({
      sessionId,
      type: "tool_output_artifact_persisted",
      payload: {
        toolName: "exec",
        artifactRef: ".orchestrator/tool-output-artifacts/sample.txt",
      },
    });
    runtime.events.record({
      sessionId,
      type: "tool_output_search",
      payload: {
        queryCount: 1,
        resultCount: 2,
        throttleLevel: "normal",
      },
    });

    expect(runtime.events.query(sessionId, { type: "tool_output_observed" })).toHaveLength(1);
    expect(runtime.events.query(sessionId, { type: "tool_output_distilled" })).toHaveLength(1);
    expect(
      runtime.events.query(sessionId, { type: "tool_output_artifact_persisted" }),
    ).toHaveLength(1);
    expect(runtime.events.query(sessionId, { type: "tool_output_search" })).toHaveLength(0);
    expect(runtime.events.query(sessionId, { type: "tool_execution_end" })).toHaveLength(0);
  });
});
