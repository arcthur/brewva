import type { ToolOutputView } from "@brewva/brewva-runtime/protocol";

export type HostedTurnAdapterProfileName =
  | "interactive"
  | "print"
  | "channel"
  | "scheduled"
  | "heartbeat"
  | "wal_recovery"
  | "subagent";

export interface HostedTurnAdapterProfile {
  readonly name: HostedTurnAdapterProfileName;
}

export type HostedTurnAdapterDecisionAction = "complete" | "fail" | "suspend_for_approval";

export type HostedTurnAdapterResult =
  | {
      readonly status: "completed";
      readonly attemptId: string;
      readonly assistantText: string;
      readonly toolOutputs: readonly ToolOutputView[];
      readonly diagnostic: HostedTurnAdapterDiagnosticView;
    }
  | {
      readonly status: "failed";
      readonly error: unknown;
      readonly attemptId?: string;
      readonly assistantText?: string;
      readonly toolOutputs?: readonly ToolOutputView[];
      readonly diagnostic: HostedTurnAdapterDiagnosticView;
    }
  | {
      readonly status: "suspended";
      readonly reason: "approval";
      readonly sourceEventId: string | null;
      readonly diagnostic: HostedTurnAdapterDiagnosticView;
    }
  | {
      readonly status: "cancelled";
      readonly diagnostic: HostedTurnAdapterDiagnosticView;
    };

export interface HostedTurnAdapterDiagnosticView {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly profile: HostedTurnAdapterProfileName;
  readonly lastDecision?: HostedTurnAdapterDecisionAction;
}

export function createMinimalHostedTurnAdapterDiagnostic(input: {
  readonly sessionId: string;
  readonly turnId?: string;
  readonly profile: HostedTurnAdapterProfile | HostedTurnAdapterProfileName;
  readonly lastDecision?: HostedTurnAdapterDecisionAction;
}): HostedTurnAdapterDiagnosticView {
  const diagnostic: HostedTurnAdapterDiagnosticView = {
    sessionId: input.sessionId,
    turnId: input.turnId,
    profile: typeof input.profile === "string" ? input.profile : input.profile.name,
  };

  return {
    ...diagnostic,
    ...(input.lastDecision ? { lastDecision: input.lastDecision } : {}),
  };
}

export interface ResolveHostedTurnAdapterProfileInput {
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

const PROFILE_BY_NAME: Record<HostedTurnAdapterProfileName, HostedTurnAdapterProfile> = {
  interactive: {
    name: "interactive",
  },
  print: {
    name: "print",
  },
  channel: {
    name: "channel",
  },
  scheduled: {
    name: "scheduled",
  },
  heartbeat: {
    name: "heartbeat",
  },
  wal_recovery: {
    name: "wal_recovery",
  },
  subagent: {
    name: "subagent",
  },
};

export function getHostedTurnAdapterProfile(
  name: HostedTurnAdapterProfileName,
): HostedTurnAdapterProfile {
  return PROFILE_BY_NAME[name];
}

export function resolveHostedTurnAdapterProfile(
  input: ResolveHostedTurnAdapterProfileInput,
): HostedTurnAdapterProfile {
  if (typeof input.walReplayId === "string" && input.walReplayId.trim().length > 0) {
    return getHostedTurnAdapterProfile("wal_recovery");
  }
  if (input.triggerKind === "schedule" || input.source === "schedule") {
    return getHostedTurnAdapterProfile("scheduled");
  }
  if (input.triggerKind === "heartbeat" || input.source === "heartbeat") {
    return getHostedTurnAdapterProfile("heartbeat");
  }
  if (input.source === "interactive") {
    return getHostedTurnAdapterProfile("interactive");
  }
  if (input.source === "print") {
    return getHostedTurnAdapterProfile("print");
  }
  if (input.source === "channel") {
    return getHostedTurnAdapterProfile("channel");
  }
  if (input.source === "subagent") {
    return getHostedTurnAdapterProfile("subagent");
  }
  return getHostedTurnAdapterProfile("channel");
}
