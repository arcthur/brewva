import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EXPECTED_SYMBOLS = [
  "HostedExtensionPlugin",
  "HostedExtensionApi",
  "HostedExtensionCapability",
  "defineHostedExtensionPlugin",
  "LocalHookPort",
];

describe("docs/reference extensions coverage", () => {
  it("documents extension entry points without hosted behavior internals", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const markdown = readFileSync(resolve(repoRoot, "docs/reference/extensions.md"), "utf-8");

    const missing = EXPECTED_SYMBOLS.filter((name) => !markdown.includes(`\`${name}\``));

    expect(
      missing,
      `Missing extension symbols in docs/reference/extensions.md: ${missing.join(", ")}`,
    ).toEqual([]);

    expect(markdown).not.toContain("packages/brewva-gateway/src/hosted/internal/");
    expect(markdown).not.toContain("@brewva/brewva-gateway/runtime-plugins");
  });
});
