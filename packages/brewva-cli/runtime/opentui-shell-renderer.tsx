/** @jsxImportSource @opentui/solid */

import {
  installDiagnosticErrorCapture,
  recordDiagnosticError,
} from "../src/internal/perf-trace.js";
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
  createOpenTuiSplitFooterRenderer,
  getOpenTuiTerminalBackgroundMode,
  shutdownSplitFooterRenderer,
  startOpenTuiStatsCapture,
} from "./internal-opentui-runtime.js";
import { render } from "./opentui/index.js";
import { BrewvaOpenTuiShell } from "./shell/app.js";
import { copyTextToClipboard } from "./shell/clipboard.js";
import { SplitFooterScrollbackWriter } from "./shell/split-footer-scrollback-writer.js";
import { renderCliTranscriptScrollbackLines } from "./shell/transcript-scrollback.js";

export { BrewvaOpenTuiShell } from "./shell/app.js";

/**
 * Runtime host for the Brewva interactive shell. Uses the split-footer renderer
 * (createOpenTuiSplitFooterRenderer / shutdownSplitFooterRenderer): the
 * transcript is committed to the renderer's native scrollback (no per-frame
 * transcript repaint -> no streaming flicker), while only the footer
 * (BrewvaOpenTuiShell — composer + status + overlays) stays live in the
 * rendered tree.
 *
 *  - mounts the footer-only BrewvaOpenTuiShell; the transcript is NOT rendered
 *    into the live tree — it is committed to the renderer's native scrollback by
 *    a SplitFooterScrollbackWriter;
 *  - subscribes to the runtime store and drives a scrollback sync on every
 *    change (plus one initial sync after mount + start so a seeded transcript
 *    commits immediately).
 */
class CliInteractiveOpenTuiShellRuntime {
  #renderer: OpenTuiRenderer | undefined;
  #stopStatsCapture: (() => void) | undefined;
  #unsubscribe: (() => void) | undefined;
  readonly #orchestrator = new SplitFooterScrollbackWriter();

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
    // Splash: on a fresh empty session, anchor the footer with a one-shot banner
    // so stale terminal content above it is replaced by clean session context
    // (commitSplashBanner is a no-op for a non-empty/restored transcript).
    this.commitSplashBanner();
    // Initial sync: commit whatever the seeded transcript already contains
    // (start() may have hydrated a restored session) before any change fires.
    this.requestScrollbackSync();
    try {
      await this.shellRuntime.waitForExit();
    } finally {
      this.shellRuntime.dispose();
      await this.unmount();
    }
  }

  async openExternalEditor(title: string, prefill?: string): Promise<string | undefined> {
    const editor = process.env.VISUAL ?? process.env.EDITOR;
    if (!editor) {
      return prefill;
    }
    // Await unmount so the in-flight sync drains and the OLD renderer is fully
    // torn down BEFORE the external editor takes the terminal — and before the
    // finally-block mounts a NEW renderer (FIX A: otherwise a stale drain pass
    // could resume holding the destroyed OLD renderer in its closure).
    //
    // preserveWriterState (P1-2): the editor draws on the alt screen, so on exit
    // the committed transcript is still in native scrollback. Suspend (not reset)
    // the writer so the remount's first sync resumes from the preserved cursor
    // instead of re-committing the whole transcript below the rows already there.
    await this.unmount({ preserveWriterState: true });
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
    await this.unmount({ preserveWriterState: true });
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
    await this.unmount({ preserveWriterState: true });
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

  /**
   * Drive one scrollback reconcile pass. Fire-and-forget: SplitFooterScrollback
   * Writer serializes overlapping calls (coalescing into a single trailing
   * re-run), so rapid store changes during streaming never overlap commits.
   */
  private requestScrollbackSync(): void {
    const renderer = this.#renderer;
    if (!renderer) {
      return;
    }
    // Fire-and-forget, but route any rejection to the diagnostic log instead of
    // leaving an unhandled rejection (defense in depth — the dispose-guard in the
    // writer + the awaited unmount are the real teardown-race fix; this catches
    // any other unexpected sync failure so it never crashes the shell).
    this.#orchestrator
      .sync({
        renderer,
        runtime: this.shellRuntime,
        width: renderer.width,
      })
      .catch((error: unknown) => {
        recordDiagnosticError(
          "scrollbackSync",
          error instanceof Error ? error.message : String(error),
          error instanceof Error ? error.stack : undefined,
        );
      });
  }

  /**
   * Commit the one-shot splash banner for a fresh empty session. The
   * orchestrator no-ops if the transcript is non-empty or the banner already
   * fired, so this is safe to call unconditionally in the initial-sync path.
   */
  private commitSplashBanner(): void {
    const renderer = this.#renderer;
    if (!renderer) {
      return;
    }
    this.#orchestrator.commitSplashBanner({
      renderer,
      runtime: this.shellRuntime,
      width: renderer.width,
    });
  }

  private async mount(): Promise<void> {
    // Start with a usable footer height so the composer is not clipped to a
    // sliver before the footer-height router (BrewvaOpenTuiShell) measures the
    // real content height on the first frame and fine-tunes it.
    this.#renderer = await createOpenTuiSplitFooterRenderer({ footerHeight: 8 });
    this.#stopStatsCapture = startOpenTuiStatsCapture(this.#renderer);
    await render(
      () => (
        <BrewvaOpenTuiShell
          runtime={this.shellRuntime}
          renderer={this.#renderer}
          copyTextToClipboard={(text) => this.copyTextToClipboard(text)}
        />
      ),
      this.#renderer as never,
    );
    // Subscribe AFTER mount so the first change already has a live renderer to
    // commit against. The transcript lives in native scrollback, so every store
    // change must trigger a reconcile pass.
    this.#unsubscribe = this.shellRuntime.subscribe(() => this.requestScrollbackSync());
  }

  /**
   * Tear down the live renderer. By default this fully `reset()`s the scrollback
   * writer (new-session semantics: the next mount replays the log from the
   * start). The external-editor / pager paths pass `preserveWriterState: true`
   * so the writer is `suspend()`ed instead — it keeps its drain cursor + de-dup
   * state so the post-editor remount resumes forward instead of re-committing the
   * transcript that is still in native scrollback (the P1-2 fix).
   */
  private async unmount(opts?: { preserveWriterState?: boolean }): Promise<void> {
    // Unsubscribe FIRST so no further store change can fire a new scrollback
    // sync while we drain + tear down.
    this.#unsubscribe?.();
    this.#unsubscribe = undefined;
    this.#stopStatsCapture?.();
    this.#stopStatsCapture = undefined;
    // Teardown-race guard (FIX A): await any in-flight (fire-and-forget) sync so
    // the suspended drain pass completes — or, once reset()/suspend() latches
    // dispose, bails — against the STILL-ALIVE renderer. Without this await,
    // reset()/suspend() + shutdownSplitFooterRenderer would destroy the renderer
    // while a pass is suspended inside entry.update()/surface.settle(); the
    // resumed pass would then throw inside writeToScrollback/
    // createScrollbackSurface (unhandled rejection). whenIdle() resolves even if
    // the in-flight pass rejected.
    try {
      await this.#orchestrator.whenIdle();
    } catch {
      // A pre-existing in-flight rejection is already routed to diagnostics by
      // requestScrollbackSync; swallow here so teardown always proceeds.
    }
    // Suspend/reset the orchestrator BEFORE tearing down the renderer: both
    // latch dispose and destroy any in-flight streaming entry (which holds
    // renderer-backed resources) while the renderer is still alive. suspend()
    // additionally PRESERVES the cursor + de-dup state (external-editor path);
    // reset() clears it (new-session path).
    if (opts?.preserveWriterState) {
      this.#orchestrator.suspend();
    } else {
      this.#orchestrator.reset();
    }
    const renderer = this.#renderer;
    this.#renderer = undefined;
    if (renderer) {
      shutdownSplitFooterRenderer(renderer);
    }
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
