export const SESSION_PHASE_KINDS = [
  "idle",
  "model_streaming",
  "tool_executing",
  "waiting_approval",
  "recovering",
  "crashed",
  "terminated",
] as const;

export const SESSION_CRASH_POINTS = [
  "model_streaming",
  "tool_executing",
  "wal_append",
  "checkpoint_write",
] as const;

export const SESSION_TERMINATION_REASONS = [
  "completed",
  "cancelled",
  "fatal_error",
  "host_closed",
] as const;

export type SessionPhaseKind = (typeof SESSION_PHASE_KINDS)[number];
export type SessionCrashPoint = (typeof SESSION_CRASH_POINTS)[number];
export type SessionTerminationReason = (typeof SESSION_TERMINATION_REASONS)[number];

export type SessionPhaseTransitionError = "invalid session phase transition";

export type SessionPhase =
  | { kind: "idle" }
  | { kind: "model_streaming"; modelCallId: string; turn: number }
  | { kind: "tool_executing"; toolCallId: string; toolName: string; turn: number }
  | {
      kind: "waiting_approval";
      requestId: string;
      toolCallId: string;
      toolName: string;
      turn: number;
    }
  | { kind: "recovering"; recoveryAnchor?: string; turn: number }
  | {
      kind: "crashed";
      crashAt: SessionCrashPoint;
      turn: number;
      modelCallId?: string;
      toolCallId?: string;
      recoveryAnchor?: string;
    }
  | { kind: "terminated"; reason: SessionTerminationReason };

export type SessionPhaseTransitionResult =
  | { ok: true; phase: SessionPhase }
  | { ok: false; error: SessionPhaseTransitionError };

export function isSessionPhaseActive(phase: SessionPhase): boolean {
  return phase.kind === "model_streaming" || phase.kind === "tool_executing";
}

export function isSessionPhaseTerminal(phase: SessionPhase): boolean {
  return phase.kind === "terminated";
}

export function canResumeSessionPhase(phase: SessionPhase): boolean {
  return phase.kind === "crashed";
}
