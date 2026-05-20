import { describe, expect, test } from "bun:test";
import { resolveHostedTurnAdapterProfile } from "../../../packages/brewva-gateway/src/hosted/internal/turn-adapter/state.js";
import { createMinimalHostedTurnAdapterDiagnostic } from "../../../packages/brewva-gateway/src/hosted/internal/turn-adapter/state.js";

describe("turn adapter diagnostics", () => {
  test("builds a typed minimal diagnostic view for synthetic adapter results", () => {
    const profile = resolveHostedTurnAdapterProfile({ source: "interactive" });

    expect(
      createMinimalHostedTurnAdapterDiagnostic({
        sessionId: "session-1",
        turnId: "turn-1",
        profile,
      }),
    ).toEqual({
      sessionId: "session-1",
      turnId: "turn-1",
      profile: "interactive",
    });
  });
});
