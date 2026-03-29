import { describe, expect, test } from "bun:test";
import { requireNonEmptyString } from "../../helpers/assertions.js";
import { assertCliSuccess, runCli } from "../../helpers/cli.js";
import { writeMinimalConfig } from "../../helpers/config.js";
import {
  isRecord,
  parseEventFile,
  parseJsonLines,
  requireLatestEventFile,
} from "../../helpers/events.js";
import { startGatewayDaemonHarness } from "../../helpers/gateway.js";
import { cleanupTestWorkspace, createTestWorkspace } from "../../helpers/workspace.js";

type ReplayStructuredEvent = {
  schema: "brewva.event.v1";
  sessionId: string;
  type: string;
  timestamp: number;
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

describe("cli contract: gateway-backed json replay", () => {
  test("gateway-backed print run can be replayed through the persisted json event stream", async () => {
    const workspace = createTestWorkspace("contract-json-replay-gateway");
    writeMinimalConfig(workspace);
    const harness = await startGatewayDaemonHarness({
      workspace,
      fakeAssistantText: "SYSTEM_JSON_REPLAY_OK",
    });

    try {
      const run = await runCli(
        workspace,
        [
          "--cwd",
          workspace,
          "--config",
          ".brewva/brewva.json",
          "--backend",
          "gateway",
          "--print",
          "Return a deterministic json response.",
        ],
        { env: harness.env },
      );
      assertCliSuccess(run, "system-json-run");

      const eventFile = requireLatestEventFile(workspace, "gateway-backed json replay");
      const persistedEvents = parseEventFile(eventFile, { strict: true });
      const sessionId = requireNonEmptyString(
        persistedEvents.find(
          (event) => typeof event.sessionId === "string" && event.sessionId.trim().length > 0,
        )?.sessionId,
        "Expected persisted sessionId for replay.",
      );

      const replay = await runCli(workspace, [
        "--cwd",
        workspace,
        "--config",
        ".brewva/brewva.json",
        "--replay",
        "--mode",
        "json",
        "--session",
        sessionId,
      ]);
      assertCliSuccess(replay, "system-json-replay");

      const replayEvents = toReplayStructuredEvents(
        parseJsonLines(replay.stdout, { strict: true }),
      );
      expect(replayEvents.length).toBeGreaterThan(0);
      expect(new Set(replayEvents.map((event) => event.type))).toContain("agent_end");
      expect(new Set(replayEvents.map((event) => event.sessionId))).toEqual(new Set([sessionId]));
    } finally {
      await harness.dispose();
      cleanupTestWorkspace(workspace);
    }
  }, 15_000);
});
