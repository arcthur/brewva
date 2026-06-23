import { scanAppendOnly } from "@brewva/brewva-std/node/fs";
import { classifyTapeRecord, type TapeRecordIssueClass } from "./impl.js";

export { resolveTapeFilePath } from "./path.js";

/**
 * A single damaged record located in a tape file. Non-authoritative: forensic
 * evidence for diagnosis and repair planning, never permission to resume.
 */
export type TapeForensicIssue = {
  /** 1-based line number of the offending record. */
  readonly line: number;
  /** Byte offset of the record's first byte, for a truncate-based repair plan. */
  readonly byteOffset: number;
  readonly issueClass: TapeRecordIssueClass;
  /** The schema tag the strict reader would report (`malformed`, a type, ...). */
  readonly tag: string;
  /** True when this is the last non-empty record (no valid record follows it). */
  readonly tailLocal: boolean;
};

/**
 * Tolerant, non-authoritative scan of a session's tape file. Unlike the strict
 * reader it never throws: it localizes every damaged record so an operator can
 * see what is wrong without the session collapsing to "empty but healthy".
 */
export type TapeForensicScan = {
  readonly sessionId: string;
  readonly filePath: string;
  readonly exists: boolean;
  /** Non-empty records scanned (valid plus damaged). */
  readonly totalRecords: number;
  readonly validRecords: number;
  /** Id of the last record that parsed cleanly, or null. */
  readonly lastValidEventId: string | null;
  /**
   * True only for a crash-torn final line: the last non-empty record is an
   * incomplete (unparseable) JSON fragment with no terminating newline and no
   * later bytes. Distinct from a complete-but-invalid trailing record.
   */
  readonly tornTail: boolean;
  readonly issues: readonly TapeForensicIssue[];
};

function emptyScan(sessionId: string, filePath: string, exists: boolean): TapeForensicScan {
  return Object.freeze({
    sessionId,
    filePath,
    exists,
    totalRecords: 0,
    validRecords: 0,
    lastValidEventId: null,
    tornTail: false,
    issues: [],
  });
}

/**
 * An empty, file-absent scan, for a session with no durable tape file (for
 * example an in-memory session when tape persistence is disabled).
 */
export function emptyTapeForensicScan(sessionId: string): TapeForensicScan {
  return emptyScan(sessionId, "", false);
}

export function scanTapeFileForensics(filePath: string, sessionId: string): TapeForensicScan {
  const issues: TapeForensicIssue[] = [];
  let totalRecords = 0;
  let validRecords = 0;
  let lastValidEventId: string | null = null;
  // The torn-tail boundary is decided once, in scanAppendOnly, byte-for-byte the
  // same as the strict reader truncates — so the forensic scan and the strict
  // load agree on which final line is a torn write rather than a real record.
  const scan = scanAppendOnly(filePath, (line) => {
    totalRecords += 1;
    const classified = classifyTapeRecord(line.text);
    if (classified.ok) {
      validRecords += 1;
      lastValidEventId = classified.event.id;
      return;
    }
    issues.push(
      Object.freeze({
        line: line.lineNumber,
        byteOffset: line.byteOffset,
        issueClass: classified.issueClass,
        tag: classified.tag,
        tailLocal: line.isLastRecord,
      }),
    );
  });
  if (!scan.exists) {
    return emptyScan(sessionId, filePath, false);
  }
  return Object.freeze({
    sessionId,
    filePath,
    exists: true,
    totalRecords,
    validRecords,
    lastValidEventId,
    tornTail: scan.tornTail,
    issues: Object.freeze(issues),
  });
}
