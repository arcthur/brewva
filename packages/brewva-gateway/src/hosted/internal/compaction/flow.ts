import type { BrewvaCompactionRequest } from "@brewva/brewva-substrate/tools";
import type { SessionCompactionGenerationMetadata } from "@brewva/brewva-vocabulary/session";
import type {
  BrewvaCompactionSummaryGenerationResult,
  BrewvaCompactionSummaryStrategy,
} from "./summary-generator.js";

export interface PendingCompactionRequestState {
  customInstructions?: string;
  onComplete?: BrewvaCompactionRequest["onComplete"];
  onError?: BrewvaCompactionRequest["onError"];
}

export interface ResolvedCompactionSummary {
  summary: string;
  strategy: BrewvaCompactionSummaryStrategy;
  model?: BrewvaCompactionSummaryGenerationResult["model"];
  usage?: BrewvaCompactionSummaryGenerationResult["usage"];
  fallbackReason?: string;
}

export function nonNegativeUsageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

export function buildCompactionSummaryGenerationMetadata(
  resolution: ResolvedCompactionSummary,
): SessionCompactionGenerationMetadata {
  return {
    strategy: resolution.strategy,
    ...(resolution.model ? { model: resolution.model } : {}),
    ...(resolution.usage
      ? {
          usage: {
            input: nonNegativeUsageNumber(resolution.usage.input),
            output: nonNegativeUsageNumber(resolution.usage.output),
            cacheRead: nonNegativeUsageNumber(resolution.usage.cacheRead),
            cacheWrite: nonNegativeUsageNumber(resolution.usage.cacheWrite),
            totalTokens: nonNegativeUsageNumber(resolution.usage.totalTokens),
            cost: {
              total: nonNegativeUsageNumber(resolution.usage.cost?.total),
            },
          },
        }
      : {}),
    ...(resolution.fallbackReason ? { fallbackReason: resolution.fallbackReason } : {}),
  };
}

export function sameSessionMessages(left: unknown, right: unknown): boolean {
  if (!Array.isArray(left) || !Array.isArray(right)) {
    return false;
  }
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

export function compactionFallbackReason(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message.trim();
  }
  const text = String(error).trim();
  return text.length > 0 ? text : "llm_compaction_failed";
}

export class ManagedSessionCompactionFlowState {
  #pendingCompactionRequest: PendingCompactionRequestState | null = null;
  #isCompacting = false;
  #stopAfterCurrentToolResults = false;

  get isCompacting(): boolean {
    return this.#isCompacting;
  }

  requestCompaction(isStreaming: boolean, request?: BrewvaCompactionRequest): boolean {
    if (this.#isCompacting || this.#pendingCompactionRequest) {
      request?.onError?.(new Error("Hosted compaction is already in progress."));
      return false;
    }

    this.#pendingCompactionRequest = {
      customInstructions: request?.customInstructions,
      onComplete: request?.onComplete,
      onError: request?.onError,
    };

    if (isStreaming) {
      this.#stopAfterCurrentToolResults = true;
    }
    return !isStreaming;
  }

  consumeToolResultStop(): boolean {
    if (!this.#stopAfterCurrentToolResults) {
      return false;
    }
    this.#stopAfterCurrentToolResults = false;
    return true;
  }

  beginDeferredCompaction(): PendingCompactionRequestState | null {
    const request = this.#pendingCompactionRequest;
    if (!request || this.#isCompacting) {
      return null;
    }
    this.#pendingCompactionRequest = null;
    this.#isCompacting = true;
    return request;
  }

  clearStopAfterCurrentToolResults(): void {
    this.#stopAfterCurrentToolResults = false;
  }

  finishDeferredCompaction(): void {
    this.#isCompacting = false;
  }
}
