import type { BrewvaRuntime, ContextBudgetUsage } from "@brewva/brewva-runtime";
import type { ComposedContextBlock } from "./context-composer.js";

export function appendSupplementalContextBlocks(
  runtime: BrewvaRuntime,
  input: {
    sessionId: string;
    usage?: ContextBudgetUsage;
    injectionScopeId?: string;
    blocks: readonly ComposedContextBlock[];
  },
): ComposedContextBlock[] {
  const acceptedBlocks: ComposedContextBlock[] = [];
  for (const block of input.blocks) {
    const decision = runtime.context.appendSupplementalInjection(
      input.sessionId,
      block.content,
      input.usage,
      input.injectionScopeId,
    );
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
