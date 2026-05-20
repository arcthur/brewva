import type { BrewvaAgentProtocolMessage } from "@brewva/brewva-substrate/agent-protocol";
import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate/prompt";
import type { BrewvaPromptOptions } from "@brewva/brewva-substrate/session";

export const HOSTED_RUNTIME_TURN_PRELUDE: unique symbol = Symbol("brewva.hostedRuntimeTurnPrelude");

export const HOSTED_RUNTIME_TURN_CONTEXT: unique symbol = Symbol("brewva.hostedRuntimeTurnContext");

export type HostedRuntimeTurnPreludeResult =
  | {
      readonly status: "ready";
      readonly promptText: string;
      readonly promptContent: readonly BrewvaPromptContentPart[];
      readonly signal?: AbortSignal;
      readonly complete?: () => void | Promise<void>;
    }
  | {
      readonly status: "handled" | "queued";
    };

export interface HostedRuntimeTurnPreludeSession {
  [HOSTED_RUNTIME_TURN_PRELUDE](
    parts: readonly BrewvaPromptContentPart[],
    options?: BrewvaPromptOptions,
  ): Promise<HostedRuntimeTurnPreludeResult>;
}

export interface HostedRuntimeTurnContextSession {
  [HOSTED_RUNTIME_TURN_CONTEXT](): readonly BrewvaAgentProtocolMessage[];
}

export function hasHostedRuntimeTurnPrelude(
  session: unknown,
): session is HostedRuntimeTurnPreludeSession {
  return (
    typeof session === "object" &&
    session !== null &&
    typeof (session as Partial<HostedRuntimeTurnPreludeSession>)[HOSTED_RUNTIME_TURN_PRELUDE] ===
      "function"
  );
}

export function getHostedRuntimeTurnContextMessages(
  session: unknown,
): readonly BrewvaAgentProtocolMessage[] {
  if (
    typeof session !== "object" ||
    session === null ||
    typeof (session as Partial<HostedRuntimeTurnContextSession>)[HOSTED_RUNTIME_TURN_CONTEXT] !==
      "function"
  ) {
    return [];
  }
  return (session as HostedRuntimeTurnContextSession)[HOSTED_RUNTIME_TURN_CONTEXT]();
}
