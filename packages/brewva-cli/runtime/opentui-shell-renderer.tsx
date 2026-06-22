/** @jsxImportSource @opentui/solid */

import { installDiagnosticErrorCapture } from "../src/internal/perf-trace.js";
import { resolveAutomaticTuiTheme } from "../src/internal/tui/index.js";
import {
  getExternalPagerCommand,
  openExternalEditorWithShell,
  openExternalPagerWithShell,
} from "../src/io/external-process.js";
import { CliShellRuntime } from "../src/shell/controller/shell-runtime.js";
import type { CliShellRuntimeOptions } from "../src/shell/controller/shell-runtime.js";
import type { CliShellSessionBundle } from "../src/shell/ports/session-port.js";
import type { OpenTuiRenderer } from "./internal-opentui-runtime.js";
import {
  createOpenTuiCliRenderer,
  getOpenTuiTerminalBackgroundMode,
  startOpenTuiStatsCapture,
} from "./internal-opentui-runtime.js";
import { render } from "./opentui/index.js";
import { copyTextToClipboard } from "./shell/clipboard.js";
import { BrewvaFullScreenShell } from "./shell/fullscreen-app.js";
import { createToolRenderCache, type ToolRenderCache } from "./shell/tool-render.js";
import { renderCliTranscriptScrollbackLines } from "./shell/transcript-scrollback.js";

export { BrewvaFullScreenShell } from "./shell/fullscreen-app.js";

/**
 * Runtime host for the Brewva interactive shell. Uses the full-screen
 * alternate-screen renderer (createOpenTuiCliRenderer): the whole shell —
 * transcript scrollbox + composer + overlays — renders live in the alt screen.
 *
 * Streaming markdown renders incrementally via @opentui's native
 * `<markdown streaming internalBlockMode="top-level">` inside a declaratively
 * bottom-stuck scrollbox.
 */
class CliInteractiveOpenTuiShellRuntime {
  #renderer: OpenTuiRenderer | undefined;
  #stopStatsCapture: (() => void) | undefined;
  // Runtime-owned so tool expand/collapse state survives the unmount/remount
  // around an external editor or pager.
  readonly #toolRenderCache: ToolRenderCache = createToolRenderCache();

  constructor(private readonly shellRuntime: CliShellRuntime) {}

  async run(): Promise<void> {
    const configuredTheme = this.shellRuntime.getTuiConfig().theme;
    if (configuredTheme === "auto") {
      const automaticTheme = resolveAutomaticTuiTheme(await getOpenTuiTerminalBackgroundMode());
      this.shellRuntime.ui.setTheme(automaticTheme.name);
    } else {
      this.shellRuntime.ui.setTheme(configuredTheme);
    }
    await this.mount();
    await this.shellRuntime.start();
    try {
      await this.shellRuntime.waitForExit();
    } finally {
      this.shellRuntime.dispose();
      this.unmount();
    }
  }

  async openExternalEditor(title: string, prefill?: string): Promise<string | undefined> {
    const editor = process.env.VISUAL ?? process.env.EDITOR;
    if (!editor) {
      return prefill;
    }
    // Tear the alt-screen renderer down before the external editor takes the
    // terminal, then remount fresh on return. The full-screen shell re-renders
    // the whole transcript from the live store, so there is no native-scrollback
    // state to preserve across the round-trip.
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
    this.#stopStatsCapture = startOpenTuiStatsCapture(this.#renderer);
    await render(
      () => (
        <BrewvaFullScreenShell
          runtime={this.shellRuntime}
          renderer={this.#renderer}
          toolRenderCache={this.#toolRenderCache}
          copyTextToClipboard={(text) => this.copyTextToClipboard(text)}
        />
      ),
      this.#renderer as never,
    );
  }

  private unmount(): void {
    this.#stopStatsCapture?.();
    this.#stopStatsCapture = undefined;
    this.#renderer?.destroy();
    this.#renderer = undefined;
  }
}

export async function renderCliInteractiveOpenTuiShell(
  bundle: CliShellSessionBundle,
  options: Omit<CliShellRuntimeOptions, "openExternalEditor" | "openExternalPager">,
): Promise<void> {
  installDiagnosticErrorCapture();
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
