import { describe, expect, test } from "bun:test";
import { asBrewvaSessionId } from "@brewva/brewva-runtime";
import {
  deriveDuplicateSideEffectSuppressionCount,
  deriveRecoveryCanonicalization,
} from "../../../packages/brewva-runtime/src/recovery/read-model.js";

describe("recovery read model", () => {
  test("derives active skill degradation directly from tape events before hydration state exists", () => {
    const canonicalization = deriveRecoveryCanonicalization([
      {
        id: "ev-skill-1",
        sessionId: asBrewvaSessionId("s-recovery-read-model"),
        type: "skill_activated",
        timestamp: 1,
        turn: 1,
        payload: {
          skillName: "design",
        },
      },
    ]);

    expect(canonicalization).toEqual({
      mode: "degraded",
      degradedReason: "active_skill_without_terminal_receipt",
      reasons: ["active_skill_without_terminal_receipt"],
      openToolCalls: [],
      openTurns: [],
    });
  });

  test("reuses a durable unclean-shutdown receipt as the canonical pre-hydration signal", () => {
    const canonicalization = deriveRecoveryCanonicalization([
      {
        id: "ev-unclean-1",
        sessionId: asBrewvaSessionId("s-recovery-read-model"),
        type: "unclean_shutdown_reconciled",
        timestamp: 5,
        turn: 1,
        payload: {
          detectedAt: 5,
          reasons: ["open_turn_without_terminal_receipt"],
          openToolCalls: [],
          openTurns: [
            {
              turn: 1,
              startedAt: 1,
              eventId: "ev-turn-start-1",
            },
          ],
          latestEventType: "turn_start",
          latestEventAt: 1,
        },
      },
    ]);

    expect(canonicalization).toEqual({
      mode: "degraded",
      degradedReason: "open_turn_without_terminal_receipt",
      reasons: ["open_turn_without_terminal_receipt"],
      openToolCalls: [],
      openTurns: [
        {
          turn: 1,
          startedAt: 1,
          eventId: "ev-turn-start-1",
        },
      ],
    });
  });

  test("lets later recovery transitions supersede a persisted unclean-shutdown diagnostic", () => {
    const canonicalization = deriveRecoveryCanonicalization([
      {
        id: "ev-unclean-1",
        sessionId: asBrewvaSessionId("s-recovery-read-model"),
        type: "unclean_shutdown_reconciled",
        timestamp: 5,
        turn: 1,
        payload: {
          detectedAt: 5,
          reasons: ["open_turn_without_terminal_receipt"],
          openToolCalls: [],
          openTurns: [
            {
              turn: 1,
              startedAt: 1,
              eventId: "ev-turn-start-1",
            },
          ],
          latestEventType: "turn_start",
          latestEventAt: 1,
        },
      },
      {
        id: "ev-transition-1",
        sessionId: asBrewvaSessionId("s-recovery-read-model"),
        type: "session_turn_transition",
        timestamp: 6,
        turn: 2,
        payload: {
          reason: "wal_recovery_resume",
          status: "entered",
          family: "recovery",
        },
      },
    ]);

    expect(canonicalization).toEqual({
      mode: "resumable",
      degradedReason: null,
      reasons: [],
      openToolCalls: [],
      openTurns: [],
    });
  });

  test("counts duplicate side-effect suppression from durable effect-commitment replay guards only", () => {
    expect(
      deriveDuplicateSideEffectSuppressionCount([
        {
          id: "ev-blocked-1",
          sessionId: asBrewvaSessionId("s-recovery-read-model"),
          type: "tool_call_blocked",
          timestamp: 10,
          turn: 2,
          payload: {
            toolName: "exec",
            reason: "effect_commitment_request_in_flight:req-1",
          },
        },
        {
          id: "ev-blocked-2",
          sessionId: asBrewvaSessionId("s-recovery-read-model"),
          type: "tool_call_blocked",
          timestamp: 11,
          turn: 2,
          payload: {
            toolName: "exec",
            reason: "effect_commitment_operator_approval_consumed:req-1",
          },
        },
        {
          id: "ev-blocked-3",
          sessionId: asBrewvaSessionId("s-recovery-read-model"),
          type: "tool_call_blocked",
          timestamp: 12,
          turn: 2,
          payload: {
            toolName: "read",
            reason: "Tool 'read' called with identical arguments 3 times consecutively.",
          },
        },
      ]),
    ).toBe(2);
  });
});
