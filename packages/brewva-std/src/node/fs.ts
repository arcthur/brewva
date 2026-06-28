import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

export interface ForEachUtf8LineSyncOptions {
  readonly chunkSize?: number;
}

function normalizeChunkSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 1024 * 1024;
  }
  return Math.max(1, Math.trunc(value));
}

export function forEachUtf8LineSync(
  filePath: string,
  visit: (line: string, lineNumber: number) => void,
  options: ForEachUtf8LineSyncOptions = {},
): void {
  const fd = openSync(resolve(filePath), "r");
  const chunk = Buffer.allocUnsafe(normalizeChunkSize(options.chunkSize));
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let lineNumber = 1;

  const visitLine = (line: string) => {
    visit(line.endsWith("\r") ? line.slice(0, -1) : line, lineNumber);
    lineNumber += 1;
  };

  try {
    while (true) {
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) {
        break;
      }
      pending += decoder.write(chunk.subarray(0, bytesRead));
      let lineStart = 0;
      while (true) {
        const newlineIndex = pending.indexOf("\n", lineStart);
        if (newlineIndex === -1) {
          pending = pending.slice(lineStart);
          break;
        }
        visitLine(pending.slice(lineStart, newlineIndex));
        lineStart = newlineIndex + 1;
      }
    }

    pending += decoder.end();
    if (pending.length > 0) {
      visitLine(pending);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Atomically replace a file's contents. Writes a sibling `.tmp`, fsyncs it,
 * renames it over the target, then fsyncs the containing directory so the
 * rename entry is itself durable. A crash before the rename leaves the prior
 * file intact and an inert orphan `.tmp`; a crash after it leaves the new file
 * fully present. The `.tmp` is derived from the target path, so it always shares
 * the target's directory and filesystem and the rename stays atomic.
 *
 * The `.tmp` suffix is fixed (not pid/random-suffixed), so this assumes a single
 * writer per path: two concurrent writers to the same target would clobber each
 * other's `.tmp`. The Recovery WAL and event tape both hold that
 * single-writer-per-scope invariant. A fixed name is also self-healing — a crash
 * leaves at most one orphan `.tmp`, overwritten by the next rewrite — where a
 * unique name would instead accumulate orphans.
 */
export function rewriteFileAtomic(
  filePath: string,
  contents: string,
  options?: { readonly mode?: number },
): void {
  const resolved = resolve(filePath);
  const tmpPath = `${resolved}.tmp`;
  if (options?.mode !== undefined) {
    // Sensitive targets must not inherit a wider stale tmp mode from a previous crash.
    rmSync(tmpPath, { force: true });
  }
  // A sensitive target (e.g. a credential/token file) passes mode 0o600 so the tmp file,
  // and therefore the renamed target, is created owner-only.
  const fileDescriptor =
    options?.mode === undefined ? openSync(tmpPath, "w") : openSync(tmpPath, "wx", options.mode);
  try {
    writeFileSync(fileDescriptor, contents, "utf8");
    fsyncSync(fileDescriptor);
  } finally {
    closeSync(fileDescriptor);
  }
  renameSync(tmpPath, resolved);
  flushDirectoryDurable(dirname(resolved));
}

/**
 * fsync a directory entry boundary. Use after creating or renaming a file when the directory
 * entry itself, not just file contents, must survive host power loss.
 */
export function flushDirectoryDurable(directoryPath: string): void {
  const directoryDescriptor = openSync(resolve(directoryPath), "r");
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
}

/**
 * fsync an open file descriptor. Named for intent at a durability boundary: the
 * writes before it survive host power loss, not merely a process or worker kill.
 */
export function flushDurable(fileDescriptor: number): void {
  fsyncSync(fileDescriptor);
}

/**
 * Append to a file and fsync it, so the appended record is power-loss durable
 * rather than only in the OS page cache. For low-frequency append-only logs whose
 * every record must survive a crash; a high-frequency log should instead batch
 * its fsync at a boundary via `flushDurable` on a long-lived descriptor. On the
 * first append that creates the file, the parent directory is fsynced too, so the
 * new file's directory entry — not just its contents — is power-loss durable.
 */
export function appendFileDurable(filePath: string, contents: string): void {
  const resolved = resolve(filePath);
  const createdFile = !existsSync(resolved);
  const fileDescriptor = openSync(resolved, "a");
  try {
    writeFileSync(fileDescriptor, contents, "utf8");
    fsyncSync(fileDescriptor);
  } finally {
    closeSync(fileDescriptor);
  }
  if (createdFile) {
    const directoryDescriptor = openSync(dirname(resolved), "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  }
}

export type AppendOnlyClassification<TRecord> =
  | { readonly ok: true; readonly value: TRecord }
  | { readonly ok: false; readonly issueClass: string; readonly tag: string };

export type AppendOnlyLoadIssue =
  | { readonly kind: "torn_tail"; readonly truncatedToBytes: number; readonly droppedBytes: number }
  | {
      readonly kind: "malformed";
      readonly lineNumber: number;
      readonly text: string;
      readonly issueClass: string;
      readonly tag: string;
    };

export interface LoadAppendOnlyHandlers<TRecord> {
  readonly classify: (line: string) => AppendOnlyClassification<TRecord>;
  readonly onRecord: (value: TRecord, lineNumber: number) => void;
  readonly onIssue?: (issue: AppendOnlyLoadIssue) => void;
}

/**
 * Locate a torn trailing line. Every record writer terminates its line with
 * `\n`, so a file that does not end in `\n` has a torn final line by
 * construction. Returns the byte offset to truncate to (just past the last
 * newline, or 0 if there is none) and the current size, or null when the file is
 * empty or already ends cleanly.
 */
function locateTornTail(
  filePath: string,
): { readonly truncateTo: number; readonly size: number } | null {
  const fileDescriptor = openSync(filePath, "r");
  try {
    const { size } = fstatSync(fileDescriptor);
    if (size === 0) {
      return null;
    }
    const lastByte = Buffer.allocUnsafe(1);
    readSync(fileDescriptor, lastByte, 0, 1, size - 1);
    if (lastByte[0] === 0x0a) {
      return null; // ends in a newline: no torn tail
    }
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, size));
    let position = size;
    while (position > 0) {
      const readStart = Math.max(0, position - buffer.length);
      const bytesRead = readSync(fileDescriptor, buffer, 0, position - readStart, readStart);
      for (let index = bytesRead - 1; index >= 0; index -= 1) {
        if (buffer[index] === 0x0a) {
          return { truncateTo: readStart + index + 1, size };
        }
      }
      position = readStart;
    }
    return { truncateTo: 0, size }; // a single torn line, no newline at all
  } finally {
    closeSync(fileDescriptor);
  }
}

/**
 * Read an append-only log, repairing a torn trailing line. A file that does not
 * end in `\n` has a torn final line by construction (every record writer
 * terminates with `\n`), so that line is physically truncated — closing both the
 * "valid-looking but truncated tail" case and the "next append concatenates onto
 * the torn bytes" corruption — and reported as a `torn_tail` issue. Every
 * surviving newline-terminated line is classified: an `ok` record goes to
 * `onRecord`, a failure to `onIssue` as `malformed`. Blank lines are skipped. A
 * missing file is a no-op.
 */
export function loadAppendOnly<TRecord>(
  filePath: string,
  handlers: LoadAppendOnlyHandlers<TRecord>,
): void {
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    return;
  }
  const { classify, onRecord, onIssue } = handlers;

  const tornTail = locateTornTail(resolved);
  if (tornTail) {
    truncateSync(resolved, tornTail.truncateTo);
    onIssue?.({
      kind: "torn_tail",
      truncatedToBytes: tornTail.truncateTo,
      droppedBytes: tornTail.size - tornTail.truncateTo,
    });
  }

  forEachUtf8LineSync(resolved, (text, lineNumber) => {
    if (text.trim().length === 0) {
      return; // skip blank lines
    }
    const classification = classify(text);
    if (classification.ok) {
      onRecord(classification.value, lineNumber);
      return;
    }
    onIssue?.({
      kind: "malformed",
      lineNumber,
      text,
      issueClass: classification.issueClass,
      tag: classification.tag,
    });
  });
}

export interface AppendOnlyScanLine {
  /** Trimmed line content. */
  readonly text: string;
  /** 1-based line number. */
  readonly lineNumber: number;
  /** Byte offset of the line's first byte, for a truncate-based repair plan. */
  readonly byteOffset: number;
  /** True when this is the last surviving (non-torn) record in the file. */
  readonly isLastRecord: boolean;
}

export interface AppendOnlyScanResult {
  readonly exists: boolean;
  /**
   * True when the file ends in a crash-torn final line: a non-empty trailing
   * record with no terminating newline. Decided purely at the byte level — the
   * SAME boundary `loadAppendOnly` truncates at — independent of whether the line
   * parses, so the strict and forensic readers cannot drift.
   */
  readonly tornTail: boolean;
}

/**
 * Read-only forensic counterpart to `loadAppendOnly`. It never truncates, but it
 * decides "torn tail" through the very same `locateTornTail` boundary the strict
 * reader truncates at: a non-empty final line with no terminating newline is a
 * torn write and is delivered to neither `onRecord` (so it is not a record) nor a
 * caller's issue handler (so it is not corruption) — it only sets `tornTail`.
 * Every other non-empty line is delivered for the caller to classify through the
 * same grammar the strict reader uses. This is the one place the torn-tail
 * boundary is decided for forensics, so the two readers stay in lockstep.
 */
export function scanAppendOnly(
  filePath: string,
  onRecord: (line: AppendOnlyScanLine) => void,
): AppendOnlyScanResult {
  const resolved = resolve(filePath);
  if (!existsSync(resolved)) {
    return { exists: false, tornTail: false };
  }
  const torn = locateTornTail(resolved);
  const raw = readFileSync(resolved, "utf8");
  if (raw.length === 0) {
    return { exists: true, tornTail: false };
  }
  const segments = raw.split("\n");
  const offsets: number[] = [];
  let cursor = 0;
  for (let index = 0; index < segments.length; index += 1) {
    offsets.push(cursor);
    cursor +=
      Buffer.byteLength(segments[index] ?? "", "utf8") + (index < segments.length - 1 ? 1 : 0);
  }
  // A segment is the torn tail when it begins at or after the truncate point —
  // exactly the bytes `loadAppendOnly` would drop.
  const isTorn = (index: number): boolean =>
    torn !== null && (offsets[index] ?? 0) >= torn.truncateTo;
  let lastRecordIndex = -1;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if ((segments[index] ?? "").trim().length > 0 && !isTorn(index)) {
      lastRecordIndex = index;
      break;
    }
  }
  for (let index = 0; index < segments.length; index += 1) {
    const trimmed = (segments[index] ?? "").trim();
    if (trimmed.length === 0 || isTorn(index)) {
      continue;
    }
    onRecord({
      text: trimmed,
      lineNumber: index + 1,
      byteOffset: offsets[index] ?? 0,
      isLastRecord: index === lastRecordIndex,
    });
  }
  return { exists: true, tornTail: torn !== null };
}
