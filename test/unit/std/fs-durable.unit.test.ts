import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AppendOnlyClassification,
  type AppendOnlyLoadIssue,
  appendFileDurable,
  flushDurable,
  loadAppendOnly,
  rewriteFileAtomic,
  scanAppendOnly,
} from "@brewva/brewva-std/node/fs";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "brewva-fs-durable-"));
}

describe("rewriteFileAtomic", () => {
  test("writes the full contents when the target does not exist", () => {
    const path = join(tempDir(), "log.jsonl");
    rewriteFileAtomic(path, "a\nb\n");
    expect(readFileSync(path, "utf8")).toBe("a\nb\n");
  });

  test("replaces existing contents entirely", () => {
    const path = join(tempDir(), "log.jsonl");
    writeFileSync(path, "old-content-that-is-much-longer\n");
    rewriteFileAtomic(path, "new\n");
    expect(readFileSync(path, "utf8")).toBe("new\n");
  });

  test("leaves no .tmp sibling behind", () => {
    const dir = tempDir();
    rewriteFileAtomic(join(dir, "log.jsonl"), "x\n");
    expect(readdirSync(dir)).toEqual(["log.jsonl"]);
  });

  test("a .tmp written but never renamed leaves the prior file intact", () => {
    // Models a crash between the tmp write and the rename: the live file is
    // whatever it was before; the orphan .tmp is inert.
    const dir = tempDir();
    const path = join(dir, "log.jsonl");
    rewriteFileAtomic(path, "committed\n");
    writeFileSync(`${path}.tmp`, "half-written-uncommitted");
    expect(readFileSync(path, "utf8")).toBe("committed\n");
  });

  test("sensitive rewrites do not inherit a wider stale tmp mode", () => {
    const path = join(tempDir(), "secret.json");
    const tmpPath = `${path}.tmp`;
    writeFileSync(tmpPath, "stale-secret\n", "utf8");
    chmodSync(tmpPath, 0o644);

    rewriteFileAtomic(path, "fresh-secret\n", { mode: 0o600 });

    expect(readFileSync(path, "utf8")).toBe("fresh-secret\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(existsSync(tmpPath)).toBe(false);
  });
});

describe("flushDurable", () => {
  test("fsyncs an open descriptor without corrupting the written bytes", () => {
    const path = join(tempDir(), "log.jsonl");
    const fd = openSync(path, "w");
    try {
      writeSync(fd, "durable\n");
      flushDurable(fd);
    } finally {
      closeSync(fd);
    }
    expect(readFileSync(path, "utf8")).toBe("durable\n");
  });

  test("throws on a closed descriptor", () => {
    const fd = openSync(join(tempDir(), "closed.jsonl"), "w");
    closeSync(fd);
    expect(() => flushDurable(fd)).toThrow(/EBADF|bad file descriptor/iu);
  });
});

describe("appendFileDurable", () => {
  test("appends and fsyncs, preserving prior content", () => {
    const path = join(tempDir(), "log.jsonl");
    appendFileDurable(path, "a\n");
    appendFileDurable(path, "b\n");
    expect(readFileSync(path, "utf8")).toBe("a\nb\n");
  });

  test("creates the file when it does not exist", () => {
    const path = join(tempDir(), "fresh.jsonl");
    expect(existsSync(path)).toBe(false);
    appendFileDurable(path, "first\n");
    expect(readFileSync(path, "utf8")).toBe("first\n");
  });
});

describe("loadAppendOnly and scanAppendOnly share one torn-tail boundary", () => {
  const classify = (line: string): AppendOnlyClassification<string> =>
    line.startsWith("BAD")
      ? { ok: false, issueClass: "invalid", tag: "bad" }
      : { ok: true, value: line };

  // The strict loader drops an unterminated final line by the byte rule alone (a
  // later append would otherwise merge onto it); the forensic scanner must call
  // the same line a torn tail and deliver it as neither record nor issue —
  // regardless of whether it would classify ok. Asserting both readers agree for
  // a valid-but-unterminated tail (a) and a classify-failing unterminated tail
  // (b) pins item D's "one definition, two readers, never drift".
  for (const [label, tail] of [
    ["valid but unterminated", "ok-tail"],
    ["classify-failing and unterminated", "BAD-tail"],
  ] as const) {
    test(`an unterminated final line (${label}) is torn in both readers`, () => {
      const path = join(tempDir(), "log.jsonl");
      writeFileSync(path, `a\n${tail}`); // no trailing newline

      const scanned: string[] = [];
      const scan = scanAppendOnly(path, (line) => scanned.push(line.text));
      expect(scan.tornTail).toBe(true);
      expect(scanned).toEqual(["a"]);

      const loaded: string[] = [];
      loadAppendOnly<string>(path, { classify, onRecord: (value) => loaded.push(value) });
      expect(loaded).toEqual(["a"]);
    });
  }
});

describe("loadAppendOnly", () => {
  function collect(path: string): { records: string[]; issues: AppendOnlyLoadIssue[] } {
    const records: string[] = [];
    const issues: AppendOnlyLoadIssue[] = [];
    loadAppendOnly<string>(path, {
      classify: (line) =>
        line.startsWith("BAD")
          ? { ok: false, issueClass: "invalid", tag: "bad" }
          : { ok: true, value: line },
      onRecord: (value) => records.push(value),
      onIssue: (issue) => issues.push(issue),
    });
    return { records, issues };
  }

  test("delivers each newline-terminated record", () => {
    const path = join(tempDir(), "log.jsonl");
    writeFileSync(path, "a\nb\n");
    const { records, issues } = collect(path);
    expect(records).toEqual(["a", "b"]);
    expect(issues).toEqual([]);
  });

  test("drops an unterminated final line as a torn tail", () => {
    const path = join(tempDir(), "log.jsonl");
    writeFileSync(path, "a\nbad-tail"); // no trailing newline
    const { records, issues } = collect(path);
    expect(records).toEqual(["a"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("torn_tail");
  });

  test("drops an unterminated final line even when it would classify as ok", () => {
    // A partial flush that happens to leave a valid-looking record is still a
    // torn write, because every record writer terminates its line with \n.
    const path = join(tempDir(), "log.jsonl");
    writeFileSync(path, "a\nb"); // "b" classifies ok but is unterminated
    const { records, issues } = collect(path);
    expect(records).toEqual(["a"]);
    expect(issues[0]?.kind).toBe("torn_tail");
  });

  test("reports a malformed newline-terminated mid-file line as malformed, not torn", () => {
    const path = join(tempDir(), "log.jsonl");
    writeFileSync(path, "a\nBAD\nc\n");
    const { records, issues } = collect(path);
    expect(records).toEqual(["a", "c"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.kind).toBe("malformed");
  });

  test("skips blank lines", () => {
    const path = join(tempDir(), "log.jsonl");
    writeFileSync(path, "a\n\nb\n");
    expect(collect(path).records).toEqual(["a", "b"]);
  });

  test("is a no-op for a missing file", () => {
    const path = join(tempDir(), "missing.jsonl");
    expect(existsSync(path)).toBe(false);
    const { records, issues } = collect(path);
    expect(records).toEqual([]);
    expect(issues).toEqual([]);
  });

  test("repairs the torn tail on disk so a subsequent append stays well-formed", () => {
    // Writers use append fds: if the torn tail is only skipped in memory, the
    // next append concatenates onto it ("bad-tail" + "c" -> one malformed line).
    // The tail must be physically truncated on load.
    const path = join(tempDir(), "log.jsonl");
    writeFileSync(path, "a\nbad-tail"); // torn tail, no trailing newline
    collect(path); // load repairs the file
    appendFileSync(path, "c\n"); // the next durable append
    expect(collect(path).records).toEqual(["a", "c"]);
    expect(readFileSync(path, "utf8")).toBe("a\nc\n");
  });
});
