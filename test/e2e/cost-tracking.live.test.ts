import { describe, expect } from "bun:test";
import {
  assertCliSuccess,
  cleanupWorkspace,
  createWorkspace,
  findFinalBundle,
  isRecord,
  parseJsonLines,
  runCliSync,
  runLive,
  writeMinimalConfig,
} from "./helpers.js";

describe("e2e: cost tracking visibility", () => {
  runLive("json bundle exposes numeric costSummary fields", () => {
    const workspace = createWorkspace("cost-json");
    writeMinimalConfig(workspace);

    try {
      const run = runCliSync(workspace, [
        "--mode",
        "json",
        "Do not call any tool. Reply exactly: COST-OK",
      ]);

      assertCliSuccess(run, "cost-json");

      const bundle = findFinalBundle(parseJsonLines(run.stdout, { strict: true }));
      expect(bundle).toBeDefined();

      expect(typeof bundle?.costSummary?.totalTokens).toBe("number");
      expect((bundle?.costSummary?.totalTokens as number) >= 0).toBe(true);
      expect(typeof bundle?.costSummary?.totalCostUsd).toBe("number");
      expect((bundle?.costSummary?.totalCostUsd as number) >= 0).toBe(true);

      const costUpdates = (bundle?.events ?? []).filter(
        (event) => event.type === "cost_update",
      );
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

      assertCliSuccess(run, "cost-print");

      if (run.stderr.includes("[cost] session=")) {
        expect(
          /\[cost\] session=\S+\s+tokens=\d+/.test(run.stderr),
        ).toBe(true);
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
