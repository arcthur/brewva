import { describe, expect } from "bun:test";
import { assertCliSuccess, runCliSync } from "../../helpers/cli.js";
import { writeMinimalConfig } from "../../helpers/config.js";
import { isRecord, parseJsonLines, requireFinalBundle } from "../../helpers/events.js";
import { runLive } from "../../helpers/live.js";
import { cleanupWorkspace, createWorkspace } from "../../helpers/workspace.js";

type ReplayStructuredEvent = {
  schema: "brewva.event.v1";
  sessionId: string;
  type: string;
  timestamp: number;
  [key: string]: unknown;
};

function toReplayStructuredEvents(lines: unknown[]): ReplayStructuredEvent[] {
  const events: ReplayStructuredEvent[] = [];
  for (const line of lines) {
    if (!isRecord(line)) continue;
    if (line.schema !== "brewva.event.v1") continue;
    if (typeof line.sessionId !== "string") continue;
    if (typeof line.type !== "string") continue;
    if (typeof line.timestamp !== "number") continue;
    events.push(line as ReplayStructuredEvent);
  }
  return events;
}

describe("live: replay and persistence", () => {
  runLive("replay returns structured persisted events for json-mode session", () => {
    const workspace = createWorkspace("replay");
    writeMinimalConfig(workspace);

    try {
      const run = runCliSync(workspace, [
        "--mode",
        "json",
        "Do not call any tool. Reply exactly: REPLAY-OK",
      ]);

      assertCliSuccess(run, "replay-run");

      const bundle = requireFinalBundle(parseJsonLines(run.stdout, { strict: true }), "replay run");
      const sessionId = bundle.sessionId;
      expect(sessionId.length).toBeGreaterThan(0);

      const replay = runCliSync(workspace, ["--replay", "--mode", "json", "--session", sessionId]);

      assertCliSuccess(replay, "replay-cmd");

      const replayEvents = toReplayStructuredEvents(
        parseJsonLines(replay.stdout, { strict: true }),
      );
      expect(replayEvents.length).toBeGreaterThan(0);

      for (const event of replayEvents) {
        expect(event.sessionId).toBe(sessionId);
      }

      const replayTypes = replayEvents.map((event) => event.type);
      expect(replayTypes).toContain("session_start");
      expect(replayTypes).toContain("turn_start");
      expect(replayTypes).toContain("turn_end");
      expect(replayTypes).toContain("agent_end");
      const bundleEventCount = bundle.events.length;
      expect(replayEvents.length).toBeGreaterThanOrEqual(bundleEventCount);
      expect(replayEvents.length).toBeLessThanOrEqual(bundleEventCount + 5);
      expect(replayTypes).toContain("session_shutdown");
    } finally {
      cleanupWorkspace(workspace);
    }
  });

  runLive("replay on empty workspace reports no replayable session", () => {
    const workspace = createWorkspace("replay-empty");
    writeMinimalConfig(workspace);

    try {
      const replay = runCliSync(workspace, ["--replay", "--mode", "json"]);
      expect(replay.error).toBeUndefined();
      expect(replay.status).toBe(1);
      expect(replay.stdout.trim()).toBe("");
      expect(replay.stderr).toContain("Error: no replayable session found.");
    } finally {
      cleanupWorkspace(workspace);
    }
  });
});
