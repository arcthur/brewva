import { describe, expect, it, setDefaultTimeout } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

// Cases here do real end-to-end work (subprocess spawns, source-tree scans, embedded
// runtimes) that can exceed bun's 5s default test timeout under machine load (bare
// `bun test`; package scripts pass --timeout 600000).
setDefaultTimeout(60_000);

describe("generated docs inventory freshness", () => {
  it("matches current code-derived inventories exactly", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const result = spawnSync("bun", ["run", "docs:inventory:check"], {
      cwd: repoRoot,
      encoding: "utf-8",
    });

    expect(result.status, [result.stdout, result.stderr].filter(Boolean).join("\n")).toBe(0);
  });
});
