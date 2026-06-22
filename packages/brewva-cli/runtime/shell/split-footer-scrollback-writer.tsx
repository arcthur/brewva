/** @jsxImportSource @opentui/solid */

import type { BrewvaToolDefinition } from "@brewva/brewva-substrate/tools";
import { recordDiagnosticError } from "../../src/internal/perf-trace.js";
import type { ShellRendererController } from "../../src/shell/domain/renderer-contract.js";
import {
  deriveLogicalId,
  type ScrollbackCommit,
  type ScrollbackCommitCursor,
} from "../../src/shell/domain/scrollback/commit.js";
import {
  isStreamingMessage,
  type CliShellTranscriptMessage,
} from "../../src/shell/domain/transcript.js";
import type { OpenTuiRenderer, SplitFooterRenderer } from "../internal-opentui-runtime.js";
import { commitSolidToScrollback } from "../internal-opentui-runtime.js";
import { createPalette, getTranscriptSyntaxStyle, type SessionPalette } from "./palette.js";
import { buildShellRenderContext, ShellRenderProvider } from "./render-context.js";
import { StreamingScrollbackEntry } from "./streaming-scrollback-entry.js";
import { createToolRenderCache, type ToolRenderCache } from "./tool-render.js";
import { AssistantLabelLine, TranscriptMessageView } from "./transcript.js";

interface ActiveStreamingEntry {
  readonly messageId: string;
  readonly entry: StreamingScrollbackEntry;
  /**
   * The theme name in effect when the entry was created. Used to detect a
   * mid-stream theme switch so the live renderable can be recolored in place
   * (FIX 4); already-committed scrollback rows are immutable.
   */
  themeName: string;
}

/**
 * Commit a single blank scrollback row. Mirrors the `marginTop={1}` that settled
 * TranscriptMessageViews carry, so the first streamed block does not butt
 * against the preceding committed message (opencode parity: flushPendingSpacer).
 */
function commitSpacerRow(renderer: OpenTuiRenderer, width: number): void {
  commitSolidToScrollback(renderer, () => <box height={1} />, { width });
}

/**
 * Whether the renderer has been torn down. After teardown
 * (shutdownSplitFooterRenderer flips externalOutputMode -> "passthrough" and
 * screenMode -> "main-screen" then destroys), writeToScrollback /
 * createScrollbackSurface THROW — so a drain pass that resumed post-teardown
 * must bail before touching the renderer. The runtime CliRenderer exposes
 * `isDestroyed` (declared on SplitFooterRenderer); a renderer that does not
 * surface it (test doubles) is treated as alive.
 */
function isRendererDestroyed(renderer: OpenTuiRenderer): boolean {
  return (renderer as Partial<SplitFooterRenderer>).isDestroyed === true;
}

/**
 * The CliRenderer members the session-switch replay boundary drives that neither
 * the minimal {@link OpenTuiRenderer} nor {@link SplitFooterRenderer} declares
 * (they intentionally stay free of OpenTUI-owned types). All three are plain
 * primitive/promise callbacks, so a local structural cast keeps the OpenTUI
 * import quarantine intact (this module already casts the same way for
 * `isDestroyed` / `writeToScrollback`):
 *
 *  - `idle`: resolve once the renderer has flushed pending split-footer frames,
 *    so the clear lands on a settled frame (opencode parity: await footer idle).
 *  - `resetSplitFooterForReplay`: clear the native scrollback (+ the terminal's
 *    saved scrollback lines when `clearSavedLines`) so a NEW session REPLACES the
 *    old one instead of appending below it. Available in @opentui/core 0.4.1.
 *  - `requestRender`: schedule a repaint after the boundary (defensive; the
 *    native reset already requests one).
 */
interface ReplayCapableRenderer {
  idle(): Promise<void>;
  resetSplitFooterForReplay(options?: { clearSavedLines?: boolean }): void;
  requestRender(): void;
}

function asReplayCapable(renderer: OpenTuiRenderer): ReplayCapableRenderer {
  return renderer as unknown as ReplayCapableRenderer;
}

/**
 * Commit the `▣ <assistantLabel> · <model>` header row for a streamed assistant
 * message, matching the label box AssistantMessageView renders for a settled
 * assistant message. Committed once, when the streamed message settles, so the
 * streamed-message scrollback layout = [streamed blocks][label row].
 */
function commitAssistantLabelRow(input: {
  renderer: OpenTuiRenderer;
  width: number;
  theme: SessionPalette;
  assistantLabel: string;
  modelLabel: string;
}): void {
  const { renderer, width, theme, assistantLabel, modelLabel } = input;
  commitSolidToScrollback(
    renderer,
    () => (
      <box paddingLeft={3}>
        <AssistantLabelLine theme={theme} assistantLabel={assistantLabel} modelLabel={modelLabel} />
      </box>
    ),
    { width },
  );
}

/**
 * The single text part's text for an assistant `progress` commit. The projector
 * emits one growing text message per turn answer (`updateTranscriptAssistantDelta`
 * keys by turn+attempt), so the renderable text is the first non-empty text
 * part. Mirrors TextPartView, which renders `part.text.trim()`.
 */
function readCommitText(message: CliShellTranscriptMessage): string {
  for (const part of message.parts) {
    if (part.type === "text" && part.text.trim().length > 0) {
      return part.text;
    }
  }
  return "";
}

/**
 * Orchestrates committing the transcript to the split-footer renderer's native
 * scrollback, driven by the append-only scrollback COMMIT LOG (P2-2: no
 * O(history x updates) rescan) keyed by a STABLE logical id (P1-1: a turn's
 * streamed answer and its committed re-segmentation collapse to one logical id,
 * so the committed replay is never double-written).
 *
 * Two cooperating inputs per pass:
 *
 *  - The commit cursor (`runtime.peekScrollbackCommits`) is the spine: it drives
 *    the in-flight streaming entry (`assistant`/`progress`), the finish-on-final
 *    + label, and the three de-dup branches. This is the only path that streams
 *    a live answer, via a StreamingScrollbackEntry (stable blocks commit
 *    incrementally; the unstable trailing block stays live -> no flicker).
 *
 *  - A bounded settled SWEEP renders the transcript messages that the commit log
 *    never carries: seed / user / note / system messages (injected OUTSIDE the
 *    wire-fold projector) and hydrated wire history (loaded via snapshot on
 *    session open, which emits no commits). The sweep is high-water-marked so it
 *    is O(newly-settled), never O(history); the live answer hot path never
 *    touches it. A message already committed (or whose logical id was streamed)
 *    is skipped, so the sweep and the commit drain never double-render.
 *
 * Holds its own ToolRenderCache (component-identity continuity across frames).
 * `sync` calls are serialized: a call arriving while another is in flight
 * coalesces into a single trailing re-run after the current one completes.
 */
export class SplitFooterScrollbackWriter {
  private toolRenderCache: ToolRenderCache;

  /**
   * Active streaming entries keyed by the streamed message id. The verified
   * protocol streams a turn's whole answer as ONE growing message, so this holds
   * at most one entry per in-flight turn; the map shape tolerates the general
   * case without special-casing.
   */
  private readonly entries = new Map<string, ActiveStreamingEntry>();
  /** Message ids already committed to scrollback (drain final-path OR sweep). */
  private readonly committedMessageIds = new Set<string>();
  /**
   * Logical ids whose answer a streaming entry already wrote to scrollback. A
   * `final` for a DIFFERENT message id but the SAME logical id is the committed
   * re-segmentation of an already-streamed turn -> skipped (the P1-1 fix).
   */
  private readonly streamedLogicalIds = new Set<string>();
  /** Cursor into the append-only commit log; advanced ONLY after a commit is processed (P2-1). */
  private cursor: ScrollbackCommitCursor = undefined;
  /** Session generation observed last; a change means the log was reset (new session). */
  private lastEpoch: number | undefined;
  /**
   * Rewind generation observed last; a change WITHOUT an epoch change means an
   * in-place rewind / redo / undo happened (same session, same log, abandoned
   * commits still in the log behind the cursor). The writer then clears native
   * scrollback and SKIPS the abandoned commits (advancing the cursor to the log
   * tail) instead of replaying the log from the start.
   */
  private lastRewindGeneration: number | undefined;
  /**
   * High-water mark into `transcript.messages` for the settled sweep. This is an
   * OPTIMIZATION, not the correctness mechanism: it keeps the streaming-time sweep
   * O(1) (load-bearing for P2-2 — during a stream the mark sits at the live tail,
   * so the sweep finds nothing new). Correctness is enforced by
   * `committedMessageIds`: a re-scanned message is skipped, never doubled.
   * `refreshFromWireFold` rebuilds messages as `[non-wire] ++ [wire]` — the wire
   * suffix is append-stable, while the non-wire prefix (seed / user / rewind /
   * system, injected outside the fold) is swept before the next wire rebuild by
   * emit ordering. Future-change invariant: a non-wire message must be swept
   * before the mark advances past its index, else it would be stranded.
   */
  private settledScanIndex = 0;

  // Whether ANY content has been committed to scrollback this session (settled
  // message, streamed label, spacer, or splash banner). Gates the leading
  // spacer so the very first scrollback content is never preceded by a blank.
  private hasCommittedContent = false;
  // Whether the one-shot splash banner was already committed this session.
  private splashCommitted = false;

  // Test/diagnostic counters for the one-shot scrollback rows the writer commits
  // directly (outside the per-message settled path). Deterministic and cheap —
  // same philosophy as StreamingScrollbackEntry's committedBlocks getter.
  private labelCommits = 0;
  private spacerCommits = 0;
  private bannerCommits = 0;
  // Number of native-scrollback replay-boundary clears performed (one per session
  // switch / epoch change OR per in-place rewind / redo / undo). Observable so a
  // test can assert the boundary fires on a session switch or a rewind and NOT on
  // a plain streaming sync or an editor suspend.
  private replayBoundaryClears = 0;

  // Serialization state: a single run loop coalesces concurrent sync requests
  // into one trailing re-run. `currentRun` is the in-flight loop promise so
  // coalesced callers (and whenIdle) can await the final settled count.
  private syncRunning = false;
  private syncPending = false;
  private currentRun: Promise<number> = Promise.resolve(0);

  // Dispose latch (teardown-race guard). `reset()` sets it; a sync pass suspended
  // inside an `await` (entry.update / surface.settle / finish) re-checks it (and
  // renderer liveness) after each await and early-returns so a pass that resumes
  // AFTER the host tore down the renderer never touches a dead renderer (which
  // would throw -> unhandled rejection). Re-armed (cleared) at the top of `sync`
  // so a remount after reset (e.g. external-editor return) can sync again.
  private disposed = false;

  constructor() {
    this.toolRenderCache = createToolRenderCache();
  }

  /** Number of one-shot assistant-label rows committed for streamed messages. */
  get committedLabelCount(): number {
    return this.labelCommits;
  }

  /** Number of leading spacer rows committed before streaming entries. */
  get committedSpacerCount(): number {
    return this.spacerCommits;
  }

  /** Number of splash banner rows committed (0 or 1 per session). */
  get committedBannerCount(): number {
    return this.bannerCommits;
  }

  /**
   * Number of native-scrollback replay-boundary clears performed (one per epoch
   * change / session switch OR per in-place rewind / redo / undo). Stays 0 across
   * plain streaming syncs and an external-editor suspend, which must NOT clear
   * native scrollback.
   */
  get replayBoundaryClearCount(): number {
    return this.replayBoundaryClears;
  }

  /**
   * Orchestrate one reconcile pass: drain the commit cursor (streaming entries,
   * finals, de-dup), then sweep newly-settled non-commit transcript messages.
   *
   * Serialized into a single drain loop: only one pass runs at a time. A call
   * arriving while a pass is in flight coalesces into exactly one trailing
   * re-run after the current pass completes (so the live runtime can fire sync
   * rapidly without overlapping commits).
   *
   * The returned number is THIS call's own pass result — the count of settled
   * (final-path / sweep) messages committed by the pass it triggered (NOT
   * counting streaming-entry block commits). A coalesced call resolves with the
   * trailing drain run's count. Use `whenIdle()` to await the loop draining
   * completely.
   */
  async sync(input: {
    renderer: OpenTuiRenderer;
    runtime: ShellRendererController;
    /** Deprecated/ignored: each pass reads width LIVE from `renderer.width` (FIX B). */
    width?: number;
  }): Promise<number> {
    if (this.syncRunning) {
      // Coalesce: request exactly one trailing re-run; resolve with the count
      // of the drained loop (the trailing run reflects the latest state).
      this.syncPending = true;
      return this.currentRun;
    }

    // Leading edge of a fresh drain loop: re-arm the dispose latch so a sync
    // after a prior reset() (e.g. an external-editor remount) is live again.
    this.disposed = false;
    this.syncRunning = true;
    this.syncPending = false;

    // Run the first pass; capture its result so THIS call can return its own
    // pass count. The drain loop (assigned synchronously to `currentRun`)
    // continues with any coalesced trailing passes and resolves with the final
    // pass count for coalesced callers + whenIdle.
    let resolveFirst!: (count: number) => void;
    let rejectFirst!: (error: unknown) => void;
    const firstCount = new Promise<number>((resolve, reject) => {
      resolveFirst = resolve;
      rejectFirst = reject;
    });

    this.currentRun = (async () => {
      let lastCount = 0;
      let isFirstPass = true;
      try {
        do {
          this.syncPending = false;
          // eslint-disable-next-line no-await-in-loop
          lastCount = await this.runSyncOnce(input);
          if (isFirstPass) {
            resolveFirst(lastCount);
            isFirstPass = false;
          }
        } while (this.syncPending);
      } catch (error) {
        // A first-pass failure is surfaced to its caller via `firstCount`
        // (requestScrollbackSync routes it to diagnostics). A failure in a
        // COALESCED trailing pass has no caller-facing promise; resolving
        // `currentRun` (rather than rejecting) keeps whenIdle() and any coalesced
        // callers from observing an unhandled rejection. The dispose-guard means
        // a post-teardown resume early-returns rather than throws, so reaching
        // here at all is unexpected — fail soft, never crash the shell.
        if (isFirstPass) {
          rejectFirst(error);
          isFirstPass = false;
        }
      } finally {
        this.syncRunning = false;
      }
      return lastCount;
    })();

    return firstCount;
  }

  /**
   * Resolves once no sync is in flight (and any coalesced trailing run has
   * completed), yielding the final settled-commit count of the last pass.
   */
  whenIdle(): Promise<number> {
    return this.currentRun;
  }

  /**
   * Whether the current pass must abort before touching the renderer: the writer
   * was disposed (reset() during teardown) or the renderer itself is destroyed.
   * Checked after every `await` in a sync pass so a suspended pass that resumes
   * post-teardown bails instead of throwing inside writeToScrollback /
   * createScrollbackSurface against a dead renderer.
   */
  private shouldAbortPass(renderer: OpenTuiRenderer): boolean {
    return this.disposed || isRendererDestroyed(renderer);
  }

  /**
   * Finish a streaming entry (committing its remaining stable blocks), then
   * commit the assistant label row that a settled assistant message would carry.
   * The streamed message's final scrollback layout becomes
   * [streamed blocks][label row], matching a settled assistant message.
   *
   * Returns true if the label row was committed; false if the pass aborted
   * (teardown race) before committing it. The caller owns set/map bookkeeping.
   */
  private async finishEntryWithLabel(input: {
    renderer: OpenTuiRenderer;
    runtime: ShellRendererController;
    entry: ActiveStreamingEntry;
  }): Promise<boolean> {
    const { renderer, runtime, entry } = input;
    await entry.entry.finish();

    // Teardown-race guard (FIX A): finish() awaited surface.settle(); if the host
    // tore down the renderer meanwhile, bail before committing the label row
    // (which would throw against a dead renderer). The entry was already
    // destroyed by finish().
    if (this.shouldAbortPass(renderer)) {
      return false;
    }

    // Commit the `▣ <assistantLabel> · <model>` header so the streamed message
    // matches a settled assistant message's layout (FIX 2). Width is read LIVE
    // from the renderer (FIX B) so a mid-stream resize commits at the current
    // width.
    const sessionIdentity = runtime.getSessionIdentity();
    commitAssistantLabelRow({
      renderer,
      width: renderer.width,
      theme: createPalette(runtime.getViewState().theme),
      assistantLabel: sessionIdentity.assistantLabel,
      modelLabel: sessionIdentity.modelLabel,
    });
    this.labelCommits += 1;
    this.hasCommittedContent = true;
    return true;
  }

  /**
   * One orchestration pass: epoch check, commit drain, settled sweep. Returns
   * the count of settled (final-path drain + sweep) messages committed.
   */
  private async runSyncOnce(input: {
    renderer: OpenTuiRenderer;
    runtime: ShellRendererController;
  }): Promise<number> {
    const { renderer, runtime } = input;

    // Teardown-race guard (FIX A): a coalesced trailing pass may start after the
    // host disposed the writer / tore down the renderer. Bail before any commit.
    if (this.shouldAbortPass(renderer)) {
      return 0;
    }

    // 1. Replay boundaries. Two orthogonal signals ride on the peek, handled as
    //    two clearly-distinguished branches that SHARE the clear primitive
    //    (clearNativeScrollbackForReplay) but diverge on cursor handling:
    //
    //    1a. Epoch change (session switch / full re-hydrate): the per-session log
    //        was RESET (fresh, monotonic-from-0). Clear native scrollback, then
    //        replay the new log from the START (cursor -> undefined) so the new
    //        session REPLACES the old one instead of appending below it.
    //
    //    1b. Rewind generation change WITHOUT an epoch change (in-place rewind /
    //        redo / undo): the SAME log keeps its abandoned-branch commits behind
    //        the cursor. Clear native scrollback, then — UNLIKE the session switch
    //        — do NOT replay from undefined (that would re-drain the abandoned
    //        turns). Instead ADVANCE the cursor to the current log TAIL (skipping
    //        the abandoned commits) and re-render the now-shorter transcript
    //        purely via the settled SWEEP (settledScanIndex -> 0). New post-rewind
    //        turns append at higher seq and drain forward normally.
    let peek = runtime.peekScrollbackCommits(this.cursor);

    // Adopt the initial generations on the first pass (no prior session/branch to
    // replace), so the very first sync never fires a boundary.
    if (this.lastEpoch === undefined) {
      this.lastEpoch = peek.epoch;
    }
    if (this.lastRewindGeneration === undefined) {
      this.lastRewindGeneration = peek.rewindGeneration;
    }

    if (peek.epoch !== this.lastEpoch) {
      // 1a. Session switch: clear, then rebase cursor + sweep to the start.
      await this.clearNativeScrollbackForReplay({ renderer, runtime });
      // clearNativeScrollbackForReplay awaited renderer.idle(); a pass that
      // resumed after a teardown must bail before re-peeking against a dead renderer.
      if (this.shouldAbortPass(renderer)) {
        return 0;
      }
      this.cursor = undefined;
      this.settledScanIndex = 0;
      this.lastEpoch = peek.epoch;
      // An epoch change supersedes any concurrent rewind signal: the fresh log
      // replays in full, so adopt the rewind generation without a second clear.
      this.lastRewindGeneration = peek.rewindGeneration;
      peek = runtime.peekScrollbackCommits(this.cursor);
    } else if (peek.rewindGeneration !== this.lastRewindGeneration) {
      // 1b. In-place rewind / redo / undo: clear, then SKIP the abandoned commits
      //     by advancing the cursor to the current log tail. peek.cursor is the
      //     seq of the last commit currently in the log (or the un-advanced cursor
      //     when the log is empty), so adopting it leaves only genuinely-new
      //     post-rewind commits to drain. The shorter transcript re-renders via
      //     the sweep (settledScanIndex -> 0).
      await this.clearNativeScrollbackForReplay({ renderer, runtime });
      if (this.shouldAbortPass(renderer)) {
        return 0;
      }
      this.cursor = peek.cursor;
      this.settledScanIndex = 0;
      this.lastRewindGeneration = peek.rewindGeneration;
      // Re-peek from the advanced cursor: the abandoned commits are skipped, so
      // the slice now carries only post-rewind turns (typically none yet).
      peek = runtime.peekScrollbackCommits(this.cursor);
    }

    // 2. Drain the commit cursor: streaming entries + finals + de-dup. Two-phase
    //    ack — advance the cursor only AFTER a commit is processed.
    let settledCount = await this.drainCommits({ renderer, runtime, commits: peek.commits });
    if (this.shouldAbortPass(renderer)) {
      return settledCount;
    }

    // 3. Settled sweep: render newly-settled transcript messages the commit log
    //    never carries (seed/user/note/system + hydrated wire history).
    settledCount += this.sweepSettled({ renderer, runtime });

    return settledCount;
  }

  /**
   * Drain the commits in order. Re-checks the abort guard after every await so a
   * suspended drain that resumes post-teardown bails. Advances `this.cursor` to
   * a commit's `seq` ONLY after that commit is fully processed (P2-1): a thrown
   * or aborted commit does not skip-forward, so the next pass retries it.
   */
  private async drainCommits(input: {
    renderer: OpenTuiRenderer;
    runtime: ShellRendererController;
    commits: readonly ScrollbackCommit[];
  }): Promise<number> {
    const { renderer, runtime, commits } = input;
    let settledCount = 0;

    for (const commit of commits) {
      if (this.shouldAbortPass(renderer)) {
        // Do NOT advance the cursor: this commit was not processed.
        return settledCount;
      }

      if (commit.phase === "progress") {
        if (commit.kind === "assistant") {
          // eslint-disable-next-line no-await-in-loop
          await this.applyAssistantProgress({ renderer, runtime, commit });
          if (this.shouldAbortPass(renderer)) {
            return settledCount;
          }
        }
        // A running tool (or any non-assistant progress) renders live in the
        // footer, not scrollback — ignore it here.
      } else {
        // phase === "final"
        // eslint-disable-next-line no-await-in-loop
        const committedSettled = await this.applyFinal({ renderer, runtime, commit });
        if (this.shouldAbortPass(renderer)) {
          // applyFinal may have aborted mid-finish; cursor NOT advanced.
          return settledCount;
        }
        if (committedSettled) {
          settledCount += 1;
        }
      }

      // Two-phase ack: only now is the commit acknowledged.
      this.cursor = commit.seq;
    }

    return settledCount;
  }

  /**
   * Apply an `assistant`/`progress` commit: ensure a streaming entry for the
   * commit's message id (creating it with the leading-spacer + theme logic), then
   * push the accumulated text. The streaming entry commits stable markdown blocks
   * incrementally while the unstable trailing block stays live (no flicker).
   */
  private async applyAssistantProgress(input: {
    renderer: OpenTuiRenderer;
    runtime: ShellRendererController;
    commit: ScrollbackCommit;
  }): Promise<void> {
    const { renderer, runtime, commit } = input;
    const messageId = commit.message.id;
    const viewState = runtime.getViewState();
    const palette = createPalette(viewState.theme);
    const themeName = viewState.theme.name;

    let active = this.entries.get(messageId);
    if (!active) {
      // Leading spacer (FIX 3): mirror the `marginTop={1}` settled messages
      // carry so the first streamed block does not butt against the preceding
      // committed content. Only when prior content exists (never lead the very
      // first scrollback content with a blank), and only on entry CREATION.
      // Width read LIVE (FIX B).
      if (this.hasCommittedContent) {
        commitSpacerRow(renderer, renderer.width);
        this.spacerCommits += 1;
      }
      active = {
        messageId,
        themeName,
        entry: new StreamingScrollbackEntry(renderer, {
          kind: "markdown",
          syntaxStyle: getTranscriptSyntaxStyle(palette),
          // Width is captured at the LIVE renderer width when the entry (and its
          // ScrollbackSurface) is created. @opentui/core@0.4.1's ScrollbackSurface
          // still exposes only a readonly `width` (no setWidth/resize/reflow API;
          // re-verified against renderer.d.ts ScrollbackSurface), so a mid-stream
          // terminal resize leaves THIS turn's still-live trailing block at the
          // old width until it settles — the `final` then re-renders the whole
          // message via TranscriptMessageView at the current width, and the next
          // turn's entry picks up the new width. Already-committed blocks are
          // immutable regardless. Reflowing the live block would require
          // recreating the surface, which would re-commit committed blocks.
          width: renderer.width,
          fg: palette.markdownText,
          internalBlockMode: "top-level",
        }),
      };
      this.entries.set(messageId, active);
    } else if (active.themeName !== themeName) {
      // Theme switched mid-stream (FIX 4): recolor the live renderable in place.
      // Already-committed scrollback rows are immutable (inherent).
      active.entry.setTheme({
        fg: palette.markdownText,
        syntaxStyle: getTranscriptSyntaxStyle(palette),
      });
      active.themeName = themeName;
    }

    await active.entry.update(readCommitText(commit.message));
    // The streaming entry committed (or will commit) stable blocks; once any
    // entry exists, scrollback has content to anchor a future spacer against.
    this.hasCommittedContent = true;
  }

  /**
   * Apply a `final` commit. Returns true if a settled `TranscriptMessageView`
   * (or finished streaming entry) was committed (for the pass count); false if
   * the commit was skipped (already committed / committed-replay of a streamed
   * turn) or the pass aborted.
   *
   * De-dup branches (the crux):
   *  - entry owns this message id -> finish it WITH label; record streamed.
   *  - already committed (id) -> skip.
   *  - logical id already streamed -> skip (committed-replay of a streamed turn,
   *    THE P1-1 FIX: the StreamingScrollbackEntry already wrote this answer).
   *  - else -> commit via TranscriptMessageView (hydration / committed-only).
   */
  private async applyFinal(input: {
    renderer: OpenTuiRenderer;
    runtime: ShellRendererController;
    commit: ScrollbackCommit;
  }): Promise<boolean> {
    const { renderer, runtime, commit } = input;
    const messageId = commit.message.id;

    const active = this.entries.get(messageId);
    if (active) {
      this.entries.delete(messageId);
      const committed = await this.finishEntryWithLabel({ renderer, runtime, entry: active });
      if (!committed) {
        // Pass aborted after finish() (teardown). The entry is destroyed; leave
        // bookkeeping unmarked — reset() will clear it. Cursor not advanced by
        // the caller (it re-checks shouldAbortPass).
        return false;
      }
      // The streamed answer reached scrollback via the entry. Mark BOTH so the
      // committed re-segmentation of THIS turn (same logical id, different ids)
      // is skipped, and a duplicate final for this exact id is skipped.
      this.committedMessageIds.add(messageId);
      this.streamedLogicalIds.add(commit.logicalId);
      // Counts as one settled message reaching scrollback.
      return true;
    }

    if (this.committedMessageIds.has(messageId)) {
      return false;
    }

    if (this.streamedLogicalIds.has(commit.logicalId)) {
      // Committed-replay re-segmentation of an already-streamed turn. The
      // StreamingScrollbackEntry already wrote this answer; skip (P1-1 fix).
      return false;
    }

    // Settled message with no prior streaming for its logical id: commit it via
    // the real TranscriptMessageView (hydration / committed-only turns, tool
    // finals). Do NOT add to streamedLogicalIds — multiple committed segments of
    // ONE never-streamed turn share a logical id and must ALL render.
    this.commitSettledMessage({ renderer, runtime, message: commit.message });
    this.committedMessageIds.add(messageId);
    return true;
  }

  /**
   * Render newly-settled transcript messages the commit log never carries:
   * seed/user/note/system (injected outside the wire-fold projector) and
   * hydrated wire history (loaded via snapshot, emitting no commits). Bounded by
   * `settledScanIndex` so it is O(newly-settled), never O(history).
   *
   * A message is skipped when it is already committed (drain or a prior sweep),
   * its logical-equivalent answer was already streamed, or a streaming entry
   * currently owns it — so the sweep and the commit drain never double-render.
   * The scan stops at the first NON-settled (streaming) message: anything at or
   * after the live tail stays in the footer.
   */
  private sweepSettled(input: {
    renderer: OpenTuiRenderer;
    runtime: ShellRendererController;
  }): number {
    const { renderer, runtime } = input;
    const messages = runtime.getViewState().transcript.messages;
    if (this.settledScanIndex >= messages.length) {
      return 0;
    }

    let committed = 0;
    let index = this.settledScanIndex;
    for (; index < messages.length; index += 1) {
      const message = messages[index];
      if (!message) {
        continue;
      }
      if (isStreamingMessage(message)) {
        // Live tail (or a not-yet-settled message): stop — do not advance the
        // high-water mark past it, so a later settle is reconsidered.
        break;
      }
      if (
        this.committedMessageIds.has(message.id) ||
        this.entries.has(message.id) ||
        this.streamedLogicalIds.has(deriveLogicalId(message))
      ) {
        // Owned by the commit protocol (drained or in-flight). Advance past it.
        continue;
      }
      this.commitSettledMessage({ renderer, runtime, message });
      this.committedMessageIds.add(message.id);
      committed += 1;
    }
    this.settledScanIndex = index;
    return committed;
  }

  /**
   * Commit a single settled message to native scrollback via the real
   * TranscriptMessageView (same render path the legacy settled writer used:
   * ShellRenderProvider + TranscriptMessageView + toolRenderCache + live
   * width/theme/identity).
   */
  private commitSettledMessage(input: {
    renderer: OpenTuiRenderer;
    runtime: ShellRendererController;
    message: CliShellTranscriptMessage;
  }): void {
    const { renderer, runtime, message } = input;
    const width = renderer.width;
    const viewState = runtime.getViewState();
    const theme = createPalette(viewState.theme);
    const sessionIdentity = runtime.getSessionIdentity();
    const toolDefinitions: ReadonlyMap<string, BrewvaToolDefinition> = runtime.getToolDefinitions();
    const transcriptWidth = Math.max(20, width - 8);
    const shellRenderContext = buildShellRenderContext(runtime);

    this.toolRenderCache.resetForSession(sessionIdentity.sessionId);

    commitSolidToScrollback(
      renderer,
      () => (
        <ShellRenderProvider value={shellRenderContext}>
          <TranscriptMessageView
            message={message}
            theme={theme}
            toolDefinitions={toolDefinitions}
            toolRenderCache={this.toolRenderCache}
            transcriptWidth={transcriptWidth}
            showToolDetails={viewState.view.toolDetails}
            index={0}
            isLast={false}
            assistantLabel={sessionIdentity.assistantLabel}
            modelLabel={sessionIdentity.modelLabel}
          />
        </ShellRenderProvider>
      ),
      { width },
    );

    // Settled commits give scrollback content to anchor a future leading spacer
    // against (FIX 3).
    this.hasCommittedContent = true;
  }

  /**
   * Commit a one-shot splash banner anchoring a fresh, empty session: stale
   * terminal content otherwise sits above the new footer until the first message
   * scrolls it up. Committed at most once per session and only when the
   * transcript is empty. Counts as prior committed content, so a subsequent
   * streaming entry receives its leading spacer (FIX 3 + FIX 5).
   */
  commitSplashBanner(input: {
    renderer: OpenTuiRenderer;
    runtime: ShellRendererController;
    /** Deprecated/ignored: width is read LIVE from `renderer.width` (FIX B). */
    width?: number;
  }): void {
    if (this.splashCommitted) {
      return;
    }
    const { renderer, runtime } = input;
    const viewState = runtime.getViewState();
    if (viewState.transcript.messages.length > 0) {
      return;
    }
    this.splashCommitted = true;
    const sessionIdentity = runtime.getSessionIdentity();
    commitAssistantLabelRow({
      renderer,
      width: renderer.width,
      theme: createPalette(viewState.theme),
      assistantLabel: sessionIdentity.assistantLabel,
      modelLabel: sessionIdentity.modelLabel,
    });
    this.bannerCommits += 1;
    this.hasCommittedContent = true;
  }

  /**
   * The SHARED clear primitive behind both replay boundaries (session switch and
   * in-place rewind). After this returns the renderer's native scrollback is
   * empty and the writer's per-message render state (active entries, de-dup sets,
   * content/splash gates) is rebased, so the next drain/sweep re-anchors cleanly.
   *
   * CRUCIALLY it does NOT touch `this.cursor` or `this.settledScanIndex` — those
   * encode the divergence between the two boundaries and are owned by the caller:
   *  - session switch: cursor -> undefined (replay the fresh log from the start);
   *  - in-place rewind: cursor -> log tail (skip the abandoned commits).
   *
   * Mirrors opencode's `resetForReplay` (runtime.lifecycle.ts). Order matters:
   *
   *  1. `await renderer.idle()` — let pending split-footer frames flush so the
   *     clear lands on a settled frame (re-check the abort guard after the await:
   *     a pass that resumes post-teardown must NOT touch a dead renderer).
   *  2. `destroyEntriesAndDedup()` — destroy the in-flight streaming entries
   *     (their ScrollbackSurfaces are bound to scrollback rows about to be
   *     cleared) and clear the de-dup sets, so the re-render does not skip
   *     anything as "already committed".
   *  3. Re-arm the content/splash gates so the boundary re-anchors cleanly: the
   *     cleared scrollback has no prior content, so the first streamed/swept block
   *     must not be preceded by a leading spacer, and the one-shot splash banner
   *     is eligible to fire again.
   *  4. `resetSplitFooterForReplay({ clearSavedLines: true })` — clear the native
   *     scrollback AND the terminal's saved scrollback lines (present in
   *     @opentui/core 0.4.1). It requests a render internally; `requestRender()`
   *     is belt-and-suspenders.
   *  5. Re-commit the splash banner — `commitSplashBanner` no-ops for a non-empty
   *     restored transcript, so a boundary INTO non-empty history skips it.
   */
  private async clearNativeScrollbackForReplay(input: {
    renderer: OpenTuiRenderer;
    runtime: ShellRendererController;
  }): Promise<void> {
    const { renderer, runtime } = input;
    const replay = asReplayCapable(renderer);

    await replay.idle().catch(() => {});
    if (this.shouldAbortPass(renderer)) {
      return;
    }

    this.destroyEntriesAndDedup();
    this.hasCommittedContent = false;
    this.splashCommitted = false;

    // Soft-fail guard, symmetric with the `idle()` catch above: a pass that
    // resumed after `idle()` can race a teardown that flips the renderer into a
    // suspended / wrong-screen-mode state where `resetSplitFooterForReplay`
    // throws even though `shouldAbortPass` did not yet observe it. A coalesced
    // trailing pass has no caller-facing promise, so an uncaught throw here would
    // surface as an unhandled rejection — bail instead of clearing/re-anchoring
    // against a renderer that can no longer accept the replay reset.
    //
    // The genuine teardown race (renderer destroyed / writer disposed) is
    // EXPECTED and stays silent. A throw while the renderer is still LIVE is a
    // real reset failure: the boundary is not counted and the splash is not
    // re-committed, so stale abandoned rows stay visible — record a diagnostic so
    // that failure is observable (mirrors the renderer host's scrollback-sync
    // catch) instead of vanishing.
    try {
      replay.resetSplitFooterForReplay({ clearSavedLines: true });
      replay.requestRender();
    } catch (error) {
      if (!this.shouldAbortPass(renderer)) {
        recordDiagnosticError(
          "scrollbackReplayReset",
          error instanceof Error ? error.message : String(error),
          error instanceof Error ? error.stack : undefined,
        );
      }
      return;
    }
    this.replayBoundaryClears += 1;

    this.commitSplashBanner({ renderer, runtime });
  }

  /**
   * Destroy the active streaming entries (WITHOUT committing their remainder) and
   * clear the per-message de-dup sets. The render-state half of a clear/reset:
   * it leaves `this.cursor` and `this.settledScanIndex` untouched so callers can
   * decide whether to replay from the start, skip to the tail, or preserve the
   * drain position.
   */
  private destroyEntriesAndDedup(): void {
    for (const active of this.entries.values()) {
      active.entry.destroy();
    }
    this.entries.clear();
    this.committedMessageIds.clear();
    this.streamedLogicalIds.clear();
  }

  /**
   * Full per-session reset: destroy entries + clear de-dup sets AND rebase the
   * cursor + sweep mark to the start. Used by reset() (new-session teardown).
   * Does NOT touch the splash/spacer/teardown latches — reset() owns those.
   */
  private resetCommitState(): void {
    this.destroyEntriesAndDedup();
    this.cursor = undefined;
    this.settledScanIndex = 0;
  }

  /**
   * Suspend the writer across an external-editor / pager round-trip WITHOUT
   * discarding what has already reached scrollback (the P1-2 fix).
   *
   * The renderer is torn down and remounted for an external editor, but the
   * editor draws on the ALT screen, so on exit the terminal's native scrollback
   * is intact — the committed transcript is still visible. A full `reset()` here
   * would clear the cursor + de-dup sets, so the next `sync()` after remount
   * would re-drain the log from seq 0 and RE-COMMIT the entire transcript below
   * the rows that are already there (double output). `suspend()` avoids that by
   * preserving the drain/dedup spine:
   *
   *  - latches `disposed` (teardown-race guard, identical to reset()) and
   *    destroys+clears the active `entries` — they hold OLD-renderer-bound
   *    resources that must not outlive the renderer being torn down;
   *  - PRESERVES `cursor`, `committedMessageIds`, `streamedLogicalIds`,
   *    `settledScanIndex`, `lastEpoch`, `hasCommittedContent`, `splashCommitted`,
   *    and the `toolRenderCache`.
   *
   * The next `sync()` after remount clears the `disposed` latch at its leading
   * edge and resumes from the preserved `cursor`: no re-commit. The epoch stays
   * consistent because an editor remount does NOT switch sessions —
   * `#sessionGeneration` is unchanged, so the preserved `lastEpoch` still matches
   * and the writer does NOT epoch-reset on resume.
   *
   * Edge case (editor opened mid-stream): destroying the active entry means that
   * turn's later `final` finds no active entry, so `applyFinal` commits the whole
   * message once via `TranscriptMessageView` — content is preserved. Any STABLE
   * blocks the entry already flushed to native scrollback before the suspend
   * remain there, so the full re-commit can visually repeat that already-shown
   * prefix. A clear IS available (`resetSplitFooterForReplay`, see
   * `beginReplayBoundary`), but it is deliberately NOT used here: an editor
   * suspend is a same-session round-trip that must PRESERVE the visible
   * transcript, so clearing the terminal's history would be wrong. The bounded
   * mid-stream repeat is rare (opening an editor mid-stream is an edge) and
   * accepted, scoped to this same-session suspend path only.
   */
  suspend(): void {
    this.disposed = true;
    for (const active of this.entries.values()) {
      active.entry.destroy();
    }
    this.entries.clear();
  }

  /**
   * Reset all commit state for a new session (and signal teardown). Sets the
   * dispose latch so an in-flight sync pass that resumes after this call bails
   * before touching the renderer (teardown-race guard, FIX A). Any in-flight
   * streaming entries are destroyed (aborted WITHOUT committing their
   * remainder), the de-dup sets + cursor + sweep mark are cleared, and the tool
   * render cache is reset.
   *
   * After reset the next `sync()` re-arms the dispose latch, observes the
   * current epoch fresh, replays the log from the start, re-arms the splash
   * banner, and clears the leading-spacer "prior content" gate.
   *
   * Contrast `suspend()`, which latches dispose + destroys active entries but
   * PRESERVES the cursor/de-dup/content state (used across an external-editor
   * round-trip so the transcript is not re-committed).
   */
  reset(): void {
    this.disposed = true;
    this.resetCommitState();
    this.lastEpoch = undefined;
    this.lastRewindGeneration = undefined;
    this.toolRenderCache = createToolRenderCache();
    this.hasCommittedContent = false;
    this.splashCommitted = false;
  }
}
