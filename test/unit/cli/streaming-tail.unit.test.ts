import { describe, expect, test } from "bun:test";
import {
  STREAMING_TAIL_MAX_CHARS,
  STREAMING_TAIL_MAX_LINES,
  streamingTailWindow,
} from "../../../packages/brewva-cli/runtime/shell/streaming-tail.js";

describe("streamingTailWindow", () => {
  test("short content passes through untouched", () => {
    const result = streamingTailWindow("hello\nworld");
    expect(result).toEqual({ text: "hello\nworld", truncated: false });
  });

  test("caps content by line count, keeping the newest lines", () => {
    const lines = Array.from({ length: 50 }, (_, index) => `line ${index + 1}`);
    const result = streamingTailWindow(lines.join("\n"), { maxLines: 10 });
    expect(result.truncated).toBe(true);
    const resultLines = result.text.split("\n");
    expect(resultLines).toHaveLength(10);
    expect(resultLines.at(-1)).toBe("line 50");
    expect(resultLines[0]).toBe("line 41");
  });

  test("caps content by character count at a line boundary", () => {
    const lines = Array.from(
      { length: 100 },
      (_, index) => `row ${String(index).padStart(4, "0")}`,
    );
    const content = lines.join("\n");
    const result = streamingTailWindow(content, { maxChars: 100 });
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(100);
    expect(result.text.startsWith("row ")).toBe(true);
    expect(result.text.endsWith("row 0099")).toBe(true);
  });

  test("single long line without newlines is char-capped", () => {
    const content = "x".repeat(STREAMING_TAIL_MAX_CHARS * 2);
    const result = streamingTailWindow(content);
    expect(result.truncated).toBe(true);
    expect(result.text.length).toBeLessThanOrEqual(STREAMING_TAIL_MAX_CHARS);
  });

  test("default limits hold for typical streaming responses", () => {
    const lines = Array.from({ length: STREAMING_TAIL_MAX_LINES - 1 }, (_, i) => `line ${i}`);
    const result = streamingTailWindow(lines.join("\n"));
    expect(result.truncated).toBe(false);
  });
});
