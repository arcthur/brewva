import { describe, expect, test } from "bun:test";
import { splitRetainedTranscriptRows } from "../../../packages/brewva-cli/runtime/shell/transcript-retention.js";
import type { CliShellTranscriptMessage } from "../../../packages/brewva-cli/src/shell/domain/transcript.js";

const expectedDefaultInteractiveRowLimit = 100;

function textMessage(
  id: string,
  renderMode: CliShellTranscriptMessage["renderMode"] = "stable",
): CliShellTranscriptMessage {
  return {
    id,
    role: "assistant",
    renderMode,
    parts: [
      {
        type: "text",
        id: `${id}:text`,
        text: id,
        renderMode,
      },
    ],
  };
}

describe("transcript retention", () => {
  test("keeps only the stable tail when there is no live row", () => {
    const messages = Array.from({ length: 150 }, (_, index) => textMessage(`row-${index + 1}`));

    const retained = splitRetainedTranscriptRows(messages);

    expect(retained.stableRows).toHaveLength(expectedDefaultInteractiveRowLimit);
    expect(retained.liveRows).toEqual([]);
    expect(retained.stableRows[0]?.id).toBe("row-51");
    expect(retained.stableRows.at(-1)?.id).toBe("row-150");
  });

  test("always keeps live rows and uses the remaining budget for stable rows", () => {
    const stable = Array.from({ length: 120 }, (_, index) => textMessage(`stable-${index + 1}`));
    const live = Array.from({ length: 3 }, (_, index) =>
      textMessage(`live-${index + 1}`, "streaming"),
    );

    const retained = splitRetainedTranscriptRows([...stable, ...live], 10);

    expect(retained.stableRows.map((message) => message.id)).toEqual([
      "stable-114",
      "stable-115",
      "stable-116",
      "stable-117",
      "stable-118",
      "stable-119",
      "stable-120",
    ]);
    expect(retained.liveRows.map((message) => message.id)).toEqual(["live-1", "live-2", "live-3"]);
  });

  test("does not drop live rows when live rows exceed the stable budget", () => {
    const stable = [textMessage("stable-1"), textMessage("stable-2")];
    const live = Array.from({ length: 4 }, (_, index) =>
      textMessage(`live-${index + 1}`, "streaming"),
    );

    const retained = splitRetainedTranscriptRows([...stable, ...live], 2);

    expect(retained.stableRows).toEqual([]);
    expect(retained.liveRows.map((message) => message.id)).toEqual([
      "live-1",
      "live-2",
      "live-3",
      "live-4",
    ]);
  });
});
