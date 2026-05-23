import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearMermaidRuntimeRenderCache,
  mermaidTerminalGraphicsProfileFromOpenTui,
  renderMermaidWithRuntime,
} from "../../../packages/brewva-cli/runtime/shell/mermaid/runtime-renderer.js";
import { createPalette } from "../../../packages/brewva-cli/runtime/shell/palette.js";
import { DEFAULT_TUI_THEME } from "../../../packages/brewva-cli/src/internal/tui/index.js";
import { patchProcessEnv } from "../../helpers/global-state.js";

describe("Mermaid runtime renderer", () => {
  let previewDir = "";
  let restorePreviewDirEnv: (() => void) | undefined;

  beforeEach(() => {
    previewDir = mkdtempSync(join(tmpdir(), "brewva-mermaid-test-"));
    restorePreviewDirEnv = patchProcessEnv({ BREWVA_MERMAID_PREVIEW_DIR: previewDir });
    clearMermaidRuntimeRenderCache();
  });

  afterEach(() => {
    restorePreviewDirEnv?.();
    restorePreviewDirEnv = undefined;
    clearMermaidRuntimeRenderCache();
    rmSync(previewDir, { recursive: true, force: true });
  });

  test("creates a bundled runtime preview for complex Mermaid source", () => {
    const artifact = renderMermaidWithRuntime({
      source: [
        "graph TB",
        '  CLI["@brewva/brewva-cli<br/>CLI entry"]',
        '  subgraph runtime ["Runtime internals"]',
        '    KERNEL["Kernel Port"]',
        "  end",
        "  CLI --> KERNEL",
      ].join("\n"),
      theme: createPalette(DEFAULT_TUI_THEME),
      terminal: { kittyGraphics: false, sixel: false },
    });

    expect(artifact.kind).toBe("ready");
    if (artifact.kind !== "ready") {
      throw new Error(artifact.reason);
    }

    expect(artifact.inline).toMatchObject({
      kind: "unavailable",
      reason: "terminal_graphics_unavailable",
    });
    expect(existsSync(artifact.preview.filePath)).toBe(true);
    expect(existsSync(join(previewDir, "mermaid-runtime.js"))).toBe(true);

    const html = readFileSync(artifact.preview.filePath, "utf8");
    expect(html).toContain("Rendered by Brewva's bundled Mermaid runtime");
    expect(html).toContain("graph TB");
    expect(html).toContain("&lt;br/&gt;");
    expect(html).toContain('<script src="./mermaid-runtime.js"></script>');
    expect(html).toContain("startOnLoad: false");
    expect(html).toContain('securityLevel: "strict"');
    expect(html).toContain("suppressErrorRendering: true");
    expect(html).toContain("globalThis.mermaid.run");
  });

  test("keeps terminal image support behind an explicit backend artifact", () => {
    const artifact = renderMermaidWithRuntime({
      source: "flowchart TD\n  A --> B",
      theme: createPalette(DEFAULT_TUI_THEME),
      terminal: { kittyGraphics: true, sixel: false },
    });

    expect(artifact.inline).toMatchObject({
      kind: "unavailable",
      reason: "renderer_backend_unavailable",
    });
  });

  test("normalizes OpenTUI terminal graphics capabilities at the boundary", () => {
    expect(
      mermaidTerminalGraphicsProfileFromOpenTui({ kitty_graphics: true, sixel: false }),
    ).toEqual({
      kittyGraphics: true,
      sixel: false,
    });
    expect(mermaidTerminalGraphicsProfileFromOpenTui(null)).toEqual({
      kittyGraphics: false,
      sixel: false,
    });
  });

  test("keys preview artifacts by every theme value used by the runtime preview", () => {
    const theme = createPalette(DEFAULT_TUI_THEME);
    const first = renderMermaidWithRuntime({
      source: "flowchart TD\n  A --> B",
      theme,
      terminal: { kittyGraphics: false, sixel: false },
    });
    const second = renderMermaidWithRuntime({
      source: "flowchart TD\n  A --> B",
      theme: { ...theme, backgroundElement: "#123456" },
      terminal: { kittyGraphics: false, sixel: false },
    });

    expect(first.kind).toBe("ready");
    expect(second.kind).toBe("ready");
    if (first.kind !== "ready" || second.kind !== "ready") {
      throw new Error("Expected ready preview artifacts.");
    }
    expect(first.preview.filePath).not.toBe(second.preview.filePath);
    expect(readFileSync(second.preview.filePath, "utf8")).toContain("#123456");
  });
});
