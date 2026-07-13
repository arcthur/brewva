import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { scanAppendOnly } from "@brewva/brewva-std/node/fs";
import { isRecord } from "@brewva/brewva-std/unknown";
import {
  HARNESS_CANDIDATE_LIFECYCLE_SCHEMA,
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
 * Writer discipline: every append happens inside an exclusive on-disk lock
 * (`candidates.jsonl.lock`, O_EXCL create) that first repairs a crash-torn
 * tail by truncating to the last newline boundary — the same boundary
 * `scanAppendOnly` classifies — so a new receipt is never glued onto a torn
 * fragment where readers would skip both lines forever. Appends are
 * fsync-durable: an accept/reject receipt is a low-frequency accountable
 * decision whose loss would leave a promoted learning citing a candidateId
 * with no receipt behind it.
 *
 * Containment: the ledger path is opened O_NOFOLLOW after verifying no path
 * component under the workspace root is a symlink and the realpath'd parent
 * stays inside the realpath'd workspace root — a hostile checkout cannot
 * point `.brewva/harness` (or the file itself) outside the workspace and
 * turn a routine compare into an operator-privileged write elsewhere.
 */

const HARNESS_CANDIDATE_LEDGER_RELATIVE_PATH = join(".brewva", "harness", "candidates.jsonl");
const LEDGER_LOCK_SUFFIX = ".lock";
const LEDGER_LOCK_STALE_MS = 10_000;
const LEDGER_LOCK_ATTEMPTS = 50;
const LEDGER_LOCK_RETRY_MS = 20;

export function resolveHarnessCandidateLedgerPath(workspaceRoot: string): string {
  return resolve(workspaceRoot, HARNESS_CANDIDATE_LEDGER_RELATIVE_PATH);
}

function assertNoSymlinkComponents(workspaceRoot: string, path: string): void {
  const root = resolve(workspaceRoot);
  let current = resolve(path);
  const components: string[] = [];
  while (current.startsWith(`${root}${sep}`)) {
    components.push(current);
    current = dirname(current);
  }
  for (const component of components) {
    let stats;
    try {
      stats = lstatSync(component);
    } catch {
      continue; // not created yet — mkdir below creates real directories
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`harness_candidate_ledger_symlink_rejected:${component}`);
    }
  }
}

function assertParentContainment(workspaceRoot: string, ledgerPath: string): void {
  const realRoot = realpathSync(resolve(workspaceRoot));
  const realParent = realpathSync(dirname(ledgerPath));
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) {
    throw new Error(`harness_candidate_ledger_escapes_workspace:${realParent}`);
  }
}

function acquireLedgerLock(ledgerPath: string): () => void {
  const lockPath = `${ledgerPath}${LEDGER_LOCK_SUFFIX}`;
  for (let attempt = 0; attempt < LEDGER_LOCK_ATTEMPTS; attempt += 1) {
    try {
      const fd = openSync(
        lockPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      try {
        writeFileSync(fd, `${process.pid}\n`, "utf8");
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          unlinkSync(lockPath);
        } catch {
          // Already gone (stale-broken by a peer): the append completed, and
          // releasing an absent lock is not a failure.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      // Appends are millisecond-scale; a lock older than the stale window is
      // a crashed writer, not a slow one. Breaking it must elect ONE winner:
      // a bare stat→rm would let two breakers race, with the loser's rm
      // deleting the winner's FRESH lock (both then "hold" the mutex and the
      // repair truncate can destroy the other's fsync'd receipt). rename() of
      // the stale lock to a unique name succeeds for exactly one process —
      // the loser's rename ENOENTs and it goes back to waiting.
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > LEDGER_LOCK_STALE_MS) {
          const claimed = `${lockPath}.stale.${process.pid}.${attempt}`;
          renameSync(lockPath, claimed);
          rmSync(claimed, { force: true });
          continue;
        }
      } catch {
        continue; // lock vanished or another breaker won the rename — retry
      }
      // Synchronous sleep: the CLI append path is sync end-to-end and the
      // peer's hold time is a single small write + fsync.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, LEDGER_LOCK_RETRY_MS);
    }
  }
  throw new Error("harness_candidate_ledger_lock_unavailable");
}

/**
 * Truncate a crash-torn final line (no terminating newline) back to the last
 * newline boundary — the SAME boundary `scanAppendOnly` classifies, so writer
 * repair and reader classification cannot drift. Runs only inside the ledger
 * lock: outside a lock this would race a concurrent in-flight append and
 * destroy it. An all-torn file (no newline at all) truncates to zero.
 */
function repairTornTail(ledgerPath: string): void {
  const scan = scanAppendOnly(ledgerPath, () => undefined);
  if (!scan.exists || !scan.tornTail) {
    return;
  }
  truncateSync(ledgerPath, findLastNewlineBoundary(ledgerPath));
}

function findLastNewlineBoundary(path: string): number {
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const chunkSize = 64 * 1024;
    const buffer = Buffer.allocUnsafe(chunkSize);
    let end = size;
    while (end > 0) {
      const start = Math.max(0, end - chunkSize);
      const length = end - start;
      readIntoBuffer(fd, buffer, start, length);
      for (let index = length - 1; index >= 0; index -= 1) {
        if (buffer[index] === 0x0a) {
          return start + index + 1;
        }
      }
      end = start;
    }
    return 0;
  } finally {
    closeSync(fd);
  }
}

function readIntoBuffer(fd: number, buffer: Buffer, position: number, length: number): void {
  let read = 0;
  while (read < length) {
    const got = readSync(fd, buffer, read, length - read, position + read);
    if (got <= 0) {
      return;
    }
    read += got;
  }
}

function appendDurableNoFollow(path: string, contents: string): void {
  const createdFile = !existsSync(path);
  const fd = openSync(
    path,
    fsConstants.O_CREAT | fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, contents, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  if (createdFile) {
    // First append also created the directory entry: fsync the parent so the
    // file itself survives power loss, matching `appendFileDurable`.
    const dirFd = openSync(dirname(path), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  }
}

export function appendHarnessCandidateLifecycleRecord(
  workspaceRoot: string,
  record: HarnessCandidateLifecycleRecord,
): void {
  const path = resolveHarnessCandidateLedgerPath(workspaceRoot);
  assertNoSymlinkComponents(workspaceRoot, path);
  mkdirSync(dirname(path), { recursive: true });
  assertParentContainment(workspaceRoot, path);
  const release = acquireLedgerLock(path);
  try {
    repairTornTail(path);
    appendDurableNoFollow(path, `${JSON.stringify(record)}\n`);
  } finally {
    release();
  }
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

export interface HarnessCandidateLedgerIntegrity {
  /** True when the ledger holds no genuinely-corrupt (unparseable) interior line. */
  readonly ok: boolean;
  /** `path:line:invalid_json` for each corrupt interior line; empty when clean. */
  readonly issues: readonly string[];
}

/**
 * Read-only durability check of the candidate ledger, the ledger dimension of
 * the unified session integrity aggregation (RFC WS1). It never repairs —
 * torn-tail repair belongs to the owning writer's lock, not to a read. It
 * classifies through the SAME `scanAppendOnly` grammar the reader uses, so the
 * two cannot drift, and it degrades only on genuine byte-level corruption:
 *
 * - A crash-torn final line is tolerated: `scanAppendOnly` never delivers it,
 *   and the owner's next append self-heals it (matching the WAL and tape scans,
 *   which also treat a torn tail as recoverable rather than damage).
 * - A well-formed-but-unknown-schema interior line is tolerated: the on-disk
 *   reader already skips foreign/newer-writer rows rather than treating them as
 *   damage, so degrading on one would be a false positive against forward-compat.
 *   A row claiming the current schema must nevertheless pass the current record
 *   validator; otherwise the durable audit chain has dropped a malformed receipt.
 * - An interior line that does not parse as JSON is real corruption — a broken
 *   chain — and is reported.
 */
export function verifyHarnessCandidateLedgerIntegrity(
  workspaceRoot: string,
): HarnessCandidateLedgerIntegrity {
  const path = resolveHarnessCandidateLedgerPath(workspaceRoot);
  const issues: string[] = [];
  scanAppendOnly(path, (line) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.text);
    } catch {
      issues.push(`${path}:${line.lineNumber}:invalid_json`);
      return;
    }
    if (
      isRecord(parsed) &&
      parsed.schema === HARNESS_CANDIDATE_LIFECYCLE_SCHEMA &&
      !isHarnessCandidateLifecycleRecord(parsed)
    ) {
      issues.push(`${path}:${line.lineNumber}:invalid_schema`);
    }
  });
  return { ok: issues.length === 0, issues };
}
