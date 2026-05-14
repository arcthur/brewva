import { describe, expect, test } from "bun:test";
import {
  acceptComposerCompletion,
  createPromptHistoryState,
  navigatePromptHistoryState,
} from "../../../packages/brewva-cli/src/shell/domain/composer-actions.js";

describe("shell composer action helpers", () => {
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
        trigger: "@",
        query: "src",
        range: {
          trigger: "@",
          query: "src",
          start: 7,
          end: 11,
        },
        selectedIndex: 0,
        items: [
          {
            id: "file:src/index.ts",
            kind: "file",
            source: "workspace",
            label: "@src/index.ts",
            value: "src/index.ts",
            insertText: "src/index.ts",
            accept: {
              type: "insertFilePart",
              path: "src/index.ts",
            },
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

  test("accepts an agent completion into prompt text and a structured agent part", () => {
    const next = acceptComposerCompletion({
      completion: {
        trigger: "@",
        query: "rev",
        range: {
          trigger: "@",
          query: "rev",
          start: 9,
          end: 12,
        },
        selectedIndex: 0,
        items: [
          {
            id: "agent:reviewer",
            kind: "agent",
            source: "agent",
            label: "@reviewer",
            value: "reviewer",
            insertText: "reviewer",
            description: "Code review agent",
            accept: {
              type: "insertAgentPart",
              agentId: "reviewer",
            },
          },
        ],
      },
      composer: {
        text: "route to @rev",
        cursor: "route to @rev".length,
        parts: [],
      },
      createPromptPartId: () => "agent-part:1",
    });

    expect(next).toEqual({
      text: "route to @reviewer",
      cursor: "route to @reviewer".length,
      parts: [
        {
          id: "agent-part:1",
          type: "agent",
          agentId: "reviewer",
          source: {
            text: {
              start: 9,
              end: "route to @reviewer".length,
              value: "@reviewer",
            },
          },
        },
      ],
    });
  });
});
