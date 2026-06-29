import type { BrewvaToolOptions } from "../../../contracts/index.js";

export interface GrepToolOptions extends BrewvaToolOptions {
  ripgrepCommand?: string;
}

export type GrepCase = "smart" | "ignore" | "sensitive";
export type GrepSuggestionMode = "combo" | "source" | "path" | "hybrid";

export type GrepRunResult = {
  exitCode: number;
  lines: string[];
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  terminationReason: "process_exit" | "truncate" | "timeout" | "abort";
};

export type GrepAdvisorStatus =
  | "applied"
  | "skipped"
  | "auto_broadened"
  | "fuzzy_retry"
  | "suggestion_only";

export interface GrepAdvisorDetails {
  status: GrepAdvisorStatus;
  signalFiles: number;
  reorderedFiles: number;
  comboMatches: number;
  autoBroaden?: {
    from: string[];
    to: string[];
  };
  fuzzyRetry?: {
    from: string;
    to: string;
  };
  suggestionMode?: GrepSuggestionMode;
}

export interface GrepGroupedLines {
  path?: string;
  /** Un-normalized path exactly as it appears in the match line, used to look up
   * engine-provided frecency scores (which are keyed by that same raw path). */
  rawPath?: string;
  lines: string[];
  originalOrder: number;
}

export interface GrepSuggestionItem {
  path: string;
  text: string;
  source: Exclude<GrepSuggestionMode, "hybrid">;
}
