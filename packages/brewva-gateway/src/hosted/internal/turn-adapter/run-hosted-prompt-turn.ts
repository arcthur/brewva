import type { ToolOutputView } from "@brewva/brewva-runtime/protocol";
import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate/prompt";
import type { HostedRuntimeAdapterPort } from "../session/runtime-ports.js";
import type { CollectSessionPromptOutputSession } from "./collect-output.js";
import { runHostedTurnEnvelope } from "./turn-envelope.js";

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
 * Lightweight host convenience wrapper around the canonical hosted turn envelope.
 * CLI/TUI ports use this shape to keep their user-facing result contract free of
 * process-local diagnostic state.
 */
export async function runHostedPromptTurn(input: {
  readonly session: CollectSessionPromptOutputSession;
  readonly parts: readonly BrewvaPromptContentPart[];
  readonly source: HostedPromptTurnSource;
  readonly runtime: HostedRuntimeAdapterPort;
  readonly sessionId: string;
  readonly turnId?: string;
}): Promise<HostedPromptTurnResult> {
  const result = await runHostedTurnEnvelope({
    session: input.session,
    prompt: input.parts,
    runtime: input.runtime,
    sessionId: input.sessionId,
    turnId: input.turnId,
    source: input.source,
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
