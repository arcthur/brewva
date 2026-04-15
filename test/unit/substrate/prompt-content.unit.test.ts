import { describe, expect, test } from "bun:test";
import { brewvaPromptContentPartsEqual } from "@brewva/brewva-substrate";

describe("brewva prompt content equality", () => {
  test("matches equal structured prompt parts without relying on JSON serialization", () => {
    const left = [
      { type: "text", text: "hello" },
      {
        type: "file",
        uri: "file:///tmp/readme.md",
        name: "readme.md",
        displayText: "@readme.md",
      },
    ] as const;
    const right = [
      { type: "text", text: "hello" },
      {
        type: "file",
        uri: "file:///tmp/readme.md",
        name: "readme.md",
        displayText: "@readme.md",
      },
    ] as const;

    expect(brewvaPromptContentPartsEqual(left, right)).toBe(true);
  });

  test("detects real prompt part changes", () => {
    expect(
      brewvaPromptContentPartsEqual(
        [{ type: "image", data: "aaa", mimeType: "image/png" }],
        [{ type: "image", data: "bbb", mimeType: "image/png" }],
      ),
    ).toBe(false);
  });
});
