import { describe, expect, test } from "bun:test";
import {
  buildAnthropicDocumentBlock,
  buildGoogleFileDataPart,
  buildMistralDocumentUrlChunk,
  buildOpenAIInputFilePart,
  materializeResolvedUserMessageContentPart,
} from "../../../packages/brewva-provider-core/src/providers/prompt-content.js";

const TEXT_ONLY_MODEL = {
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

describe("provider prompt content helpers", () => {
  test("builds native OpenAI input_file payloads from resolved text files", () => {
    expect(
      buildOpenAIInputFilePart({
        type: "file",
        file: {
          type: "file",
          uri: "file:///tmp/example.ts",
          name: "example.ts",
        },
        resolved: {
          kind: "text",
          uri: "file:///tmp/example.ts",
          name: "example.ts",
          mimeType: "text/typescript",
          text: "export const answer = 42;\n",
        },
      }),
    ).toEqual({
      type: "input_file",
      filename: "example.ts",
      file_data: Buffer.from("export const answer = 42;\n", "utf8").toString("base64"),
    });
  });

  test("builds native Anthropic document blocks for text and PDF files", () => {
    expect(
      buildAnthropicDocumentBlock({
        type: "file",
        file: {
          type: "file",
          uri: "file:///tmp/notes.txt",
          name: "notes.txt",
        },
        resolved: {
          kind: "text",
          uri: "file:///tmp/notes.txt",
          name: "notes.txt",
          text: "hello",
        },
      }),
    ).toEqual({
      type: "document",
      source: {
        type: "text",
        media_type: "text/plain",
        data: "hello",
      },
      title: "notes.txt",
    });

    expect(
      buildAnthropicDocumentBlock({
        type: "file",
        file: {
          type: "file",
          uri: "file:///tmp/spec.pdf",
          name: "spec.pdf",
          mimeType: "application/pdf",
        },
        resolved: {
          kind: "binary",
          uri: "file:///tmp/spec.pdf",
          name: "spec.pdf",
          mimeType: "application/pdf",
          dataBase64: "cGRm",
        },
      }),
    ).toEqual({
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: "cGRm",
      },
      title: "spec.pdf",
    });
  });

  test("builds native Google and Mistral file references only for supported URI schemes", () => {
    expect(
      buildGoogleFileDataPart({
        type: "file",
        file: {
          type: "file",
          uri: "gs://bucket/spec.pdf",
          name: "spec.pdf",
          mimeType: "application/pdf",
        },
      }),
    ).toEqual({
      fileData: {
        fileUri: "gs://bucket/spec.pdf",
        mimeType: "application/pdf",
      },
    });

    expect(
      buildMistralDocumentUrlChunk({
        type: "file",
        file: {
          type: "file",
          uri: "https://example.com/spec.pdf",
          name: "spec.pdf",
        },
      }),
    ).toEqual({
      type: "document_url",
      documentUrl: "https://example.com/spec.pdf",
      documentName: "spec.pdf",
    });
  });

  test("falls back to deterministic text serialization for unresolved local binary files", () => {
    expect(
      materializeResolvedUserMessageContentPart(TEXT_ONLY_MODEL as never, {
        type: "file",
        file: {
          type: "file",
          uri: "file:///tmp/archive.bin",
          name: "archive.bin",
        },
        resolved: {
          kind: "binary",
          uri: "file:///tmp/archive.bin",
          name: "archive.bin",
          mimeType: "application/octet-stream",
          sizeBytes: 7,
          summary: "Binary file reference",
        },
      }),
    ).toEqual([
      {
        type: "text",
        text: "[Binary file: archive.bin] (mime=application/octet-stream, bytes=7)\nBinary file reference",
      },
    ]);
  });
});
