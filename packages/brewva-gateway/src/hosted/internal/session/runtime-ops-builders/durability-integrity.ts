import { resolve } from "node:path";
import { isRecord } from "@brewva/brewva-std/unknown";
import type { RuntimeSessionIssue } from "@brewva/brewva-tools/contracts";
import {
  createWorkspaceWorldStore,
  type WorkspaceWorldStore,
} from "@brewva/brewva-tools/world-store";
import {
  parseWorldCheckpointBlock,
  SESSION_REWIND_CHECKPOINT_EVENT_TYPE,
} from "@brewva/brewva-vocabulary/session";
import {
  resolveRecoveryWalConfigForSessionBootstrap,
  scanRecoveryWalForensics,
  type RecoveryWalConfig,
  type RecoveryWalForensicScan,
} from "../../../../daemon/api.js";
import {
  verifyHarnessCandidateLedgerIntegrity,
  type HarnessCandidateLedgerIntegrity,
} from "../../../../harness/api.js";

/**
 * Durability-integrity probes for the WAL, ledger, and artifact dimensions the
 * unified session integrity aggregation folds alongside the event tape (RFC
 * WS1). Each probe reports domain-tagged issues; an empty result is a positive
 * "verified clean", not "unknown". The pure aggregation (`projectIntegrity`)
 * concatenates these with the tape's own forensic issues and decides the status.
 */

// The hosted runtime's recovery WAL is a single workspace-level file under the
// configured WAL dir, written by the "runtime"-scoped store (see
// `createRecoveryWalStore` in runtime-ports.ts) and read read-only by
// `brewva inspect`. The integrity probe reads the same file the same way.
const RUNTIME_WAL_SCOPE = "runtime";
const RUNTIME_WAL_FILENAME = "runtime.jsonl";

/** The world-store surface the artifact dimension reads: batch-verify tape-referenced worlds. */
export type ArtifactWorldStore = Pick<WorkspaceWorldStore, "verifyWorlds">;

type WorldReferenceEvent = {
  readonly type: string;
  readonly payload?: unknown;
};

/**
 * Rewind checkpoint payloads on the event tape are the authoritative world
 * references. The world-store refs sidecar is a retention index only: it is
 * intentionally rebuildable and may be missing or corrupted, so it must never
 * decide whether an artifact has to be verified for session durability.
 */
export function tapeReferencedWorldIds(events: readonly WorldReferenceEvent[]): readonly string[] {
  const worldIds = new Set<string>();
  for (const event of events) {
    if (event.type !== SESSION_REWIND_CHECKPOINT_EVENT_TYPE) {
      continue;
    }
    const block = parseWorldCheckpointBlock(
      isRecord(event.payload) ? event.payload.world : undefined,
    );
    if (block?.ok) {
      worldIds.add(block.worldId);
    }
  }
  return [...worldIds];
}

/**
 * The recovery-WAL dimension: a quarantined (malformed / invalid-schema) WAL row
 * is a fail-closed durability failure — the loader refuses it, so a turn it
 * recorded cannot be recovered. A crash-torn tail is reported separately by the
 * scan and is recoverable (the owning store repairs it on load), so it is NOT
 * folded here — only quarantined rows degrade integrity.
 */
export function walIntegrityIssues(scan: RecoveryWalForensicScan): RuntimeSessionIssue[] {
  return scan.issues.map(
    (issue): RuntimeSessionIssue => ({ domain: "wal", severity: "error", reason: issue }),
  );
}

/**
 * The ledger dimension: a corrupt (unparseable) interior line in the candidate
 * ledger is a broken chain. Torn tails and forward-compat rows are tolerated by
 * the verifier itself; this mapper only tags what it reports.
 */
export function ledgerIntegrityIssues(
  integrity: HarnessCandidateLedgerIntegrity,
): RuntimeSessionIssue[] {
  return integrity.issues.map(
    (issue): RuntimeSessionIssue => ({ domain: "ledger", severity: "error", reason: issue }),
  );
}

/**
 * The artifact dimension: every world a session referenced (one ref per rewind
 * checkpoint) must still be materializable — its manifest and every
 * content-addressed blob must hash to their durable references. A referenced
 * world that retention or damage made unavailable is a durability failure the
 * session's workspace-rewind recoverability silently depends on, so it degrades
 * integrity. Each distinct world is reported once even when referenced across
 * many turns.
 */
export function artifactIntegrityIssues(
  store: ArtifactWorldStore,
  sessionId: string,
  worldIds: readonly string[],
): RuntimeSessionIssue[] {
  const issues: RuntimeSessionIssue[] = [];
  for (const verification of store.verifyWorlds(worldIds)) {
    const { worldId } = verification;
    if (verification.present) {
      continue;
    }
    const details: string[] = [];
    if (verification.manifestHashMismatch) {
      details.push("manifest digest mismatch");
    }
    if (verification.missingBlobCount > 0) {
      details.push(`${verification.missingBlobCount} of ${verification.fileCount} blob(s) missing`);
    }
    if ((verification.corruptBlobCount ?? 0) > 0) {
      details.push(`${verification.corruptBlobCount} blob(s) corrupt`);
    }
    issues.push({
      domain: "artifact",
      severity: "error",
      sessionId,
      reason: `world ${worldId}: ${details.join("; ") || "manifest missing"}`,
    });
  }
  return issues;
}

/** The per-dimension probes `projectIntegrity` folds, minus the tape scan it owns. */
export interface DurabilityProbeSet {
  readonly tapeEnabled: boolean;
  readonly walIssues: (sessionId: string) => readonly RuntimeSessionIssue[];
  readonly ledgerIssues: () => readonly RuntimeSessionIssue[];
  readonly artifactIssues: (sessionId: string) => readonly RuntimeSessionIssue[];
}

/**
 * Build the WAL, ledger, and artifact durability probes from a hosted session's
 * workspace layout and config — the seam that wires `projectIntegrity` to the
 * real subsystems (the recovery WAL file, the candidate ledger, and the world
 * store). The world store is built read-only even after worlds are disabled so
 * historical tape checkpoints remain verifiable. Every probe reads read-only
 * and never repairs.
 */
export function buildDurabilityProbes(deps: {
  readonly workspaceRoot: string;
  readonly tapeEnabled: boolean;
  readonly listEvents: (sessionId: string) => readonly WorldReferenceEvent[];
  readonly recoveryWal: RecoveryWalConfig & { readonly dir: string };
  readonly worlds: {
    readonly dir: string;
    readonly retainPerSession: number;
  };
}): DurabilityProbeSet {
  const { workspaceRoot, tapeEnabled, listEvents, recoveryWal, worlds } = deps;

  const walIssues = (sessionId: string): readonly RuntimeSessionIssue[] => {
    // The WAL dimension must stay independent of the tape: reading the bootstrap
    // event only refines the WAL dir for a per-session override. A strict-reader
    // throw (an I/O-unreadable or schema-broken tape) must NOT blind the WAL
    // check — else real WAL damage is swallowed as `inconclusive`, defeating the
    // `RuntimeSessionIntegrityDegradedWithoutTapeEvidence` guarantee. Fall back to
    // the base config (which already handles an absent bootstrap) and still scan.
    let bootstrap: unknown;
    try {
      bootstrap = listEvents(sessionId)
        .toReversed()
        .find((event) => event.type === "session_bootstrap")?.payload;
    } catch {
      bootstrap = undefined;
    }
    const config = resolveRecoveryWalConfigForSessionBootstrap(recoveryWal, bootstrap);
    const walFilePath = resolve(workspaceRoot, config.dir, RUNTIME_WAL_FILENAME);
    return walIntegrityIssues(
      scanRecoveryWalForensics(walFilePath, { scope: RUNTIME_WAL_SCOPE, config }),
    );
  };

  const ledgerIssues = (): readonly RuntimeSessionIssue[] =>
    ledgerIntegrityIssues(verifyHarnessCandidateLedgerIntegrity(workspaceRoot));

  const store = createWorkspaceWorldStore({
    workspaceRoot,
    dir: worlds.dir,
    retainPerSession: worlds.retainPerSession,
  });
  const artifactIssues = (sessionId: string): readonly RuntimeSessionIssue[] =>
    artifactIntegrityIssues(store, sessionId, tapeReferencedWorldIds(listEvents(sessionId)));

  return { tapeEnabled, walIssues, ledgerIssues, artifactIssues };
}
