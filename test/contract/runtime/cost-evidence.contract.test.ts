import { describe, expect, test } from "bun:test";
import { BrewvaRuntime } from "@brewva/brewva-runtime";
import { createRuntimeConfig } from "../../helpers/runtime.js";

function repoRoot(): string {
  return process.cwd();
}

function createCleanRuntime(): BrewvaRuntime {
  return new BrewvaRuntime({
    cwd: repoRoot(),
    config: createRuntimeConfig(),
  });
}

describe("cost evidence separation in digest", () => {
  test("given ledger and infrastructure cost records, when building digest, then infrastructure entries are excluded", async () => {
    const runtime = createCleanRuntime();
    const sessionId = `cost-sep-${Date.now()}`;

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo hello" },
      outputText: "hello",
      channelSuccess: true,
    });

    runtime.cost.recordAssistantUsage({
      sessionId,
      model: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      costUsd: 0.001,
    });

    const digest = runtime.ledger.getDigest(sessionId);
    expect(digest).toContain("count=1");
    expect(digest).not.toContain("brewva_cost");
  });
});
