import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRecoveryWalStore, scanRecoveryWalForensics } from "@brewva/brewva-gateway/daemon";
import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import type { TurnEnvelope } from "@brewva/brewva-vocabulary/wire";

const config = DEFAULT_BREWVA_CONFIG.infrastructure.recoveryWal;

function envelope(id: string): TurnEnvelope {
  return {
    schema: "brewva.turn.v1",
    kind: "user",
    sessionId: "grammar-session",
    turnId: id,
    channel: "telegram",
    conversationId: "grammar-conversation",
    timestamp: 1_700_000_000_000,
    parts: [{ type: "text", text: id }],
  };
}

function sorted(values: readonly string[]): string[] {
  return [...values].toSorted((left, right) => left.localeCompare(right));
}

// Standing fitness: the strict store loader and the read-only forensic scanner
// classify through one `classifyWalRecord` grammar, so they cannot drift — every
// healthy row the loader keeps, the scanner reports as a row; every malformed line
// the loader quarantines, the scanner localizes as an issue. (The WAL counterpart
// to tape-reader-grammar-parity.)
describe("recovery WAL strict and forensic readers share one grammar", () => {
  test("healthy rows and malformed lines: loader and scanner agree", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "brewva-wal-parity-"));
    const path = resolve(workspaceRoot, config.dir, "grammar.jsonl");
    mkdirSync(dirname(path), { recursive: true });

    // Two valid rows written by the store, then two malformed lines appended.
    const seed = createRecoveryWalStore({ workspaceRoot, config, scope: "grammar" });
    const a = seed.appendPending(envelope("turn-a"), "gateway");
    const b = seed.appendPending(envelope("turn-b"), "gateway");
    seed.markDone(b.walId);
    appendFileSync(path, 'not-json\n{"schema":"unknown-row"}\n');

    // Strict loader (the owning daemon's read).
    const strict = createRecoveryWalStore({ workspaceRoot, config, scope: "grammar" });
    const strictRows = sorted(strict.listCurrent().map((row) => row.walId));
    const strictIssueCount = strict.getIntegrityIssues().length;

    // Read-only forensic scanner (inspect's read).
    const scan = scanRecoveryWalForensics(path, { scope: "grammar", config });
    const scanRows = sorted(scan.rows.map((row) => row.walId));

    expect(scanRows).toEqual(strictRows);
    expect(scanRows).toEqual(sorted([a.walId, b.walId]));
    expect(scan.issues.length).toBe(strictIssueCount);
    expect(scan.issues.length).toBe(2);
  });

  test("an unterminated final row is torn in both readers, not a quarantine issue", () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "brewva-wal-parity-torn-"));
    const path = resolve(workspaceRoot, config.dir, "torn.jsonl");
    mkdirSync(dirname(path), { recursive: true });
    const seed = createRecoveryWalStore({ workspaceRoot, config, scope: "torn" });
    const a = seed.appendPending(envelope("turn-a"), "gateway");
    seed.appendPending(envelope("turn-b"), "gateway");
    // Strip the trailing newline so the final (still valid) row is a torn write.
    writeFileSync(path, readFileSync(path, "utf8").replace(/\n$/u, ""));

    // Forensic scan first (read-only, before the strict load truncates the tail).
    const scan = scanRecoveryWalForensics(path, { scope: "torn", config });
    expect(scan.tornTail).toBe(true);
    expect(scan.issues).toEqual([]);
    expect(scan.rows.map((row) => row.walId)).toEqual([a.walId]);

    // The strict loader drops the same torn row, keeping only the survivor.
    const strict = createRecoveryWalStore({ workspaceRoot, config, scope: "torn" });
    expect(strict.listCurrent().map((row) => row.walId)).toEqual([a.walId]);
  });
});
