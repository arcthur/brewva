import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanTapeFileForensics } from "@brewva/brewva-runtime";

const sessionId = "forensic-session";

function tempTape(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "brewva-forensics-"));
  const filePath = join(dir, "tape.jsonl");
  writeFileSync(filePath, contents, "utf8");
  return filePath;
}

function validRecord(id: string): string {
  return JSON.stringify({ id, sessionId, type: "turn.started", timestamp: 1, payload: {} });
}

describe("tape forensic scanner (RFC WS1)", () => {
  test("a clean tape reports no issues and the last valid event id", () => {
    const filePath = tempTape(`${validRecord("e1")}\n${validRecord("e2")}\n${validRecord("e3")}\n`);
    const scan = scanTapeFileForensics(filePath, sessionId);

    expect(scan.exists).toBe(true);
    expect(scan.totalRecords).toBe(3);
    expect(scan.validRecords).toBe(3);
    expect(scan.lastValidEventId).toBe("e3");
    expect(scan.tornTail).toBe(false);
    expect(scan.issues).toEqual([]);
  });

  test("a malformed middle row is localized as preceding later records", () => {
    const filePath = tempTape(`${validRecord("e1")}\n{ not json\n${validRecord("e3")}\n`);
    const scan = scanTapeFileForensics(filePath, sessionId);

    expect(scan.totalRecords).toBe(3);
    expect(scan.validRecords).toBe(2);
    expect(scan.lastValidEventId).toBe("e3");
    expect(scan.tornTail).toBe(false);
    expect(scan.issues).toHaveLength(1);
    expect(scan.issues[0]?.issueClass).toBe("malformed_json");
    expect(scan.issues[0]?.line).toBe(2);
    expect(scan.issues[0]?.tailLocal).toBe(false);
  });

  test("an unterminated incomplete final line is a torn tail, not a corruption issue", () => {
    const first = validRecord("e1");
    const filePath = tempTape(`${first}\n{"id":"e2","type":"turn.started"`);
    const scan = scanTapeFileForensics(filePath, sessionId);

    // The strict reader drops a torn final line by the byte-level rule; the
    // forensic scan must agree — flag `tornTail`, but never count the torn line as
    // a record or report it as corruption (that would over-report damage the
    // daemon silently self-heals).
    expect(scan.validRecords).toBe(1);
    expect(scan.lastValidEventId).toBe("e1");
    expect(scan.tornTail).toBe(true);
    expect(scan.issues).toHaveLength(0);
  });

  test("an unknown canonical event type is reported with its tag", () => {
    const bogus = JSON.stringify({
      id: "e1",
      sessionId,
      type: "bogus.type",
      timestamp: 1,
      payload: {},
    });
    const scan = scanTapeFileForensics(tempTape(`${bogus}\n`), sessionId);

    expect(scan.validRecords).toBe(0);
    expect(scan.issues).toHaveLength(1);
    expect(scan.issues[0]?.issueClass).toBe("unknown_type");
    expect(scan.issues[0]?.tag).toBe("bogus.type");
  });

  test("a missing tape file is reported as absent, not empty-but-healthy", () => {
    const scan = scanTapeFileForensics(join(tmpdir(), "does-not-exist-xyz.jsonl"), sessionId);

    expect(scan.exists).toBe(false);
    expect(scan.totalRecords).toBe(0);
    expect(scan.issues).toEqual([]);
  });
});
