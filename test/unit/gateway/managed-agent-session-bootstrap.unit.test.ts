import { describe, expect, test } from "bun:test";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import { resolveManagedSessionBootstrapPhase } from "../../../packages/brewva-gateway/src/hosted/internal/session/session-phase/api.js";

describe("managed-agent-session bootstrap", () => {
  test("prefers a recovering lifecycle snapshot over the runtime wire fallback", () => {
    const phase = resolveManagedSessionBootstrapPhase(
      {
        getSessionId: () => "sess-1",
        // Producer-realistic: a suspended-recovery snapshot emits `recovering` on
        // execution, which the snapshot phase projection sources directly — so the wire
        // fallback must not be consulted.
        readLifecycle: () => ({
          sessionId: "sess-1",
          execution: {
            kind: "recovering",
            reason: "compaction_required",
            detail: "runtime.suspended",
          },
          recovery: {
            mode: "observed",
            latestReason: "compaction_required",
            latestStatus: "entered",
            pendingFamily: "recovery",
            degradedReason: null,
            duplicateSideEffectSuppressionCount: 0,
            latestSourceEventId: "evt-1",
            latestSourceEventType: "runtime.suspended",
            recentTransitions: ["compaction_required"],
          },
          tooling: { openToolCalls: [] },
          summary: {
            kind: "recovering",
            reason: "compaction_required",
            detail: "runtime.suspended",
          },
        }),
        querySessionWire: () => {
          throw new Error("querySessionWire should not run");
        },
      },
      1,
    );

    expect(phase?.kind).toBe("recovering");
  });

  test("sources the approval phase from wire frames even when a snapshot exists", () => {
    const phase = resolveManagedSessionBootstrapPhase(
      {
        getSessionId: () => "sess-1",
        // An approval wait stays `running` at the snapshot kind level (it carries no tool
        // identity), so the snapshot phase projection returns null and the bootstrap must
        // fall through to the wire history that does carry the approval identity.
        readLifecycle: () => ({
          sessionId: "sess-1",
          execution: { kind: "running", detail: "runtime_turn_active" },
          recovery: {
            mode: "idle",
            latestReason: null,
            latestStatus: "entered",
            pendingFamily: "approval",
            degradedReason: null,
            duplicateSideEffectSuppressionCount: 0,
            latestSourceEventId: "evt-1",
            latestSourceEventType: "runtime.suspended",
            recentTransitions: [],
          },
          tooling: { openToolCalls: [] },
          summary: { kind: "running", reason: null, detail: "runtime.suspended" },
        }),
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
