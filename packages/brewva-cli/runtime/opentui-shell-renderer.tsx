/** @jsxImportSource @opentui/solid */

import { resolveAutomaticTuiTheme } from "@brewva/brewva-tui";
import type { OpenTuiRenderer } from "@brewva/brewva-tui/internal-opentui-runtime";
import {
  createOpenTuiCliRenderer,
  getOpenTuiTerminalBackgroundMode,
} from "@brewva/brewva-tui/internal-opentui-runtime";
import { render } from "@opentui/solid";
import {
  getExternalPagerCommand,
  openExternalEditorWithShell,
  openExternalPagerWithShell,
} from "../src/external-process.js";
import { CliShellController } from "../src/shell/controller.js";
import type { CliShellControllerOptions } from "../src/shell/controller.js";
import type { CliShellSessionBundle } from "../src/shell/types.js";
import { BrewvaOpenTuiShell } from "./shell/app.js";
import { createToolRenderCache, type ToolRenderCache } from "./shell/tool-render.js";

export { BrewvaOpenTuiShell } from "./shell/app.js";

class CliInteractiveOpenTuiShellRuntime {
  #renderer: OpenTuiRenderer | undefined;
  readonly #toolRenderCache: ToolRenderCache = createToolRenderCache();

  constructor(private readonly controller: CliShellController) {}

  async run(): Promise<void> {
    const automaticTheme = resolveAutomaticTuiTheme(await getOpenTuiTerminalBackgroundMode());
    this.controller.ui.setTheme(automaticTheme.name);
    await this.mount();
    await this.controller.start();
    try {
      await this.controller.waitForExit();
    } finally {
      this.controller.dispose();
      this.#toolRenderCache.clear();
      this.unmount();
    }
  }

  async openExternalEditor(title: string, prefill?: string): Promise<string | undefined> {
    const editor = process.env.VISUAL ?? process.env.EDITOR;
    if (!editor) {
      return prefill;
    }
    this.unmount();
    try {
      return await openExternalEditorWithShell(editor, title, prefill);
    } finally {
      await this.mount();
    }
  }

  async openExternalPager(title: string, lines: readonly string[]): Promise<boolean> {
    const pager = getExternalPagerCommand();
    if (!pager) {
      return false;
    }
    this.unmount();
    try {
      return await openExternalPagerWithShell(pager, title, lines);
    } finally {
      await this.mount();
    }
  }

  private async mount(): Promise<void> {
    this.#renderer = await createOpenTuiCliRenderer();
    await render(
      () => (
        <BrewvaOpenTuiShell controller={this.controller} toolRenderCache={this.#toolRenderCache} />
      ),
      this.#renderer as never,
    );
  }

  private unmount(): void {
    this.#renderer?.destroy();
    this.#renderer = undefined;
  }
}

export async function renderCliInteractiveOpenTuiShell(
  bundle: CliShellSessionBundle,
  options: Omit<CliShellControllerOptions, "openExternalEditor" | "openExternalPager">,
): Promise<void> {
  let runtime: CliInteractiveOpenTuiShellRuntime | undefined;
  const controller = new CliShellController(bundle, {
    ...options,
    async openExternalEditor(title, prefill) {
      return await runtime?.openExternalEditor(title, prefill);
    },
    async openExternalPager(title, lines) {
      return (await runtime?.openExternalPager(title, lines)) ?? false;
    },
  });
  runtime = new CliInteractiveOpenTuiShellRuntime(controller);
  await runtime.run();
}
