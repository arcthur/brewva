import { describe, expect, test } from "bun:test";
import { SESSION_WIRE_SCHEMA, type SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import { createShellCockpitWireFoldStore } from "../../../packages/brewva-cli/src/shell/domain/cockpit/wire-fold.js";
import {
  deriveLogicalId,
  ScrollbackCommitLog,
  type ScrollbackCommit,
} from "../../../packages/brewva-cli/src/shell/domain/scrollback/commit.js";
import {
  buildTextTranscriptMessage,
  isStreamingMessage,
  isStreamingPart,
  type CliShellTranscriptMessage,
} from "../../../packages/brewva-cli/src/shell/domain/transcript.js";

function frame(
  input: Omit<SessionWireFrame, "schema" | "sessionId" | "source" | "durability">,
  sessionId = "session-1",
): SessionWireFrame {
  return {
    schema: SESSION_WIRE_SCHEMA,
    sessionId,
    source: "live",
    durability: "cache",
    ...input,
  } as SessionWireFrame;
}

function textMessage(id: string): ScrollbackCommit["message"] {
  const message = buildTextTranscriptMessage({ id, role: "assistant", text: "x" });
  if (!message) {
    throw new Error("expected a message");
  }
  return message;
}

function commit(
  id: string,
  overrides: Partial<Omit<ScrollbackCommit, "message" | "seq">> = {},
): Omit<ScrollbackCommit, "seq"> {
  return {
    logicalId: overrides.logicalId ?? `logical:${id}`,
    kind: overrides.kind ?? "assistant",
    phase: overrides.phase ?? "progress",
    message: textMessage(id),
  };
}

describe("ScrollbackCommitLog", () => {
  test("append assigns monotonic seq starting at 0 and grows length", () => {
    const log = new ScrollbackCommitLog();
    expect(log.length).toBe(0);

    const first = log.append(commit("a"));
    const second = log.append(commit("b"));
    const third = log.append(commit("c"));

    expect([first.seq, second.seq, third.seq]).toEqual([0, 1, 2]);
    expect(log.length).toBe(3);
  });

  test("since returns commits strictly after the cursor plus the advanced cursor", () => {
    const log = new ScrollbackCommitLog();
    log.append(commit("a"));
    log.append(commit("b"));
    log.append(commit("c"));

    const initial = log.since(undefined);
    expect(initial.commits.map((entry) => entry.seq)).toEqual([0, 1, 2]);
    expect(initial.cursor).toBe(2);

    const afterFirst = log.since(0);
    expect(afterFirst.commits.map((entry) => entry.seq)).toEqual([1, 2]);
    expect(afterFirst.cursor).toBe(2);

    const drained = log.since(2);
    expect(drained.commits).toEqual([]);
    expect(drained.cursor).toBe(2);
  });

  test("since past the tail keeps the caller cursor stable", () => {
    const log = new ScrollbackCommitLog();
    log.append(commit("a"));

    const drained = log.since(99);
    expect(drained.commits).toEqual([]);
    expect(drained.cursor).toBe(99);
  });

  test("reset clears commits and rewinds seq for replay", () => {
    const log = new ScrollbackCommitLog();
    log.append(commit("a"));
    log.append(commit("b"));
    expect(log.length).toBe(2);

    log.reset();
    expect(log.length).toBe(0);
    expect(log.since(undefined)).toEqual({ commits: [], cursor: undefined });

    const reappended = log.append(commit("c"));
    expect(reappended.seq).toBe(0);
    expect(log.length).toBe(1);
  });
});

describe("deriveLogicalId — P1-1 invariant", () => {
  test("streaming and committed assistant ids of the SAME turn collapse to one logicalId", () => {
    const sessionId = "session-1";
    const turnId = "turn-1";
    const attemptId = "attempt-1";

    const streaming = `wire:${sessionId}:${turnId}:${attemptId}:assistant:5`;
    const committedSegmentBySequence = `wire:${sessionId}:${turnId}:${attemptId}:assistant:committed:evt:after-tool:sequence:3`;
    const committedSegmentByIndex = `wire:${sessionId}:${turnId}:${attemptId}:assistant:committed:index:0`;
    const committedSingle = `wire:${sessionId}:${turnId}:${attemptId}:assistant:committed`;

    const expected = `turn:${sessionId}:${turnId}:${attemptId}:assistant`;
    expect(deriveLogicalId(textMessage(streaming))).toBe(expected);
    expect(deriveLogicalId(textMessage(committedSegmentBySequence))).toBe(expected);
    expect(deriveLogicalId(textMessage(committedSegmentByIndex))).toBe(expected);
    expect(deriveLogicalId(textMessage(committedSingle))).toBe(expected);
  });

  test("a colon-bearing attemptId still collapses streaming and committed forms", () => {
    const streaming = "wire:session-1:turn-1:attempt:2:assistant:9";
    const committed = "wire:session-1:turn-1:attempt:2:assistant:committed:evt:x:index:0";
    const expected = "turn:session-1:turn-1:attempt:2:assistant";
    expect(deriveLogicalId(textMessage(streaming))).toBe(expected);
    expect(deriveLogicalId(textMessage(committed))).toBe(expected);
  });

  test("an attemptId containing ':tool:' still classifies as assistant, not tool", () => {
    // The `:assistant` kind marker is definitive: a positional "first marker wins"
    // test would misread the attempt-embedded `:tool:` as a tool id and break the
    // P1-1 collapse (streaming vs committed would no longer dedup -> double-write).
    const streaming = "wire:session-1:turn-1:attempt:tool:x:assistant:5";
    const committed = "wire:session-1:turn-1:attempt:tool:x:assistant:committed:index:0";
    const expected = "turn:session-1:turn-1:attempt:tool:x:assistant";
    expect(deriveLogicalId(textMessage(streaming))).toBe(expected);
    expect(deriveLogicalId(textMessage(committed))).toBe(expected);
  });

  test("tool message ids map to a stable per-toolCall logicalId", () => {
    expect(deriveLogicalId(textMessage("wire:session-1:turn-1:tool:tool-read-1"))).toBe(
      "turn:session-1:turn-1:tool:tool-read-1",
    );
  });

  test("seed / user / rewind / unknown ids pass through unchanged", () => {
    expect(deriveLogicalId(textMessage("seed:default:0"))).toBe("seed:default:0");
    expect(deriveLogicalId(textMessage("rewind:session-1:2"))).toBe("rewind:session-1:2");
    expect(deriveLogicalId(textMessage("user:abc"))).toBe("user:abc");
    expect(deriveLogicalId(textMessage("tool:result:legacy"))).toBe("tool:result:legacy");
  });
});

describe("wireFold scrollback emission", () => {
  test("progress deltas and committed segments of one turn share a single assistant logicalId", () => {
    const store = createShellCockpitWireFoldStore();
    store.remember(
      frame({
        type: "assistant.delta",
        frameId: "frame:answer-before-tool",
        ts: 1_000,
        turnId: "turn-1",
        attemptId: "attempt-1",
        lane: "answer",
        delta: "Let me inspect first.",
      }),
    );
    store.remember(
      frame({
        type: "tool.started",
        frameId: "frame:tool-start",
        ts: 1_010,
        turnId: "turn-1",
        attemptId: "attempt-1",
        toolCallId: "tool-read-1",
        toolName: "read",
      }),
    );
    store.remember(
      frame({
        type: "tool.finished",
        frameId: "frame:tool-finish",
        ts: 1_020,
        turnId: "turn-1",
        attemptId: "attempt-1",
        toolCallId: "tool-read-1",
        toolName: "read",
        verdict: "pass",
        isError: false,
        text: "src/app.ts",
      }),
    );
    store.remember(
      frame({
        type: "assistant.delta",
        frameId: "frame:answer-after-tool",
        ts: 1_030,
        turnId: "turn-1",
        attemptId: "attempt-1",
        lane: "answer",
        delta: "The file is in src/app.ts.",
      }),
    );
    store.remember(
      frame({
        type: "turn.committed",
        frameId: "frame:commit",
        ts: 1_040,
        turnId: "turn-1",
        attemptId: "attempt-1",
        status: "completed",
        assistantText: "Let me inspect first.The file is in src/app.ts.",
        assistantSegments: [
          {
            text: "Let me inspect first.",
            ts: 1_000,
            sequence: 1,
            sourceEventId: "evt:assistant-before-tool",
          },
          {
            text: "The file is in src/app.ts.",
            ts: 1_030,
            sequence: 3,
            sourceEventId: "evt:assistant-after-tool",
          },
        ],
        toolOutputs: [
          {
            toolCallId: "tool-read-1",
            toolName: "read",
            verdict: "pass",
            isError: false,
            text: "src/app.ts",
            ts: 1_020,
            sequence: 2,
            sourceEventId: "evt:tool-read",
          },
        ],
      }),
    );

    const log = store.scrollbackLog("session-1");
    const { commits } = log.since(undefined);

    // The double-write bug would surface as TWO distinct assistant logicalIds for
    // one turn (streaming `…:assistant:<seq>` vs committed `…:assistant:committed:…`).
    const assistantLogicalIds = new Set(
      commits.filter((entry) => entry.kind === "assistant").map((entry) => entry.logicalId),
    );
    expect(assistantLogicalIds).toEqual(new Set(["turn:session-1:turn-1:attempt-1:assistant"]));

    // The turn must have emitted at least one progress commit AND a final commit,
    // all keyed by the same assistant logicalId.
    const assistant = commits.filter((entry) => entry.kind === "assistant");
    expect(assistant.some((entry) => entry.phase === "progress")).toBe(true);
    expect(assistant.some((entry) => entry.phase === "final")).toBe(true);

    // The tool commit is keyed by its own stable per-toolCall logicalId and ends final.
    const toolCommits = commits.filter((entry) => entry.kind === "tool");
    expect(new Set(toolCommits.map((entry) => entry.logicalId))).toEqual(
      new Set(["turn:session-1:turn-1:tool:tool-read-1"]),
    );
    expect(toolCommits.at(-1)?.phase).toBe("final");

    // seq is monotonic across the whole log.
    const seqs = commits.map((entry) => entry.seq);
    expect(seqs).toEqual([...seqs].toSorted((left, right) => left - right));
  });

  test("replace() resets the scrollback log so replay starts from an empty append-only stream", () => {
    const store = createShellCockpitWireFoldStore();
    store.remember(
      frame({
        type: "assistant.delta",
        frameId: "frame:answer",
        ts: 1_000,
        turnId: "turn-1",
        attemptId: "attempt-1",
        lane: "answer",
        delta: "hello",
      }),
    );
    expect(store.scrollbackLog("session-1").length).toBeGreaterThan(0);

    store.replaceSession("session-1", []);
    expect(store.scrollbackLog("session-1").length).toBe(0);
    expect(store.scrollbackLog("session-1").since(undefined)).toEqual({
      commits: [],
      cursor: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// Streaming predicates — the writer's sweep (sweepSettled) relies on
// isStreamingMessage to stop at the live tail, so this coverage is load-bearing.
// (Moved here from the deleted scrollback-commit-controller suite.)
// ---------------------------------------------------------------------------

function assistantTextMessage(input: {
  id: string;
  messageMode: "stable" | "streaming";
  partMode: "stable" | "streaming";
}): CliShellTranscriptMessage {
  return {
    id: input.id,
    role: "assistant",
    renderMode: input.messageMode,
    parts: [
      {
        type: "text",
        id: `${input.id}:text`,
        text: input.id,
        renderMode: input.partMode,
      },
    ],
  };
}

describe("isStreamingPart", () => {
  test("returns true for a streaming part", () => {
    const part = { type: "text" as const, id: "p1", text: "x", renderMode: "streaming" as const };
    expect(isStreamingPart(part)).toBe(true);
  });

  test("returns false for a stable part", () => {
    const part = { type: "text" as const, id: "p1", text: "x", renderMode: "stable" as const };
    expect(isStreamingPart(part)).toBe(false);
  });
});

describe("isStreamingMessage", () => {
  test("returns true when the message renderMode is streaming", () => {
    expect(
      isStreamingMessage(
        assistantTextMessage({ id: "m1", messageMode: "streaming", partMode: "streaming" }),
      ),
    ).toBe(true);
  });

  test("returns false for a fully stable message", () => {
    expect(
      isStreamingMessage(
        assistantTextMessage({ id: "m1", messageMode: "stable", partMode: "stable" }),
      ),
    ).toBe(false);
  });

  test("returns true when the message is stable but a part is streaming", () => {
    expect(
      isStreamingMessage(
        assistantTextMessage({ id: "m1", messageMode: "stable", partMode: "streaming" }),
      ),
    ).toBe(true);
  });
});
