import { sha256Hex } from "@brewva/brewva-std/hash";

export function buildPromptStabilityObservation(input: {
  systemPrompt: string;
  composedContent: string;
  contextScopeId?: string;
  turn: number;
}): {
  stablePrefixHash: string;
  dynamicTailHash: string;
  contextScopeId?: string;
  turn: number;
} {
  return {
    stablePrefixHash: sha256Hex(input.systemPrompt),
    dynamicTailHash: sha256Hex(input.composedContent),
    contextScopeId: input.contextScopeId,
    turn: input.turn,
  };
}
