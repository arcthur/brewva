import { describe, expect, test } from "bun:test";
import {
  CURRENT_DELEGATION_CONTRACT_VERSION,
  SUBAGENT_COMPLETED_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/delegation";
import {
  formatReplayRawText,
  formatReplayTimelineText,
} from "../../../packages/brewva-cli/src/entry/main.js";

describe("cli replay timeline formatting", () => {
  test("keeps raw replay text as the default event dump shape", () => {
    const text = formatReplayRawText([
      {
        schema: "brewva.event.v1",
        id: "evt-raw",
        sessionId: "replay-session",
        type: "turn_end",
        timestamp: 1_000,
        payload: { status: "ok" },
      },
    ]);

    expect(text).toContain("type=turn_end");
    expect(text).toContain('payload={"status":"ok"}');
    expect(text).not.toContain("kind=delegation");
  });

  test("prints redacted timeline groups with canonical event refs", () => {
    const text = formatReplayTimelineText("replay-session", [
      {
        id: "evt-worker",
        sessionId: "replay-session",
        type: SUBAGENT_COMPLETED_EVENT_TYPE,
        timestamp: 1_000,
        payload: {
          contractVersion: CURRENT_DELEGATION_CONTRACT_VERSION,
          runId: "worker-replay",
          agent: "worker",
          targetName: "worker",
          delegate: "worker",
          taskName: "Replay patch",
          taskPath: "/replay",
          nickname: "Replay patch",
          depth: 1,
          forkTurns: "none",
          gateReason: "implement_isolated",
          modelCategory: "isolated-execution",
          executionPrimitive: "named",
          visibility: "public",
          isolationStrategy: "snapshot",
          adoption: { decision: "patch_apply" },
          status: "completed",
          lifecycleReason: "none",
          retention: "live",
          createdAt: 900,
          updatedAt: 1_000,
          kind: "patch",
          summary: "Worker touched SECRET_TOKEN=abc123.",
        },
      },
    ]);

    expect(text).toContain("kind=delegation");
    expect(text).toContain("refs=event:evt-worker,delegation:worker-replay");
    expect(text).not.toContain("abc123");
  });
});
