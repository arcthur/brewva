import { sha256Hex } from "@brewva/brewva-std/hash";

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
    stablePrefixHash: sha256Hex(input.systemPrompt),
    dynamicTailHash: sha256Hex(input.composedContent),
    injectionScopeId: input.injectionScopeId,
    turn: input.turn,
  };
}
