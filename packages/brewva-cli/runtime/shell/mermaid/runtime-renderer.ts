import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { shortSha256Hex } from "@brewva/brewva-std/hash";
import { toErrorMessage } from "@brewva/brewva-std/unknown";
import type { SessionPalette } from "../palette.js";

export interface MermaidTerminalGraphicsProfile {
  readonly kittyGraphics: boolean;
  readonly sixel: boolean;
}

export interface OpenTuiTerminalGraphicsCapabilities {
  readonly kitty_graphics?: boolean;
  readonly sixel?: boolean;
}

export type MermaidInlineRenderArtifact =
  | {
      readonly kind: "inline";
      readonly protocol: "kitty" | "sixel";
      readonly data: string;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: "terminal_graphics_unavailable" | "renderer_backend_unavailable";
    };

export type MermaidRuntimeRenderArtifact =
  | {
      readonly kind: "ready";
      readonly sourceHash: string;
      readonly preview: MermaidRuntimePreviewArtifact;
      readonly inline: MermaidInlineRenderArtifact;
    }
  | {
      readonly kind: "failed";
      readonly reason: string;
      readonly inline: MermaidInlineRenderArtifact;
    };

export interface MermaidRuntimePreviewArtifact {
  readonly kind: "browser-preview";
  readonly filePath: string;
  readonly displayPath: string;
  readonly url: string;
  readonly renderer: "bundled-mermaid";
}

const PREVIEW_CACHE_DIR_ENV = "BREWVA_MERMAID_PREVIEW_DIR";
const VENDOR_RELATIVE_TO_RUNTIME_SOURCE =
  "../../../runtime-assets/export-html/vendor/mermaid.min.js";
const VENDOR_RELATIVE_TO_DISTRIBUTION_BIN = "export-html/vendor/mermaid.min.js";
const PREVIEW_RUNTIME_ASSET = "mermaid-runtime.js";

type CachedMermaidRuntimePreview =
  | Omit<Extract<MermaidRuntimeRenderArtifact, { kind: "ready" }>, "inline">
  | Omit<Extract<MermaidRuntimeRenderArtifact, { kind: "failed" }>, "inline">;

const renderCache = new Map<string, CachedMermaidRuntimePreview>();
const runtimeAssetCache = new Set<string>();

export function renderMermaidWithRuntime(input: {
  readonly source: string;
  readonly theme: SessionPalette;
  readonly terminal?: MermaidTerminalGraphicsProfile | null;
}): MermaidRuntimeRenderArtifact {
  const inline = resolveInlineArtifact(input.terminal);
  const cacheDir = resolvePreviewCacheDir();
  const sourceHash = hashPreviewInput(input.source, input.theme);
  const cacheKey = `${cacheDir}\0${sourceHash}`;
  const cached = renderCache.get(cacheKey);
  if (cached) {
    return { ...cached, inline };
  }

  const vendor = resolveMermaidVendorAsset();
  if (!vendor) {
    const artifact: CachedMermaidRuntimePreview = {
      kind: "failed",
      reason: "Bundled Mermaid runtime asset is unavailable.",
    };
    return { ...artifact, inline };
  }

  try {
    mkdirSync(cacheDir, { recursive: true });
    ensureMermaidRuntimeAsset(cacheDir, vendor);
    const filePath = join(cacheDir, `mermaid-${sourceHash}.html`);
    const html = buildMermaidRuntimePreviewHtml({
      source: input.source,
      theme: input.theme,
    });
    if (!existsSync(filePath) || readFileSync(filePath, "utf8") !== html) {
      writeFileSync(filePath, html);
    }
    const artifact: CachedMermaidRuntimePreview = {
      kind: "ready",
      sourceHash,
      preview: {
        kind: "browser-preview",
        filePath,
        displayPath: displayPathFor(filePath),
        url: pathToFileURL(filePath).href,
        renderer: "bundled-mermaid",
      },
    };
    renderCache.set(cacheKey, artifact);
    return { ...artifact, inline };
  } catch (error) {
    const artifact: CachedMermaidRuntimePreview = {
      kind: "failed",
      reason: toErrorMessage(error),
    };
    return { ...artifact, inline };
  }
}

export function clearMermaidRuntimeRenderCache(): void {
  renderCache.clear();
  runtimeAssetCache.clear();
}

export function mermaidTerminalGraphicsProfileFromOpenTui(
  capabilities: OpenTuiTerminalGraphicsCapabilities | null | undefined,
): MermaidTerminalGraphicsProfile {
  return {
    kittyGraphics: capabilities?.kitty_graphics === true,
    sixel: capabilities?.sixel === true,
  };
}

function resolveInlineArtifact(
  terminal: MermaidTerminalGraphicsProfile | null | undefined,
): MermaidInlineRenderArtifact {
  const hasGraphicsProtocol = terminal?.kittyGraphics === true || terminal?.sixel === true;
  if (hasGraphicsProtocol) {
    return {
      kind: "unavailable",
      reason: "renderer_backend_unavailable",
    };
  }
  return {
    kind: "unavailable",
    reason: "terminal_graphics_unavailable",
  };
}

function resolvePreviewCacheDir(): string {
  const configured = process.env[PREVIEW_CACHE_DIR_ENV]?.trim();
  if (configured) {
    return resolve(configured);
  }
  const workspaceCacheDir = resolve(process.cwd(), ".brewva", "mermaid-previews");
  try {
    mkdirSync(workspaceCacheDir, { recursive: true });
    return workspaceCacheDir;
  } catch {
    return join(tmpdir(), "brewva-mermaid-previews");
  }
}

function resolveMermaidVendorAsset(): string | undefined {
  const candidates = [
    resolve(import.meta.dirname, VENDOR_RELATIVE_TO_RUNTIME_SOURCE),
    join(dirname(process.execPath), VENDOR_RELATIVE_TO_DISTRIBUTION_BIN),
    resolve(process.cwd(), "packages/brewva-cli/runtime-assets/export-html/vendor/mermaid.min.js"),
    resolve(process.cwd(), VENDOR_RELATIVE_TO_DISTRIBUTION_BIN),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function ensureMermaidRuntimeAsset(cacheDir: string, vendorPath: string): void {
  const targetPath = join(cacheDir, PREVIEW_RUNTIME_ASSET);
  const cacheKey = `${cacheDir}\0${vendorPath}`;
  if (runtimeAssetCache.has(cacheKey) && existsSync(targetPath)) {
    return;
  }
  copyFileSync(vendorPath, targetPath);
  runtimeAssetCache.add(cacheKey);
}

function hashPreviewInput(source: string, theme: SessionPalette): string {
  return shortSha256Hex(
    [
      source,
      theme.background,
      theme.backgroundPanel,
      theme.backgroundElement,
      theme.text,
      theme.textMuted,
      theme.accent,
      theme.borderSubtle,
    ].join("\0"),
    20,
  );
}

function displayPathFor(filePath: string): string {
  const relativePath = relative(process.cwd(), filePath);
  if (!relativePath.startsWith("..") && !isAbsolute(relativePath)) {
    return relativePath;
  }
  return filePath;
}

function buildMermaidRuntimePreviewHtml(input: {
  readonly source: string;
  readonly theme: SessionPalette;
}): string {
  const cssVariables = safeScriptJson({
    "--brewva-bg": input.theme.background,
    "--brewva-panel": input.theme.backgroundPanel,
    "--brewva-text": input.theme.text,
    "--brewva-muted": input.theme.textMuted,
    "--brewva-accent": input.theme.accent,
    "--brewva-border": input.theme.borderSubtle,
  });
  const themeVariables = safeScriptJson({
    background: input.theme.background,
    mainBkg: input.theme.backgroundPanel,
    primaryColor: input.theme.backgroundPanel,
    primaryTextColor: input.theme.text,
    primaryBorderColor: input.theme.borderSubtle,
    lineColor: input.theme.accent,
    secondaryColor: input.theme.backgroundElement,
    tertiaryColor: input.theme.background,
    textColor: input.theme.text,
    noteTextColor: input.theme.text,
    noteBkgColor: input.theme.backgroundElement,
    noteBorderColor: input.theme.borderSubtle,
    edgeLabelBackground: input.theme.background,
  });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Brewva Mermaid Preview</title>
  <style>
    :root {
      color-scheme: dark;
      --brewva-bg: #0b0f14;
      --brewva-panel: #101820;
      --brewva-text: #e6edf3;
      --brewva-muted: #8b949e;
      --brewva-accent: #58a6ff;
      --brewva-border: #30363d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--brewva-bg);
      color: var(--brewva-text);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    main {
      width: min(1200px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 24px 0;
    }
    header {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 14px;
      color: var(--brewva-muted);
    }
    header strong { color: var(--brewva-text); font-weight: 650; }
    .diagram-shell {
      overflow: auto;
      border: 1px solid var(--brewva-border);
      background: var(--brewva-panel);
      padding: 18px;
    }
    .brewva-mermaid {
      min-width: max-content;
    }
    .brewva-mermaid svg {
      max-width: none;
      height: auto;
      display: block;
    }
    .status {
      margin-top: 12px;
      color: var(--brewva-muted);
      white-space: pre-wrap;
    }
    .failed {
      color: var(--brewva-text);
      white-space: pre-wrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <strong>Mermaid preview</strong>
      <span>Rendered by Brewva's bundled Mermaid runtime</span>
    </header>
    <section class="diagram-shell">
      <div id="brewva-mermaid-diagram" class="mermaid brewva-mermaid">${escapeHtml(input.source)}</div>
      <pre id="brewva-mermaid-source" hidden>${escapeHtml(input.source)}</pre>
      <div id="brewva-mermaid-status" class="status" aria-live="polite">Rendering diagram...</div>
    </section>
  </main>
  <script src="./${PREVIEW_RUNTIME_ASSET}"></script>
  <script>
    const cssVariables = ${cssVariables};
    const themeVariables = ${themeVariables};
    const diagram = document.getElementById("brewva-mermaid-diagram");
    const source = document.getElementById("brewva-mermaid-source");
    const status = document.getElementById("brewva-mermaid-status");

    for (const [name, value] of Object.entries(cssVariables)) {
      document.documentElement.style.setProperty(name, String(value));
    }

    async function renderMermaidPreview() {
      if (!globalThis.mermaid) {
        throw new Error("Mermaid runtime did not initialize.");
      }
      globalThis.mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: "base",
        themeVariables,
      });
      await globalThis.mermaid.run({ nodes: [diagram] });
      status.textContent = "Rendered with bundled Mermaid runtime.";
    }

    renderMermaidPreview().catch((error) => {
      diagram.classList.add("failed");
      diagram.textContent = source.textContent;
      status.textContent = "Mermaid rendering failed: " + (error && error.message ? error.message : String(error));
    });
  </script>
</body>
</html>
`;
}

function safeScriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("</", "<\\/");
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
