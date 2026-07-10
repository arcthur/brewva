import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { appendFileDurable, scanAppendOnly } from "@brewva/brewva-std/node/fs";
import {
  isHarnessCandidateLifecycleRecord,
  type HarnessCandidateLifecycleRecord,
} from "@brewva/brewva-vocabulary/harness";

/**
 * The candidate lifecycle ledger: one append-only JSONL sidecar per operator
 * workspace (`.brewva/harness/candidates.jsonl`). Candidates are
 * cross-session artifacts — created against one session's base snapshot,
 * evaluated in another, decided later with no session at all — so their
 * receipts live beside the session stores, never inside a session tape
 * (tapes stay single-writer session truth).
 *
 * Durability: every append is fsync-durable (`appendFileDurable`) — an
 * accept/reject receipt is a low-frequency accountable decision whose loss
 * would leave a promoted learning citing a candidateId with no receipt
 * behind it. Reads go through `scanAppendOnly`, the substrate's single
 * torn-tail boundary, so a crashed append is classified exactly as every
 * other append-only reader classifies it; unknown records from newer
 * writers are skipped, never fatal.
 */

const HARNESS_CANDIDATE_LEDGER_RELATIVE_PATH = join(".brewva", "harness", "candidates.jsonl");

export function resolveHarnessCandidateLedgerPath(workspaceRoot: string): string {
  return resolve(workspaceRoot, HARNESS_CANDIDATE_LEDGER_RELATIVE_PATH);
}

export function appendHarnessCandidateLifecycleRecord(
  workspaceRoot: string,
  record: HarnessCandidateLifecycleRecord,
): void {
  const path = resolveHarnessCandidateLedgerPath(workspaceRoot);
  mkdirSync(dirname(path), { recursive: true });
  appendFileDurable(path, `${JSON.stringify(record)}\n`);
}

export function readHarnessCandidateLifecycleRecords(
  workspaceRoot: string,
): HarnessCandidateLifecycleRecord[] {
  const records: HarnessCandidateLifecycleRecord[] = [];
  scanAppendOnly(resolveHarnessCandidateLedgerPath(workspaceRoot), (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.text);
    } catch {
      // Interior malformed line (foreign writer, hand edit): skip it; the
      // torn tail never reaches this callback.
      return;
    }
    if (isHarnessCandidateLifecycleRecord(parsed)) {
      records.push(parsed);
    }
  });
  return records;
}
