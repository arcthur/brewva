import type { BrewvaHostedRuntimePort } from "@brewva/brewva-runtime";
import { getHostedRecoveryProjection } from "./projection.js";

export function armNextPromptOutputBudgetEscalation(
  runtime: BrewvaHostedRuntimePort,
  input: {
    sessionId: string;
    targetMaxTokens: number;
    model?: string | null;
  },
): void {
  getHostedRecoveryProjection(runtime).armOutputBudgetEscalation(input.sessionId, {
    targetMaxTokens: input.targetMaxTokens,
    model: input.model ?? null,
  });
}

export function consumeNextPromptOutputBudgetEscalation(
  runtime: BrewvaHostedRuntimePort,
  sessionId: string,
) {
  return getHostedRecoveryProjection(runtime).consumeOutputBudgetEscalation(sessionId);
}

export function clearNextPromptOutputBudgetEscalation(
  runtime: BrewvaHostedRuntimePort,
  sessionId: string,
): boolean {
  return getHostedRecoveryProjection(runtime).clearOutputBudgetEscalation(sessionId);
}

export function markProviderRequestRecoveryInstalled(runtime: BrewvaHostedRuntimePort): void {
  getHostedRecoveryProjection(runtime).markProviderRequestRecoveryInstalled();
}
