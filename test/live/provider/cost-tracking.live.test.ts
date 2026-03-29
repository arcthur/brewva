import { describe, expect } from "bun:test";
import {
  assertCliSuccess,
  runCliSync,
  skipLiveForProviderRateLimitResult,
} from "../../helpers/cli.js";
import { writeMinimalConfig } from "../../helpers/config.js";
import { isRecord, parseJsonLines, requireFinalBundle } from "../../helpers/events.js";
import { runLive } from "../../helpers/live.js";
import { cleanupWorkspace, createWorkspace } from "../../helpers/workspace.js";

describe("live: cost tracking visibility", () => {
  runLive("json bundle exposes numeric costSummary fields", () => {
    const workspace = createWorkspace("cost-json");
    writeMinimalConfig(workspace);

    try {
      const run = runCliSync(workspace, [
        "--mode",
        "json",
        "Do not call any tool. Reply exactly: COST-OK",
      ]);

      if (skipLiveForProviderRateLimitResult("cost-json", run)) {
        return;
      }
      assertCliSuccess(run, "cost-json");

      const bundle = requireFinalBundle(parseJsonLines(run.stdout, { strict: true }), "cost json");
      const totalTokens = bundle.costSummary?.totalTokens;
      const totalCostUsd = bundle.costSummary?.totalCostUsd;
      if (typeof totalTokens !== "number" || typeof totalCostUsd !== "number") {
        throw new Error("Expected numeric costSummary totals in final bundle.");
      }
      expect(totalTokens).toBeGreaterThanOrEqual(0);
      expect(totalCostUsd).toBeGreaterThanOrEqual(0);

      const costUpdates = bundle.events.filter((event) => event.type === "cost_update");
      for (const event of costUpdates) {
        if (!isRecord(event.payload)) continue;
        if (event.payload.totalTokens !== undefined) {
          expect(typeof event.payload.totalTokens).toBe("number");
        }
        if (event.payload.sessionTokens !== undefined) {
          expect(typeof event.payload.sessionTokens).toBe("number");
        }
        if (event.payload.costUsd !== undefined) {
          expect(typeof event.payload.costUsd).toBe("number");
        }
        if (event.payload.sessionCostUsd !== undefined) {
          expect(typeof event.payload.sessionCostUsd).toBe("number");
        }
      }
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  runLive("print mode cost line check is non-blocking", () => {
    const workspace = createWorkspace("cost-print");
    writeMinimalConfig(workspace);

    try {
      const run = runCliSync(workspace, [
        "--print",
        "Do not call any tool. Reply exactly: COST-PRINT-OK",
      ]);

      if (skipLiveForProviderRateLimitResult("cost-print", run)) {
        return;
      }
      assertCliSuccess(run, "cost-print");

      if (run.stderr.includes("[cost] session=")) {
        expect(run.stderr).toMatch(/\[cost\] session=\S+\s+tokens=\d+/);
      } else {
        console.warn(
          "[cost-tracking.live] [cost] summary line is absent; this can happen when usage data is unavailable.",
        );
      }
    } finally {
      cleanupWorkspace(workspace);
    }
  });
});
