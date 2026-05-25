import { describe, expect, test } from "bun:test";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import { resolveManagedSessionBootstrapPhase } from "../../../packages/brewva-gateway/src/hosted/internal/session/session-phase/api.js";

describe("managed-agent-session bootstrap", () => {
  test("prefers lifecycle snapshot over runtime wire fallback", () => {
    const phase = resolveManagedSessionBootstrapPhase(
      {
        getSessionId: () => "sess-1",
        readLifecycle: () =>
          ({
            execution: {
              kind: "waiting_approval",
              requestId: "req-1",
              toolCallId: "tool-1",
              toolName: "exec",
            },
            tooling: { openToolCalls: [] },
          }) as never,
        querySessionWire: () => {
          throw new Error("querySessionWire should not run");
        },
      },
      1,
    );

    expect(phase?.kind).toBe("waiting_approval");
  });

  test("falls back to runtime wire history when lifecycle snapshot is unavailable", () => {
    const phase = resolveManagedSessionBootstrapPhase(
      {
        getSessionId: () => "sess-1",
        querySessionWire: () =>
          [
            {
              sessionId: "sess-1",
              type: "turn.input",
              promptText: "approve this",
            },
            {
              sessionId: "sess-1",
              type: "approval.requested",
              requestId: "req-1",
              toolCallId: "tool-1",
              toolName: "exec",
              subject: "run command",
            },
          ] as SessionWireFrame[],
      },
      1,
    );

    expect(phase?.kind).toBe("waiting_approval");
  });

  test("returns null when neither lifecycle nor wire history is available", () => {
    const phase = resolveManagedSessionBootstrapPhase(
      {
        getSessionId: () => "sess-1",
      },
      1,
    );

    expect(phase).toBeNull();
  });
});
