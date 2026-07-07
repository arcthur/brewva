import type { spawn } from "node:child_process";
import {
  buildRipgrepArgs,
  DEFAULT_RUNTIME_ARTIFACT_EXCLUDE_GLOBS,
  runRipgrep,
} from "../ripgrep.js";
import type { GrepRunResult } from "../types.js";
import type { GlobEngineRequest, GrepEngineRequest, SearchEngine } from "./port.js";

/**
 * The baseline engine: shells out to ripgrep, exactly as the tools did before
 * the engine seam was introduced. It is both the default backend and the
 * universal fallback for cases a faster engine cannot serve identically.
 */
export class RipgrepEngine implements SearchEngine {
  readonly #command: string | undefined;
  readonly #spawnImpl: typeof spawn | undefined;

  constructor(options: { command?: string; spawnImpl?: typeof spawn } = {}) {
    this.#command = options.command;
    this.#spawnImpl = options.spawnImpl;
  }

  grep(request: GrepEngineRequest): Promise<GrepRunResult> {
    return runRipgrep(
      {
        cwd: request.cwd,
        args: buildRipgrepArgs({
          query: request.query,
          paths: request.paths,
          globs: request.globs,
          caseMode: request.caseMode,
          fixed: request.fixed,
          forceIgnoreCase: request.forceIgnoreCase,
        }),
        maxLines: request.maxLines,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      },
      { command: this.#command, spawnImpl: this.#spawnImpl },
    );
  }

  glob(request: GlobEngineRequest): Promise<GrepRunResult> {
    return runRipgrep(
      {
        cwd: request.cwd,
        args: [
          "--files",
          "--hidden",
          "--glob",
          request.pattern,
          ...DEFAULT_RUNTIME_ARTIFACT_EXCLUDE_GLOBS.flatMap((glob) => ["--glob", glob]),
          ...request.paths,
        ],
        maxLines: request.maxResults,
        timeoutMs: request.timeoutMs,
        signal: request.signal,
      },
      { command: this.#command, spawnImpl: this.#spawnImpl },
    );
  }
}
