import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createBrewvaRuntime } from "@brewva/brewva-runtime";
import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import { createRuntimeConfig } from "../../helpers/runtime.js";
import { cleanupWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

let workspace = "";

beforeEach(() => {
  workspace = createTestWorkspace("ledger-query-contract");
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

describe("S-003 ledger write/query", () => {
  test("given recorded tool result, when querying recent ledger entries, then text includes tool and output", async () => {
    const runtime = createCleanRuntime();
    const sessionId = "s3";

    runtime.authority.tools.invocation.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "PASS",
      channelSuccess: true,
    });

    const text = runtime.inspect.ledger.store.query(sessionId, { last: 5 });
    expect(text).toContain("exec");
    expect(text).toContain("PASS");
  });
});
