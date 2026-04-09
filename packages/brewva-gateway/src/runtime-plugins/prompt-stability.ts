import { createHash } from "node:crypto";

function sha256Utf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function buildPromptStabilityObservation(input: {
  systemPrompt: string;
  composedContent: string;
  injectionScopeId?: string;
  turn: number;
}): {
  stablePrefixHash: string;
  dynamicTailHash: string;
  injectionScopeId?: string;
  turn: number;
} {
  return {
    stablePrefixHash: sha256Utf8(input.systemPrompt),
    dynamicTailHash: sha256Utf8(input.composedContent),
    injectionScopeId: input.injectionScopeId,
    turn: input.turn,
  };
}
