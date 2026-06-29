import type { GrepRunResult } from "../types.js";
import { acquireFinder } from "./fff-finder-cache.js";
import type { FffGrepMode, FffGrepResult } from "./fff-types.js";
import type { GlobEngineRequest, GrepEngineRequest, SearchEngine } from "./port.js";
import type { RipgrepEngine } from "./ripgrep-engine.js";

/**
 * Conservative predicate: only the cases fff can serve byte-for-identically to
 * ripgrep return `true`. Everything else delegates to ripgrep, which is the
 * authoritative reference. Kept deliberately narrow for v1 (the dominant
 * whole-tree identifier search); scoped/globbed search can graduate later, each
 * gated by parity tests.
 */
function canFffHandleGrep(request: GrepEngineRequest): boolean {
  // Whole-tree only. Scoped subpaths and sibling/absolute roots may point
  // outside the finder's indexed basePath, which fff cannot search.
  if (request.paths.length !== 1 || request.paths[0] !== ".") {
    return false;
  }
  // Glob-constrained content search relies on ripgrep's --glob semantics.
  if (request.globs.length > 0) {
    return false;
  }
  // fff grep cannot force case-insensitivity for a literal query; ripgrep can.
  if (request.forceIgnoreCase || request.caseMode === "ignore") {
    return false;
  }
  return true;
}

/**
 * Per-result frecency side-table. fff returns a cross-session frecency score per
 * matched file; the engine seam contract is plain `path:line:content` strings,
 * so the scores ride alongside the specific result object in a WeakMap instead
 * of widening {@link GrepRunResult} or leaking into the tool payload. ripgrep
 * results are never registered, so {@link frecencyForGrepResult} returns
 * `undefined` for them and the advisor reranks exactly as before.
 */
const frecencyByResult = new WeakMap<GrepRunResult, ReadonlyMap<string, number>>();

/** Frecency-by-(raw relative path) for an fff-produced result, if any. */
export function frecencyForGrepResult(
  result: GrepRunResult,
): ReadonlyMap<string, number> | undefined {
  return frecencyByResult.get(result);
}

function toGrepRunResult(result: FffGrepResult, maxLines: number): GrepRunResult {
  const lines: string[] = [];
  const frecency = new Map<string, number>();
  for (const match of result.items) {
    if (lines.length >= maxLines) {
      break;
    }
    lines.push(`${match.relativePath}:${match.lineNumber}:${match.lineContent}`);
    if (!frecency.has(match.relativePath)) {
      frecency.set(match.relativePath, match.totalFrecencyScore);
    }
  }
  const truncated = result.nextCursor !== null || result.items.length > lines.length;
  const runResult: GrepRunResult = {
    exitCode: lines.length > 0 ? 0 : 1,
    lines,
    stderr: "",
    truncated,
    timedOut: false,
    terminationReason: truncated ? "truncate" : "process_exit",
  };
  if (frecency.size > 0) {
    frecencyByResult.set(runResult, frecency);
  }
  return runResult;
}

/**
 * fff-backed search engine. Holds a long-lived in-memory index per workspace
 * (scan once, search many) and reconstructs the exact `path:line:content`
 * line contract ripgrep produces, so the downstream advisor/anchoring pipeline
 * is unaffected. Any request it cannot serve identically — or any fff/native
 * error — transparently falls back to the wrapped {@link RipgrepEngine}.
 */
export class FffEngine implements SearchEngine {
  readonly #fallback: RipgrepEngine;

  constructor(fallback: RipgrepEngine) {
    this.#fallback = fallback;
  }

  async grep(request: GrepEngineRequest): Promise<GrepRunResult> {
    if (!canFffHandleGrep(request)) {
      return this.#fallback.grep(request);
    }
    try {
      const acquired = await acquireFinder(request.cwd);
      if (!acquired) {
        return this.#fallback.grep(request);
      }
      const scanned = await acquired.scanReady;
      if (!scanned) {
        return this.#fallback.grep(request);
      }

      const mode: FffGrepMode = request.fixed ? "plain" : "regex";
      const result = acquired.finder.grep(request.query, {
        mode,
        smartCase: request.caseMode === "smart",
        pageSize: request.maxLines,
      });
      if (!result.ok) {
        return this.#fallback.grep(request);
      }
      // fff silently degrades an uncompilable regex to literal matching; defer
      // to ripgrep as the authoritative regex engine in that case.
      if (result.value.regexFallbackError) {
        return this.#fallback.grep(request);
      }
      return toGrepRunResult(result.value, request.maxLines);
    } catch {
      return this.#fallback.grep(request);
    }
  }

  glob(request: GlobEngineRequest): Promise<GrepRunResult> {
    // v1: file discovery stays on ripgrep until glob-syntax parity (npm-glob vs
    // ripgrep --glob) is proven. The seam is in place to graduate it later.
    return this.#fallback.glob(request);
  }
}
