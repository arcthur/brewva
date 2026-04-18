import type { BrewvaHostedRuntimePort, ContextBudgetUsage } from "@brewva/brewva-runtime";
import type { ComposedContextBlock } from "./context-composer.js";

export function appendSupplementalContextBlocks(
  runtime: BrewvaHostedRuntimePort,
  input: {
    sessionId: string;
    usage?: ContextBudgetUsage;
    injectionScopeId?: string;
    blocks: readonly ComposedContextBlock[];
  },
): ComposedContextBlock[] {
  const acceptedBlocks: ComposedContextBlock[] = [];
  const decisions = runtime.maintain.context.appendGuardedSupplementalBlocks(
    input.sessionId,
    input.blocks.map((block) => ({
      familyId: block.familyId ?? block.id,
      content: block.content,
    })),
    input.usage,
    input.injectionScopeId,
  );
  for (const [index, block] of input.blocks.entries()) {
    const decision = decisions[index];
    if (!decision) {
      continue;
    }
    if (!decision.accepted || decision.finalTokens <= 0) {
      continue;
    }
    const content = decision.text.trim();
    if (content.length === 0) {
      continue;
    }
    acceptedBlocks.push({
      ...block,
      content,
      estimatedTokens: decision.finalTokens,
    });
  }
  return acceptedBlocks;
}
