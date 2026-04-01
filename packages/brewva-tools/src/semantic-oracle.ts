import type {
  DeliberationMemoryArtifact,
  NarrativeMemoryRecordClass,
} from "@brewva/brewva-deliberation";

export interface SemanticOracleCandidate {
  id: string;
  title: string;
  summary: string;
  content: string;
  kind?: string;
  scope?: string;
}

export interface SemanticOracleRerankInput {
  sessionId: string;
  surface: "deliberation_memory" | "narrative_memory";
  query: string;
  targetRoots: readonly string[];
  candidates: readonly SemanticOracleCandidate[];
  stateRevision: string;
}

export interface SemanticOracleRerankResult {
  orderedIds: string[];
  cacheKey: string;
  modelRef?: string;
  cached: boolean;
}

export interface SemanticOracleNarrativeExtractionInput {
  sessionId: string;
  agentId: string;
  targetRoots: readonly string[];
  userText: string;
  toolEvidence: ReadonlyArray<{
    toolName: string;
    summary: string;
    isError: boolean;
  }>;
}

export interface SemanticOracleNarrativeExtractionResult {
  class: NarrativeMemoryRecordClass;
  title: string;
  summary: string;
  content: string;
  applicabilityScope: "operator" | "agent" | "repository";
  confidenceScore: number;
}

export interface BrewvaSemanticOracle {
  rerankDeliberationMemory?(
    input: SemanticOracleRerankInput & {
      candidates: readonly SemanticOracleCandidate[];
      artifacts: readonly DeliberationMemoryArtifact[];
    },
  ): Promise<SemanticOracleRerankResult | null>;
  rerankNarrativeMemory?(
    input: SemanticOracleRerankInput,
  ): Promise<SemanticOracleRerankResult | null>;
  extractNarrativeMemoryCandidate?(
    input: SemanticOracleNarrativeExtractionInput,
  ): Promise<SemanticOracleNarrativeExtractionResult | null>;
}

export function shouldInvokeSemanticRerank(
  scores: readonly number[],
  options: {
    minimumTopK?: number;
    marginThreshold?: number;
  } = {},
): boolean {
  const minimumTopK = Math.max(2, options.minimumTopK ?? 3);
  if (scores.length < minimumTopK) {
    return false;
  }
  const sorted = [...scores].toSorted((left, right) => right - left);
  const first = sorted[0] ?? 0;
  const second = sorted[1] ?? 0;
  return first - second <= Math.max(0, options.marginThreshold ?? 0.08);
}
