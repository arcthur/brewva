import { describe, expect, test } from "bun:test";
import { SyntaxStyle } from "@opentui/core";
import {
  createHeadlessSplitFooterRenderer,
  shutdownSplitFooterRenderer,
} from "../../../packages/brewva-cli/runtime/internal-opentui-runtime.js";
import { StreamingScrollbackEntry } from "../../../packages/brewva-cli/runtime/shell/streaming-scrollback-entry.js";

describe("StreamingScrollbackEntry — markdown monotonic commit", () => {
  test("committedBlocks is non-decreasing across incremental updates", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });
    const syntaxStyle = SyntaxStyle.create();

    try {
      const entry = new StreamingScrollbackEntry(renderer, {
        kind: "markdown",
        syntaxStyle,
        startOnNewLine: false,
      });

      // Step 1: stable paragraph
      await entry.update("# Title\n\nFirst paragraph.\n\n");
      const blocks1 = entry.committedBlocks;

      // Step 2: open (unstable) code fence — trailing block is not yet stable
      await entry.update("# Title\n\nFirst paragraph.\n\n```ts\nconst x = 1");
      const blocks2 = entry.committedBlocks;

      // Monotonic invariant: blocks committed never decrease
      expect(blocks2).toBeGreaterThanOrEqual(blocks1);

      await entry.finish();
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });
});

describe("StreamingScrollbackEntry — unstable tail not committed prematurely", () => {
  test("open code fence is not yet committed (committedBlocks < totalBlocks)", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });
    const syntaxStyle = SyntaxStyle.create();

    try {
      const entry = new StreamingScrollbackEntry(renderer, {
        kind: "markdown",
        syntaxStyle,
        startOnNewLine: false,
      });

      await entry.update("# Title\n\nFirst paragraph.\n\n");
      await entry.update("# Title\n\nFirst paragraph.\n\n```ts\nconst x = 1");

      // totalBlocks must be captured BEFORE finish() destroys the surface
      const totalBeforeFinish = entry.totalBlocks;

      // The unstable trailing code fence must not have been committed yet
      // (stableBlockCount < blockStates.length => committedBlocks < totalBlocks)
      expect(entry.committedBlocks).toBeLessThan(totalBeforeFinish);

      await entry.finish();
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });
});

describe("StreamingScrollbackEntry — finish commits all blocks", () => {
  test("after finish() all blocks are committed and surface is destroyed", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });
    const syntaxStyle = SyntaxStyle.create();

    try {
      const entry = new StreamingScrollbackEntry(renderer, {
        kind: "markdown",
        syntaxStyle,
        startOnNewLine: false,
      });

      await entry.update("# Title\n\nFirst paragraph.\n\n```ts\nconst x = 1");

      // Capture total before finish (surface still alive)
      const totalBeforeFinish = entry.totalBlocks;

      // finish() must drive committedBlocks up to the total
      await entry.finish();

      // After finish, committedBlocks reflects the full total (surface destroyed,
      // totalBlocks returns 0; but committedBlocks retains the last committed value).
      // We assert that the committed count at finish equals what was totalBlocks before finish.
      expect(entry.committedBlocks).toBe(totalBeforeFinish);

      // No throw occurred, surface is gone (totalBlocks returns 0 after destroy)
      expect(entry.totalBlocks).toBe(0);
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });
});

// The renderable's fg getter returns a parsed RGBA object, not the raw color
// string, so compare via its stable string form.
function fgString(value: unknown): string {
  return String(value);
}

describe("StreamingScrollbackEntry — setTheme recolors the live renderable", () => {
  test("setTheme updates the renderable fg and syntaxStyle in place", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });
    const initialStyle = SyntaxStyle.create();

    try {
      const entry = new StreamingScrollbackEntry(renderer, {
        kind: "markdown",
        syntaxStyle: initialStyle,
        fg: "#111111",
        startOnNewLine: false,
      });

      await entry.update("# Title\n\nA paragraph that stays live.");

      const fgBefore = fgString(entry.currentFg);
      expect(entry.currentSyntaxStyle).toBe(initialStyle);

      const nextStyle = SyntaxStyle.create();
      entry.setTheme({ fg: "#eeeeee", syntaxStyle: nextStyle });

      // The live renderable is recolored without waiting for settle: the fg
      // changed and the syntaxStyle is now the new object (set by reference).
      expect(fgString(entry.currentFg)).not.toBe(fgBefore);
      expect(entry.currentSyntaxStyle).toBe(nextStyle);

      await entry.finish();
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });

  test("setTheme with only fg leaves syntaxStyle untouched", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });
    const initialStyle = SyntaxStyle.create();

    try {
      const entry = new StreamingScrollbackEntry(renderer, {
        kind: "markdown",
        syntaxStyle: initialStyle,
        fg: "#111111",
        startOnNewLine: false,
      });
      await entry.update("# Title\n\nBody.");
      const fgBefore = fgString(entry.currentFg);

      entry.setTheme({ fg: "#222222" });

      expect(fgString(entry.currentFg)).not.toBe(fgBefore);
      expect(entry.currentSyntaxStyle).toBe(initialStyle);

      await entry.finish();
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });

  test("setTheme after destroy is a no-op", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });
    const initialStyle = SyntaxStyle.create();

    try {
      const entry = new StreamingScrollbackEntry(renderer, {
        kind: "markdown",
        syntaxStyle: initialStyle,
        fg: "#111111",
        startOnNewLine: false,
      });
      await entry.update("# Title");
      await entry.finish();
      const fgAfterFinish = fgString(entry.currentFg);

      // After the surface is destroyed setTheme is a no-op: it returns without
      // touching the renderable (a throw here would fail the test directly).
      entry.setTheme({ fg: "#999999", syntaxStyle: SyntaxStyle.create() });
      expect(fgString(entry.currentFg)).toBe(fgAfterFinish);
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });
});

describe("StreamingScrollbackEntry — shrinking block count is safe (FIX D)", () => {
  // A re-projected partial can drop a trailing block, so the live block count
  // (and the stable count) can fall BELOW committedBlocksCount, which is
  // monotonic. Streaming is append-only in practice, so this is rare — but it
  // must never throw (out-of-range block access) nor over-commit.
  test("update() then a shorter re-projection does not throw or over-commit", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });
    const syntaxStyle = SyntaxStyle.create();

    try {
      const entry = new StreamingScrollbackEntry(renderer, {
        kind: "markdown",
        syntaxStyle,
        startOnNewLine: false,
      });

      // Commit several stable blocks.
      await entry.update("# Heading\n\nPara one.\n\nPara two.\n\nPara three.\n\n");
      const committedAfterGrow = entry.committedBlocks;
      expect(committedAfterGrow).toBeGreaterThan(0);

      // Re-project to FEWER top-level blocks (a trailing-block drop). The live
      // total now falls below committedBlocks; the guard must bail without
      // throwing and without rewinding/advancing the committed counter.
      await entry.update("# Heading\n\n");
      expect(entry.committedBlocks).toBe(committedAfterGrow);
      // committedBlocks is never advanced past what is actually committed; and it
      // is monotonic (never rewound below the grown value).
      expect(entry.committedBlocks).toBeGreaterThanOrEqual(committedAfterGrow);

      // finish() over a shrunk projection must also be safe (done=true path).
      await entry.finish();
      expect(entry.committedBlocks).toBe(committedAfterGrow);
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });

  test("finish() directly after a shrink commits nothing extra and does not throw", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });
    const syntaxStyle = SyntaxStyle.create();

    try {
      const entry = new StreamingScrollbackEntry(renderer, {
        kind: "markdown",
        syntaxStyle,
        startOnNewLine: false,
      });

      await entry.update("# T\n\nA.\n\nB.\n\nC.\n\n");
      const committed = entry.committedBlocks;

      // Shrink hard to a single block, then finish — no throw, no over-commit.
      await entry.update("# T\n\n");
      await entry.finish();

      expect(entry.committedBlocks).toBe(committed);
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });
});

describe("StreamingScrollbackEntry — text kind", () => {
  test("committedRows is non-decreasing and ends >= streamed row count", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });

    try {
      const entry = new StreamingScrollbackEntry(renderer, {
        kind: "text",
        startOnNewLine: false,
      });

      const rows0 = entry.committedRows;

      await entry.update("line one\nline two\n");
      const rows1 = entry.committedRows;

      // Non-decreasing
      expect(rows1).toBeGreaterThanOrEqual(rows0);

      await entry.finish();
      const rowsFinal = entry.committedRows;

      // Must be non-decreasing after finish
      expect(rowsFinal).toBeGreaterThanOrEqual(rows1);

      // Should have committed at least 1 row (two non-empty lines)
      expect(rowsFinal).toBeGreaterThanOrEqual(1);
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });
});
