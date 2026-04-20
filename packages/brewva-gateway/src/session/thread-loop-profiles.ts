import type { ThreadLoopProfile, ThreadLoopProfileName } from "./thread-loop-types.js";

export interface ResolveThreadLoopProfileInput {
  readonly source?:
    | "interactive"
    | "print"
    | "gateway"
    | "heartbeat"
    | "schedule"
    | "channel"
    | "subagent";
  readonly triggerKind?: "schedule" | "heartbeat";
  readonly walReplayId?: string;
}

const PROFILE_BY_NAME: Record<ThreadLoopProfileName, ThreadLoopProfile> = {
  interactive: {
    name: "interactive",
    allowsScheduleTrigger: false,
    allowsReasoningRevertResume: true,
    allowsPromptRecovery: true,
    allowsProviderFallbackRecovery: true,
    allowsSubagentDelivery: false,
    requiresRecoveryWalReplay: false,
    recordsTurnReceipts: false,
    settlesForegroundCompaction: true,
  },
  print: {
    name: "print",
    allowsScheduleTrigger: false,
    allowsReasoningRevertResume: true,
    allowsPromptRecovery: true,
    allowsProviderFallbackRecovery: true,
    allowsSubagentDelivery: false,
    requiresRecoveryWalReplay: false,
    recordsTurnReceipts: false,
    settlesForegroundCompaction: true,
  },
  channel: {
    name: "channel",
    allowsScheduleTrigger: false,
    allowsReasoningRevertResume: true,
    allowsPromptRecovery: true,
    allowsProviderFallbackRecovery: true,
    allowsSubagentDelivery: false,
    requiresRecoveryWalReplay: false,
    recordsTurnReceipts: false,
    settlesForegroundCompaction: true,
  },
  scheduled: {
    name: "scheduled",
    allowsScheduleTrigger: true,
    allowsReasoningRevertResume: true,
    allowsPromptRecovery: true,
    allowsProviderFallbackRecovery: true,
    allowsSubagentDelivery: false,
    requiresRecoveryWalReplay: false,
    recordsTurnReceipts: true,
    settlesForegroundCompaction: true,
  },
  heartbeat: {
    name: "heartbeat",
    allowsScheduleTrigger: true,
    allowsReasoningRevertResume: true,
    allowsPromptRecovery: true,
    allowsProviderFallbackRecovery: true,
    allowsSubagentDelivery: false,
    requiresRecoveryWalReplay: false,
    recordsTurnReceipts: true,
    settlesForegroundCompaction: true,
  },
  wal_recovery: {
    name: "wal_recovery",
    allowsScheduleTrigger: false,
    allowsReasoningRevertResume: true,
    allowsPromptRecovery: true,
    allowsProviderFallbackRecovery: true,
    allowsSubagentDelivery: false,
    requiresRecoveryWalReplay: true,
    recordsTurnReceipts: true,
    settlesForegroundCompaction: true,
  },
  subagent: {
    name: "subagent",
    allowsScheduleTrigger: false,
    allowsReasoningRevertResume: true,
    allowsPromptRecovery: true,
    allowsProviderFallbackRecovery: false,
    allowsSubagentDelivery: true,
    requiresRecoveryWalReplay: false,
    recordsTurnReceipts: false,
    settlesForegroundCompaction: true,
  },
};

export function getThreadLoopProfile(name: ThreadLoopProfileName): ThreadLoopProfile {
  return PROFILE_BY_NAME[name];
}

export function resolveThreadLoopProfile(input: ResolveThreadLoopProfileInput): ThreadLoopProfile {
  if (typeof input.walReplayId === "string" && input.walReplayId.trim().length > 0) {
    return getThreadLoopProfile("wal_recovery");
  }
  if (input.triggerKind === "schedule" || input.source === "schedule") {
    return getThreadLoopProfile("scheduled");
  }
  if (input.triggerKind === "heartbeat" || input.source === "heartbeat") {
    return getThreadLoopProfile("heartbeat");
  }
  if (input.source === "interactive") {
    return getThreadLoopProfile("interactive");
  }
  if (input.source === "print") {
    return getThreadLoopProfile("print");
  }
  if (input.source === "channel") {
    return getThreadLoopProfile("channel");
  }
  if (input.source === "subagent") {
    return getThreadLoopProfile("subagent");
  }
  return getThreadLoopProfile("channel");
}
