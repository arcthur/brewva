import { resolve } from "node:path";

/**
 * Resolve the on-disk JSONL path for a session's tape. Single source of the
 * tape-path formula so the authoritative reader and the non-authoritative
 * forensic scanner address exactly the same file.
 */
export function resolveTapeFilePath(cwd: string, tapeDir: string, sessionId: string): string {
  return resolve(resolve(cwd, tapeDir), `${encodeURIComponent(sessionId)}.jsonl`);
}
