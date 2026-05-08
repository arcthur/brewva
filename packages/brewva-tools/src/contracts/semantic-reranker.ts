import type {
  DeliberationMemoryArtifact,
  NarrativeMemoryRecordClass,
} from "@brewva/brewva-deliberation";

export interface SemanticRerankerCandidate {
  id: string;
  title: string;
  summary: string;
  content: string;
  kind?: string;
  scope?: string;
}

export interface SemanticRerankerRerankInput {
  sessionId: string;
  surface: "deliberation_memory" | "narrative_memory";
  query: string;
  targetRoots: readonly string[];
  candidates: readonly SemanticRerankerCandidate[];
  stateRevision: string;
}

export interface SemanticRerankerRerankResult {
  orderedIds: string[];
  cacheKey: string;
  modelRef?: string;
  cached: boolean;
}

export interface SemanticRerankerNarrativeExtractionInput {
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

export interface SemanticRerankerNarrativeExtractionResult {
  class: NarrativeMemoryRecordClass;
  title: string;
  summary: string;
  content: string;
  applicabilityScope: "operator" | "agent" | "repository";
  confidenceScore: number;
}

export interface BrewvaSemanticReranker {
  rerankDeliberationMemory?(
    input: SemanticRerankerRerankInput & {
      candidates: readonly SemanticRerankerCandidate[];
      artifacts: readonly DeliberationMemoryArtifact[];
    },
  ): Promise<SemanticRerankerRerankResult | null>;
  rerankNarrativeMemory?(
    input: SemanticRerankerRerankInput,
  ): Promise<SemanticRerankerRerankResult | null>;
  extractNarrativeMemoryCandidate?(
    input: SemanticRerankerNarrativeExtractionInput,
  ): Promise<SemanticRerankerNarrativeExtractionResult | null>;
}
