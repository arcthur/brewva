import type { GrepCase, GrepRunResult } from "../types.js";

/**
 * Semantic content-search request handed to a {@link SearchEngine}.
 *
 * The fields mirror the inputs of {@link buildRipgrepArgs} rather than a
 * pre-built ripgrep argv, so a non-ripgrep engine (e.g. the fff in-process
 * index) can interpret the intent natively instead of parsing flags.
 */
export interface GrepEngineRequest {
  cwd: string;
  query: string;
  paths: string[];
  globs: string[];
  caseMode: GrepCase;
  fixed: boolean;
  forceIgnoreCase: boolean;
  maxLines: number;
  timeoutMs: number;
  signal?: AbortSignal | null;
}

/** Semantic file-discovery (glob) request handed to a {@link SearchEngine}. */
export interface GlobEngineRequest {
  cwd: string;
  pattern: string;
  paths: string[];
  maxResults: number;
  timeoutMs: number;
  signal?: AbortSignal | null;
}

/**
 * Pluggable search backend behind the `grep` and `glob` tools.
 *
 * Every implementation MUST return the exact {@link GrepRunResult} contract the
 * downstream advisor/anchoring pipeline already consumes: `lines` as
 * `path:line:content` strings (file paths for glob), `exitCode` following
 * ripgrep conventions (0 = matches, 1 = no matches, other = error), and the
 * truncation/timeout flags. This is what lets the engine be swapped without
 * touching `grep.ts`.
 */
export interface SearchEngine {
  grep(request: GrepEngineRequest): Promise<GrepRunResult>;
  glob(request: GlobEngineRequest): Promise<GrepRunResult>;
}
