export type ContentShape =
  | "json_array"
  | "build_log"
  | "unified_diff"
  | "search_results"
  | "prose"
  | "unknown";

export type ContentShapeConfidence = "low" | "medium" | "high";

export interface ContentShapeDetection {
  readonly shape: ContentShape;
  readonly confidence: ContentShapeConfidence;
  /** Signal names that drove the classification, for inspectable advisories. */
  readonly indicators: readonly string[];
  /** Fraction of the content a shape-aware reduction could safely drop (0..1). */
  readonly estimatedReductionRatio: number;
}

const REDUCTION_RATIO_BY_SHAPE: Record<ContentShape, number> = {
  json_array: 0.7,
  build_log: 0.8,
  unified_diff: 0.4,
  search_results: 0.6,
  prose: 0.2,
  unknown: 0,
};

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
const DIFF_GIT = /^diff --git /;
const LOG_LEVEL = /\b(?:FATAL|ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/;
const STACK_FRAME = /^\s+at\s+\S/;
const BUILD_MARKER = /(?:npm ERR!|error\[[A-Z]?\d|warning:|BUILD (?:FAILED|SUCCESS)|panicked at)/;
const SEARCH_LINE = /^[\w./-]+:\d+:/;

function detection(
  shape: ContentShape,
  confidence: ContentShapeConfidence,
  indicators: readonly string[],
): ContentShapeDetection {
  return {
    shape,
    confidence,
    indicators,
    estimatedReductionRatio: REDUCTION_RATIO_BY_SHAPE[shape],
  };
}

function isSearchResultLine(line: string): boolean {
  if (!SEARCH_LINE.test(line)) return false;
  const prefix = line.slice(0, line.indexOf(":"));
  // A real "path:line:" result carries a file path, not a clock or version. The
  // extension must start with a letter so version numbers like "v1.2.3" do not
  // masquerade as filenames.
  return prefix.includes("/") || /\.[A-Za-z][A-Za-z0-9]*$/.test(prefix);
}

function looksLikeProse(text: string): boolean {
  const words = text.split(/\s+/u).filter(Boolean);
  if (words.length < 5) return false;
  const letters = (text.match(/[A-Za-z]/gu) ?? []).length;
  return letters / text.length > 0.6 && /[.!?]/u.test(text);
}

/**
 * Classify a span of tool/conversation content by shape so callers can describe
 * (never apply) a shape-aware reduction. Pure and deterministic: the same input
 * always yields the same classification, indicators, and reduction ratio.
 *
 * This is the brewva-native counterpart of an external content router's strategy
 * table — it only describes what a reduction could look like; it never mutates
 * attention or applies the reduction.
 */
export function detectContentShape(content: string): ContentShapeDetection {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return detection("unknown", "low", []);
  }
  const lines = trimmed.split(/\r?\n/u);
  const nonEmpty = lines.filter((line) => line.trim().length > 0);

  const hasHunkHeader = lines.some((line) => HUNK_HEADER.test(line));
  const hasDiffGit = lines.some((line) => DIFF_GIT.test(line));
  if (hasHunkHeader) {
    const indicators = ["hunk_header"];
    if (hasDiffGit) indicators.push("diff_git_header");
    return detection("unified_diff", "high", indicators);
  }
  if (
    hasDiffGit &&
    lines.some((line) => line.startsWith("--- ")) &&
    lines.some((line) => line.startsWith("+++ "))
  ) {
    return detection("unified_diff", "medium", ["diff_git_header"]);
  }

  if (trimmed.startsWith("[")) {
    try {
      if (Array.isArray(JSON.parse(trimmed))) {
        return detection("json_array", "high", ["json_array_parse"]);
      }
    } catch {
      // Not JSON; fall through to other shapes.
    }
  }

  const searchLines = nonEmpty.filter(isSearchResultLine).length;
  if (nonEmpty.length >= 2 && searchLines / nonEmpty.length >= 0.6) {
    const confidence = searchLines / nonEmpty.length >= 0.85 ? "high" : "medium";
    return detection("search_results", confidence, ["path_line_prefix"]);
  }

  if (nonEmpty.length >= 3) {
    const levelLines = nonEmpty.filter((line) => LOG_LEVEL.test(line)).length;
    const stackLines = nonEmpty.filter((line) => STACK_FRAME.test(line)).length;
    const markerLines = nonEmpty.filter((line) => BUILD_MARKER.test(line)).length;
    const signal = levelLines + stackLines + markerLines;
    const indicators: string[] = [];
    if (levelLines > 0) indicators.push("log_levels");
    if (stackLines > 0) indicators.push("stack_frames");
    if (markerLines > 0) indicators.push("build_markers");
    if (signal >= 2 && signal / nonEmpty.length >= 0.3) {
      const confidence = signal / nonEmpty.length >= 0.6 ? "high" : "medium";
      return detection("build_log", confidence, indicators);
    }
  }

  if (looksLikeProse(trimmed)) {
    return detection("prose", "medium", ["natural_language"]);
  }
  return detection("unknown", "low", []);
}
