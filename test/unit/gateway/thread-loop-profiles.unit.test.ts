import { describe, expect, test } from "bun:test";
import { resolveThreadLoopProfile } from "../../../packages/brewva-gateway/src/session/thread-loop-profiles.js";

describe("thread loop profiles", () => {
  test("keeps interactive turns on the narrow fast path", () => {
    const profile = resolveThreadLoopProfile({
      source: "interactive",
    });

    expect(profile).toMatchObject({
      name: "interactive",
      allowsScheduleTrigger: false,
      allowsReasoningRevertResume: true,
      allowsPromptRecovery: true,
      allowsProviderFallbackRecovery: true,
      allowsSubagentDelivery: false,
      requiresRecoveryWalReplay: false,
      recordsTurnReceipts: false,
    });
  });

  test("keeps scheduled and WAL recovery turns explicit", () => {
    expect(
      resolveThreadLoopProfile({
        source: "schedule",
        triggerKind: "schedule",
      }),
    ).toMatchObject({
      name: "scheduled",
      allowsScheduleTrigger: true,
      allowsReasoningRevertResume: true,
      requiresRecoveryWalReplay: false,
      recordsTurnReceipts: true,
    });

    expect(
      resolveThreadLoopProfile({
        source: "gateway",
        walReplayId: "wal-1",
      }),
    ).toMatchObject({
      name: "wal_recovery",
      allowsScheduleTrigger: false,
      allowsReasoningRevertResume: true,
      requiresRecoveryWalReplay: true,
      recordsTurnReceipts: true,
    });
  });

  test("uses a constrained subagent recovery profile", () => {
    const profile = resolveThreadLoopProfile({
      source: "subagent",
    });

    expect(profile).toMatchObject({
      name: "subagent",
      allowsScheduleTrigger: false,
      allowsReasoningRevertResume: true,
      allowsPromptRecovery: true,
      allowsProviderFallbackRecovery: false,
      allowsSubagentDelivery: true,
      requiresRecoveryWalReplay: false,
      recordsTurnReceipts: false,
    });
  });
});
