import type { BrewvaSessionId } from "@brewva/brewva-runtime/core";
import type { SessionPhase } from "@brewva/brewva-substrate/session";
import type { HostedSessionPhase } from "../session-phase/api.js";

export function createHostedSessionInitPhases(input: {
  sessionId: BrewvaSessionId;
  providerApi?: string;
  toolNames: readonly string[];
}): readonly HostedSessionPhase[] {
  const phases: HostedSessionPhase[] = [{ kind: "init", sessionId: input.sessionId }];
  if (input.providerApi) {
    phases.push({
      kind: "provider-bound",
      sessionId: input.sessionId,
      providerApi: input.providerApi,
    });
  }
  phases.push({
    kind: "tool-bound",
    sessionId: input.sessionId,
    toolNames: [...input.toolNames],
  });
  phases.push({
    kind: "ready",
    sessionId: input.sessionId,
  });
  return phases;
}

export function projectHostedRuntimePhase(
  sessionId: BrewvaSessionId,
  phase: SessionPhase,
): HostedSessionPhase {
  switch (phase.kind) {
    case "idle":
      return { kind: "ready", sessionId };
    case "model_streaming":
    case "tool_executing":
    case "waiting_approval":
      return {
        kind: "turn-active",
        sessionId,
        turnId: `${sessionId}:turn:${phase.turn}`,
      };
    case "recovering":
      return {
        kind: "recovering",
        sessionId,
        cause: phase.recoveryAnchor ?? "recovering",
      };
    case "crashed":
      return {
        kind: "recovering",
        sessionId,
        cause: phase.crashAt,
      };
    case "terminated":
      return {
        kind: "closed",
        sessionId,
        reason: phase.reason,
      };
  }
  const exhaustive: never = phase;
  return exhaustive;
}
