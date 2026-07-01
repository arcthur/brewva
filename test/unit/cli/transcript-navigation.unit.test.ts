import { describe, expect, test } from "bun:test";
import type { OpenTuiScrollBoxHandle } from "../../../packages/brewva-cli/src/internal/tui/internal-opentui-runtime.js";
import { navigateTranscriptMessage } from "../../../packages/brewva-cli/src/shell/domain/transcript-navigation.js";
import type { CliShellTranscriptMessage } from "../../../packages/brewva-cli/src/shell/domain/transcript.js";

function textMessage(id: string): CliShellTranscriptMessage {
  return {
    id,
    role: "assistant",
    renderMode: "stable",
    parts: [{ id: `${id}:text:0`, type: "text", text: "content", renderMode: "stable" }],
  };
}

function fakeScroll(input: {
  y?: number;
  height?: number;
  scrollHeight?: number;
  children: { id?: string; y: number }[];
}): { handle: OpenTuiScrollBoxHandle; scrollBy: number[]; scrollTo: number[] } {
  const scrollBy: number[] = [];
  const scrollTo: number[] = [];
  const handle: OpenTuiScrollBoxHandle = {
    isDestroyed: false,
    y: input.y ?? 0,
    height: input.height ?? 20,
    scrollTop: 0,
    scrollHeight: input.scrollHeight ?? 100,
    viewport: { height: input.height ?? 20 },
    stickyScroll: true,
    scrollBy: (delta) => scrollBy.push(delta),
    scrollTo: (offset) => scrollTo.push(offset),
    getChildren: () => input.children,
  };
  return { handle, scrollBy, scrollTo };
}

describe("navigateTranscriptMessage", () => {
  const messages = [textMessage("a"), textMessage("b"), textMessage("c")];
  const children = [
    { id: "transcript-row:a", y: 0 },
    { id: "transcript-row:b", y: 30 },
    { id: "transcript-row:c", y: 60 },
  ];

  test("next scrolls to the first message below the current anchor", () => {
    const scroll = fakeScroll({ y: 35, children });
    navigateTranscriptMessage(scroll.handle, messages, "next");
    // First row with y > 35 + 10 = 45 is row c (y 60): scrollBy(60 - 35 - 1).
    expect(scroll.scrollBy).toEqual([24]);
    expect(scroll.scrollTo).toEqual([]);
  });

  test("previous scrolls to the last message above the current anchor", () => {
    const scroll = fakeScroll({ y: 35, children });
    navigateTranscriptMessage(scroll.handle, messages, "previous");
    // Last row with y < 35 - 10 = 25 is row a (y 0): scrollBy(0 - 35 - 1).
    expect(scroll.scrollBy).toEqual([-36]);
  });

  test("first jumps to the top and last jumps to the bottom", () => {
    const top = fakeScroll({ y: 35, children });
    navigateTranscriptMessage(top.handle, messages, "first");
    expect(top.scrollTo).toEqual([0]);

    const bottom = fakeScroll({ y: 35, scrollHeight: 100, children });
    navigateTranscriptMessage(bottom.handle, messages, "last");
    expect(bottom.scrollTo).toEqual([100]);
  });

  test("falls back to a page scroll when there is no boundary in the direction", () => {
    const scroll = fakeScroll({ y: 0, height: 20, children });
    navigateTranscriptMessage(scroll.handle, messages, "previous");
    expect(scroll.scrollBy).toEqual([-20]);
  });

  test("skips rows whose message has no visible text", () => {
    const withEmpty: CliShellTranscriptMessage[] = [
      { id: "a", role: "assistant", renderMode: "stable", parts: [] },
      textMessage("b"),
    ];
    const scroll = fakeScroll({
      y: 0,
      children: [
        { id: "transcript-row:a", y: 5 },
        { id: "transcript-row:b", y: 30 },
      ],
    });
    navigateTranscriptMessage(scroll.handle, withEmpty, "next");
    // Empty row a is skipped; row b (y 30 > 10) -> scrollBy(30 - 0 - 1).
    expect(scroll.scrollBy).toEqual([29]);
  });

  test("does nothing on a destroyed scrollbox", () => {
    const scroll = fakeScroll({ y: 35, children });
    scroll.handle.isDestroyed = true;
    navigateTranscriptMessage(scroll.handle, messages, "next");
    expect(scroll.scrollBy).toEqual([]);
    expect(scroll.scrollTo).toEqual([]);
  });
});
