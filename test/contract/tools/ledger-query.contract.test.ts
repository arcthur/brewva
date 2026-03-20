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

describe("S-003 ledger write/query", () => {
  test("given recorded tool result, when querying recent ledger entries, then text includes tool and output", async () => {
    const runtime = createCleanRuntime();
    const sessionId = "s3";

    runtime.tools.recordResult({
      sessionId,
      toolName: "exec",
      args: { command: "bun test" },
      outputText: "PASS",
      channelSuccess: true,
    });

    const text = runtime.ledger.query(sessionId, { last: 5 });
    expect(text).toContain("exec");
    expect(text).toContain("PASS");
  });
});
