import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("substrate contract: Brewva-owned provider and asset branding", () => {
  test("removes Pi-branded provider identity markers from Brewva-owned providers", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const googleGeminiCliPath = resolve(
      repoRoot,
      "packages",
      "brewva-provider-core",
      "src",
      "providers",
      "google-gemini-cli.ts",
    );
    const openaiCodexResponsesPath = resolve(
      repoRoot,
      "packages",
      "brewva-provider-core",
      "src",
      "providers",
      "openai-codex-responses.ts",
    );
    const openaiCompletionsPath = resolve(
      repoRoot,
      "packages",
      "brewva-provider-core",
      "src",
      "providers",
      "openai-completions.ts",
    );

    const googleGeminiCliSource = readFileSync(googleGeminiCliPath, "utf8");
    const openaiCodexResponsesSource = readFileSync(openaiCodexResponsesPath, "utf8");
    const openaiCompletionsSource = readFileSync(openaiCompletionsPath, "utf8");

    expect(googleGeminiCliSource).not.toContain("pi-coding-agent");
    expect(openaiCodexResponsesSource).not.toContain('originator", "pi"');
    expect(openaiCodexResponsesSource).not.toContain("pi (");
    expect(openaiCompletionsSource).not.toContain("pi-ai semantics");
  });

  test("removes Pi-branded CLI runtime assets from Brewva-owned packaging surfaces", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const darkThemePath = resolve(
      repoRoot,
      "packages",
      "brewva-cli",
      "runtime-assets",
      "theme",
      "dark.json",
    );
    const lightThemePath = resolve(
      repoRoot,
      "packages",
      "brewva-cli",
      "runtime-assets",
      "theme",
      "light.json",
    );
    const themeDeclarationPath = resolve(
      repoRoot,
      "packages",
      "brewva-cli",
      "runtime-assets",
      "theme",
      "theme.d.ts",
    );
    const themeRuntimePath = resolve(
      repoRoot,
      "packages",
      "brewva-cli",
      "runtime-assets",
      "theme",
      "theme.js",
    );
    const themeSourceMapPath = resolve(
      repoRoot,
      "packages",
      "brewva-cli",
      "runtime-assets",
      "theme",
      "theme.js.map",
    );
    const exportHtmlIndexPath = resolve(
      repoRoot,
      "packages",
      "brewva-cli",
      "runtime-assets",
      "export-html",
      "index.d.ts",
    );
    const exportHtmlIndexMapPath = resolve(
      repoRoot,
      "packages",
      "brewva-cli",
      "runtime-assets",
      "export-html",
      "index.d.ts.map",
    );
    const exportHtmlToolRendererPath = resolve(
      repoRoot,
      "packages",
      "brewva-cli",
      "runtime-assets",
      "export-html",
      "tool-renderer.d.ts.map",
    );

    const darkThemeSource = readFileSync(darkThemePath, "utf8");
    const lightThemeSource = readFileSync(lightThemePath, "utf8");
    const themeDeclarationSource = readFileSync(themeDeclarationPath, "utf8");
    const themeRuntimeSource = readFileSync(themeRuntimePath, "utf8");
    const themeSourceMap = readFileSync(themeSourceMapPath, "utf8");
    const exportHtmlIndexSource = readFileSync(exportHtmlIndexPath, "utf8");
    const exportHtmlIndexMapSource = readFileSync(exportHtmlIndexMapPath, "utf8");
    const exportHtmlToolRendererSource = readFileSync(exportHtmlToolRendererPath, "utf8");

    expect(darkThemeSource).not.toContain("pi-mono");
    expect(lightThemeSource).not.toContain("pi-mono");
    expect(themeDeclarationSource).not.toContain("@mariozechner/pi-tui");
    expect(themeRuntimeSource).not.toContain("@mariozechner/pi-coding-agent:theme");
    expect(themeSourceMap).not.toContain("@mariozechner/pi-coding-agent:theme");
    expect(themeSourceMap).not.toContain("@mariozechner/pi-tui");
    expect(exportHtmlIndexSource).not.toContain("@mariozechner/pi-agent-core");
    expect(exportHtmlIndexMapSource).not.toContain("@mariozechner/pi-agent-core");
    expect(exportHtmlToolRendererSource).not.toContain("@mariozechner/pi-ai");
    expect(exportHtmlToolRendererSource).not.toContain("@mariozechner/pi-tui");
  });
});
