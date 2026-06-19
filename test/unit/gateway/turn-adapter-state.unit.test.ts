import { describe, expect, test } from "bun:test";
import { resolveHostedTurnAdapterProfile } from "../../../packages/brewva-gateway/src/hosted/internal/turn/state.js";

describe("turn adapter state profiles", () => {
  test("keeps interactive turns on the narrow fast path", () => {
    const profile = resolveHostedTurnAdapterProfile({
      source: "interactive",
    });

    expect(profile).toMatchObject({
      name: "interactive",
    });
  });

  test("keeps scheduled and WAL recovery turns explicit", () => {
    expect(
      resolveHostedTurnAdapterProfile({
        source: "schedule",
        triggerKind: "schedule",
      }),
    ).toMatchObject({
      name: "scheduled",
    });

    expect(
      resolveHostedTurnAdapterProfile({
        source: "gateway",
        walReplayId: "wal-1",
      }),
    ).toMatchObject({
      name: "wal_recovery",
    });
  });

  test("uses a named subagent profile", () => {
    const profile = resolveHostedTurnAdapterProfile({
      source: "subagent",
    });

    expect(profile).toMatchObject({
      name: "subagent",
    });
  });
});
