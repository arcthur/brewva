import type { ContextInjectionCategory } from "@brewva/brewva-runtime";
import { estimateTokens } from "./tool-output-distiller.js";

const GOVERNANCE_TOKEN_CAP_RATIO = 0.15;
const MIN_GOVERNANCE_TOKEN_CAP = 96;
const MIN_CAPABILITY_VIEW_TOKENS = 48;
const CHARS_PER_TOKEN = 3.5;

export interface GovernanceContextBlock {
  id: string;
  category: ContextInjectionCategory;
  content: string;
  estimatedTokens: number;
  compactContent?: string;
}

export interface GovernanceContextMetrics {
  totalTokens: number;
  narrativeTokens: number;
  constraintTokens: number;
  diagnosticTokens: number;
  narrativeRatio: number;
}

type BuildGovernanceMetrics = (blocks: GovernanceContextBlock[]) => GovernanceContextMetrics;

const DIAGNOSTIC_CAPABILITY_NAMES = new Set<string>([
  "cost_view",
  "obs_query",
  "obs_slo_assert",
  "obs_snapshot",
  "tape_info",
  "tape_search",
]);

function truncateContentToTokenBudget(content: string, maxTokens: number): string {
  const maxChars = Math.max(1, Math.floor(Math.max(1, maxTokens) * CHARS_PER_TOKEN));
  if (content.length <= maxChars) {
    return content;
  }
  if (maxChars <= 3) {
    return content.slice(0, maxChars);
  }
  return `${content.slice(0, maxChars - 3)}...`;
}

function rebuildBlock(
  block: GovernanceContextBlock,
  content: string,
  options: {
    compactContent?: string;
  } = {},
): GovernanceContextBlock | null {
  const normalized = content.trim();
  if (normalized.length === 0) {
    return null;
  }
  const normalizedCompact =
    typeof options.compactContent === "string" ? options.compactContent.trim() : undefined;
  return {
    id: block.id,
    category: block.category,
    content: normalized,
    estimatedTokens: estimateTokens(normalized),
    compactContent:
      normalizedCompact && normalizedCompact.length > 0 && normalizedCompact !== normalized
        ? normalizedCompact
        : undefined,
  };
}

function compactBlock(block: GovernanceContextBlock): GovernanceContextBlock | null {
  if (!block.compactContent) {
    return block;
  }
  const compacted = rebuildBlock(block, block.compactContent);
  if (!compacted) {
    return null;
  }
  return {
    ...compacted,
    estimatedTokens: Math.min(block.estimatedTokens, compacted.estimatedTokens),
  };
}

function measureGovernanceTokens(blocks: GovernanceContextBlock[]): number {
  return blocks.reduce((sum, block) => {
    if (block.category === "constraint" || block.category === "diagnostic") {
      return sum + block.estimatedTokens;
    }
    return sum;
  }, 0);
}

function isDiagnosticCapabilityDetailBlock(block: GovernanceContextBlock): boolean {
  if (!block.id.startsWith("capability-detail:")) {
    return false;
  }
  const toolName = block.id.slice("capability-detail:".length);
  return DIAGNOSTIC_CAPABILITY_NAMES.has(toolName);
}

function removeBlocksWhileOverCap(
  blocks: GovernanceContextBlock[],
  governanceCap: number,
  predicate: (block: GovernanceContextBlock) => boolean,
): GovernanceContextBlock[] {
  let governanceTokens = measureGovernanceTokens(blocks);
  if (governanceTokens <= governanceCap) {
    return blocks;
  }
  return blocks.filter((block) => {
    if (!predicate(block)) {
      return true;
    }
    if (governanceTokens <= governanceCap) {
      return true;
    }
    governanceTokens -=
      block.category === "constraint" || block.category === "diagnostic"
        ? block.estimatedTokens
        : 0;
    return false;
  });
}

function compactBlocksWhileOverCap(
  blocks: GovernanceContextBlock[],
  governanceCap: number,
  predicate: (block: GovernanceContextBlock) => boolean,
): GovernanceContextBlock[] {
  const current = [...blocks];
  let governanceTokens = measureGovernanceTokens(current);
  if (governanceTokens <= governanceCap) {
    return current;
  }
  for (let index = 0; index < current.length; index += 1) {
    const block = current[index];
    if (!block || !predicate(block) || !block.compactContent) {
      continue;
    }
    if (governanceTokens <= governanceCap) {
      break;
    }
    const compacted = compactBlock(block);
    if (!compacted || compacted.estimatedTokens >= block.estimatedTokens) {
      continue;
    }
    governanceTokens -= block.estimatedTokens - compacted.estimatedTokens;
    current[index] = compacted;
  }
  return current;
}

export function applyGovernanceBudgetCap(
  blocks: GovernanceContextBlock[],
  buildMetrics: BuildGovernanceMetrics,
): GovernanceContextBlock[] {
  if (blocks.length === 0) {
    return blocks;
  }

  let current = [...blocks];
  const hasCriticalCompactionGate = current.some((block) => block.id === "compaction-gate");
  const hasNarrativeBlocks = current.some((block) => block.category === "narrative");
  if (hasCriticalCompactionGate && !hasNarrativeBlocks) {
    current = current.filter((block) => block.id !== "operational-diagnostics");
  }
  let metrics = buildMetrics(current);
  const hasPendingCompactionAdvisory = current.some((block) => block.id === "compaction-advisory");
  const governanceCap = Math.max(
    hasPendingCompactionAdvisory && !hasCriticalCompactionGate
      ? MIN_GOVERNANCE_TOKEN_CAP + 32
      : MIN_GOVERNANCE_TOKEN_CAP,
    Math.floor(metrics.totalTokens * GOVERNANCE_TOKEN_CAP_RATIO),
  );
  let governanceTokens = metrics.constraintTokens + metrics.diagnosticTokens;
  if (governanceTokens <= governanceCap) {
    return current;
  }

  current = removeBlocksWhileOverCap(
    current,
    governanceCap,
    (block) => block.category === "diagnostic" && block.id !== "operational-diagnostics",
  );

  governanceTokens = measureGovernanceTokens(current);
  if (governanceTokens <= governanceCap) {
    return current;
  }

  current = removeBlocksWhileOverCap(
    current,
    governanceCap,
    (block) => block.id === "capability-view-inventory",
  );

  governanceTokens = measureGovernanceTokens(current);
  if (governanceTokens <= governanceCap) {
    return current;
  }

  current = removeBlocksWhileOverCap(
    current,
    governanceCap,
    (block) => block.id === "compaction-advisory",
  );

  governanceTokens = measureGovernanceTokens(current);
  if (governanceTokens <= governanceCap) {
    return current;
  }

  current = compactBlocksWhileOverCap(
    current,
    governanceCap,
    (block) => block.id.startsWith("capability-detail:") || block.id === "capability-view-policy",
  );

  governanceTokens = measureGovernanceTokens(current);
  if (governanceTokens <= governanceCap) {
    return current;
  }

  current = compactBlocksWhileOverCap(
    current,
    governanceCap,
    (block) => block.id === "capability-view-summary",
  );

  governanceTokens = measureGovernanceTokens(current);
  if (governanceTokens <= governanceCap) {
    return current;
  }

  current = removeBlocksWhileOverCap(
    current,
    governanceCap,
    (block) => block.id === "capability-view-policy",
  );

  governanceTokens = measureGovernanceTokens(current);
  if (governanceTokens <= governanceCap) {
    return current;
  }

  current = removeBlocksWhileOverCap(current, governanceCap, isDiagnosticCapabilityDetailBlock);

  governanceTokens = measureGovernanceTokens(current);
  if (governanceTokens <= governanceCap) {
    return current;
  }

  current = compactBlocksWhileOverCap(
    current,
    governanceCap,
    (block) => block.id === "operational-diagnostics",
  );

  governanceTokens = measureGovernanceTokens(current);
  if (governanceTokens <= governanceCap) {
    return current;
  }

  const capabilityIndex = current.findIndex(
    (block) => block.id === "capability-view-summary" || block.id === "capability-view",
  );
  if (capabilityIndex < 0) {
    return removeBlocksWhileOverCap(
      current,
      governanceCap,
      (block) => block.id === "operational-diagnostics",
    );
  }

  const otherGovernanceTokens = current.reduce((sum, block, index) => {
    if (index === capabilityIndex) {
      return sum;
    }
    if (block.category === "constraint" || block.category === "diagnostic") {
      return sum + block.estimatedTokens;
    }
    return sum;
  }, 0);
  const capabilityBudget = Math.max(
    MIN_CAPABILITY_VIEW_TOKENS,
    governanceCap - otherGovernanceTokens,
  );
  const capabilityBlock = current[capabilityIndex]!;
  if (capabilityBlock.estimatedTokens > capabilityBudget) {
    const truncatedCapability = rebuildBlock(
      capabilityBlock,
      truncateContentToTokenBudget(capabilityBlock.content, capabilityBudget),
    );
    if (!truncatedCapability) {
      current = current.filter((_, index) => index !== capabilityIndex);
    } else {
      current[capabilityIndex] = {
        ...truncatedCapability,
        estimatedTokens: Math.min(capabilityBlock.estimatedTokens, capabilityBudget),
      };
    }
  }

  governanceTokens = measureGovernanceTokens(current);
  if (governanceTokens <= governanceCap) {
    return current;
  }

  if (hasPendingCompactionAdvisory && !hasCriticalCompactionGate) {
    current = removeBlocksWhileOverCap(
      current,
      governanceCap,
      (block) => block.id === "capability-view-summary" || block.id === "capability-view",
    );
    governanceTokens = measureGovernanceTokens(current);
    if (governanceTokens <= governanceCap) {
      return current;
    }
  }

  return removeBlocksWhileOverCap(
    current,
    governanceCap,
    (block) => block.id === "operational-diagnostics",
  );
}
