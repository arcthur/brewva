import type { GrepToolOptions } from "../types.js";
import { FffEngine } from "./fff-engine.js";
import type { SearchEngine } from "./port.js";
import { RipgrepEngine } from "./ripgrep-engine.js";

export type { GlobEngineRequest, GrepEngineRequest, SearchEngine } from "./port.js";
export { RipgrepEngine } from "./ripgrep-engine.js";
export { FffEngine, frecencyForGrepResult } from "./fff-engine.js";
export {
  acquireFinder,
  disposeFinders,
  isFffAvailable,
  noteFileAccess,
  warmFinder,
  type AcquiredFinder,
} from "./fff-finder-cache.js";

/**
 * Resolve the search engine for the `grep`/`glob` tools.
 *
 * Returns the fff-backed engine, which self-checks native availability per call
 * and transparently falls back to ripgrep when it cannot serve a request
 * identically (or when fff isn't loadable, e.g. under Node).
 */
export function getSearchEngine(options: GrepToolOptions): SearchEngine {
  return new FffEngine(new RipgrepEngine({ command: options.ripgrepCommand }));
}
