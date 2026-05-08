import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import type { BrewvaBundledToolOptions } from "../../../contracts/index.js";
import { createBrowserClickTool } from "./tools/click.js";
import { createBrowserCloseTool } from "./tools/close.js";
import { createBrowserDiffSnapshotTool } from "./tools/diff-snapshot.js";
import { createBrowserFillTool } from "./tools/fill.js";
import { createBrowserGetTool } from "./tools/get.js";
import { createBrowserOpenTool } from "./tools/open.js";
import { createBrowserPdfTool } from "./tools/pdf.js";
import { createBrowserScreenshotTool } from "./tools/screenshot.js";
import { createBrowserSnapshotTool } from "./tools/snapshot.js";
import { createBrowserStateLoadTool } from "./tools/state-load.js";
import { createBrowserStateSaveTool } from "./tools/state-save.js";
import { createBrowserWaitTool } from "./tools/wait.js";
import type { BrowserToolDeps } from "./types.js";

export type { BrowserToolDeps } from "./types.js";

export function createBrowserTools(
  options: BrewvaBundledToolOptions,
  deps: BrowserToolDeps = {},
): ToolDefinition[] {
  return [
    createBrowserOpenTool(options, deps),
    createBrowserWaitTool(options, deps),
    createBrowserSnapshotTool(options, deps),
    createBrowserClickTool(options, deps),
    createBrowserFillTool(options, deps),
    createBrowserGetTool(options, deps),
    createBrowserScreenshotTool(options, deps),
    createBrowserPdfTool(options, deps),
    createBrowserDiffSnapshotTool(options, deps),
    createBrowserStateLoadTool(options, deps),
    createBrowserStateSaveTool(options, deps),
    createBrowserCloseTool(options, deps),
  ];
}
