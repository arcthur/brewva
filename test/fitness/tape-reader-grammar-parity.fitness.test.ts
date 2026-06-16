import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveTapeFilePath, scanTapeFileForensics } from "@brewva/brewva-runtime";
import { createHostedRuntimeAdapter } from "../../packages/brewva-gateway/src/hosted/internal/session/runtime-ports.js";

// Standing fitness (RFC WS3/WS4): the strict authoritative reader and the tolerant
// forensic scanner share one record grammar (classifyTapeRecord), so they cannot
// drift: every byte sequence the strict reader accepts is healthy to the scanner,
// and every sequence it rejects is localized by the scanner. Exercising both
// readers over the same tape proves the relationship behaviorally.
describe("strict and forensic tape readers share one grammar (RFC WS3)", () => {
  const sessionId = "grammar-parity-session";

  function validRecord(id: string): string {
    return JSON.stringify({ id, sessionId, type: "turn.started", timestamp: 1, payload: {} });
  }

  function adapterAndTapePath(contents: string) {
    const cwd = mkdtempSync(join(tmpdir(), "brewva-grammar-"));
    const adapter = createHostedRuntimeAdapter({ cwd });
    const path = resolveTapeFilePath(
      adapter.identity.workspaceRoot,
      adapter.config.tape.dir,
      sessionId,
    );
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
    return { adapter, path };
  }

  test("a clean tape: strict reader loads it and the forensic scanner finds no issues", () => {
    const { adapter, path } = adapterAndTapePath(`${validRecord("e1")}\n${validRecord("e2")}\n`);

    // The strict reader loads both valid records without rejecting the tape.
    expect(adapter.runtime.tape.list(sessionId)).toHaveLength(2);
    expect(scanTapeFileForensics(path, sessionId).issues).toEqual([]);
  });

  test("a malformed tape: strict reader rejects it and the forensic scanner localizes it", () => {
    const { adapter, path } = adapterAndTapePath(`${validRecord("e1")}\n{ not json\n`);

    expect(() => adapter.runtime.tape.list(sessionId)).toThrow(/unsupported_tape_schema/u);
    const scan = scanTapeFileForensics(path, sessionId);
    expect(scan.issues.length).toBeGreaterThan(0);
    expect(scan.lastValidEventId).toBe("e1");
  });
});
