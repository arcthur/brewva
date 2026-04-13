import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("cli contract: Brewva-native runtime boundary", () => {
  test("keeps Pi interactive runtime and Pi session bridges out of the cli runtime path", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const indexPath = resolve(repoRoot, "packages", "brewva-cli", "src", "index.ts");
    const runtimePath = resolve(repoRoot, "packages", "brewva-cli", "src", "cli-runtime.ts");
    const packageJsonPath = resolve(repoRoot, "packages", "brewva-cli", "package.json");
    const legacyPiRuntimePath = resolve(
      repoRoot,
      "packages",
      "brewva-cli",
      "src",
      "pi-cli-runtime.ts",
    );
    const sessionBridgePath = resolve(
      repoRoot,
      "packages",
      "brewva-cli",
      "src",
      "pi-cli-session.ts",
    );

    const indexSource = readFileSync(indexPath, "utf8");
    const runtimeSource = readFileSync(runtimePath, "utf8");
    const packageJsonSource = readFileSync(packageJsonPath, "utf8");
    expect(existsSync(legacyPiRuntimePath)).toBe(false);
    expect(existsSync(sessionBridgePath)).toBe(false);

    expect(indexSource).not.toContain('from "@mariozechner/pi-coding-agent"');
    expect(indexSource).not.toContain("./pi-cli-runtime");
    expect(indexSource).not.toContain("toPiCliSession(");
    expect(indexSource).toContain("./cli-runtime.js");

    expect(runtimeSource).not.toContain('from "@mariozechner/pi-coding-agent"');
    expect(runtimeSource).not.toContain("toPiCliSession(");
    expect(runtimeSource).not.toContain("requireHostedPiSession");
    expect(runtimeSource).toContain("runCliInteractiveSession");
    expect(runtimeSource).toContain("runCliPrintSession");
    expect(runtimeSource).toContain("session.subscribe(");
    expect(runtimeSource).toContain("readline.createInterface");

    expect(packageJsonSource).not.toContain('"@mariozechner/pi-coding-agent"');
  });
});
