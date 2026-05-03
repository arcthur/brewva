import { describe, expect, test } from "bun:test";
import { readSseFrames } from "../../../packages/brewva-provider-core/src/streaming/sse-frame-reader.js";

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

describe("SSE frame reader", () => {
  test("parses multiline CRLF frames", async () => {
    const response = createResponseFromChunks([
      "id: 1\r\nevent: delta\r\ndata: alpha\r\ndata: beta\r\n\r\n",
    ]);

    const frames = [];
    for await (const frame of readSseFrames(response)) {
      frames.push(frame);
    }

    expect(frames).toEqual([
      {
        id: "1",
        event: "delta",
        data: "alpha\nbeta",
      },
    ]);
  });

  test("flushes the tail frame when the stream ends without a terminal separator", async () => {
    const response = createResponseFromChunks(['data: {"tail":true}']);

    const frames = [];
    for await (const frame of readSseFrames(response)) {
      frames.push(frame);
    }

    expect(frames).toEqual([
      {
        data: '{"tail":true}',
        event: undefined,
        id: undefined,
      },
    ]);
  });

  test("surfaces parser errors instead of silently dropping malformed fields", async () => {
    const response = createResponseFromChunks(["bad field\r\n\r\n"]);
    let error: unknown;
    try {
      for await (const _ of readSseFrames(response)) {
      }
    } catch (nextError) {
      error = nextError;
    }
    expect(error).toBeInstanceOf(Error);
  });
});
