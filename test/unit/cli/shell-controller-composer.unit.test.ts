import { describe, expect, test } from "bun:test";
import {
  acceptComposerCompletion,
  createPromptHistoryState,
  navigatePromptHistoryState,
} from "../../../packages/brewva-cli/src/shell/controller-composer.js";

describe("shell controller composer helpers", () => {
  test("restores the in-flight draft when prompt history returns to the live composer", () => {
    const first = navigatePromptHistoryState({
      history: createPromptHistoryState([
        { text: "older", parts: [] },
        { text: "latest", parts: [] },
      ]),
      direction: -1,
      composer: {
        text: "draft",
        cursor: 5,
        parts: [],
      },
    });

    expect(first?.composer.text).toBe("latest");
    expect(first?.composer.cursor).toBe(0);

    const second = navigatePromptHistoryState({
      history: first!.history,
      direction: 1,
      composer: first!.composer,
    });

    expect(second?.composer).toEqual({
      text: "draft",
      cursor: 5,
      parts: [],
    });
  });

  test("accepts a path completion into prompt text and structured file parts together", () => {
    const next = acceptComposerCompletion({
      completion: {
        kind: "path",
        query: "src",
        selectedIndex: 0,
        items: [
          {
            kind: "path",
            label: "@src/index.ts",
            value: "src/index.ts",
            insertText: "src/index.ts",
          },
        ],
      },
      composer: {
        text: "review @src",
        cursor: "review @src".length,
        parts: [],
      },
      createPromptPartId: () => "file-part:1",
    });

    expect(next).toEqual({
      text: "review @src/index.ts",
      cursor: "review @src/index.ts".length,
      parts: [
        {
          id: "file-part:1",
          type: "file",
          path: "src/index.ts",
          source: {
            text: {
              start: 7,
              end: "review @src/index.ts".length,
              value: "@src/index.ts",
            },
          },
        },
      ],
    });
  });
});
