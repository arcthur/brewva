import {
  type ContentShape,
  type ContentShapeConfidence,
  detectContentShape,
} from "@brewva/brewva-std/content-shape";

/** Minimum reduction ratio for a span to be worth surfacing as a candidate. */
const REDUCTION_CANDIDATE_MIN_RATIO = 0.4;

export interface ReductionCandidate {
  readonly spanRef: string;
  readonly detectedShape: ContentShape;
  readonly suggestedReduction: string;
  readonly estimatedTokensSaved: number;
  readonly confidence: ContentShapeConfidence;
  /** Signal names that drove the classification, surfaced for inspectability. */
  readonly indicators: readonly string[];
}

const SUGGESTED_REDUCTION_BY_SHAPE: Partial<Record<ContentShape, string>> = {
  json_array: "deduplicate repeated fields and keep a representative sample of rows",
  build_log: "keep error and warning lines plus the tail; drop repeated info noise",
  unified_diff: "keep changed hunks; drop unchanged surrounding context",
  search_results: "keep the top relevant matches; drop the long tail",
};

export interface BuildReductionCandidateInput {
  readonly spanRef: string;
  readonly content: string;
}

/**
 * Describe (never apply) a shape-aware reduction for a span as an inspectable
 * advisory candidate. Returns null when the content has no high-signal reduction
 * shape, keeping the surfaced option set small. The model decides whether to act;
 * adopting a candidate means issuing the model's own workbench operation (which is
 * where RCR attaches a reversible reference — this builder never produces one).
 */
export function buildReductionCandidate(
  input: BuildReductionCandidateInput,
): ReductionCandidate | null {
  const detection = detectContentShape(input.content);
  const suggestedReduction = SUGGESTED_REDUCTION_BY_SHAPE[detection.shape];
  if (
    suggestedReduction === undefined ||
    detection.estimatedReductionRatio < REDUCTION_CANDIDATE_MIN_RATIO
  ) {
    return null;
  }
  const estimatedTokensSaved = Math.round(
    (input.content.length / 4) * detection.estimatedReductionRatio,
  );
  return {
    spanRef: input.spanRef,
    detectedShape: detection.shape,
    suggestedReduction,
    estimatedTokensSaved,
    confidence: detection.confidence,
    indicators: detection.indicators,
  };
}
