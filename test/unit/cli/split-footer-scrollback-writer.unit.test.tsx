/** @jsxImportSource @opentui/solid */

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
import type { ShellRendererController } from "../../../packages/brewva-cli/src/shell/domain/renderer-contract.js";
import type {
  ScrollbackCommit,
  ScrollbackCommitCursor,
} from "../../../packages/brewva-cli/src/shell/domain/scrollback/commit.js";
import {
  buildTextTranscriptMessage,
  type CliShellTranscriptMessage,
} from "../../../packages/brewva-cli/src/shell/domain/transcript.js";

// ---------------------------------------------------------------------------
// Transcript message builders (for the sweep path: transcript.messages)
// ---------------------------------------------------------------------------

function textMessage(input: {
  id: string;
  role: "assistant" | "user";
  text: string;
}): CliShellTranscriptMessage {
  const message = buildTextTranscriptMessage({
    id: input.id,
    role: input.role,
    text: input.text,
  });
  if (!message) {
    throw new Error(`failed to build message for ${input.id}`);
  }
  return message;
}

/**
 * A streaming assistant tail: renderMode "streaming". The sweep must STOP at the
 * first such message (the live tail belongs in the footer, not scrollback).
 */
function streamingTailMessage(input: { id: string; text: string }): CliShellTranscriptMessage {
  const message = textMessage({ id: input.id, role: "assistant", text: input.text });
  const streamingPart = { ...message.parts[0]!, renderMode: "streaming" as const };
  return { ...message, renderMode: "streaming", parts: [streamingPart] };
}

// ---------------------------------------------------------------------------
// ScrollbackCommit builders. The writer reads commit.logicalId DIRECTLY (it
// never recomputes it), so each commit carries an explicit logicalId.
// ---------------------------------------------------------------------------

interface CommitInput {
  id: string;
  logicalId: string;
  kind: ScrollbackCommit["kind"];
  phase: ScrollbackCommit["phase"];
  text: string;
}

function buildCommit(input: CommitInput, seq: number): ScrollbackCommit {
  return {
    logicalId: input.logicalId,
    kind: input.kind,
    phase: input.phase,
    message: textMessage({
      id: input.id,
      role: input.kind === "user" ? "user" : "assistant",
      text: input.text,
    }),
    seq,
  };
}

// ---------------------------------------------------------------------------
// Scripted commit runtime.
//
// Models the append-only ScrollbackCommitLog the live runtime exposes: a flat,
// monotonic-seq commit list, an epoch, and the transcript messages that drive
// the sweep. `peekScrollbackCommits(cursor)` reproduces ScrollbackCommitLog.since
// EXACTLY (commits strictly after `cursor`; advanced cursor = last commit seq, or
// the caller's cursor when the slice is empty) so the writer's two-phase ack and
// epoch-reset logic exercise real semantics.
//
// `peekCursorArgs` records every cursor the writer asked from, so a test can
// assert which cursor a follow-up peek used (proving cursor (non-)advancement).
// ---------------------------------------------------------------------------

class ScriptedCommitRuntime {
  private commits: ScrollbackCommit[];
  private epoch: number;
  private rewindGeneration: number;
  private messages: CliShellTranscriptMessage[];
  readonly peekCursorArgs: ScrollbackCommitCursor[] = [];
  /**
   * The message ids returned in each peek slice, one array PER peek call (aligned
   * with peekCursorArgs by index). After a rewind boundary the writer advances
   * its cursor past the abandoned commits and re-peeks, so the FINAL slice the
   * writer actually drains is the one returned from the advanced cursor — a test
   * asserts THAT slice (servedSlices.at(-1)) omits the abandoned id, proving the
   * abandoned turn is never drained/re-emitted post-boundary.
   */
  readonly servedSlices: string[][] = [];

  constructor(input: {
    commitInputs: readonly CommitInput[];
    epoch?: number;
    rewindGeneration?: number;
    messages?: readonly CliShellTranscriptMessage[];
  }) {
    this.commits = input.commitInputs.map((commit, index) => buildCommit(commit, index));
    this.epoch = input.epoch ?? 0;
    this.rewindGeneration = input.rewindGeneration ?? 0;
    this.messages = [...(input.messages ?? [])];
  }

  /** Replace the commit log (keeping monotonic seq) — e.g. appending a later turn. */
  setCommitInputs(commitInputs: readonly CommitInput[]): void {
    this.commits = commitInputs.map((commit, index) => buildCommit(commit, index));
  }

  /** Bump the session generation (session switch) so the next peek triggers a reset. */
  setEpoch(epoch: number): void {
    this.epoch = epoch;
  }

  /**
   * Bump the rewind generation (in-place rewind / redo / undo) so the next peek
   * triggers the SKIP-to-tail clearing boundary — WITHOUT changing the epoch.
   */
  bumpRewindGeneration(): void {
    this.rewindGeneration += 1;
  }

  /** Replace the transcript the settled sweep renders (post-rewind shorter set). */
  setMessages(messages: readonly CliShellTranscriptMessage[]): void {
    this.messages = [...messages];
  }

  // Arrow-function properties capture `this` lexically (no `this` alias needed);
  // the returned object is cast to the controller port.
  asController(): ShellRendererController {
    return {
      peekScrollbackCommits: (cursor: ScrollbackCommitCursor) => {
        this.peekCursorArgs.push(cursor);
        const slice =
          cursor === undefined
            ? [...this.commits]
            : this.commits.filter((entry) => entry.seq > cursor);
        this.servedSlices.push(slice.map((entry) => entry.message.id));
        const lastSeq = slice.at(-1)?.seq;
        return {
          commits: slice,
          cursor: lastSeq ?? cursor,
          epoch: this.epoch,
          rewindGeneration: this.rewindGeneration,
        };
      },
      getViewState: () => ({
        theme: DEFAULT_TUI_THEME,
        transcript: {
          messages: this.messages,
          followMode: "live",
          scrollOffset: 0,
        },
        diff: { style: "auto", wrapMode: "word" },
        view: { showThinking: false, toolDetails: false },
      }),
      getSessionIdentity: () => ({
        sessionId: "test-session",
        assistantLabel: "Brewva",
        lineageLabel: null,
        modelLabel: "Test Model",
        thinkingLevel: "low",
      }),
      getToolDefinitions: () => new Map(),
      getTuiConfig: () => ({
        theme: DEFAULT_TUI_THEME,
        keymap: { leader: ",", leaderTimeoutMs: 500, bindings: {} },
        view: {
          showThinking: false,
          toolDetails: false,
          diff: { style: "auto", wrapMode: "word" },
        },
        input: { largePasteThreshold: { minLines: 5, minCharacters: 200 } },
        scroll: { acceleration: { type: "linear", speed: 3 } },
      }),
      getClock: () => ({ now: () => Date.now() }),
      handleInput: () => Promise.resolve(true),
    } as unknown as ShellRendererController;
  }
}

// Wire-style ids so deriveLogicalId behaves like production. A turn streams as
// `wire:s:t:a:assistant:<seq>`; its committed re-segmentation carries DIFFERENT
// ids (`…:assistant:committed:index:<n>`) but the SAME logical id.
const STREAM_ASSISTANT_ID = "wire:s:t:a:assistant:1";
const COMMITTED_ASSISTANT_ID_0 = "wire:s:t:a:assistant:committed:index:0";
const COMMITTED_ASSISTANT_ID_1 = "wire:s:t:a:assistant:committed:index:1";
const ASSISTANT_LOGICAL_ID = "turn:s:t:a:assistant";

// Wrap the renderer's native `resetSplitFooterForReplay` so a test can observe
// the session-switch replay boundary (the writer clears native scrollback there).
// Records each call's `clearSavedLines` option and still invokes the real method
// (so the headless renderer's scrollback state is genuinely reset). `restore`
// puts the original method back before teardown.
function spyResetSplitFooterForReplay(renderer: unknown): {
  calls: Array<{ clearSavedLines: boolean | undefined }>;
  restore: () => void;
} {
  const target = renderer as {
    resetSplitFooterForReplay(options?: { clearSavedLines?: boolean }): void;
  };
  const original = target.resetSplitFooterForReplay.bind(target);
  const calls: Array<{ clearSavedLines: boolean | undefined }> = [];
  target.resetSplitFooterForReplay = (options?: { clearSavedLines?: boolean }) => {
    calls.push({ clearSavedLines: options?.clearSavedLines });
    original(options);
  };
  return {
    calls,
    restore() {
      target.resetSplitFooterForReplay = original;
    },
  };
}

// Count external_output events on the renderer (the observable signal that
// writeToScrollback enqueued a scrollback commit).
function countExternalOutputEvents(renderer: unknown): { count: number; cleanup: () => void } {
  let count = 0;
  const listener = () => {
    count += 1;
  };
  (renderer as { on(event: string, listener: () => void): void }).on("external_output", listener);
  return {
    get count() {
      return count;
    },
    cleanup() {
      (renderer as { off(event: string, listener: () => void): void }).off(
        "external_output",
        listener,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SplitFooterScrollbackWriter (commit-cursor driven)", () => {
  let previewDir = "";

  beforeEach(() => {
    previewDir = mkdtempSync(join(tmpdir(), "brewva-sfwriter-"));
    process.env.BREWVA_MERMAID_PREVIEW_DIR = previewDir;
  });

  afterEach(() => {
    delete process.env.BREWVA_MERMAID_PREVIEW_DIR;
    rmSync(previewDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // 1. P1-1 (the headline): a streamed turn answer reaches scrollback ONCE; its
  //    committed re-segmentation (same logicalId, different ids) is skipped.
  // -------------------------------------------------------------------------
  test("P1-1: streamed turn answer reaches scrollback once; committed replay is skipped", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });

    try {
      const writer = new SplitFooterScrollbackWriter();
      const runtime = new ScriptedCommitRuntime({
        // The turn streams as ONE growing assistant message (progress x2, same
        // id), then a streamed final (SAME id) — so applyFinal finishes the
        // active entry + commits its label. THEN two committed-replay finals
        // carry DIFFERENT ids but the SAME logicalId -> the streamedLogicalIds
        // branch SKIPS them (the P1-1 fix: no double-write).
        commitInputs: [
          {
            id: STREAM_ASSISTANT_ID,
            logicalId: ASSISTANT_LOGICAL_ID,
            kind: "assistant",
            phase: "progress",
            text: "Hello",
          },
          {
            id: STREAM_ASSISTANT_ID,
            logicalId: ASSISTANT_LOGICAL_ID,
            kind: "assistant",
            phase: "progress",
            text: "Hello world",
          },
          {
            id: STREAM_ASSISTANT_ID,
            logicalId: ASSISTANT_LOGICAL_ID,
            kind: "assistant",
            phase: "final",
            text: "Hello world done",
          },
          {
            id: COMMITTED_ASSISTANT_ID_0,
            logicalId: ASSISTANT_LOGICAL_ID,
            kind: "assistant",
            phase: "final",
            text: "Hello world",
          },
          {
            id: COMMITTED_ASSISTANT_ID_1,
            logicalId: ASSISTANT_LOGICAL_ID,
            kind: "assistant",
            phase: "final",
            text: " done",
          },
        ],
        // Empty transcript: the sweep contributes nothing — every assistant row
        // is owned by the commit protocol.
        messages: [],
      });

      const settledCount = await writer.sync({ renderer, runtime: runtime.asController() });

      // Exactly ONE assistant answer reached scrollback: the streamed final
      // finished the active entry (settledCount counts it as one) and committed
      // exactly one assistant label row.
      expect(settledCount).toBe(1);
      expect(writer.committedLabelCount).toBe(1);

      // The two committed-replay finals committed ZERO settled messages: they hit
      // the streamedLogicalIds branch and were skipped. No second label row, no
      // second settled commit -> the answer is NOT double-written.
      expect(writer.committedLabelCount).toBe(1);
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });

  // -------------------------------------------------------------------------
  // 2. Hydration: no commits emitted; the sweep renders transcript.messages in
  //    order, once each.
  // -------------------------------------------------------------------------
  test("hydration: empty commit log -> sweep commits all settled messages in order, once", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });
    const counter = countExternalOutputEvents(renderer);

    try {
      const writer = new SplitFooterScrollbackWriter();
      const runtime = new ScriptedCommitRuntime({
        commitInputs: [],
        messages: [
          textMessage({ id: "user:0", role: "user", text: "first question" }),
          textMessage({
            id: "wire:s:t:a:assistant:committed:index:0",
            role: "assistant",
            text: "answer part one",
          }),
          textMessage({
            id: "wire:s:t:a:assistant:committed:index:1",
            role: "assistant",
            text: "answer part two",
          }),
        ],
      });

      const settledCount = await writer.sync({ renderer, runtime: runtime.asController() });

      // All three settled messages were committed by the sweep.
      expect(settledCount).toBe(3);
      // Three scrollback commits landed (one per swept message; no streaming
      // entries, no labels, no spacers from the commit path).
      expect(counter.count).toBe(3);
      expect(writer.committedLabelCount).toBe(0);
      expect(writer.committedSpacerCount).toBe(0);

      // A second sync with the SAME transcript commits nothing (high-water mark).
      const secondCount = await writer.sync({ renderer, runtime: runtime.asController() });
      expect(secondCount).toBe(0);
      expect(counter.count).toBe(3);
    } finally {
      counter.cleanup();
      shutdownSplitFooterRenderer(renderer);
    }
  });

  // -------------------------------------------------------------------------
  // 3. Tool dedup: two `tool`/`final` commits with the SAME message.id -> the
  //    second is skipped via committedMessageIds.
  // -------------------------------------------------------------------------
  test("tool dedup: a tool final with an already-committed id is skipped", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });

    try {
      const writer = new SplitFooterScrollbackWriter();
      const runtime = new ScriptedCommitRuntime({
        commitInputs: [
          {
            id: "wire:s:t:tool:tool-read-1",
            logicalId: "turn:s:t:tool:tool-read-1",
            kind: "tool",
            phase: "final",
            text: "tool output",
          },
          {
            // SAME message id -> second final skipped via committedMessageIds.
            id: "wire:s:t:tool:tool-read-1",
            logicalId: "turn:s:t:tool:tool-read-1",
            kind: "tool",
            phase: "final",
            text: "tool output again",
          },
        ],
        messages: [],
      });

      const settledCount = await writer.sync({ renderer, runtime: runtime.asController() });

      // Committed exactly once: the first final via the settled path, the second
      // skipped.
      expect(settledCount).toBe(1);
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });

  // -------------------------------------------------------------------------
  // 4. Two-phase ack: a commit whose processing aborts (renderer destroyed
  //    mid-pass) does NOT advance this.cursor; the next pass re-peeks from the
  //    un-advanced cursor and re-processes the commit.
  // -------------------------------------------------------------------------
  test("two-phase ack: an aborted commit does not advance the cursor; it is retried next pass", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });

    // `isDestroyed` is a configurable prototype getter (no setter). Shadow it with
    // an own getter over a mutable flag so a pass can be forced to abort; delete
    // the own property to restore the real getter (and let teardown see truth).
    let destroyed = false;
    Object.defineProperty(renderer, "isDestroyed", {
      configurable: true,
      get() {
        return destroyed;
      },
    });

    try {
      const writer = new SplitFooterScrollbackWriter();
      const runtime = new ScriptedCommitRuntime({
        // A single settled (tool) final. The renderer reports destroyed for the
        // first pass, so the pass bails before the commit is processed and the
        // cursor is NOT advanced past it.
        commitInputs: [
          {
            id: "wire:s:t:tool:tool-1",
            logicalId: "turn:s:t:tool:tool-1",
            kind: "tool",
            phase: "final",
            text: "tool output",
          },
        ],
        messages: [],
      });
      const controller = runtime.asController();

      // First pass: the renderer reports destroyed, so runSyncOnce's guard bails
      // before peeking/draining. The commit is NOT processed; the cursor stays
      // undefined.
      destroyed = true;
      const firstCount = await writer.sync({ renderer, runtime: controller });
      expect(firstCount).toBe(0);
      // The aborted pass bailed before any peek (the abort guard precedes the
      // commit-log read), so it never even asked the runtime for commits.
      expect(runtime.peekCursorArgs).toEqual([]);

      // Revive the renderer and run again: the same commit is peeked from the
      // un-advanced (undefined) cursor and NOW processed -> 1 settled commit.
      destroyed = false;
      const secondCount = await writer.sync({ renderer, runtime: controller });
      expect(secondCount).toBe(1);
      // The retry peeked from undefined (the aborted pass never advanced the
      // cursor), proving two-phase ack held it back.
      expect(runtime.peekCursorArgs).toEqual([undefined]);

      // A THIRD pass now peeks from the advanced cursor (seq 0) and finds nothing.
      const thirdCount = await writer.sync({ renderer, runtime: controller });
      expect(thirdCount).toBe(0);
      expect(runtime.peekCursorArgs).toEqual([undefined, 0]);
    } finally {
      // Restore the real prototype getter so shutdown observes the true state.
      delete (renderer as unknown as { isDestroyed?: boolean }).isDestroyed;
      shutdownSplitFooterRenderer(renderer);
    }
  });

  // -------------------------------------------------------------------------
  // 5. Sweep/drain order + no double-render: a settled `user` precedes a
  //    streaming assistant tail in transcript.messages, and the log carries the
  //    assistant `progress`. The user is swept once; the assistant streams; the
  //    sweep STOPS at the streaming tail (does not render it).
  // -------------------------------------------------------------------------
  test("sweep stops at the streaming tail; the user is swept, the assistant streams", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });

    try {
      const writer = new SplitFooterScrollbackWriter();
      const runtime = new ScriptedCommitRuntime({
        // Only a progress commit for the in-flight assistant turn (no final yet).
        commitInputs: [
          {
            id: STREAM_ASSISTANT_ID,
            logicalId: ASSISTANT_LOGICAL_ID,
            kind: "assistant",
            phase: "progress",
            text: "# Heading\n\nStreaming answer.\n\n",
          },
        ],
        messages: [
          textMessage({ id: "user:0", role: "user", text: "the question" }),
          streamingTailMessage({ id: STREAM_ASSISTANT_ID, text: "Streaming answer." }),
        ],
      });

      const settledCount = await writer.sync({ renderer, runtime: runtime.asController() });

      // The sweep committed exactly the settled user message (1). The streaming
      // assistant tail was NOT swept (the scan stops at the first streaming
      // message) and the progress commit produced no settled count.
      expect(settledCount).toBe(1);

      // No label committed yet (the assistant turn has not received its final).
      expect(writer.committedLabelCount).toBe(0);

      // No leading spacer: within a single pass the commit DRAIN (step 2, which
      // creates the streaming entry) runs BEFORE the settled SWEEP (step 3, which
      // commits the user message). So at entry-creation time no content has been
      // committed yet -> the leading-spacer gate (hasCommittedContent) is false.
      expect(writer.committedSpacerCount).toBe(0);
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });

  // -------------------------------------------------------------------------
  // 6. Epoch reset: a first pass at epoch 0 commits; a later peek returns epoch 1
  //    -> the writer resets (cursor back to undefined, sets cleared) and replays
  //    from the start.
  // -------------------------------------------------------------------------
  test("epoch reset: a session switch resets the cursor and replays the new log", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });

    try {
      const writer = new SplitFooterScrollbackWriter();
      const runtime = new ScriptedCommitRuntime({
        commitInputs: [
          {
            id: "wire:s1:t:tool:tool-a",
            logicalId: "turn:s1:t:tool:tool-a",
            kind: "tool",
            phase: "final",
            text: "session one tool",
          },
        ],
        epoch: 0,
        messages: [],
      });
      const controller = runtime.asController();

      const firstCount = await writer.sync({ renderer, runtime: controller });
      expect(firstCount).toBe(1);
      // Cursor advanced to seq 0; a follow-up peek would start from 0.
      expect(runtime.peekCursorArgs).toEqual([undefined]);

      // Session switch: bump the epoch and install a NEW log (fresh seq from 0).
      runtime.setEpoch(1);
      runtime.setCommitInputs([
        {
          id: "wire:s2:t:tool:tool-b",
          logicalId: "turn:s2:t:tool:tool-b",
          kind: "tool",
          phase: "final",
          text: "session two tool",
        },
      ]);

      const secondCount = await writer.sync({ renderer, runtime: controller });
      // The new session's single tool final was committed (1), proving the writer
      // reset its cursor and replayed from the start instead of skipping seq 0.
      expect(secondCount).toBe(1);

      // The epoch-reset path re-peeks from undefined: the pass first peeks from
      // the advanced cursor (0), detects the epoch change, resets the cursor, then
      // re-peeks from undefined.
      expect(runtime.peekCursorArgs).toEqual([undefined, 0, undefined]);
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });

  // -------------------------------------------------------------------------
  // 6b. Session-switch replay boundary: an epoch change clears the renderer's
  //     native scrollback (resetSplitFooterForReplay with clearSavedLines) BEFORE
  //     replaying the new session, so the new session REPLACES the old one in
  //     scrollback instead of appending below it.
  // -------------------------------------------------------------------------
  test("session switch: an epoch change clears native scrollback before replaying the new session", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });
    const replaySpy = spyResetSplitFooterForReplay(renderer);

    try {
      const writer = new SplitFooterScrollbackWriter();
      const runtime = new ScriptedCommitRuntime({
        commitInputs: [
          {
            id: "wire:s1:t:tool:tool-a",
            logicalId: "turn:s1:t:tool:tool-a",
            kind: "tool",
            phase: "final",
            text: "session one tool",
          },
        ],
        epoch: 0,
        messages: [],
      });
      const controller = runtime.asController();

      const firstCount = await writer.sync({ renderer, runtime: controller });
      expect(firstCount).toBe(1);
      // No clear on the FIRST sync: the writer adopts the initial epoch without a
      // boundary (there is no prior session to replace).
      expect(replaySpy.calls).toEqual([]);
      expect(writer.replayBoundaryClearCount).toBe(0);

      // Session switch: bump the epoch and install a NEW log (fresh seq from 0).
      runtime.setEpoch(1);
      runtime.setCommitInputs([
        {
          id: "wire:s2:t:tool:tool-b",
          logicalId: "turn:s2:t:tool:tool-b",
          kind: "tool",
          phase: "final",
          text: "session two tool",
        },
      ]);

      const secondCount = await writer.sync({ renderer, runtime: controller });
      // The new session's single tool final was committed (1): the boundary
      // cleared, then the drain replayed the new log from the start.
      expect(secondCount).toBe(1);
      // EXACTLY ONE clear fired, and it requested clearSavedLines (so the
      // terminal's saved scrollback lines are wiped, not just the live region).
      expect(replaySpy.calls).toEqual([{ clearSavedLines: true }]);
      expect(writer.replayBoundaryClearCount).toBe(1);
    } finally {
      replaySpy.restore();
      shutdownSplitFooterRenderer(renderer);
    }
  });

  // -------------------------------------------------------------------------
  // 6c. No clear on a plain streaming sync: progress + a streamed final in the
  //     SAME epoch must NOT touch the replay boundary (the boundary is for a
  //     session switch only, never for ordinary streaming).
  // -------------------------------------------------------------------------
  test("plain streaming sync: no epoch change -> the replay boundary never fires", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });
    const replaySpy = spyResetSplitFooterForReplay(renderer);

    try {
      const writer = new SplitFooterScrollbackWriter();
      const runtime = new ScriptedCommitRuntime({
        commitInputs: [
          {
            id: STREAM_ASSISTANT_ID,
            logicalId: ASSISTANT_LOGICAL_ID,
            kind: "assistant",
            phase: "progress",
            text: "Hello",
          },
          {
            id: STREAM_ASSISTANT_ID,
            logicalId: ASSISTANT_LOGICAL_ID,
            kind: "assistant",
            phase: "final",
            text: "Hello world done",
          },
        ],
        epoch: 0,
        messages: [],
      });
      const controller = runtime.asController();

      const firstCount = await writer.sync({ renderer, runtime: controller });
      // The streamed turn settled (1) — but no session switch, so no clear.
      expect(firstCount).toBe(1);
      expect(replaySpy.calls).toEqual([]);
      expect(writer.replayBoundaryClearCount).toBe(0);

      // A second sync in the SAME epoch (idempotent) also leaves the boundary
      // untouched.
      const secondCount = await writer.sync({ renderer, runtime: controller });
      expect(secondCount).toBe(0);
      expect(replaySpy.calls).toEqual([]);
      expect(writer.replayBoundaryClearCount).toBe(0);
    } finally {
      replaySpy.restore();
      shutdownSplitFooterRenderer(renderer);
    }
  });

  // -------------------------------------------------------------------------
  // 6d. External-editor suspend does NOT clear native scrollback: the editor
  //     draws on the alt screen, so on exit the committed transcript is still in
  //     native scrollback. suspend() preserves the cursor/de-dup state and a
  //     same-epoch resume must NOT fire the replay boundary (no double-clear of
  //     content that is correctly still on screen).
  // -------------------------------------------------------------------------
  test("editor suspend: a same-epoch resume after suspend() does not clear native scrollback", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });
    const replaySpy = spyResetSplitFooterForReplay(renderer);

    try {
      const writer = new SplitFooterScrollbackWriter();
      const runtime = new ScriptedCommitRuntime({
        commitInputs: [
          {
            id: "wire:s:t1:tool:tool-a",
            logicalId: "turn:s:t1:tool:tool-a",
            kind: "tool",
            phase: "final",
            text: "committed before editor",
          },
        ],
        epoch: 0,
        messages: [],
      });
      const controller = runtime.asController();

      const firstCount = await writer.sync({ renderer, runtime: controller });
      expect(firstCount).toBe(1);
      expect(replaySpy.calls).toEqual([]);

      // External-editor round-trip: the host suspends the writer (preserving the
      // cursor + de-dup state) and the editor returns. The epoch is UNCHANGED.
      writer.suspend();

      // A post-editor turn appends a new commit at a higher seq in the SAME epoch.
      runtime.setCommitInputs([
        {
          id: "wire:s:t1:tool:tool-a",
          logicalId: "turn:s:t1:tool:tool-a",
          kind: "tool",
          phase: "final",
          text: "committed before editor",
        },
        {
          id: "wire:s:t2:tool:tool-b",
          logicalId: "turn:s:t2:tool:tool-b",
          kind: "tool",
          phase: "final",
          text: "committed after editor",
        },
      ]);

      const resumeCount = await writer.sync({ renderer, runtime: controller });
      // The post-editor turn committed forward (1) from the preserved cursor, and
      // the replay boundary NEVER fired: native scrollback was left intact.
      expect(resumeCount).toBe(1);
      expect(replaySpy.calls).toEqual([]);
      expect(writer.replayBoundaryClearCount).toBe(0);
    } finally {
      replaySpy.restore();
      shutdownSplitFooterRenderer(renderer);
    }
  });

  // -------------------------------------------------------------------------
  // 7. Spacer / label / splash counters (carried over from the prior suite where
  //    still meaningful under the commit protocol).
  // -------------------------------------------------------------------------

  // 7a. NO leading spacer when the streaming entry is the first scrollback
  //     content (no prior committed content).
  test("no leading spacer when the streaming entry is the first scrollback content", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });

    try {
      const writer = new SplitFooterScrollbackWriter();
      const runtime = new ScriptedCommitRuntime({
        commitInputs: [
          {
            id: STREAM_ASSISTANT_ID,
            logicalId: ASSISTANT_LOGICAL_ID,
            kind: "assistant",
            phase: "progress",
            text: "# Title\n\nFirst.\n\n",
          },
        ],
        messages: [],
      });

      const settledCount = await writer.sync({ renderer, runtime: runtime.asController() });

      // No settled commit (only a progress), and no spacer (the streaming entry
      // is the very first content).
      expect(settledCount).toBe(0);
      expect(writer.committedSpacerCount).toBe(0);
      expect(writer.committedLabelCount).toBe(0);
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });

  // 7b. The spacer is committed once per entry, not on every progress update.
  test("spacer is committed once per entry, not on every progress update", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });

    try {
      const writer = new SplitFooterScrollbackWriter();
      const runtime = new ScriptedCommitRuntime({
        commitInputs: [
          {
            id: "wire:s:t:tool:tool-prior",
            logicalId: "turn:s:t:tool:tool-prior",
            kind: "tool",
            phase: "final",
            text: "prior content",
          },
          {
            id: STREAM_ASSISTANT_ID,
            logicalId: ASSISTANT_LOGICAL_ID,
            kind: "assistant",
            phase: "progress",
            text: "# Title\n\nFirst.\n\n",
          },
        ],
        messages: [],
      });
      const controller = runtime.asController();

      await writer.sync({ renderer, runtime: controller });
      // Prior committed content (the tool final) exists, so the streaming entry
      // received exactly one leading spacer.
      expect(writer.committedSpacerCount).toBe(1);

      // Append more progress for the SAME streaming entry; the writer re-peeks the
      // appended commit and only UPDATES the entry -> no second spacer.
      runtime.setCommitInputs([
        {
          id: "wire:s:t:tool:tool-prior",
          logicalId: "turn:s:t:tool:tool-prior",
          kind: "tool",
          phase: "final",
          text: "prior content",
        },
        {
          id: STREAM_ASSISTANT_ID,
          logicalId: ASSISTANT_LOGICAL_ID,
          kind: "assistant",
          phase: "progress",
          text: "# Title\n\nFirst.\n\n",
        },
        {
          id: STREAM_ASSISTANT_ID,
          logicalId: ASSISTANT_LOGICAL_ID,
          kind: "assistant",
          phase: "progress",
          text: "# Title\n\nFirst.\n\nSecond paragraph.\n\n",
        },
      ]);
      await writer.sync({ renderer, runtime: controller });
      expect(writer.committedSpacerCount).toBe(1);
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });

  // 7c. commitSplashBanner: commits once, is idempotent, and counts as prior
  //     content so a subsequent streaming entry gets its leading spacer.
  test("commitSplashBanner: commits once and marks prior content for the spacer", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });

    try {
      const writer = new SplitFooterScrollbackWriter();
      const runtime = new ScriptedCommitRuntime({ commitInputs: [], messages: [] });
      const controller = runtime.asController();

      writer.commitSplashBanner({ renderer, runtime: controller });
      expect(writer.committedBannerCount).toBe(1);

      // Idempotent within a session.
      writer.commitSplashBanner({ renderer, runtime: controller });
      expect(writer.committedBannerCount).toBe(1);

      // A streaming assistant turn now arrives. Because the banner is prior
      // content, the streaming entry gets a leading spacer.
      runtime.setCommitInputs([
        {
          id: STREAM_ASSISTANT_ID,
          logicalId: ASSISTANT_LOGICAL_ID,
          kind: "assistant",
          phase: "progress",
          text: "# Heading\n\nFirst paragraph.\n\n",
        },
      ]);
      await writer.sync({ renderer, runtime: controller });
      expect(writer.committedSpacerCount).toBe(1);
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });

  // 7d. A streamed text-only turn commits exactly one assistant label row when it
  //     settles (the streamed message matches a settled assistant's layout).
  test("a streamed turn commits exactly one assistant label row on settle", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });

    try {
      const writer = new SplitFooterScrollbackWriter();
      const runtime = new ScriptedCommitRuntime({
        commitInputs: [
          {
            id: STREAM_ASSISTANT_ID,
            logicalId: ASSISTANT_LOGICAL_ID,
            kind: "assistant",
            phase: "progress",
            text: "# Heading\n\nFirst paragraph.\n\n",
          },
        ],
        messages: [],
      });
      const controller = runtime.asController();

      await writer.sync({ renderer, runtime: controller });
      // Mid-stream: no label committed yet.
      expect(writer.committedLabelCount).toBe(0);

      // Append the streamed final (SAME id) -> applyFinal finishes the entry and
      // commits exactly one label row.
      runtime.setCommitInputs([
        {
          id: STREAM_ASSISTANT_ID,
          logicalId: ASSISTANT_LOGICAL_ID,
          kind: "assistant",
          phase: "progress",
          text: "# Heading\n\nFirst paragraph.\n\n",
        },
        {
          id: STREAM_ASSISTANT_ID,
          logicalId: ASSISTANT_LOGICAL_ID,
          kind: "assistant",
          phase: "final",
          text: "# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n\n",
        },
      ]);
      const settledCount = await writer.sync({ renderer, runtime: controller });

      // The streamed final finished the entry (counts as one settled) and committed
      // exactly one label row.
      expect(settledCount).toBe(1);
      expect(writer.committedLabelCount).toBe(1);
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });

  // 7e. End-to-end: a streamed turn (progress -> final) actually writes rows to
  //     the renderer's native scrollback. The other streamed-turn tests assert
  //     the writer's own counters (label/settled); this one observes the
  //     renderer-side signal directly — `external_output` fires once per
  //     writeToScrollback — so the whole streaming -> scrollback pipeline is
  //     exercised, not just the bookkeeping.
  test("a streamed turn writes rows to native scrollback (external_output fires)", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });
    const counter = countExternalOutputEvents(renderer);

    try {
      const writer = new SplitFooterScrollbackWriter();
      const runtime = new ScriptedCommitRuntime({
        // A single self-contained turn: one progress chunk then its streamed
        // final (SAME id). The stable markdown block ("# Heading\n\nBody.") is
        // committed by the streaming entry; the final commits the label row.
        commitInputs: [
          {
            id: STREAM_ASSISTANT_ID,
            logicalId: ASSISTANT_LOGICAL_ID,
            kind: "assistant",
            phase: "progress",
            text: "# Heading\n\nFirst paragraph.\n\n",
          },
          {
            id: STREAM_ASSISTANT_ID,
            logicalId: ASSISTANT_LOGICAL_ID,
            kind: "assistant",
            phase: "final",
            text: "# Heading\n\nFirst paragraph.\n\nSecond paragraph.\n\n",
          },
        ],
        messages: [],
      });

      const settledCount = await writer.sync({ renderer, runtime: runtime.asController() });

      // The turn settled as exactly one assistant message with its label row.
      expect(settledCount).toBe(1);
      expect(writer.committedLabelCount).toBe(1);
      // At least two scrollback writes reached the renderer: the streamed
      // markdown body block(s) plus the assistant label row. The exact count
      // depends on block segmentation, so assert the floor, not an exact value.
      expect(counter.count).toBeGreaterThanOrEqual(2);
    } finally {
      counter.cleanup();
      shutdownSplitFooterRenderer(renderer);
    }
  });

  // -------------------------------------------------------------------------
  // 8. reset() destroys the active streaming entry WITHOUT committing it, then
  //    re-arms: a subsequent sync replays the log from the start.
  // -------------------------------------------------------------------------
  test("reset(): active entry is destroyed (not committed) and state re-arms for a replay", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });
    const counter = countExternalOutputEvents(renderer);

    try {
      const writer = new SplitFooterScrollbackWriter();
      const runtime = new ScriptedCommitRuntime({
        commitInputs: [
          {
            id: "wire:s:t:tool:tool-1",
            logicalId: "turn:s:t:tool:tool-1",
            kind: "tool",
            phase: "final",
            text: "settled tool",
          },
          {
            id: STREAM_ASSISTANT_ID,
            logicalId: ASSISTANT_LOGICAL_ID,
            kind: "assistant",
            phase: "progress",
            text: "# Heading\n\nStreaming.\n\n",
          },
        ],
        messages: [],
      });
      const controller = runtime.asController();

      const firstCount = await writer.sync({ renderer, runtime: controller });
      // The tool final committed (1); the assistant progress created a live entry.
      expect(firstCount).toBe(1);
      const countAfterFirst = counter.count;

      // reset() destroys the active entry WITHOUT committing its remainder and
      // clears the de-dup state + cursor. Synchronous; must not throw.
      writer.reset();

      // A fresh sync replays the same log from the start: the tool final
      // re-commits (1) and the assistant entry is re-created.
      const secondCount = await writer.sync({ renderer, runtime: controller });
      expect(secondCount).toBe(1);
      // The replay produced at least one fresh settled external_output event.
      expect(counter.count).toBeGreaterThanOrEqual(countAfterFirst + 1);
    } finally {
      counter.cleanup();
      shutdownSplitFooterRenderer(renderer);
    }
  });

  // -------------------------------------------------------------------------
  // 8b. suspend() (P1-2, THE headline fix): an external-editor round-trip
  //     SUSPENDS the writer (destroys active entries, PRESERVES cursor + de-dup
  //     state). The remount's first sync resumes from the preserved cursor and
  //     re-commits NOTHING, even though the SAME append-only log is re-read from
  //     the start (cursor === undefined would have re-drained it).
  // -------------------------------------------------------------------------
  test("suspend(): a settled transcript is NOT re-committed after an editor round-trip", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });
    const counter = countExternalOutputEvents(renderer);

    try {
      const writer = new SplitFooterScrollbackWriter();
      const runtime = new ScriptedCommitRuntime({
        // Two settled tool finals already drained before the editor opens.
        commitInputs: [
          {
            id: "wire:s:t:tool:tool-1",
            logicalId: "turn:s:t:tool:tool-1",
            kind: "tool",
            phase: "final",
            text: "settled tool one",
          },
          {
            id: "wire:s:t:tool:tool-2",
            logicalId: "turn:s:t:tool:tool-2",
            kind: "tool",
            phase: "final",
            text: "settled tool two",
          },
        ],
        messages: [],
      });
      const controller = runtime.asController();

      const firstCount = await writer.sync({ renderer, runtime: controller });
      expect(firstCount).toBe(2);
      const eventsAfterDrain = counter.count;
      expect(eventsAfterDrain).toBe(2);
      // Cursor advanced past the second commit (seq 1); a follow-up would peek from 1.
      expect(runtime.peekCursorArgs).toEqual([undefined]);

      // The editor round-trip: unmount suspends (NOT resets) the writer. The
      // cursor + committedMessageIds are preserved across the suspend.
      writer.suspend();

      // Remount: the first sync re-reads the SAME log. Because the cursor is
      // preserved (seq 1), since(cursor) returns NOTHING -> zero re-commits.
      const resumedCount = await writer.sync({ renderer, runtime: controller });
      expect(resumedCount).toBe(0);
      // No NEW external_output events: the transcript was not re-committed.
      expect(counter.count).toBe(eventsAfterDrain);
      // The resume peeked from the PRESERVED cursor (1), not from undefined —
      // proving suspend() did not rebase the cursor to the start.
      expect(runtime.peekCursorArgs).toEqual([undefined, 1]);
    } finally {
      counter.cleanup();
      shutdownSplitFooterRenderer(renderer);
    }
  });

  // -------------------------------------------------------------------------
  // 8c. suspend() vs reset() contrast: the SAME drained-then-replayed log
  //     re-commits everything after reset() (cursor cleared) but nothing after
  //     suspend() (cursor preserved). One test, two writers, identical input.
  // -------------------------------------------------------------------------
  test("suspend() preserves the cursor where reset() rebases it to the start", async () => {
    const commitInputs = [
      {
        id: "wire:s:t:tool:tool-1",
        logicalId: "turn:s:t:tool:tool-1",
        kind: "tool" as const,
        phase: "final" as const,
        text: "settled tool",
      },
    ];

    // reset() arm: after reset the same log re-commits (cursor back to undefined).
    const resetRenderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });
    try {
      const writer = new SplitFooterScrollbackWriter();
      const runtime = new ScriptedCommitRuntime({ commitInputs, messages: [] });
      const controller = runtime.asController();
      expect(await writer.sync({ renderer: resetRenderer, runtime: controller })).toBe(1);
      writer.reset();
      // reset() rebased the cursor: the replay re-commits the single final.
      expect(await writer.sync({ renderer: resetRenderer, runtime: controller })).toBe(1);
      expect(runtime.peekCursorArgs).toEqual([undefined, undefined]);
    } finally {
      shutdownSplitFooterRenderer(resetRenderer);
    }

    // suspend() arm: identical input, but after suspend the replay commits nothing.
    const suspendRenderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });
    try {
      const writer = new SplitFooterScrollbackWriter();
      const runtime = new ScriptedCommitRuntime({ commitInputs, messages: [] });
      const controller = runtime.asController();
      expect(await writer.sync({ renderer: suspendRenderer, runtime: controller })).toBe(1);
      writer.suspend();
      // suspend() preserved the cursor (seq 0): the replay finds nothing forward.
      expect(await writer.sync({ renderer: suspendRenderer, runtime: controller })).toBe(0);
      expect(runtime.peekCursorArgs).toEqual([undefined, 0]);
    } finally {
      shutdownSplitFooterRenderer(suspendRenderer);
    }
  });

  // -------------------------------------------------------------------------
  // 8d. suspend() destroys an in-flight streaming entry (editor opened
  //     mid-stream). That turn's later `final` then finds NO active entry, so
  //     applyFinal commits the whole message via TranscriptMessageView ONCE
  //     (content preserved, not doubled).
  // -------------------------------------------------------------------------
  test("suspend(): mid-stream entry is destroyed; the later final commits the message once", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });

    try {
      const writer = new SplitFooterScrollbackWriter();
      const runtime = new ScriptedCommitRuntime({
        // A turn is mid-stream: one progress commit, no final yet.
        commitInputs: [
          {
            id: STREAM_ASSISTANT_ID,
            logicalId: ASSISTANT_LOGICAL_ID,
            kind: "assistant",
            phase: "progress",
            text: "# Heading\n\nStreaming answer.\n\n",
          },
        ],
        messages: [],
      });
      const controller = runtime.asController();

      await writer.sync({ renderer, runtime: controller });
      // The active entry exists but has committed no label yet.
      expect(writer.committedLabelCount).toBe(0);

      // Editor opens mid-stream: suspend destroys the active entry (no commit of
      // its remainder, no label). Must not throw.
      writer.suspend();

      // The turn now settles with its committed final (DIFFERENT id, SAME logical
      // id — the wireFold re-segmentation). With the streaming entry gone AND the
      // logical id never marked streamed (the entry was destroyed before its
      // final), applyFinal commits the message via TranscriptMessageView ONCE.
      runtime.setCommitInputs([
        {
          id: STREAM_ASSISTANT_ID,
          logicalId: ASSISTANT_LOGICAL_ID,
          kind: "assistant",
          phase: "progress",
          text: "# Heading\n\nStreaming answer.\n\n",
        },
        {
          id: COMMITTED_ASSISTANT_ID_0,
          logicalId: ASSISTANT_LOGICAL_ID,
          kind: "assistant",
          phase: "final",
          text: "# Heading\n\nStreaming answer.\n\n",
        },
      ]);
      const settledCount = await writer.sync({ renderer, runtime: controller });

      // Exactly one settled commit for the turn (the committed final via
      // TranscriptMessageView). No streamed label (the entry was destroyed before
      // it could finish), so the answer is NOT doubled.
      expect(settledCount).toBe(1);
      expect(writer.committedLabelCount).toBe(0);
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });

  // -------------------------------------------------------------------------
  // 9. Concurrent syncs coalesce into a single trailing run; whenIdle resolves
  //    after the loop drains (no overlap, no throw).
  // -------------------------------------------------------------------------
  test("concurrent syncs coalesce into a single trailing run", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });

    try {
      const writer = new SplitFooterScrollbackWriter();
      const runtime = new ScriptedCommitRuntime({
        commitInputs: [
          {
            id: "wire:s:t:tool:tool-1",
            logicalId: "turn:s:t:tool:tool-1",
            kind: "tool",
            phase: "final",
            text: "settled tool one",
          },
          {
            id: "wire:s:t:tool:tool-2",
            logicalId: "turn:s:t:tool:tool-2",
            kind: "tool",
            phase: "final",
            text: "settled tool two",
          },
        ],
        messages: [],
      });
      const controller = runtime.asController();

      // Fire three syncs without awaiting between them: the first runs, the others
      // coalesce into one trailing run.
      const p1 = writer.sync({ renderer, runtime: controller });
      const p2 = writer.sync({ renderer, runtime: controller });
      const p3 = writer.sync({ renderer, runtime: controller });

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      // First pass commits the two settled finals; coalesced passes observe the
      // drained (idempotent) state -> 0 additional settled commits.
      expect(r1).toBe(2);
      expect(r2).toBe(0);
      expect(r3).toBe(0);

      // whenIdle resolves after the loop fully drains, yielding the trailing pass
      // count (0 — nothing new to commit).
      const idleCount = await writer.whenIdle();
      expect(idleCount).toBe(0);
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });

  // -------------------------------------------------------------------------
  // 10. Rewind/redo robustness (Task 2): a rewind mutates the SAME session in
  //     place (refreshFromSession + requestSync) WITHOUT calling mountSession, so
  //     `#sessionGeneration` (== epoch) does NOT change AND the append-only
  //     ScrollbackCommitLog is NOT reset (its `reset()` runs only via the
  //     bundle-switch replace() path, which bumps the generation). The log keeps
  //     growing monotonically in the same epoch, so post-rewind turns append
  //     commits with HIGHER seq — the writer's preserved cursor still sees them
  //     via since(cursor). This reproduces that: a post-rewind turn must still
  //     commit forward (the writer is never STUCK).
  //
  //     Scoped behavior (documented, by design): the rows this same-epoch rewind
  //     abandons stay in the terminal's native scrollback. @opentui/core@0.4.1
  //     DOES expose a scrollback-clear API (resetSplitFooterForReplay), but the
  //     writer only fires it at a REPLAY BOUNDARY (epoch/session switch via
  //     beginReplayBoundary) — an in-place same-epoch rewind never crosses one, so
  //     no clear runs. The writer does not un-write the abandoned rows here; it
  //     only guarantees forward progress for new turns.
  // -------------------------------------------------------------------------
  test("rewind: the writer keeps committing forward after a same-epoch log growth (not stuck)", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });

    try {
      const writer = new SplitFooterScrollbackWriter();
      const runtime = new ScriptedCommitRuntime({
        // Pre-rewind turn: a single committed assistant final.
        commitInputs: [
          {
            id: "wire:s:t1:a:assistant:committed:index:0",
            logicalId: "turn:s:t1:a:assistant",
            kind: "assistant",
            phase: "final",
            text: "answer to the first turn",
          },
        ],
        epoch: 0,
        messages: [],
      });
      const controller = runtime.asController();

      const firstCount = await writer.sync({ renderer, runtime: controller });
      expect(firstCount).toBe(1);
      // Cursor advanced to seq 0.
      expect(runtime.peekCursorArgs).toEqual([undefined]);

      // Rewind happens: SAME epoch (no mountSession), and the log is NOT reset.
      // A new post-rewind turn appends MORE commits at HIGHER seq (seq 1 here).
      // The epoch is deliberately UNCHANGED to model the in-place rewind.
      runtime.setCommitInputs([
        {
          id: "wire:s:t1:a:assistant:committed:index:0",
          logicalId: "turn:s:t1:a:assistant",
          kind: "assistant",
          phase: "final",
          text: "answer to the first turn",
        },
        {
          id: "wire:s:t2:a:assistant:committed:index:0",
          logicalId: "turn:s:t2:a:assistant",
          kind: "assistant",
          phase: "final",
          text: "answer to the post-rewind turn",
        },
      ]);

      const secondCount = await writer.sync({ renderer, runtime: controller });
      // The post-rewind turn committed forward (1) — the writer is NOT stuck. It
      // peeked from the preserved cursor (0) and found the new seq-1 commit.
      expect(secondCount).toBe(1);
      expect(runtime.peekCursorArgs).toEqual([undefined, 0]);

      // A redundant sync now finds nothing (cursor at seq 1) — idempotent, still
      // not stuck for a future turn.
      const thirdCount = await writer.sync({ renderer, runtime: controller });
      expect(thirdCount).toBe(0);
      expect(runtime.peekCursorArgs).toEqual([undefined, 0, 1]);
    } finally {
      shutdownSplitFooterRenderer(renderer);
    }
  });

  // -------------------------------------------------------------------------
  // 11. FULL rewind replay boundary (the headline of this change). An in-place
  //     rewind bumps `rewindGeneration` WITHOUT changing the epoch and WITHOUT
  //     resetting the log. The writer must:
  //       (a) clear native scrollback EXACTLY ONCE (clearSavedLines: true);
  //       (b) NOT re-drain the abandoned commits (cursor advanced to the log
  //           tail, so the abandoned seq is skipped — proven by the re-peek
  //           slice omitting the abandoned id);
  //       (c) re-render the now-SHORTER transcript purely via the settled SWEEP;
  //       (d) keep draining genuinely-new post-rewind turns forward.
  // -------------------------------------------------------------------------
  test("rewind: clears native scrollback once and re-sweeps the shorter transcript without re-committing the abandoned turn", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });
    const replaySpy = spyResetSplitFooterForReplay(renderer);
    const counter = countExternalOutputEvents(renderer);

    const SURVIVING_ID = "wire:s:t1:a:assistant:committed:index:0";
    const ABANDONED_ID = "wire:s:t2:a:assistant:committed:index:0";
    const REWIND_MARKER_ID = "rewind:s:marker";
    const POST_REWIND_ID = "wire:s:t3:a:assistant:committed:index:0";

    try {
      const writer = new SplitFooterScrollbackWriter();
      // Pre-rewind: two committed assistant turns drained from the log (seq 0, 1).
      // The transcript carries both surviving + abandoned messages.
      const runtime = new ScriptedCommitRuntime({
        commitInputs: [
          {
            id: SURVIVING_ID,
            logicalId: "turn:s:t1:a:assistant",
            kind: "assistant",
            phase: "final",
            text: "answer to turn one (surviving)",
          },
          {
            id: ABANDONED_ID,
            logicalId: "turn:s:t2:a:assistant",
            kind: "assistant",
            phase: "final",
            text: "answer to turn two (abandoned by the rewind)",
          },
        ],
        epoch: 0,
        rewindGeneration: 0,
        messages: [
          textMessage({
            id: SURVIVING_ID,
            role: "assistant",
            text: "answer to turn one (surviving)",
          }),
          textMessage({
            id: ABANDONED_ID,
            role: "assistant",
            text: "answer to turn two (abandoned)",
          }),
        ],
      });
      const controller = runtime.asController();

      // Both pre-rewind turns reached scrollback via the drain (cursor -> seq 1).
      const firstCount = await writer.sync({ renderer, runtime: controller });
      expect(firstCount).toBe(2);
      expect(writer.replayBoundaryClearCount).toBe(0);
      expect(replaySpy.calls).toEqual([]);
      const eventsAfterFirst = counter.count;
      expect(eventsAfterFirst).toBe(2);

      // Rewind to turn 1: SAME epoch, SAME log (abandoned seq-1 commit stays in
      // it behind the cursor). The handler bumps the rewind generation, then
      // refreshFromSession rebuilds the SHORTER transcript: the surviving turn +
      // the rewind marker, WITHOUT the abandoned turn.
      runtime.bumpRewindGeneration();
      runtime.setMessages([
        textMessage({
          id: SURVIVING_ID,
          role: "assistant",
          text: "answer to turn one (surviving)",
        }),
        textMessage({ id: REWIND_MARKER_ID, role: "assistant", text: "Session rewind applied." }),
      ]);

      const rewindCount = await writer.sync({ renderer, runtime: controller });

      // (a) Cleared EXACTLY ONCE, with clearSavedLines (the whole terminal
      //     scrollback history is wiped, not just the live region).
      expect(writer.replayBoundaryClearCount).toBe(1);
      expect(replaySpy.calls).toEqual([{ clearSavedLines: true }]);

      // (c) The shorter transcript (2 messages) re-rendered via the SWEEP: both
      //     swept messages are settled commits. The abandoned turn is NOT among
      //     them (it is gone from the transcript), so it is not re-rendered.
      expect(rewindCount).toBe(2);

      // (b) The cursor advanced to the log tail (seq 1) at the boundary, so the
      //     re-peek after the clear returns an EMPTY slice — the abandoned seq-1
      //     commit is skipped, never drained/re-emitted. The peek sequence is:
      //     [undefined] (first sync), then on the rewind sync [1] (detect rewind
      //     from the un-advanced cursor) and [1] again (re-peek from the tail).
      expect(runtime.peekCursorArgs).toEqual([undefined, 1, 1]);
      const sliceAfterBoundary = runtime.servedSlices.at(-1);
      expect(sliceAfterBoundary).toEqual([]);
      // The abandoned id appears in NO post-boundary slice the writer drained.
      expect(runtime.servedSlices.slice(1).flat()).not.toContain(ABANDONED_ID);

      // The sweep emitted exactly two fresh scrollback rows (one per surviving
      // message), and nothing for the abandoned turn.
      expect(counter.count).toBe(eventsAfterFirst + 2);

      // (d) A genuinely-new post-rewind turn appends at a HIGHER seq (2) and
      //     drains forward normally — the writer is not stuck after the boundary.
      runtime.setCommitInputs([
        {
          id: SURVIVING_ID,
          logicalId: "turn:s:t1:a:assistant",
          kind: "assistant",
          phase: "final",
          text: "answer to turn one (surviving)",
        },
        {
          id: ABANDONED_ID,
          logicalId: "turn:s:t2:a:assistant",
          kind: "assistant",
          phase: "final",
          text: "answer to turn two (abandoned)",
        },
        {
          id: POST_REWIND_ID,
          logicalId: "turn:s:t3:a:assistant",
          kind: "assistant",
          phase: "final",
          text: "answer to the new post-rewind turn",
        },
      ]);

      const forwardCount = await writer.sync({ renderer, runtime: controller });
      // Exactly the new turn committed (1); no second clear (rewind generation
      // unchanged); the abandoned turn was still skipped.
      expect(forwardCount).toBe(1);
      expect(writer.replayBoundaryClearCount).toBe(1);
      expect(replaySpy.calls).toEqual([{ clearSavedLines: true }]);
      // The forward drain peeked from the tail (1) and served ONLY the new seq-2
      // commit — never the abandoned seq-1 commit.
      expect(runtime.servedSlices.at(-1)).toEqual([POST_REWIND_ID]);
    } finally {
      counter.cleanup();
      replaySpy.restore();
      shutdownSplitFooterRenderer(renderer);
    }
  });

  // -------------------------------------------------------------------------
  // 12. Redo replay boundary: a redo is another in-place same-epoch mutation
  //     (rewindGeneration bumps, epoch unchanged). It clears native scrollback
  //     once and re-sweeps the restored (longer-again) transcript, skipping the
  //     pre-redo branch commits still sitting in the log behind the cursor.
  // -------------------------------------------------------------------------
  test("redo: clears native scrollback once and re-sweeps the restored transcript via the sweep", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });
    const replaySpy = spyResetSplitFooterForReplay(renderer);
    const counter = countExternalOutputEvents(renderer);

    const TURN_ONE_ID = "wire:s:t1:a:assistant:committed:index:0";
    const REDONE_ID = "wire:s:t2:a:assistant:committed:index:0";
    const REDO_MARKER_ID = "rewind:s:redo-marker";

    try {
      const writer = new SplitFooterScrollbackWriter();
      // Post-rewind state: only turn one is in the log/transcript (the writer has
      // already drained seq 0). A redo will restore turn two.
      const runtime = new ScriptedCommitRuntime({
        commitInputs: [
          {
            id: TURN_ONE_ID,
            logicalId: "turn:s:t1:a:assistant",
            kind: "assistant",
            phase: "final",
            text: "answer to turn one",
          },
        ],
        epoch: 0,
        rewindGeneration: 0,
        messages: [textMessage({ id: TURN_ONE_ID, role: "assistant", text: "answer to turn one" })],
      });
      const controller = runtime.asController();

      const firstCount = await writer.sync({ renderer, runtime: controller });
      expect(firstCount).toBe(1);
      expect(writer.replayBoundaryClearCount).toBe(0);
      const eventsAfterFirst = counter.count;
      expect(eventsAfterFirst).toBe(1);

      // Redo: same epoch, the handler bumps the rewind generation, then
      // refreshFromSession rebuilds the RESTORED transcript (turn one + the redone
      // turn two + a redo marker). The pre-redo log keeps its seq-0 commit behind
      // the cursor.
      runtime.bumpRewindGeneration();
      runtime.setMessages([
        textMessage({ id: TURN_ONE_ID, role: "assistant", text: "answer to turn one" }),
        textMessage({ id: REDONE_ID, role: "assistant", text: "answer to turn two (redone)" }),
        textMessage({ id: REDO_MARKER_ID, role: "assistant", text: "Session redo applied." }),
      ]);

      const redoCount = await writer.sync({ renderer, runtime: controller });

      // Cleared exactly once with clearSavedLines.
      expect(writer.replayBoundaryClearCount).toBe(1);
      expect(replaySpy.calls).toEqual([{ clearSavedLines: true }]);
      // All three restored messages re-rendered via the sweep.
      expect(redoCount).toBe(3);
      // The cursor advanced to the tail (seq 0), so the re-peek after the boundary
      // serves an empty slice — the pre-redo seq-0 commit is NOT re-drained.
      expect(runtime.peekCursorArgs).toEqual([undefined, 0, 0]);
      expect(runtime.servedSlices.at(-1)).toEqual([]);
      // Exactly three fresh scrollback rows from the sweep (one per restored
      // message); the pre-redo branch commit was not re-emitted via the drain.
      expect(counter.count).toBe(eventsAfterFirst + 3);
    } finally {
      counter.cleanup();
      replaySpy.restore();
      shutdownSplitFooterRenderer(renderer);
    }
  });

  // -------------------------------------------------------------------------
  // 13. Hydrated-history rewind (the last untested quadrant). The surviving
  //     post-rewind turn lives ONLY in transcript.messages (loaded from durable
  //     history via a snapshot, which emits NO commits) — it was NEVER appended
  //     to the commit log. So the settled SWEEP is its SOLE renderer, and the
  //     cursor-skip-to-tail is trivially safe (the only log commit is the
  //     abandoned branch). The earlier rewind/redo tests model surviving turns as
  //     DRAINED commits; this one models them as hydrated (sweep-only) state.
  //
  //     The writer must:
  //       (a) clear native scrollback EXACTLY ONCE (clearSavedLines: true);
  //       (b) re-render the surviving HYDRATED turn via the SWEEP (not the drain);
  //       (c) NOT re-drain the abandoned commit (cursor advanced to the tail, so
  //           the re-peek slice is empty — no double-write);
  //       (d) handle the cursor correctly (skip-to-tail, then idempotent).
  // -------------------------------------------------------------------------
  test("rewind: a hydrated (sweep-only) surviving turn re-renders via the sweep without re-draining the abandoned commit", async () => {
    const renderer = await createHeadlessSplitFooterRenderer({ columns: 80, rows: 40 });
    const replaySpy = spyResetSplitFooterForReplay(renderer);
    const counter = countExternalOutputEvents(renderer);

    // The surviving turn is HYDRATED: present in transcript.messages, absent from
    // the commit log. The abandoned turn is a LIVE commit (seq 0) the rewind drops.
    const HYDRATED_SURVIVOR_ID = "wire:s:t1:a:assistant:committed:index:0";
    const ABANDONED_ID = "wire:s:t2:a:assistant:committed:index:0";
    const REWIND_MARKER_ID = "rewind:s:marker";
    const POST_REWIND_ID = "wire:s:t3:a:assistant:committed:index:0";

    try {
      const writer = new SplitFooterScrollbackWriter();
      const runtime = new ScriptedCommitRuntime({
        // Only the abandoned turn is in the log. The surviving turn is hydrated
        // history (no commit) — the transcript carries both.
        commitInputs: [
          {
            id: ABANDONED_ID,
            logicalId: "turn:s:t2:a:assistant",
            kind: "assistant",
            phase: "final",
            text: "answer to turn two (abandoned by the rewind)",
          },
        ],
        epoch: 0,
        rewindGeneration: 0,
        messages: [
          textMessage({
            id: HYDRATED_SURVIVOR_ID,
            role: "assistant",
            text: "answer to turn one (hydrated, surviving)",
          }),
          textMessage({
            id: ABANDONED_ID,
            role: "assistant",
            text: "answer to turn two (abandoned)",
          }),
        ],
      });
      const controller = runtime.asController();

      // Pre-rewind sync: the abandoned commit drains (1) and the hydrated survivor
      // is swept (1). Two distinct rows reach scrollback; no boundary fires yet.
      const firstCount = await writer.sync({ renderer, runtime: controller });
      expect(firstCount).toBe(2);
      expect(writer.replayBoundaryClearCount).toBe(0);
      expect(replaySpy.calls).toEqual([]);
      const eventsAfterFirst = counter.count;
      expect(eventsAfterFirst).toBe(2);
      // The drain advanced the cursor to the abandoned commit's seq (0).
      expect(runtime.peekCursorArgs).toEqual([undefined]);

      // Rewind to turn one: SAME epoch, SAME log (the abandoned seq-0 commit stays
      // behind the cursor). The handler bumps the rewind generation; refreshFrom-
      // Session rebuilds the SHORTER transcript: the hydrated survivor + the rewind
      // marker, WITHOUT the abandoned turn. Neither survivor is in the commit log.
      runtime.bumpRewindGeneration();
      runtime.setMessages([
        textMessage({
          id: HYDRATED_SURVIVOR_ID,
          role: "assistant",
          text: "answer to turn one (hydrated, surviving)",
        }),
        textMessage({ id: REWIND_MARKER_ID, role: "assistant", text: "Session rewind applied." }),
      ]);

      const rewindCount = await writer.sync({ renderer, runtime: controller });

      // (a) Cleared EXACTLY ONCE, with clearSavedLines.
      expect(writer.replayBoundaryClearCount).toBe(1);
      expect(replaySpy.calls).toEqual([{ clearSavedLines: true }]);

      // (b) Both surviving messages re-rendered via the SWEEP (the drain served an
      //     empty slice — see (c)). The sweep is the SOLE renderer for the hydrated
      //     survivor; it was never a commit.
      expect(rewindCount).toBe(2);
      expect(counter.count).toBe(eventsAfterFirst + 2);

      // (c) The cursor advanced to the log tail (seq 0) at the boundary, so the
      //     re-peek after the clear serves an EMPTY slice — the abandoned seq-0
      //     commit is skipped, never drained/re-emitted (no double-write). Peek
      //     sequence: [undefined] (first sync), then on the rewind sync [0] (detect
      //     rewind from the un-advanced cursor) and [0] again (re-peek from tail).
      expect(runtime.peekCursorArgs).toEqual([undefined, 0, 0]);
      expect(runtime.servedSlices.at(-1)).toEqual([]);
      expect(runtime.servedSlices.slice(1).flat()).not.toContain(ABANDONED_ID);

      // (d) A genuinely-new post-rewind turn appends at a HIGHER seq (1) and drains
      //     forward normally — the cursor (now at the tail) is not stuck.
      runtime.setCommitInputs([
        {
          id: ABANDONED_ID,
          logicalId: "turn:s:t2:a:assistant",
          kind: "assistant",
          phase: "final",
          text: "answer to turn two (abandoned)",
        },
        {
          id: POST_REWIND_ID,
          logicalId: "turn:s:t3:a:assistant",
          kind: "assistant",
          phase: "final",
          text: "answer to the new post-rewind turn",
        },
      ]);

      const forwardCount = await writer.sync({ renderer, runtime: controller });
      // Exactly the new turn committed (1); no second clear (rewind generation
      // unchanged); the abandoned commit was still skipped.
      expect(forwardCount).toBe(1);
      expect(writer.replayBoundaryClearCount).toBe(1);
      expect(replaySpy.calls).toEqual([{ clearSavedLines: true }]);
      expect(runtime.servedSlices.at(-1)).toEqual([POST_REWIND_ID]);
    } finally {
      counter.cleanup();
      replaySpy.restore();
      shutdownSplitFooterRenderer(renderer);
    }
  });
});
