import { describe, expect, test } from "bun:test";
import { createRoot, createSignal } from "solid-js";
import {
  createRetainedTranscriptRows,
  splitRetainedTranscriptRows,
} from "../../../packages/brewva-cli/runtime/shell/transcript-retention.js";
import type { CliShellTranscriptMessage } from "../../../packages/brewva-cli/src/shell/domain/transcript.js";

function textMessage(
  id: string,
  renderMode: CliShellTranscriptMessage["renderMode"],
  text = id,
): CliShellTranscriptMessage {
  return {
    id,
    role: "assistant",
    renderMode,
    parts: [
      {
        type: "text",
        id: `${id}:text`,
        text,
        renderMode,
      },
    ],
  };
}

describe("transcript row retention", () => {
  test("splits history before the first active streaming row", () => {
    const stableA = textMessage("stable-a", "stable");
    const streaming = textMessage("streaming", "streaming");
    const stableAfterStreaming = textMessage("stable-after-streaming", "stable");

    const rows = splitRetainedTranscriptRows([stableA, streaming, stableAfterStreaming]);

    expect(rows.stableRows).toEqual([stableA]);
    expect(rows.liveRows).toEqual([streaming, stableAfterStreaming]);
  });

  test("retains the stable prefix array while only the live row changes", () => {
    createRoot((dispose) => {
      try {
        const stableA = textMessage("stable-a", "stable");
        const stableB = textMessage("stable-b", "stable");
        const streamingA = textMessage("streaming", "streaming", "first");
        const streamingB = textMessage("streaming", "streaming", "second");
        const [messages, setMessages] = createSignal<readonly CliShellTranscriptMessage[]>([
          stableA,
          stableB,
          streamingA,
        ]);
        const retained = createRetainedTranscriptRows(messages);

        const initialStableRows = retained.stableRows();
        expect(initialStableRows).toEqual([stableA, stableB]);
        expect(retained.liveRows()).toEqual([streamingA]);

        setMessages([stableA, stableB, streamingB]);

        expect(retained.stableRows()).toBe(initialStableRows);
        expect(retained.liveRows()).toEqual([streamingB]);
      } finally {
        dispose();
      }
    });
  });

  test("promotes the live row into retained history after streaming finalizes", () => {
    createRoot((dispose) => {
      try {
        const stableA = textMessage("stable-a", "stable");
        const streaming = textMessage("streaming", "streaming", "partial");
        const finalized = textMessage("streaming", "stable", "final");
        const [messages, setMessages] = createSignal<readonly CliShellTranscriptMessage[]>([
          stableA,
          streaming,
        ]);
        const retained = createRetainedTranscriptRows(messages);

        expect(retained.stableRows()).toEqual([stableA]);
        expect(retained.liveRows()).toEqual([streaming]);

        setMessages([stableA, finalized]);

        expect(retained.stableRows()).toEqual([stableA, finalized]);
        expect(retained.liveRows()).toEqual([]);
      } finally {
        dispose();
      }
    });
  });
});
