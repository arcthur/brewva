import { describe, expect, test } from "bun:test";
import { resolveScheduleApprovalMode } from "../../../packages/brewva-gateway/src/daemon/schedule-runner.js";
import { DEFAULT_BREWVA_CONFIG } from "../../../packages/brewva-runtime/src/config/defaults.js";
import { normalizeBrewvaConfig } from "../../../packages/brewva-runtime/src/config/normalize.js";

// The schedule approval envelope is derived from CONFIG IDENTITY, never from
// intent records (auto-research assembly, step 1). A model can mint schedule
// intents through `schedule_intent` / `follow_up`, so if the envelope keyed off
// the record, a model could schedule itself a future auto-approved session —
// the exact authority escalation the permission layer must sit outside of.
describe("schedule approval envelope resolution", () => {
  const policy = {
    enabled: true,
    approvalMode: "auto_within_envelope" as const,
    intentId: "intent_self_improve",
    parentSessionId: "session_self_improve_parent",
  };

  test("the config-authored self-improve intent gets the envelope", () => {
    expect(
      resolveScheduleApprovalMode({
        intent: { intentId: "intent_self_improve", parentSessionId: "session_self_improve_parent" },
        selfImprovePolicy: policy,
      }),
    ).toBe("auto_within_envelope");
  });

  test("a model-minted intent never gets the envelope, whatever its record carries", () => {
    expect(
      resolveScheduleApprovalMode({
        intent: {
          intentId: "intent_model_minted",
          parentSessionId: "session_self_improve_parent",
          // A smuggled field on the record must be ignored: authorization
          // comes from config identity, not from intent payloads.
          approvalMode: "auto_within_envelope",
        } as unknown as Parameters<typeof resolveScheduleApprovalMode>[0]["intent"],
        selfImprovePolicy: policy,
      }),
    ).toBe("suspend");
  });

  test("a parent-session mismatch resolves to suspend", () => {
    expect(
      resolveScheduleApprovalMode({
        intent: { intentId: "intent_self_improve", parentSessionId: "session_other" },
        selfImprovePolicy: policy,
      }),
    ).toBe("suspend");
  });

  test("config approvalMode suspend keeps even the config intent suspended", () => {
    expect(
      resolveScheduleApprovalMode({
        intent: { intentId: "intent_self_improve", parentSessionId: "session_self_improve_parent" },
        selfImprovePolicy: { ...policy, approvalMode: "suspend" },
      }),
    ).toBe("suspend");
  });

  test("a disabled self-improve schedule resolves to suspend", () => {
    expect(
      resolveScheduleApprovalMode({
        intent: { intentId: "intent_self_improve", parentSessionId: "session_self_improve_parent" },
        selfImprovePolicy: { ...policy, enabled: false },
      }),
    ).toBe("suspend");
  });
});

describe("schedule.selfImprove.approvalMode config contract", () => {
  test("the default lane is ON with the envelope (calibration-report pass)", () => {
    const config = normalizeBrewvaConfig({}, DEFAULT_BREWVA_CONFIG);
    expect(config.schedule.enabled).toBe(true);
    expect(config.schedule.selfImprove.enabled).toBe(true);
    expect(config.schedule.selfImprove.approvalMode).toBe("auto_within_envelope");
    expect(config.schedule.selfImprove.taskSpec.goal).toContain("calibration-report");
  });

  test("explicit suspend is honored; an unrecognized value fails CLOSED to suspend", () => {
    const suspended = normalizeBrewvaConfig(
      { schedule: { selfImprove: { approvalMode: "suspend" } } },
      DEFAULT_BREWVA_CONFIG,
    );
    expect(suspended.schedule.selfImprove.approvalMode).toBe("suspend");

    const bogus = normalizeBrewvaConfig(
      { schedule: { selfImprove: { approvalMode: "yes_please" } } },
      DEFAULT_BREWVA_CONFIG,
    );
    expect(bogus.schedule.selfImprove.approvalMode).toBe("suspend");
  });
});
