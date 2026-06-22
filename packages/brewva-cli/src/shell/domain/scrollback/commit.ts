// Append-only commit protocol for the split-footer scrollback writer.
//
// The legacy writer DIFFS the whole transcript by message id on every store
// change, which is O(history x updates) AND double-writes a turn's answer when
// `wireFold` rewrites message ids on commit (a streaming
// `wire:<sessionId>:<turnId>:<attemptId>:assistant:<sequence>` message becomes
// committed `…:assistant:committed:<…>` segments with DIFFERENT ids). This
// protocol replaces that with an append-only, typed log emitted incrementally
// by the projector and keyed by a STABLE logical id shared across a turn's
// progress and committed forms.
//
// This module is pure `src/` domain: NO `@opentui/*`. The writer's consumption
// is a later phase; nothing renders these commits yet.
import type { CliShellTranscriptMessage } from "../transcript.js";

export type ScrollbackCommitKind = "assistant" | "reasoning" | "tool" | "user" | "note" | "system";

export type ScrollbackCommitPhase = "progress" | "final";

export interface ScrollbackCommit {
  // STABLE across progress -> final for the same logical entry, e.g.
  // `turn:<sessionId>:<turnId>:<attemptId>:assistant`,
  // `turn:<sessionId>:<turnId>:tool:<toolCallId>`, `seed:<…>`, `user:<id>`.
  readonly logicalId: string;
  readonly kind: ScrollbackCommitKind;
  readonly phase: ScrollbackCommitPhase;
  // The renderable (sub)message for this commit; reuse existing rendering downstream.
  readonly message: CliShellTranscriptMessage;
  // Monotonic emission order across the whole log.
  readonly seq: number;
}

// Cursor into the append-only log. `undefined` means "from the beginning".
export type ScrollbackCommitCursor = number | undefined;

export interface ScrollbackCommitSlice {
  readonly commits: readonly ScrollbackCommit[];
  readonly cursor: ScrollbackCommitCursor;
}

/**
 * Append-only log of scrollback commits with a monotonic `seq`. The writer
 * (a later phase) drains it incrementally via `since(cursor)`; `reset()` clears
 * it for a full replay so the stream restarts from an empty, monotonic-from-0
 * state.
 */
export class ScrollbackCommitLog {
  readonly #commits: ScrollbackCommit[] = [];
  #nextSeq = 0;

  get length(): number {
    return this.#commits.length;
  }

  append(commit: Omit<ScrollbackCommit, "seq">): ScrollbackCommit {
    const entry: ScrollbackCommit = { ...commit, seq: this.#nextSeq };
    this.#nextSeq += 1;
    this.#commits.push(entry);
    return entry;
  }

  /**
   * Commits strictly after `cursor` plus the advanced cursor. With an
   * `undefined` cursor every commit is returned. The returned cursor is the
   * `seq` of the last commit in the slice, or the caller's cursor when the
   * slice is empty (so draining is idempotent and never rewinds).
   */
  since(cursor: ScrollbackCommitCursor): ScrollbackCommitSlice {
    const commits =
      cursor === undefined
        ? [...this.#commits]
        : this.#commits.filter((entry) => entry.seq > cursor);
    const lastSeq = commits.at(-1)?.seq;
    return {
      commits,
      cursor: lastSeq ?? cursor,
    };
  }

  reset(): void {
    this.#commits.length = 0;
    this.#nextSeq = 0;
  }
}

const WIRE_ID_PREFIX = "wire:";
const ASSISTANT_MARKER = ":assistant";
const TOOL_MARKER = ":tool:";

/**
 * Map a transcript message to its STABLE logical id. A turn's streaming
 * assistant message and its committed segments MUST resolve to the SAME id
 * (the P1-1 invariant) so the append-only log carries one logical entry per
 * turn answer instead of two.
 *
 * `wireFold` ids are `wire:<sessionId>:<turnId>:<attemptId>:assistant…` and
 * `wire:<sessionId>:<turnId>:tool:<toolCallId>`. `<attemptId>` can itself
 * contain `:` (e.g. `attempt:2`), so we never split positionally: we anchor on
 * the first `:assistant` / `:tool:` marker and keep the leading
 * `<sessionId>:<turnId>:<attemptId>` span as one opaque, stable blob.
 *
 * `seed:` / `user:` / `rewind:` and any unrecognized id pass through unchanged.
 */
export function deriveLogicalId(message: CliShellTranscriptMessage): string {
  const id = message.id;
  if (!id.startsWith(WIRE_ID_PREFIX)) {
    return id;
  }
  const body = id.slice(WIRE_ID_PREFIX.length);

  // The `:assistant` kind marker is DEFINITIVE: an assistant id always carries it
  // (`…:<attemptId>:assistant:<seq>` / `…:assistant:committed:…`) and a tool id
  // never does (`…:<turnId>:tool:<toolCallId>`), so anchor on it FIRST. Anchoring
  // on the first `:assistant` collapses a turn's streaming and committed forms
  // onto one `<sessionId>:<turnId>:<attemptId>` span (the P1-1 invariant), and
  // stays correct even if the attempt span itself contains `:tool:` — a
  // positional "whichever marker comes first" test would misclassify that as a
  // tool id and break the collapse (double-write). Invariant: a toolCallId must
  // not contain `:assistant`, which holds for all id generators.
  const assistantIndex = body.indexOf(ASSISTANT_MARKER);
  if (assistantIndex >= 0) {
    return `turn:${body.slice(0, assistantIndex)}:assistant`;
  }

  const toolIndex = body.indexOf(TOOL_MARKER);
  if (toolIndex >= 0) {
    const span = body.slice(0, toolIndex);
    const toolCallId = body.slice(toolIndex + TOOL_MARKER.length);
    return `turn:${span}:tool:${toolCallId}`;
  }

  return id;
}
