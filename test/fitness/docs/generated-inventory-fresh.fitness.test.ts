import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

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
