import { sha256Hex } from "@brewva/brewva-std/hash";

export interface KeyedBlockDiff {
  readonly added: readonly string[];
  readonly updated: readonly string[];
  readonly removed: readonly string[];
}

// Borrowed from opencode's System Context source algebra (baseline / update /
// removed): a structured, per-keyed-block diff instead of an opaque boolean
// (RFC: Checked Invariants And Disciplined Peer Borrowing, item A). Kept as a
// pure helper so it serves the reachable dynamic-tail blocks today and the
// systemPrompt prefix blocks once those are exposed as a document, not a string.
export function diffKeyedBlocks(
  previous: Readonly<Record<string, string>> | undefined,
  current: Readonly<Record<string, string>>,
): KeyedBlockDiff {
  const added: string[] = [];
  const updated: string[] = [];
  for (const [id, hash] of Object.entries(current)) {
    const prior = previous?.[id];
    if (prior === undefined) {
      added.push(id);
    } else if (prior !== hash) {
      updated.push(id);
    }
  }
  const removed = previous ? Object.keys(previous).filter((id) => !(id in current)) : [];
  return {
    added: added.toSorted(),
    updated: updated.toSorted(),
    removed: removed.toSorted(),
  };
}

function hashTailBlocks(
  blocks: readonly { id: string; content: string }[] | undefined,
): Record<string, string> | undefined {
  if (!blocks || blocks.length === 0) {
    return undefined;
  }
  const hashes: Record<string, string> = {};
  for (const block of blocks) {
    hashes[block.id] = sha256Hex(block.content);
  }
  return hashes;
}

export function buildPromptStabilityObservation(input: {
  systemPrompt: string;
  composedContent: string;
  contextScopeId?: string;
  turn: number;
  tailBlocks?: readonly { id: string; content: string }[];
}): {
  stablePrefixHash: string;
  dynamicTailHash: string;
  contextScopeId?: string;
  turn: number;
  tailBlockHashes?: Record<string, string>;
} {
  const tailBlockHashes = hashTailBlocks(input.tailBlocks);
  return {
    stablePrefixHash: sha256Hex(input.systemPrompt),
    dynamicTailHash: sha256Hex(input.composedContent),
    contextScopeId: input.contextScopeId,
    turn: input.turn,
    ...(tailBlockHashes ? { tailBlockHashes } : {}),
  };
}
