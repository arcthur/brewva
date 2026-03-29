import {
  type ContextCompactionGateStatus,
  type ContextInjectionCategory,
  type ContextInjectionEntry,
} from "@brewva/brewva-runtime";
import {
  renderCapabilityView,
  type BuildCapabilityViewResult,
  type CapabilityRenderedBlock,
} from "./capability-view.js";
import { applyGovernanceBudgetCap } from "./context-composer-governance.js";
import {
  listPendingDelegationOutcomes,
  resolveSupplementalContextBlocks,
  type ContextComposerSupplementalRuntime,
} from "./context-composer-supplemental.js";
import { formatPercent } from "./context-shared.js";
import { estimateTokens } from "./tool-output-distiller.js";

const CAPABILITY_VIEW_INVENTORY_RATIO_THRESHOLD = 0.35;
const CAPABILITY_VIEW_COMPACT_RATIO_THRESHOLD = 0.2;

export type ContextBlockCategory = ContextInjectionCategory;
export type ContextComposerRuntime = ContextComposerSupplementalRuntime;

export interface ComposedContextBlock {
  id: string;
  category: ContextBlockCategory;
  content: string;
  estimatedTokens: number;
}

export interface ContextComposerMetrics {
  totalTokens: number;
  narrativeTokens: number;
  constraintTokens: number;
  diagnosticTokens: number;
  narrativeRatio: number;
}

export interface ContextComposerResult {
  blocks: ComposedContextBlock[];
  content: string;
  metrics: ContextComposerMetrics;
  surfacedDelegationRunIds: string[];
}

interface InternalContextBlock extends ComposedContextBlock {
  compactContent?: string;
}

export interface ContextComposedEventPayload extends Record<string, unknown> {
  narrativeBlockCount: number;
  constraintBlockCount: number;
  diagnosticBlockCount: number;
  totalTokens: number;
  narrativeTokens: number;
  narrativeRatio: number;
  injectionAccepted: boolean;
}

export interface ContextComposerInput {
  runtime: ContextComposerRuntime;
  sessionId: string;
  gateStatus: ContextCompactionGateStatus;
  pendingCompactionReason?: string | null;
  capabilityView: BuildCapabilityViewResult;
  admittedEntries: ContextInjectionEntry[];
  injectionAccepted: boolean;
  supplementalBlocks?: readonly ComposedContextBlock[];
  includeDefaultSupplementalBlocks?: boolean;
}

function makeBlock(
  id: string,
  category: ContextBlockCategory,
  content: string,
  options: {
    compactContent?: string;
  } = {},
): InternalContextBlock | null {
  const normalized = content.trim();
  if (normalized.length === 0) {
    return null;
  }
  const normalizedCompact =
    typeof options.compactContent === "string" ? options.compactContent.trim() : undefined;
  return {
    id,
    category,
    content: normalized,
    estimatedTokens: estimateTokens(normalized),
    compactContent:
      normalizedCompact && normalizedCompact.length > 0 && normalizedCompact !== normalized
        ? normalizedCompact
        : undefined,
  };
}

function buildCompactionGateBlock(input: {
  pressure: ContextCompactionGateStatus["pressure"];
}): string {
  const usageRatio = input.pressure.usageRatio ?? 0;
  const usagePercent = formatPercent(usageRatio);
  const hardLimitPercent = formatPercent(input.pressure.hardLimitRatio);
  return [
    "[ContextCompactionGate]",
    "Context pressure is critical.",
    `Current usage: ${usagePercent} (hard limit: ${hardLimitPercent}).`,
    "Call tool `session_compact` immediately before any other tool call.",
    "Do not run `session_compact` via `exec` or shell.",
  ].join("\n");
}

function buildCompactionAdvisoryBlock(input: {
  reason: string;
  pressure: ContextCompactionGateStatus["pressure"];
}): string {
  const usageRatio = input.pressure.usageRatio ?? 0;
  const usagePercent = formatPercent(usageRatio);
  const thresholdPercent = formatPercent(input.pressure.compactionThresholdRatio);
  return [
    "[ContextCompactionAdvisory]",
    `Pending compaction request: ${input.reason}.`,
    `Current usage: ${usagePercent} (compact-soon threshold: ${thresholdPercent}).`,
    "Prefer `session_compact` before long tool chains or broad repository scans.",
    "If no further tool work is needed, answer directly instead of compacting first.",
  ].join("\n");
}

function compareCategory(left: ContextBlockCategory, right: ContextBlockCategory): number {
  const order: Record<ContextBlockCategory, number> = {
    narrative: 0,
    constraint: 1,
    diagnostic: 2,
  };
  return order[left] - order[right];
}

function buildMetrics<T extends Pick<ComposedContextBlock, "category" | "estimatedTokens">>(
  blocks: T[],
): ContextComposerMetrics {
  let narrativeTokens = 0;
  let constraintTokens = 0;
  let diagnosticTokens = 0;
  for (const block of blocks) {
    if (block.category === "narrative") {
      narrativeTokens += block.estimatedTokens;
      continue;
    }
    if (block.category === "constraint") {
      constraintTokens += block.estimatedTokens;
      continue;
    }
    diagnosticTokens += block.estimatedTokens;
  }
  const totalTokens = narrativeTokens + constraintTokens + diagnosticTokens;
  return {
    totalTokens,
    narrativeTokens,
    constraintTokens,
    diagnosticTokens,
    narrativeRatio: totalTokens > 0 ? narrativeTokens / totalTokens : 0,
  };
}

function estimateRenderedBlockTokens(blocks: CapabilityRenderedBlock[]): number {
  return blocks.reduce((sum, block) => sum + estimateTokens(block.content), 0);
}

function computeProjectedNarrativeRatio(
  existingMetrics: ContextComposerMetrics,
  renderedBlocks: CapabilityRenderedBlock[],
): number {
  const totalTokens = existingMetrics.totalTokens + estimateRenderedBlockTokens(renderedBlocks);
  if (totalTokens <= 0) {
    return 0;
  }
  return existingMetrics.narrativeTokens / totalTokens;
}

function resolveCapabilityBlocks(
  capabilityView: BuildCapabilityViewResult,
  existingMetrics: ContextComposerMetrics,
): CapabilityRenderedBlock[] {
  if (existingMetrics.narrativeTokens <= 0) {
    return renderCapabilityView({
      capabilityView,
      mode: "compact",
      includeInventory: false,
    });
  }

  const fullWithInventory = renderCapabilityView({
    capabilityView,
    mode: "full",
    includeInventory: true,
  });
  if (
    computeProjectedNarrativeRatio(existingMetrics, fullWithInventory) >=
    CAPABILITY_VIEW_INVENTORY_RATIO_THRESHOLD
  ) {
    return fullWithInventory;
  }

  const fullWithoutInventory = renderCapabilityView({
    capabilityView,
    mode: "full",
    includeInventory: false,
  });
  if (
    computeProjectedNarrativeRatio(existingMetrics, fullWithoutInventory) >=
    CAPABILITY_VIEW_COMPACT_RATIO_THRESHOLD
  ) {
    return fullWithoutInventory;
  }

  return renderCapabilityView({
    capabilityView,
    mode: "compact",
    includeInventory: false,
  });
}

function buildCapabilityBlocks(
  capabilityView: BuildCapabilityViewResult,
  existingMetrics: ContextComposerMetrics,
): InternalContextBlock[] {
  const renderedBlocks = resolveCapabilityBlocks(capabilityView, existingMetrics);
  return renderedBlocks.flatMap((block) => {
    const constraintBlock = makeBlock(block.id, "constraint", block.content, {
      compactContent: block.compactContent,
    });
    return constraintBlock ? [constraintBlock] : [];
  });
}

function toPublicBlock(block: InternalContextBlock): ComposedContextBlock {
  const { compactContent: _compactContent, ...publicBlock } = block;
  return publicBlock;
}

function normalizeSupplementalBlocks(
  blocks: readonly ComposedContextBlock[] | undefined,
  options: {
    preserveOperationalDiagnostics?: boolean;
  } = {},
): InternalContextBlock[] {
  if (!blocks || blocks.length === 0) {
    return [];
  }
  return blocks.flatMap((block) => {
    const normalized = makeBlock(
      options.preserveOperationalDiagnostics && block.id === "operational-diagnostics"
        ? "supplemental-operational-diagnostics"
        : block.id,
      block.category,
      block.content,
    );
    return normalized ? [normalized] : [];
  });
}

export { resolveSupplementalContextBlocks } from "./context-composer-supplemental.js";

export function composeContextBlocks(input: ContextComposerInput): ContextComposerResult {
  const blocks: InternalContextBlock[] = [];

  if (input.injectionAccepted) {
    for (const entry of input.admittedEntries) {
      const block = makeBlock(`source:${entry.source}:${entry.id}`, entry.category, entry.content);
      if (block) {
        blocks.push(block);
      }
    }
  }

  if (input.gateStatus.required) {
    const gateBlock = makeBlock(
      "compaction-gate",
      "constraint",
      buildCompactionGateBlock({
        pressure: input.gateStatus.pressure,
      }),
    );
    if (gateBlock) {
      blocks.push(gateBlock);
    }
  } else if (input.pendingCompactionReason) {
    const advisoryBlock = makeBlock(
      "compaction-advisory",
      "constraint",
      buildCompactionAdvisoryBlock({
        reason: input.pendingCompactionReason,
        pressure: input.gateStatus.pressure,
      }),
    );
    if (advisoryBlock) {
      blocks.push(advisoryBlock);
    }
  }

  const preCapabilityMetrics = buildMetrics(blocks);
  blocks.push(...buildCapabilityBlocks(input.capabilityView, preCapabilityMetrics));
  if (input.includeDefaultSupplementalBlocks !== false) {
    blocks.push(...normalizeSupplementalBlocks(resolveSupplementalContextBlocks(input)));
  }
  blocks.push(
    ...normalizeSupplementalBlocks(input.supplementalBlocks, {
      preserveOperationalDiagnostics: true,
    }),
  );

  const ordered = applyGovernanceBudgetCap(
    [...blocks].toSorted((left, right) => {
      const categoryDiff = compareCategory(left.category, right.category);
      return categoryDiff;
    }),
    buildMetrics,
  );
  const publicBlocks = ordered.map(toPublicBlock);
  const metrics = buildMetrics(publicBlocks);
  return {
    blocks: publicBlocks,
    content: publicBlocks.map((block) => block.content).join("\n\n"),
    metrics,
    surfacedDelegationRunIds: publicBlocks.some(
      (block) => block.id === "completed-delegation-outcomes",
    )
      ? listPendingDelegationOutcomes(input.runtime, input.sessionId).map((run) => run.runId)
      : [],
  };
}

export function buildContextComposedEventPayload(
  composed: ContextComposerResult,
  injectionAccepted: boolean,
): ContextComposedEventPayload {
  return {
    narrativeBlockCount: composed.blocks.filter((block) => block.category === "narrative").length,
    constraintBlockCount: composed.blocks.filter((block) => block.category === "constraint").length,
    diagnosticBlockCount: composed.blocks.filter((block) => block.category === "diagnostic").length,
    totalTokens: composed.metrics.totalTokens,
    narrativeTokens: composed.metrics.narrativeTokens,
    narrativeRatio: composed.metrics.narrativeRatio,
    injectionAccepted,
  };
}
