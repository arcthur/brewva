import { describe, expect, test } from "bun:test";
import {
  buildSchedulePromptTrigger,
  resolveScheduleApprovalMode,
} from "../../../packages/brewva-gateway/src/daemon/schedule-runner.js";
import {
  buildSessionTurnEnvelope,
  extractTriggerFromEnvelope,
} from "../../../packages/brewva-gateway/src/daemon/session-supervisor/turn-envelope.js";

// A scheduled worker has no interactive approver, so a crash-recovery replay must
// re-establish the approval envelope. The old bug: `approvalMode` lived only in
// the in-memory queue, so a recovered turn fell back to suspend and hung. The fix
// persists the intent IDENTITY (with its unforgeable origin) in the turn envelope
// and re-resolves the mode from CURRENT config at replay.
describe("schedule turn WAL persistence + replay re-resolution", () => {
  const configIntent = {
    intentId: "schedule:policy:self-improve:recurring",
    parentSessionId: "schedule:policy:self-improve",
    origin: "config_policy" as const,
  };

  test("the intent identity (with origin) round-trips through the turn envelope", () => {
    const trigger = buildSchedulePromptTrigger({
      continuityMode: "inherit",
      snapshot: { taskSpec: null, claims: [], parentAnchor: null },
      intent: configIntent,
    });
    const envelope = buildSessionTurnEnvelope({
      sessionId: "schedule:policy:self-improve:recurring:7",
      turnId: "turn-1",
      prompt: "[Schedule Wakeup]",
      source: "schedule",
      trigger,
    });

    const recovered = extractTriggerFromEnvelope(envelope);
    expect(recovered?.intent).toEqual(configIntent);
  });

  test("the identity travels even in fresh continuity mode", () => {
    const trigger = buildSchedulePromptTrigger({
      continuityMode: "fresh",
      snapshot: { taskSpec: null, claims: [], parentAnchor: null },
      intent: configIntent,
    });
    const envelope = buildSessionTurnEnvelope({
      sessionId: "s",
      turnId: "turn-2",
      prompt: "go",
      source: "schedule",
      trigger,
    });
    expect(extractTriggerFromEnvelope(envelope)?.intent).toEqual(configIntent);
  });

  test("replay re-resolves auto_within_envelope from the recovered identity + current config", () => {
    const trigger = buildSchedulePromptTrigger({
      continuityMode: "inherit",
      snapshot: { taskSpec: null, claims: [], parentAnchor: null },
      intent: configIntent,
    });
    const envelope = buildSessionTurnEnvelope({
      sessionId: "s",
      turnId: "turn-3",
      prompt: "go",
      source: "schedule",
      trigger,
    });
    const recovered = extractTriggerFromEnvelope(envelope);
    expect(recovered?.intent).toEqual(configIntent);

    // Config still authorizes the lane → envelope restored on replay.
    expect(
      resolveScheduleApprovalMode({
        intent: recovered!.intent!,
        selfImprovePolicy: {
          enabled: true,
          approvalMode: "auto_within_envelope",
          intentId: configIntent.intentId,
          parentSessionId: configIntent.parentSessionId,
        },
      }),
    ).toBe("auto_within_envelope");

    // Config has since opted out → replay correctly falls back to suspend
    // (never a stale, persisted grant).
    expect(
      resolveScheduleApprovalMode({
        intent: recovered!.intent!,
        selfImprovePolicy: {
          enabled: false,
          approvalMode: "auto_within_envelope",
          intentId: configIntent.intentId,
          parentSessionId: configIntent.parentSessionId,
        },
      }),
    ).toBe("suspend");
  });
});
