import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("tui ime keyboard contract", () => {
  test("enables Kitty text reporting for IME and CJK input in the Bun runtime", () => {
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    const runtimeEntrypointPath = resolve(
      repoRoot,
      "packages",
      "brewva-cli",
      "runtime",
      "internal-opentui-runtime.ts",
    );

    const runtimeEntrypointSource = readFileSync(runtimeEntrypointPath, "utf8");

    expect(runtimeEntrypointSource).toContain("allKeysAsEscapes: true");
    expect(runtimeEntrypointSource).toContain("reportText: true");
  });
});
