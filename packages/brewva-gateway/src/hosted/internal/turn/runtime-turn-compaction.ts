/**
 * Session capability that lets the canonical hosted turn envelope own the
 * mid-turn soft cut and compaction resume loop. Any session that exposes this
 * boundary gets the full suspend -> flush -> resume closure regardless of the
 * caller (interactive dispatch, channel, subagent, worker).
 */
export const HOSTED_COMPACTION_BOUNDARY = Symbol.for("brewva.hosted.compactionBoundary");

export interface HostedCompactionBoundary {
  /**
   * Polled by the runtime after each complete tool-result boundary. Returns
   * true exactly once per armed mid-turn compaction request.
   */
  consumeToolResultStop(): boolean;
  /**
   * Flushes the pending deferred compaction. Returns false when there was no
   * pending request or the compaction failed; the envelope must not resume a
   * soft-cut turn in that case.
   */
  flushPendingCompaction(): Promise<boolean>;
  /**
   * Turn-end settlement: clears a stop flag that never reached a tool-result
   * boundary (text-only turns) and flushes any still-pending compaction so
   * pressure does not leak into future turns.
   */
  settleTurnEndCompaction(): Promise<void>;
}

interface HostedCompactionBoundarySession {
  [HOSTED_COMPACTION_BOUNDARY](): HostedCompactionBoundary;
}

export function hasHostedCompactionBoundary(
  session: unknown,
): session is HostedCompactionBoundarySession {
  return (
    typeof session === "object" &&
    session !== null &&
    typeof (session as Partial<HostedCompactionBoundarySession>)[HOSTED_COMPACTION_BOUNDARY] ===
      "function"
  );
}

export function resolveHostedCompactionBoundary(session: unknown): HostedCompactionBoundary | null {
  return hasHostedCompactionBoundary(session) ? session[HOSTED_COMPACTION_BOUNDARY]() : null;
}
