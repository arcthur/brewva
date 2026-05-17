import { stableJsonSha256Hex } from "@brewva/brewva-std/hash";
import { estimateTokenCount, truncateTextToTokenBudget } from "@brewva/brewva-token-estimation";

export const CONTEXT_BUNDLE_SCHEMA = "brewva.context-bundle.v1" as const;

export type ContextBundleAdmission = "required" | "advisory";
export type ContextBundleScope = "hosted_dynamic_tail" | "delegation_prompt";

export interface ContextBundleRef {
  readonly kind: string;
  readonly locator: string;
  readonly summary?: string;
  readonly sourceSessionId?: string;
  readonly hash?: string;
}

export interface ContextBundleBlock {
  readonly id: string;
  readonly content: string;
  readonly estimatedTokens: number;
  readonly admission: ContextBundleAdmission;
  readonly priority: number;
  readonly sourceRefIds: readonly string[];
}

export interface ContextBundleRenderResult {
  readonly blocks: Pick<ContextBundleBlock, "id" | "content" | "estimatedTokens">[];
  readonly content: string;
  readonly totalTokens: number;
}

export interface ContextBundleBudget {
  readonly maxTokens?: number;
  readonly overflow: "compaction_required" | "delegation_blocker";
}

export interface ContextBundle {
  readonly schema: typeof CONTEXT_BUNDLE_SCHEMA;
  readonly bundleId: string;
  readonly scope: ContextBundleScope;
  readonly sourceRefs: readonly ContextBundleRef[];
  readonly admittedRefs: readonly ContextBundleRef[];
  readonly blocks: readonly ContextBundleBlock[];
  readonly budget: ContextBundleBudget;
  readonly totalTokens: number;
  readonly hash: string;
  readonly createdAt: number;
}

export type ContextBundleBlockInput = {
  readonly id: string;
  readonly content: string;
  readonly admission?: ContextBundleAdmission;
  readonly priority?: number;
  readonly sourceRefIds?: readonly string[];
  readonly truncate?: (content: string, maxTokens: number) => string;
};

export type ContextBundleBuildResult =
  | { ok: true; bundle: ContextBundle }
  | {
      ok: false;
      blocker: {
        reason: "context_budget_exceeded";
        overflow: ContextBundleBudget["overflow"];
        requiredTokens: number;
        maxTokens: number;
      };
    };

function normalizeBlock(input: ContextBundleBlockInput): ContextBundleBlock | undefined {
  const content = input.content.trim();
  if (!content) return undefined;
  return {
    id: input.id,
    content,
    estimatedTokens: estimateTokenCount(content),
    admission: input.admission ?? "advisory",
    priority: input.priority ?? 100,
    sourceRefIds: [...(input.sourceRefIds ?? [])],
  };
}

function renderBundleHashMaterial(input: Omit<ContextBundle, "bundleId" | "hash">): string {
  return stableJsonSha256Hex({
    schema: input.schema,
    scope: input.scope,
    sourceRefs: input.sourceRefs,
    admittedRefs: input.admittedRefs,
    blocks: input.blocks.map((block) => ({
      id: block.id,
      content: block.content,
      estimatedTokens: block.estimatedTokens,
      admission: block.admission,
      priority: block.priority,
      sourceRefIds: block.sourceRefIds,
    })),
    budget: input.budget,
    totalTokens: input.totalTokens,
  });
}

function sumTokens(blocks: readonly ContextBundleBlock[]): number {
  return blocks.reduce((sum, block) => sum + block.estimatedTokens, 0);
}

function admittedRefsForBlocks(
  refs: readonly ContextBundleRef[],
  blocks: readonly ContextBundleBlock[],
): ContextBundleRef[] {
  const admittedIds = new Set(blocks.flatMap((block) => block.sourceRefIds));
  if (admittedIds.size === 0) return [];
  return refs.filter((ref) => admittedIds.has(ref.locator));
}

function freezeContextBundle(bundle: ContextBundle): ContextBundle {
  const sourceRefs = Object.freeze(bundle.sourceRefs.map((ref) => Object.freeze({ ...ref })));
  const admittedRefs = Object.freeze(bundle.admittedRefs.map((ref) => Object.freeze({ ...ref })));
  const blocks = Object.freeze(
    bundle.blocks.map((block) =>
      Object.freeze({
        ...block,
        sourceRefIds: Object.freeze([...block.sourceRefIds]),
      }),
    ),
  );
  return Object.freeze({
    ...bundle,
    sourceRefs,
    admittedRefs,
    blocks,
    budget: Object.freeze({ ...bundle.budget }),
  });
}

function trimBlocksToBudget(input: { blocks: ContextBundleBlockInput[]; maxTokens: number }): {
  blocks: ContextBundleBlock[];
  requiredTokens: number;
} {
  const requiredInputs = input.blocks.filter(
    (block) => (block.admission ?? "advisory") === "required",
  );
  const required: ContextBundleBlock[] = [];
  let requiredTokens = 0;
  for (const blockInput of requiredInputs) {
    const full = normalizeBlock(blockInput);
    if (!full) continue;
    if (requiredTokens + full.estimatedTokens <= input.maxTokens) {
      required.push(full);
      requiredTokens += full.estimatedTokens;
      continue;
    }
    const remainingTokens = input.maxTokens - requiredTokens;
    if (blockInput.truncate && remainingTokens > 0) {
      const truncated = normalizeBlock({
        ...blockInput,
        content: blockInput.truncate(blockInput.content, remainingTokens),
      });
      if (truncated && requiredTokens + truncated.estimatedTokens <= input.maxTokens) {
        required.push(truncated);
        requiredTokens += truncated.estimatedTokens;
        continue;
      }
    }
    required.push(full);
    requiredTokens += full.estimatedTokens;
  }
  if (requiredTokens > input.maxTokens) {
    return { blocks: required, requiredTokens };
  }

  const advisory = input.blocks
    .filter((block) => (block.admission ?? "advisory") === "advisory")
    .toSorted((left, right) => (left.priority ?? 100) - (right.priority ?? 100));
  const admitted = [...required];
  let totalTokens = requiredTokens;
  for (const blockInput of advisory) {
    const block = normalizeBlock(blockInput);
    if (!block) continue;
    if (totalTokens + block.estimatedTokens <= input.maxTokens) {
      admitted.push(block);
      totalTokens += block.estimatedTokens;
      continue;
    }
    if (!blockInput.truncate) continue;
    const remainingTokens = input.maxTokens - totalTokens;
    if (remainingTokens <= 0) continue;
    const truncated = normalizeBlock({
      ...blockInput,
      content: blockInput.truncate(blockInput.content, remainingTokens),
    });
    if (truncated && totalTokens + truncated.estimatedTokens <= input.maxTokens) {
      admitted.push(truncated);
      totalTokens += truncated.estimatedTokens;
    }
  }
  return { blocks: admitted, requiredTokens };
}

export function deterministicTokenTruncate(content: string, maxTokens: number): string {
  const marker = "\n[truncated]";
  const markerTokens = estimateTokenCount(marker);
  const truncated = truncateTextToTokenBudget(
    content,
    Math.max(0, maxTokens - markerTokens),
  ).trim();
  if (truncated.length === 0 || truncated === content.trim()) {
    return truncated;
  }
  return `${truncated}${marker}`;
}

export function buildContextBundle(input: {
  scope: ContextBundleScope;
  sourceRefs?: readonly ContextBundleRef[];
  blocks: readonly ContextBundleBlockInput[];
  budget?: Partial<ContextBundleBudget>;
  createdAt?: number;
}): ContextBundleBuildResult {
  const createdAt = input.createdAt ?? 0;
  const budget: ContextBundleBudget = {
    overflow: input.budget?.overflow ?? "compaction_required",
    ...(typeof input.budget?.maxTokens === "number" ? { maxTokens: input.budget.maxTokens } : {}),
  };
  const sourceRefs = [...(input.sourceRefs ?? [])];
  const blocks =
    typeof budget.maxTokens === "number"
      ? trimBlocksToBudget({ blocks: [...input.blocks], maxTokens: budget.maxTokens })
      : {
          blocks: input.blocks
            .map(normalizeBlock)
            .filter((block): block is ContextBundleBlock => Boolean(block)),
          requiredTokens: 0,
        };

  if (typeof budget.maxTokens === "number" && blocks.requiredTokens > budget.maxTokens) {
    return {
      ok: false,
      blocker: {
        reason: "context_budget_exceeded",
        overflow: budget.overflow,
        requiredTokens: blocks.requiredTokens,
        maxTokens: budget.maxTokens,
      },
    };
  }

  const base = {
    schema: CONTEXT_BUNDLE_SCHEMA,
    scope: input.scope,
    sourceRefs,
    admittedRefs: admittedRefsForBlocks(sourceRefs, blocks.blocks),
    blocks: blocks.blocks,
    budget,
    totalTokens: sumTokens(blocks.blocks),
    createdAt,
  } satisfies Omit<ContextBundle, "bundleId" | "hash">;
  const hash = renderBundleHashMaterial(base);
  return {
    ok: true,
    bundle: freezeContextBundle({
      ...base,
      hash,
      bundleId: hash.slice(0, 24),
    }),
  };
}

export function renderContextBundle(bundle: ContextBundle): ContextBundleRenderResult {
  return {
    blocks: bundle.blocks.map((block) => ({
      id: block.id,
      content: block.content,
      estimatedTokens: block.estimatedTokens,
    })),
    content: bundle.blocks.map((block) => block.content).join("\n\n"),
    totalTokens: bundle.totalTokens,
  };
}
