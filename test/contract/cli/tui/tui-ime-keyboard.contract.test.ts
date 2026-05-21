import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("tui ime keyboard contract", () => {
  test("keeps IME and CJK text input on the raw UTF-8 terminal path", () => {
    const repoRoot = resolve(import.meta.dirname, "../../../..");
    const runtimeEntrypointPath = resolve(
      repoRoot,
      "packages",
      "brewva-cli",
      "runtime",
      "internal-opentui-runtime.ts",
    );

    const runtimeEntrypointSource = readFileSync(runtimeEntrypointPath, "utf8");

    expect(runtimeEntrypointSource).toContain("disambiguate: true");
    expect(runtimeEntrypointSource).toContain("alternateKeys: true");
    expect(runtimeEntrypointSource).not.toContain("allKeysAsEscapes: true");
    expect(runtimeEntrypointSource).not.toContain("reportText: true");
  });
});
