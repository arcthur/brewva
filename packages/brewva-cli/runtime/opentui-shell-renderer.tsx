/** @jsxImportSource @opentui/solid */

import { resolveAutomaticTuiTheme } from "@brewva/brewva-tui";
import type { OpenTuiRenderer } from "@brewva/brewva-tui/internal-opentui-runtime";
import {
  createOpenTuiCliRenderer,
  getOpenTuiTerminalBackgroundMode,
} from "@brewva/brewva-tui/internal-opentui-runtime";
import {
  getExternalPagerCommand,
  openExternalEditorWithShell,
  openExternalPagerWithShell,
} from "../src/io/external-process.js";
import { CliShellRuntime } from "../src/shell/controller/shell-runtime.js";
import type { CliShellRuntimeOptions } from "../src/shell/controller/shell-runtime.js";
import type { CliShellSessionBundle } from "../src/shell/ports/session-port.js";
import { render } from "./opentui/index.js";
import { BrewvaOpenTuiShell } from "./shell/app.js";
import { copyTextToClipboard } from "./shell/clipboard.js";
import { createToolRenderCache, type ToolRenderCache } from "./shell/tool-render.js";
import { renderCliTranscriptScrollbackLines } from "./shell/transcript-scrollback.js";

export { BrewvaOpenTuiShell } from "./shell/app.js";

class CliInteractiveOpenTuiShellRuntime {
  #renderer: OpenTuiRenderer | undefined;
  readonly #toolRenderCache: ToolRenderCache = createToolRenderCache();

  constructor(private readonly shellRuntime: CliShellRuntime) {}

  async run(): Promise<void> {
    const automaticTheme = resolveAutomaticTuiTheme(await getOpenTuiTerminalBackgroundMode());
    this.shellRuntime.ui.setTheme(automaticTheme.name);
    await this.mount();
    await this.shellRuntime.start();
    try {
      await this.shellRuntime.waitForExit();
    } finally {
      this.shellRuntime.dispose();
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

  async openExternalTranscriptPager(): Promise<boolean> {
    const width = Math.max(40, (this.#renderer?.width ?? process.stdout.columns ?? 120) - 4);
    const lines = await renderCliTranscriptScrollbackLines({ runtime: this.shellRuntime, width });
    if (lines.length === 0) {
      this.shellRuntime.ui.notify("The current session transcript is empty.", "info");
      return true;
    }
    const pager = getExternalPagerCommand();
    if (!pager) {
      return false;
    }
    this.unmount();
    try {
      return await openExternalPagerWithShell(
        pager,
        `Transcript ${this.shellRuntime.getSessionIdentity().sessionId}`,
        lines,
      );
    } finally {
      await this.mount();
    }
  }

  async copyTextToClipboard(text: string): Promise<void> {
    await copyTextToClipboard(text, { renderer: this.#renderer });
  }

  private async mount(): Promise<void> {
    this.#renderer = await createOpenTuiCliRenderer();
    await render(
      () => (
        <BrewvaOpenTuiShell
          runtime={this.shellRuntime}
          renderer={this.#renderer}
          toolRenderCache={this.#toolRenderCache}
        />
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
  options: Omit<CliShellRuntimeOptions, "openExternalEditor" | "openExternalPager">,
): Promise<void> {
  let interactiveRuntime: CliInteractiveOpenTuiShellRuntime | undefined;
  const shellRuntime = new CliShellRuntime(bundle, {
    ...options,
    async openExternalEditor(title, prefill) {
      return await interactiveRuntime?.openExternalEditor(title, prefill);
    },
    async openExternalPager(title, lines) {
      return (await interactiveRuntime?.openExternalPager(title, lines)) ?? false;
    },
    async openExternalTranscriptPager() {
      return (await interactiveRuntime?.openExternalTranscriptPager()) ?? false;
    },
    async copyTextToClipboard(text) {
      await (interactiveRuntime?.copyTextToClipboard(text) ?? copyTextToClipboard(text));
    },
  });
  interactiveRuntime = new CliInteractiveOpenTuiShellRuntime(shellRuntime);
  await interactiveRuntime.run();
}
