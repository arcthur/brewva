import { existsSync, readFileSync } from "node:fs";
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
  if (!existsSync(filePath)) {
    return emptyScan(sessionId, filePath, false);
  }
  const raw = readFileSync(filePath, "utf8");
  if (raw.length === 0) {
    return emptyScan(sessionId, filePath, true);
  }

  // Split on newlines while tracking byte offsets. A terminating newline yields a
  // trailing empty segment (not a record); its absence means the final segment is
  // unterminated — the signature of a crash mid-append.
  const segments = raw.split("\n");
  const endsWithNewline = raw.endsWith("\n");
  let lastNonEmptyIndex = -1;
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if ((segments[i] ?? "").trim().length > 0) {
      lastNonEmptyIndex = i;
      break;
    }
  }

  const issues: TapeForensicIssue[] = [];
  let byteOffset = 0;
  let totalRecords = 0;
  let validRecords = 0;
  let lastValidEventId: string | null = null;
  let tornTail = false;

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] ?? "";
    const segmentBytes = Buffer.byteLength(segment, "utf8");
    const trimmed = segment.trim();
    if (trimmed.length > 0) {
      totalRecords += 1;
      const classified = classifyTapeRecord(trimmed);
      if (classified.ok) {
        validRecords += 1;
        lastValidEventId = classified.event.id;
      } else {
        const isLastNonEmpty = i === lastNonEmptyIndex;
        if (isLastNonEmpty && !endsWithNewline && classified.issueClass === "malformed_json") {
          tornTail = true;
        }
        issues.push(
          Object.freeze({
            line: i + 1,
            byteOffset,
            issueClass: classified.issueClass,
            tag: classified.tag,
            tailLocal: isLastNonEmpty,
          }),
        );
      }
    }
    // Advance past this segment plus its "\n" delimiter (every segment except the last).
    byteOffset += segmentBytes + (i < segments.length - 1 ? 1 : 0);
  }

  return Object.freeze({
    sessionId,
    filePath,
    exists: true,
    totalRecords,
    validRecords,
    lastValidEventId,
    tornTail,
    issues: Object.freeze(issues),
  });
}
