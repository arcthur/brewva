import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

// Standing guard for the crash-safe substrate: the two durable append-only logs
// (the event tape and the Recovery WAL) must write through the brewva-std durable
// helpers — `rewriteFileAtomic` (atomic tmp + fsync + rename) for full-file
// rewrites, and `appendFileDurable` or a long-lived descriptor flushed by
// `flushDurable` for appends — never a raw non-atomic `writeFileSync` rewrite or a
// non-fsync'd `appendFileSync`. This pins the durability so a later edit cannot
// quietly reintroduce a write path that tears on a crash.
describe("durable-log write discipline", () => {
  const logSources = [
    "packages/brewva-gateway/src/daemon/recovery.ts",
    "packages/brewva-runtime/src/runtime/tape/impl.ts",
  ];

  for (const source of logSources) {
    test(`${source} never writes through a raw non-durable fs call`, () => {
      const code = readFileSync(resolve(repoRoot, source), "utf8");
      expect(code).not.toMatch(/\bappendFileSync\s*\(/u);
      expect(code).not.toMatch(/\bwriteFileSync\s*\(/u);
    });
  }
});
