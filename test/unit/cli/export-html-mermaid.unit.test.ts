import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const exportHtmlRoot = resolve(repoRoot, "packages", "brewva-cli", "runtime-assets", "export-html");

function readExportHtmlAsset(path: string): string {
  return readFileSync(resolve(exportHtmlRoot, path), "utf8");
}

describe("export HTML Mermaid rendering assets", () => {
  test("embeds the vendored Mermaid runtime into the standalone export template", () => {
    const indexSource = readExportHtmlAsset("index.js");
    const templateSource = readExportHtmlAsset("template.html");
    const vendorPath = resolve(exportHtmlRoot, "vendor", "mermaid.min.js");
    const vendorSource = readExportHtmlAsset("vendor/mermaid.min.js");

    expect(existsSync(vendorPath)).toBe(true);
    expect(vendorSource).not.toContain("</script");
    expect(vendorSource).not.toContain("sourceMappingURL");
    expect(templateSource).toContain("{{MERMAID_JS}}");
    expect(indexSource).toContain('join(templateDir, "vendor", "mermaid.min.js")');
    expect(indexSource).toContain("function renderTemplate");
    expect(indexSource).toContain("MERMAID_JS: mermaidJs");
    expect(indexSource).not.toContain('.replace("{{MERMAID_JS}}", mermaidJs)');
  });

  test("renders Mermaid code fences as Mermaid blocks instead of highlighted code", () => {
    const templateSource = readExportHtmlAsset("template.js");

    expect(templateSource).toContain("function renderMermaidBlock");
    expect(templateSource).toContain("isMermaidLanguage(lang)");
    expect(templateSource).toContain('class="mermaid brewva-mermaid"');
    expect(templateSource).toContain("renderMermaidBlock(code)");
  });

  test("runs Mermaid after transcript navigation with strict security defaults", () => {
    const templateSource = readExportHtmlAsset("template.js");

    expect(templateSource).toContain("function initializeMermaidRuntime");
    expect(templateSource).toContain("securityLevel: 'strict'");
    expect(templateSource).toContain("startOnLoad: false");
    expect(templateSource).toContain("suppressErrorRendering: true");
    expect(templateSource).toContain("function readCssVariable");
    expect(templateSource).toContain("return value || fallback");
    expect(templateSource).toContain("function renderMermaidDiagrams");
    expect(templateSource).toContain("if (!initializeMermaidRuntime())");
    expect(templateSource).toContain("renderMermaidDiagrams(messagesEl)");
    expect(templateSource).toContain(
      "Mermaid runtime initialization failed; leaving source blocks visible.",
    );
    expect(templateSource).toContain("Mermaid rendering failed; leaving source blocks visible.");
  });
});
