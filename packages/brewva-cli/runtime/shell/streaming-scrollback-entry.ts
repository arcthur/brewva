/**
 * Incremental scrollback commit for a single streaming assistant message.
 *
 * As content streams in the caller repeatedly calls `update(fullContent)`.
 * Only the STABLE leading blocks are committed to native scrollback on each
 * call; the unstable trailing block stays live (re-rendered each chunk)
 * until the content settles.  `finish()` performs a final done=true flush
 * that commits the remainder and destroys the surface.
 *
 * This is the core anti-flicker mechanism for the split-footer TUI mode.
 * Port of `createEntry` / `flushActive` / `finishActive` / `commitMarkdownBlocks`
 * from opencode's scrollback.surface.ts.
 */

import type { OpenTuiRenderer } from "../../src/internal/tui/internal-opentui-runtime.js";
import {
  CodeRenderable,
  MarkdownRenderable,
  TextRenderable,
  getTreeSitterClient,
  type BlockState,
  type ColorInput,
  type MarkdownTableOptions,
  type ScrollbackSurface,
  type SyntaxStyle,
  type TreeSitterClient,
} from "../opentui/index.js";

// CliRenderer has createScrollbackSurface; OpenTuiRenderer (the minimal interface
// used in brewva) does not declare it.  Cast at the call site so we never widen
// the type that flows through the public API.
type RendererWithScrollback = OpenTuiRenderer & {
  createScrollbackSurface(options?: { startOnNewLine?: boolean }): ScrollbackSurface;
};

export type StreamingScrollbackEntryKind = "text" | "code" | "markdown";

export interface StreamingScrollbackEntryOptions {
  kind: StreamingScrollbackEntryKind;
  /** Default "100%". Accepts a pixel count, "auto", or a percentage string like "100%". */
  width?: number | "auto" | `${number}%`;
  fg?: ColorInput;
  /** For code/markdown kinds */
  syntaxStyle?: SyntaxStyle;
  /** For code kind, e.g. "markdown" */
  filetype?: string;
  /** For markdown, default "top-level" */
  internalBlockMode?: "top-level" | undefined;
  /** For markdown tables */
  tableOptions?: MarkdownTableOptions;
  /** Defaults to getTreeSitterClient() */
  treeSitterClient?: TreeSitterClient;
  startOnNewLine?: boolean;
}

// ---- helpers ----------------------------------------------------------------

function getBlockStates(renderable: MarkdownRenderable): BlockState[] {
  // _blockStates is the public-ish accessor declared on MarkdownRenderable.
  // oxlint no-underscore-dangle is suppressed for external library members.
  // eslint-disable-next-line no-underscore-dangle
  return renderable._blockStates;
}

function getStableBlockCount(renderable: MarkdownRenderable): number {
  // eslint-disable-next-line no-underscore-dangle
  return renderable._stableBlockCount;
}

function commitMarkdownBlocks(input: {
  surface: ScrollbackSurface;
  renderable: MarkdownRenderable;
  startBlock: number;
  endBlockExclusive: number;
  trailingNewline: boolean;
}): boolean {
  if (input.endBlockExclusive <= input.startBlock) {
    return false;
  }

  const states = getBlockStates(input.renderable);
  const first = states[input.startBlock];
  const last = states[input.endBlockExclusive - 1];
  if (!first || !last) {
    return false;
  }

  const next = states[input.endBlockExclusive];
  const start = first.renderable.y;
  const end = next ? next.renderable.y : last.renderable.y + last.renderable.height;

  input.surface.commitRows(start, end, {
    trailingNewline: input.trailingNewline,
  });
  return true;
}

// ---- main class -------------------------------------------------------------

export class StreamingScrollbackEntry {
  private readonly surface: ScrollbackSurface;
  private readonly renderable: TextRenderable | CodeRenderable | MarkdownRenderable;
  private readonly kind: StreamingScrollbackEntryKind;
  private committedRowsCount = 0;
  private committedBlocksCount = 0;
  private destroyed = false;

  constructor(renderer: OpenTuiRenderer, options: StreamingScrollbackEntryOptions) {
    const cliRenderer = renderer as RendererWithScrollback;
    this.surface = cliRenderer.createScrollbackSurface({
      startOnNewLine: options.startOnNewLine,
    });

    this.kind = options.kind;
    const ctx = this.surface.renderContext;
    const width = options.width ?? "100%";

    const treeSitterClient = options.treeSitterClient ?? getTreeSitterClient();

    if (options.kind === "text") {
      this.renderable = new TextRenderable(ctx, {
        content: "",
        width,
        fg: options.fg,
      });
    } else if (options.kind === "code") {
      if (!options.syntaxStyle) {
        throw new Error("StreamingScrollbackEntry: syntaxStyle is required for kind='code'");
      }
      this.renderable = new CodeRenderable(ctx, {
        content: "",
        filetype: options.filetype,
        syntaxStyle: options.syntaxStyle,
        width,
        streaming: true,
        fg: options.fg,
        treeSitterClient,
      });
    } else {
      // markdown
      if (!options.syntaxStyle) {
        throw new Error("StreamingScrollbackEntry: syntaxStyle is required for kind='markdown'");
      }
      this.renderable = new MarkdownRenderable(ctx, {
        content: "",
        syntaxStyle: options.syntaxStyle,
        width,
        streaming: true,
        internalBlockMode: options.internalBlockMode ?? "top-level",
        tableOptions: options.tableOptions,
        fg: options.fg,
        treeSitterClient,
      });
    }

    this.surface.root.add(this.renderable);
  }

  // ---- public counters ------------------------------------------------------

  get committedRows(): number {
    return this.committedRowsCount;
  }

  get committedBlocks(): number {
    return this.committedBlocksCount;
  }

  /** Number of top-level blocks currently parsed (0 after surface is destroyed). */
  get totalBlocks(): number {
    if (this.destroyed || !(this.renderable instanceof MarkdownRenderable)) {
      return 0;
    }
    return getBlockStates(this.renderable).length;
  }

  /** The live renderable's current foreground (for tests / theme tracking). */
  get currentFg(): ColorInput | undefined {
    return this.renderable.fg;
  }

  /**
   * The live renderable's current syntaxStyle, or undefined for the text kind
   * (TextRenderable has no syntaxStyle).
   */
  get currentSyntaxStyle(): SyntaxStyle | undefined {
    if (this.renderable instanceof TextRenderable) {
      return undefined;
    }
    return this.renderable.syntaxStyle;
  }

  // ---- theme ----------------------------------------------------------------

  /**
   * Recolor the still-live renderable in place when the theme/palette changes
   * mid-stream. Only the trailing unstable block is live; already-committed
   * scrollback rows are immutable and keep the old palette (inherent — matches
   * opencode's RunScrollbackStream.setTheme behavior). No-op after destroy and
   * for fields not provided.
   */
  setTheme(options: { fg?: ColorInput; syntaxStyle?: SyntaxStyle }): void {
    if (this.destroyed || this.surface.isDestroyed) {
      return;
    }
    if (options.fg !== undefined) {
      this.renderable.fg = options.fg;
    }
    if (options.syntaxStyle !== undefined && !(this.renderable instanceof TextRenderable)) {
      this.renderable.syntaxStyle = options.syntaxStyle;
    }
  }

  // ---- core flush -----------------------------------------------------------

  /**
   * Set content on the renderable, settle, then commit newly stable rows/blocks.
   *
   * @param done  true on the final call — commits everything including the trailing block.
   * @param trailingNewline  emitted only on the very last commit when done=true.
   * @returns whether any new rows/blocks were committed.
   */
  /**
   * Await the surface settle, returning false if the surface was torn down
   * (here or while we were suspended). `settle()` itself calls assertNotDestroyed
   * and REJECTS when the surface is destroyed mid-settle — so a destroy() during
   * the await (e.g. the writer's reset() on host teardown, FIX A) surfaces as a
   * rejection, not just a post-await flag flip. Swallow that specific case as a
   * clean bail; rethrow any other (genuine) settle error.
   */
  private async settleOrBail(): Promise<boolean> {
    try {
      await this.surface.settle();
    } catch (error) {
      if (this.destroyed || this.surface.isDestroyed) {
        return false;
      }
      throw error;
    }
    return !(this.destroyed || this.surface.isDestroyed);
  }

  private async flush(done: boolean, trailingNewline: boolean): Promise<boolean> {
    // Shouldn't be called after destroy, but guard defensively.
    if (this.destroyed || this.surface.isDestroyed) {
      return false;
    }

    if (this.kind === "text" && this.renderable instanceof TextRenderable) {
      this.surface.render();
      const targetRows = done
        ? this.surface.height
        : Math.max(this.committedRowsCount, this.surface.height - 1);
      if (targetRows <= this.committedRowsCount) {
        return false;
      }
      this.surface.commitRows(this.committedRowsCount, targetRows, {
        trailingNewline: done && targetRows === this.surface.height ? trailingNewline : false,
      });
      this.committedRowsCount = targetRows;
      return true;
    }

    if (this.kind === "code" && this.renderable instanceof CodeRenderable) {
      this.renderable.streaming = !done;
      // Teardown-race guard (FIX A): bail if the surface was destroyed during or
      // before the settle (a resumed pass after host teardown), so commitRows
      // never runs against a dead surface.
      if (!(await this.settleOrBail())) {
        return false;
      }
      const targetRows = done
        ? this.surface.height
        : Math.max(this.committedRowsCount, this.surface.height - 1);
      if (targetRows <= this.committedRowsCount) {
        return false;
      }
      this.surface.commitRows(this.committedRowsCount, targetRows, {
        trailingNewline: done && targetRows === this.surface.height ? trailingNewline : false,
      });
      this.committedRowsCount = targetRows;
      return true;
    }

    if (this.kind === "markdown" && this.renderable instanceof MarkdownRenderable) {
      this.renderable.streaming = !done;
      // Teardown-race guard (FIX A): bail if the surface was destroyed during or
      // before the settle, so commitMarkdownBlocks/commitRows never runs against
      // a dead surface.
      if (!(await this.settleOrBail())) {
        return false;
      }
      const totalBlockCount = getBlockStates(this.renderable).length;
      const targetBlockCount = done ? totalBlockCount : getStableBlockCount(this.renderable);
      // `committedBlocksCount` is monotonic, but a re-projected partial can drop a
      // trailing block, so the live block count (and thus `targetBlockCount`) can
      // fall BELOW what we already committed. Streaming is append-only in practice,
      // so this is rare — but guard against both the no-progress case AND a shrink
      // that would otherwise pass `startBlock > endBlockExclusive` (or a stale
      // out-of-range `startBlock`) into commitMarkdownBlocks. Bail without
      // committing or over-advancing the counter; committed scrollback is immutable.
      if (
        targetBlockCount <= this.committedBlocksCount ||
        this.committedBlocksCount > totalBlockCount
      ) {
        return false;
      }
      const committed = commitMarkdownBlocks({
        surface: this.surface,
        renderable: this.renderable,
        startBlock: this.committedBlocksCount,
        endBlockExclusive: targetBlockCount,
        trailingNewline: done && targetBlockCount === totalBlockCount ? trailingNewline : false,
      });
      if (committed) {
        this.committedBlocksCount = targetBlockCount;
        return true;
      }
      return false;
    }

    return false;
  }

  // ---- public API -----------------------------------------------------------

  /**
   * Set the full accumulated content and commit any newly stable rows/blocks.
   * The caller must pass the FULL accumulated content each time (not a delta).
   */
  async update(content: string): Promise<void> {
    if (this.destroyed || this.surface.isDestroyed) {
      return;
    }
    this.renderable.content = content;
    await this.flush(false, false);
  }

  /**
   * Final flush (done=true): commits the remainder including the trailing block,
   * then destroys the surface.
   */
  async finish(trailingNewline = false): Promise<void> {
    if (this.destroyed) {
      return;
    }
    try {
      await this.flush(true, trailingNewline);
    } finally {
      this.destroyed = true;
      if (!this.surface.isDestroyed) {
        this.surface.destroy();
      }
    }
  }

  /**
   * Abort without committing the remainder (e.g. on session switch).
   * Only destroys the surface; no additional rows/blocks are committed.
   */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    if (!this.surface.isDestroyed) {
      this.surface.destroy();
    }
  }
}
