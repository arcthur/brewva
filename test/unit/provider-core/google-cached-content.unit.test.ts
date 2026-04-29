import { afterEach, describe, expect, test } from "bun:test";
import {
  createGoogleCachedContent,
  deleteGoogleCachedContent,
} from "../../../packages/brewva-provider-core/src/google-cached-content.js";

const INTRINSIC_FETCH = globalThis.fetch;
const CREDENTIAL = '{"token":"tok","projectId":"project-1"}';
const ENDPOINT = {
  baseUrl: "https://us-central1-aiplatform.googleapis.com",
  location: "us-central1",
};

afterEach(() => {
  globalThis.fetch = INTRINSIC_FETCH;
});

describe("google cached content adapter", () => {
  test("creates cached content with an abortable fetch request", async () => {
    let observedSignal: AbortSignal | undefined;
    globalThis.fetch = (async (_input, init) => {
      observedSignal = init?.signal ?? undefined;
      return new Response(
        JSON.stringify({
          name: "cachedContents/brewva-1",
          expireTime: "2030-01-01T00:00:00Z",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    }) as typeof fetch;

    const created = await createGoogleCachedContent(CREDENTIAL, {
      model: "gemini-2.5-pro",
      systemInstruction: { parts: [{ text: "system" }] },
      endpoint: ENDPOINT,
    });

    expect(created.name).toBe("cachedContents/brewva-1");
    expect(observedSignal).toBeInstanceOf(AbortSignal);
  });

  test("times out pending cached content deletes", async () => {
    globalThis.fetch = (async (_input, init) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        const fallback = setTimeout(() => reject(new Error("missing abort signal")), 50);
        if (!signal) {
          return;
        }
        if (signal.aborted) {
          clearTimeout(fallback);
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(fallback);
            reject(new DOMException("Aborted", "AbortError"));
          },
          { once: true },
        );
      });
    }) as typeof fetch;

    let rejection: unknown;
    try {
      await deleteGoogleCachedContent(CREDENTIAL, "cachedContents/brewva-1", {
        ...ENDPOINT,
        timeoutMs: 5,
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    expect((rejection as Error).message).toBe("Google cached content request timed out after 5ms.");
  });
});
