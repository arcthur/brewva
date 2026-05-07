import { afterEach, describe, expect, test } from "bun:test";
import { streamGoogleGeminiCli } from "../../../packages/brewva-provider-core/src/providers/google-gemini-cli/index.js";
import { collectProviderEvents } from "../../helpers/effect-stream.js";

const originalFetch = globalThis.fetch;

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
    {
      status: 200,
      headers: {
        "content-type": "text/event-stream",
      },
    },
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("google gemini cli stream", () => {
  test("parses multiline SSE JSON and flushes tail content", async () => {
    globalThis.fetch = (async () =>
      createResponseFromChunks([
        'data: {"response":{"responseId":"resp_google_1",\n',
        'data: "candidates":[{"content":{"parts":[{"text":"Hello"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":10,"cachedContentTokenCount":4,"candidatesTokenCount":2,"totalTokenCount":12}}}',
      ])) as unknown as typeof fetch;

    const stream = streamGoogleGeminiCli(
      {
        api: "google-gemini-cli",
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        provider: "google",
        baseUrl: "https://cloudcode-pa.googleapis.com",
        reasoning: true,
        input: ["text"],
        contextWindow: 1_000_000,
        maxTokens: 8_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        messages: [],
      },
      {
        apiKey: JSON.stringify({ token: "token", projectId: "project" }),
      },
    );

    const events = await collectProviderEvents(stream);

    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.message.responseId).toBe("resp_google_1");
      expect(done.message.usage.input).toBe(6);
      expect(done.message.usage.cacheRead).toBe(4);
      expect(done.message.usage.totalTokens).toBe(12);
      expect(done.message.content[0]).toMatchObject({
        type: "text",
        text: "Hello",
      });
    }
  });

  test("surfaces malformed SSE JSON as a stream error", async () => {
    globalThis.fetch = (async () =>
      createResponseFromChunks(["data: {not-json}\n\n"])) as unknown as typeof fetch;

    const stream = streamGoogleGeminiCli(
      {
        api: "google-gemini-cli",
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        provider: "google",
        baseUrl: "https://cloudcode-pa.googleapis.com",
        reasoning: true,
        input: ["text"],
        contextWindow: 1_000_000,
        maxTokens: 8_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        messages: [],
      },
      {
        apiKey: JSON.stringify({ token: "token", projectId: "project" }),
      },
    );

    const events = await collectProviderEvents(stream);

    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.error.errorMessage).toContain("Invalid Google SSE JSON");
    }
  });

  test("retries retryable HTTP failures before parsing a successful SSE response", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ error: { message: "service unavailable" } }), {
          status: 503,
          headers: {
            "content-type": "application/json",
          },
        });
      }
      return createResponseFromChunks([
        'data: {"response":{"responseId":"resp_google_retry",',
        '"candidates":[{"content":{"parts":[{"text":"Recovered"}]},"finishReason":"STOP"}],',
        '"usageMetadata":{"promptTokenCount":1,"candidatesTokenCount":1,"totalTokenCount":2}}}',
      ]);
    }) as unknown as typeof fetch;

    const stream = streamGoogleGeminiCli(
      {
        api: "google-gemini-cli",
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        provider: "google",
        baseUrl: "https://cloudcode-pa.googleapis.com",
        reasoning: true,
        input: ["text"],
        contextWindow: 1_000_000,
        maxTokens: 8_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        messages: [],
      },
      {
        apiKey: JSON.stringify({ token: "token", projectId: "project" }),
      },
    );

    const events = await collectProviderEvents(stream);

    expect(calls).toBe(2);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.message.responseId).toBe("resp_google_retry");
      expect(done.message.content[0]).toMatchObject({
        type: "text",
        text: "Recovered",
      });
    }
  });

  test("does not retry non-retryable HTTP failures", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400,
        headers: {
          "content-type": "application/json",
        },
      });
    }) as unknown as typeof fetch;

    const stream = streamGoogleGeminiCli(
      {
        api: "google-gemini-cli",
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        provider: "google",
        baseUrl: "https://cloudcode-pa.googleapis.com",
        reasoning: true,
        input: ["text"],
        contextWindow: 1_000_000,
        maxTokens: 8_192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        messages: [],
      },
      {
        apiKey: JSON.stringify({ token: "token", projectId: "project" }),
      },
    );

    const events = await collectProviderEvents(stream);

    expect(calls).toBe(1);
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    if (last?.type === "error") {
      expect(last.error.errorMessage).toBe("bad request");
    }
  });
});
