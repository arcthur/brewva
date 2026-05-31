import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forEachUtf8LineSync } from "@brewva/brewva-std/node/fs";

describe("std node fs helpers", () => {
  test("streams UTF-8 lines across chunk boundaries without requiring a trailing newline", () => {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-std-lines-"));
    const filePath = join(cwd, "events.jsonl");
    writeFileSync(filePath, "alpha\nbravo\r\ncharlie\nsnowman: \u2603", "utf8");

    const seen: Array<{ line: string; lineNumber: number }> = [];
    forEachUtf8LineSync(
      filePath,
      (line, lineNumber) => {
        seen.push({ line, lineNumber });
      },
      { chunkSize: 5 },
    );

    expect(seen).toEqual([
      { line: "alpha", lineNumber: 1 },
      { line: "bravo", lineNumber: 2 },
      { line: "charlie", lineNumber: 3 },
      { line: "snowman: \u2603", lineNumber: 4 },
    ]);
  });
});
