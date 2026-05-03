import { describe, expect, test } from "bun:test";
import { OPENAI_CODEX_RESPONSES_TEST_ONLY } from "../../../packages/brewva-provider-core/src/providers/openai-codex-responses.js";

function createResponseFromChunks(chunks: string[]): Response {
  const encoder = new TextEncoder();
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        const chunk = chunks[index];
        index += 1;
        controller.enqueue(encoder.encode(chunk ?? ""));
      },
    }),
  );
}

describe("openai codex SSE parser", () => {
  test("parses multiline JSON events and flushes the tail chunk", async () => {
    const response = createResponseFromChunks([
      'data: {"type":"response.created",\n',
      'data: "response":{"id":"resp_1"}}',
    ]);

    const events = [];
    for await (const event of OPENAI_CODEX_RESPONSES_TEST_ONLY.parseSSE(response)) {
      events.push(event);
    }

    expect(events).toEqual([
      {
        type: "response.created",
        response: { id: "resp_1" },
      },
    ]);
  });

  test("throws on malformed JSON instead of silently swallowing the frame", async () => {
    const response = createResponseFromChunks(["data: {not-json}\n\n"]);
    let error: unknown;
    try {
      for await (const _ of OPENAI_CODEX_RESPONSES_TEST_ONLY.parseSSE(response)) {
      }
    } catch (nextError) {
      error = nextError;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Invalid Codex SSE JSON");
  });
});
