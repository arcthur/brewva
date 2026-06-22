import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHeadlessSplitFooterRenderer,
  shutdownSplitFooterRenderer,
} from "../../../packages/brewva-cli/runtime/internal-opentui-runtime.js";
import { SplitFooterScrollbackWriter } from "../../../packages/brewva-cli/runtime/shell/split-footer-scrollback-writer.js";
import { DEFAULT_TUI_THEME } from "../../../packages/brewva-cli/src/internal/tui/index.js";
import type { CliShellRuntime } from "../../../packages/brewva-cli/src/shell/controller/shell-runtime.js";
import type { CliShellTranscriptMessage } from "../../../packages/brewva-cli/src/shell/domain/transcript.js";
import { patchProcessEnv } from "../../helpers/global-state.js";

// ---------------------------------------------------------------------------
// This test exercises the scrollback wiring that CliInteractiveOpenTuiShellRuntime
// drives: a SplitFooterScrollbackWriter
// committing a seeded settled transcript to a headless split-footer renderer on
// an initial sync, then re-syncing after a transcript change, then draining via
// whenIdle() and tearing down cleanly. Mounting the real Solid footer requires
// a full CliShellRuntime + a TTY-backed renderer, which cannot run headlessly;
// asserting the orchestration contract (settled count > 0, no throw, clean
// shutdown) is the meaningful headless guarantee — the runtime host is a thin
// subscribe -> orchestrator.sync(...) -> reset()/shutdown adapter over exactly
// this seam. Mirrors the fake-runtime/headless-renderer patterns in
// split-footer-scrollback-writer.unit.test.tsx and transcript-scrollback.unit.test.tsx.
// ---------------------------------------------------------------------------

function stableMessage(id: string, text = id): CliShellTranscriptMessage {
  return {
    id,
    role: "user",
    renderMode: "stable",
    parts: [
      {
        type: "text",
        id: `${id}:text`,
        text,
        renderMode: "stable",
      },
    ],
  };
}

function streamingMessage(id: string, text = id): CliShellTranscriptMessage {
  return {
    id,
    role: "assistant",
    renderMode: "streaming",
    parts: [
      {
        type: "text",
        id: `${id}:text`,
        text,
        renderMode: "streaming",
      },
    ],
  };
}

/** A fake ShellRendererController sufficient for the scrollback commit path. */
function buildFakeRuntime(messages: CliShellTranscriptMessage[]): CliShellRuntime {
  return {
    // This headless fake emits NO commit log (like session hydration: messages are
    // seeded directly, the projector never runs). With an empty log the writer
    // falls through to the settled SWEEP, which is exactly the wiring contract this
    // test asserts.
    peekScrollbackCommits() {
      return { commits: [], cursor: undefined, epoch: 0, rewindGeneration: 0 };
    },
    getViewState() {
      return {
        theme: DEFAULT_TUI_THEME,
        transcript: {
          messages,
          followMode: "live",
          scrollOffset: 0,
        },
        diff: {
          style: "auto",
          wrapMode: "word",
        },
        view: {
          showThinking: false,
          toolDetails: false,
        },
      };
    },
    getSessionIdentity() {
      return {
        sessionId: "split-footer-shell-session",
        assistantLabel: "Brewva",
        lineageLabel: null,
        modelLabel: "Test Model",
        thinkingLevel: "low",
      };
    },
    getToolDefinitions() {
      return new Map();
    },
    getTuiConfig() {
      return {
        theme: DEFAULT_TUI_THEME,
        keymap: { leader: ",", leaderTimeoutMs: 500, bindings: {} },
        view: {
          showThinking: false,
          toolDetails: false,
          diff: { style: "auto", wrapMode: "word" },
        },
        input: { largePasteThreshold: { minLines: 5, minCharacters: 200 } },
        scroll: { acceleration: { type: "linear", speed: 3 } },
      };
    },
    getClock() {
      return { now: () => Date.now() };
    },
    handleInput() {
      return Promise.resolve(true);
    },
  } as unknown as CliShellRuntime;
}

describe("split-footer shell scrollback wiring", () => {
  let previewDir = "";
  let restorePreviewDirEnv: (() => void) | undefined;

  beforeEach(() => {
    previewDir = mkdtempSync(join(tmpdir(), "brewva-sfshell-"));
    restorePreviewDirEnv = patchProcessEnv({ BREWVA_MERMAID_PREVIEW_DIR: previewDir });
  });

  afterEach(() => {
    restorePreviewDirEnv?.();
    restorePreviewDirEnv = undefined;
    rmSync(previewDir, { recursive: true, force: true });
  });

  test("initial sync commits the seeded settled transcript, then drains and shuts down", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 24 });
    const orchestrator = new SplitFooterScrollbackWriter();

    try {
      // Seeded transcript: two settled messages + a streaming tail. The host's
      // post-mount initial sync should commit exactly the two settled ones (the
      // streaming tail is streamed via its entry, not the settled path).
      const seeded: CliShellTranscriptMessage[] = [
        stableMessage("seed-1", "Welcome back"),
        stableMessage("seed-2", "Continuing the session"),
        streamingMessage("seed-3", "Working on it…"),
      ];

      const initialCommitted = await orchestrator.sync({
        renderer,
        runtime: buildFakeRuntime(seeded),
        width: renderer.width,
      });
      expect(initialCommitted).toBe(2);

      // A transcript change: a new streaming tail (seed-4) is appended and seed-3
      // flips its MESSAGE renderMode to "stable" — but its text PART is still
      // "streaming" (only the wrapper changed), so isStreamingMessage(seed-3) is
      // still true. The settled SWEEP therefore stops at seed-3 (the live tail
      // begins there) and commits nothing new -> 0. This proves the sweep never
      // commits a message whose parts are still streaming.
      const afterChange: CliShellTranscriptMessage[] = [
        stableMessage("seed-1", "Welcome back"),
        stableMessage("seed-2", "Continuing the session"),
        { ...streamingMessage("seed-3", "Done."), renderMode: "stable" },
        streamingMessage("seed-4", "Next step…"),
      ];
      const changeCommitted = await orchestrator.sync({
        renderer,
        runtime: buildFakeRuntime(afterChange),
        width: renderer.width,
      });
      expect(changeCommitted).toBe(0);

      // whenIdle resolves after the drain loop completes (no in-flight pass).
      const idleCount = await orchestrator.whenIdle();
      expect(idleCount).toBeGreaterThanOrEqual(0);
    } finally {
      // The host resets the orchestrator before tearing down the renderer.
      orchestrator.reset();
      shutdownSplitFooterRenderer(renderer);
    }

    // Clean shutdown: the renderer is destroyed and we reached here without throwing.
    expect((renderer as unknown as { isDestroyed: boolean }).isDestroyed).toBe(true);
  });

  test("empty seeded transcript commits nothing on initial sync", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 24 });
    const orchestrator = new SplitFooterScrollbackWriter();

    try {
      const committed = await orchestrator.sync({
        renderer,
        runtime: buildFakeRuntime([]),
        width: renderer.width,
      });
      expect(committed).toBe(0);
      await orchestrator.whenIdle();
    } finally {
      orchestrator.reset();
      shutdownSplitFooterRenderer(renderer);
    }

    expect((renderer as unknown as { isDestroyed: boolean }).isDestroyed).toBe(true);
  });
});
