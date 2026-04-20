import type { BrewvaRuntime, ToolOutputView } from "@brewva/brewva-runtime";
import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate";
import type { CollectSessionPromptOutputSession } from "../session/collect-output.js";
import { runHostedThreadLoop } from "../session/hosted-thread-loop.js";
import { resolveThreadLoopProfile } from "../session/thread-loop-profiles.js";

export type HostedPromptTurnSource = "interactive" | "print" | "channel" | "subagent";

export type HostedPromptTurnResult =
  | {
      readonly status: "completed";
      readonly assistantText: string;
      readonly toolOutputs: readonly ToolOutputView[];
      readonly attemptId: string;
    }
  | {
      readonly status: "failed";
      readonly error: unknown;
      readonly assistantText?: string;
      readonly toolOutputs?: readonly ToolOutputView[];
      readonly attemptId?: string;
    }
  | {
      readonly status: "suspended";
      readonly reason: "approval";
      readonly sourceEventId: string | null;
    }
  | {
      readonly status: "cancelled";
    };

/**
 * Lightweight host convenience wrapper around the internal HostedThreadLoop.
 * Callers that need recovery diagnostics should consume runHostedThreadLoop
 * directly; CLI/TUI ports use this shape to keep their user-facing result
 * contract free of process-local diagnostic state.
 */
export async function runHostedPromptTurn(input: {
  readonly session: CollectSessionPromptOutputSession;
  readonly parts: readonly BrewvaPromptContentPart[];
  readonly source: HostedPromptTurnSource;
  readonly runtime?: BrewvaRuntime;
  readonly sessionId?: string;
  readonly turnId?: string;
  readonly runtimeTurn?: number;
}): Promise<HostedPromptTurnResult> {
  const result = await runHostedThreadLoop({
    session: input.session,
    prompt: input.parts,
    profile: resolveThreadLoopProfile({ source: input.source }),
    runtime: input.runtime,
    sessionId: input.sessionId,
    turnId: input.turnId,
    runtimeTurn: input.runtimeTurn,
  });

  if (result.status === "completed") {
    return {
      status: "completed",
      assistantText: result.assistantText,
      toolOutputs: result.toolOutputs,
      attemptId: result.attemptId,
    };
  }
  if (result.status === "failed") {
    return {
      status: "failed",
      error: result.error,
      assistantText: result.assistantText,
      toolOutputs: result.toolOutputs,
      attemptId: result.attemptId,
    };
  }
  if (result.status === "suspended") {
    return {
      status: "suspended",
      reason: result.reason,
      sourceEventId: result.sourceEventId,
    };
  }
  return {
    status: "cancelled",
  };
}
