import { describe, expect } from "bun:test";
import {
  assertCliSuccess,
  runCliSync,
  skipLiveForProviderRateLimitResult,
} from "../../helpers/cli.js";
import { writeMinimalConfig } from "../../helpers/config.js";
import {
  countEventType,
  firstIndexOf,
  parseEventFile,
  parseJsonLines,
  requireFinalBundle,
  requireLatestEventFile,
} from "../../helpers/events.js";
import { runLive } from "../../helpers/live.js";
import { cleanupWorkspace, createWorkspace } from "../../helpers/workspace.js";

describe("live: print and json modes", () => {
  runLive("print mode produces output and persists core events", () => {
    const workspace = createWorkspace("print-mode");
    writeMinimalConfig(workspace);

    try {
      const result = runCliSync(workspace, [
        "--print",
        "Do not call any tool. Reply exactly: E2E-PRINT-OK",
      ]);

      if (skipLiveForProviderRateLimitResult("print-mode", result)) {
        return;
      }
      assertCliSuccess(result, "print-mode");
      expect(result.stdout).toContain("E2E-PRINT-OK");

      const eventFile = requireLatestEventFile(workspace, "print mode");
      const events = parseEventFile(eventFile, { strict: true });

      expect(countEventType(events, "session_start")).toBeGreaterThanOrEqual(1);
      expect(countEventType(events, "turn_start")).toBeGreaterThanOrEqual(1);
      expect(countEventType(events, "turn_end")).toBeGreaterThanOrEqual(1);
      expect(countEventType(events, "agent_end")).toBeGreaterThanOrEqual(1);
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  runLive("json mode emits final event bundle with structural invariants", () => {
    const workspace = createWorkspace("json-mode");
    writeMinimalConfig(workspace);

    try {
      const result = runCliSync(workspace, [
        "--mode",
        "json",
        "Do not call any tool. Reply exactly: E2E-JSON-OK",
      ]);

      if (skipLiveForProviderRateLimitResult("json-mode", result)) {
        return;
      }
      assertCliSuccess(result, "json-mode");

      const lines = parseJsonLines(result.stdout, { strict: true });
      const bundle = requireFinalBundle(lines, "json mode stdout");
      expect(bundle.sessionId.length).toBeGreaterThan(0);
      expect(bundle.events.length).toBeGreaterThanOrEqual(4);

      const totalTokens = bundle.costSummary?.totalTokens;
      const totalCostUsd = bundle.costSummary?.totalCostUsd;
      if (typeof totalTokens !== "number" || typeof totalCostUsd !== "number") {
        throw new Error("Expected numeric costSummary totals in final bundle.");
      }

      const events = bundle.events;
      const sessionStart = firstIndexOf(events, "session_start");
      const turnStart = firstIndexOf(events, "turn_start");
      const turnEnd = firstIndexOf(events, "turn_end");
      const agentEnd = firstIndexOf(events, "agent_end");

      expect(sessionStart).toBeGreaterThanOrEqual(0);
      expect(turnStart).toBeGreaterThanOrEqual(0);
      expect(turnEnd).toBeGreaterThanOrEqual(0);
      expect(agentEnd).toBeGreaterThanOrEqual(0);
      expect(sessionStart).toBeLessThan(turnStart);
      expect(turnStart).toBeLessThan(turnEnd);
      expect(turnEnd).toBeLessThan(agentEnd);
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  runLive("piped stdin falls back to print-text mode", () => {
    const workspace = createWorkspace("piped-stdin");
    writeMinimalConfig(workspace);

    try {
      const result = runCliSync(workspace, [], {
        input: "Do not call any tool. Reply exactly: PIPED-OK\n",
      });

      if (skipLiveForProviderRateLimitResult("piped-stdin", result)) {
        return;
      }
      assertCliSuccess(result, "piped-stdin");
      expect(result.stdout.trim().length).toBeGreaterThan(0);
      requireLatestEventFile(workspace, "piped stdin fallback");
    } finally {
      cleanupWorkspace(workspace);
    }
  });
});
