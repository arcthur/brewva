import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrewvaRuntime, type BrewvaConfig } from "@brewva/brewva-runtime";
import { createOpsRuntimeConfig } from "../../helpers/runtime.js";

function createConfig(): BrewvaConfig {
  return createOpsRuntimeConfig();
}

describe("context compaction request dedupe", () => {
  test("does not emit duplicate context_compaction_requested for the same pending reason", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-context-compaction-request-")),
      config: createConfig(),
    });
    const sessionId = "context-compaction-request-dedupe";

    runtime.maintain.context.requestCompaction(sessionId, "usage_threshold");
    runtime.maintain.context.requestCompaction(sessionId, "usage_threshold");
    runtime.maintain.context.requestCompaction(sessionId, "hard_limit");

    const events = runtime.inspect.events.query(sessionId, {
      type: "context_compaction_requested",
    });
    const reasons = events.map(
      (event) => (event.payload as { reason?: string } | undefined)?.reason,
    );
    expect(reasons).toEqual(["usage_threshold", "hard_limit"]);
  });

  test("respects minTurnsBetweenCompaction when usage stays high", () => {
    const runtime = new BrewvaRuntime({
      cwd: mkdtempSync(join(tmpdir(), "brewva-context-compaction-interval-")),
      config: createConfig(),
    });
    const sessionId = "context-compaction-interval";

    runtime.maintain.context.onTurnStart(sessionId, 1);
    expect(
      runtime.maintain.context.checkAndRequestCompaction(sessionId, {
        tokens: 820,
        contextWindow: 1000,
        percent: 0.9,
      }),
    ).toBe(true);
    runtime.authority.session.commitCompaction(sessionId, {
      compactId: "cmp-interval",
      sanitizedSummary: "Reset compaction interval state.",
      summaryDigest: "unused",
      sourceTurn: 1,
      leafEntryId: null,
      referenceContextDigest: null,
      fromTokens: 820,
      toTokens: 120,
      origin: "auto_compaction",
    });

    runtime.maintain.context.onTurnStart(sessionId, 2);
    expect(
      runtime.maintain.context.checkAndRequestCompaction(sessionId, {
        tokens: 820,
        contextWindow: 1000,
        percent: 0.9,
      }),
    ).toBe(false);

    runtime.maintain.context.onTurnStart(sessionId, 3);
    expect(
      runtime.maintain.context.checkAndRequestCompaction(sessionId, {
        tokens: 820,
        contextWindow: 1000,
        percent: 0.9,
      }),
    ).toBe(false);
  });
});
