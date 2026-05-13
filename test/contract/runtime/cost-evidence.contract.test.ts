import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import { createRuntimeConfig } from "../../helpers/runtime.js";
import { cleanupWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

let workspace = "";

beforeEach(() => {
  workspace = createTestWorkspace("cost-evidence-contract");
});

afterEach(() => {
  if (workspace) cleanupWorkspace(workspace);
});

function createCleanRuntime(): BrewvaHostedRuntimePort {
  return createBrewvaRuntime({
    cwd: workspace,
    config: createRuntimeConfig(),
  }).hosted;
}

describe("cost evidence separation in digest", () => {
  test("given ledger and infrastructure cost records, when building digest, then infrastructure entries are excluded", async () => {
    const runtime = createCleanRuntime();
    const sessionId = `cost-sep-${Date.now()}`;

    runtime.authority.tools.invocation.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "echo hello" },
      outputText: "hello",
      channelSuccess: true,
    });

    runtime.authority.cost.usage.recordAssistant({
      sessionId,
      model: "test-model",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      totalTokens: 150,
      costUsd: 0.001,
    });

    const digest = runtime.inspect.ledger.store.getDigest(sessionId);
    expect(digest).toContain("count=1");
    expect(digest).not.toContain("brewva_cost");
  });
});
