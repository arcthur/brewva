import { estimateTokens } from "./tool-output-distiller.js";

export interface HostedContextBlock {
  id: string;
  content: string;
  estimatedTokens: number;
}

export interface HostedContextRenderResult {
  blocks: HostedContextBlock[];
  content: string;
  totalTokens: number;
  surfacedDelegationRunIds: string[];
}

export interface ContextComposedEventPayload extends Record<string, unknown> {
  blockCount: number;
  totalTokens: number;
  workbenchContextRendered: boolean;
  blockIds: string[];
}

export function makeHostedContextBlock(id: string, content: string): HostedContextBlock | null {
  const normalized = content.trim();
  if (normalized.length === 0) {
    return null;
  }
  return {
    id,
    content: normalized,
    estimatedTokens: estimateTokens(normalized),
  };
}

export function renderHostedContextBlocks(input: {
  blocks: readonly (HostedContextBlock | null | undefined)[];
  surfacedDelegationRunIds?: readonly string[];
}): HostedContextRenderResult {
  const blocks = input.blocks.filter((block): block is HostedContextBlock => Boolean(block));
  const totalTokens = blocks.reduce((sum, block) => sum + block.estimatedTokens, 0);
  return {
    blocks,
    content: blocks.map((block) => block.content).join("\n\n"),
    totalTokens,
    surfacedDelegationRunIds: [...(input.surfacedDelegationRunIds ?? [])],
  };
}

export function buildContextComposedEventPayload(
  rendered: HostedContextRenderResult,
  workbenchContextRendered: boolean,
): ContextComposedEventPayload {
  return {
    blockCount: rendered.blocks.length,
    totalTokens: rendered.totalTokens,
    workbenchContextRendered,
    blockIds: rendered.blocks.map((block) => block.id),
  };
}
