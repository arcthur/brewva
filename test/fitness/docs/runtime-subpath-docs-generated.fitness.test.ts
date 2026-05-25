import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

describe("runtime subpath docs freshness", () => {
  test("package-boundaries runtime subpath table is generated from the registry", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const result = spawnSync("bun", ["run", "docs:runtime-subpaths:check"], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    expect(result.status, [result.stdout, result.stderr].filter(Boolean).join("\n")).toBe(0);
  });
});
