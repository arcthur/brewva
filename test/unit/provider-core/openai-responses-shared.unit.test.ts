import { describe, expect, test } from "bun:test";
import { convertResponsesMessages } from "../../../packages/brewva-provider-core/src/providers/openai-responses-shared.js";

const TEST_MODEL = {
  provider: "openai",
  id: "gpt-5.4-mini",
  name: "GPT-5.4 Mini",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  input: ["text"] as Array<"text" | "image">,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 128000,
  maxTokens: 8192,
};

describe("openai responses prompt file conversion", () => {
  test("sends resolved text files through native input_file blocks", () => {
    const messages = convertResponsesMessages(
      TEST_MODEL,
      {
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Review this file.\n" },
              {
                type: "file",
                uri: "file:///tmp/workspace/src/example.ts",
                displayText: "@src/example.ts",
                name: "example.ts",
              },
            ],
            timestamp: 1,
          } as never,
        ],
      },
      new Set(["openai"]),
      { includeSystemPrompt: false } as never,
      {
        resolveFile(part: { uri: string; name?: string }) {
          expect(part.uri).toBe("file:///tmp/workspace/src/example.ts");
          expect(part.name).toBe("example.ts");
          return {
            kind: "text",
            uri: part.uri,
            name: part.name,
            mimeType: "text/typescript",
            text: "export const answer = 42;\n",
          };
        },
      } as never,
    );

    expect(messages).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Review this file.\n",
          },
          {
            type: "input_file",
            filename: "example.ts",
            file_data: Buffer.from("export const answer = 42;\n", "utf8").toString("base64"),
          },
        ],
      },
    ]);
  });
});
