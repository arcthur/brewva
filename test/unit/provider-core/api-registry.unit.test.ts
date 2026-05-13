import { describe, expect, test } from "bun:test";
import {
  getApiProvider,
  getExternalApiProvider,
  getTypedApiProvider,
  clearApiProviderSessions,
  clearApiProviders,
  registerExternalApiProvider,
  registerApiProvider,
  registerTypedApiProvider,
} from "@brewva/brewva-provider-core/registry";
import { createProviderEventStream } from "../../helpers/effect-stream.js";

describe("provider api registry session resources", () => {
  test("clears session resources only for registered providers that declare them", async () => {
    const clearedSessions: string[] = [];

    clearApiProviders();
    registerApiProvider({
      api: "session-resource-test",
      stream() {
        return createProviderEventStream();
      },
      streamSimple() {
        return createProviderEventStream();
      },
      sessionResources: {
        clearSession(sessionId) {
          clearedSessions.push(sessionId);
        },
      },
    });
    registerApiProvider({
      api: "session-resource-test-noop",
      stream() {
        return createProviderEventStream();
      },
      streamSimple() {
        return createProviderEventStream();
      },
    });

    await clearApiProviderSessions("session-42");

    expect(clearedSessions).toEqual(["session-42"]);
    clearApiProviders();
  });

  test("separates typed and external providers without losing lookup coverage", () => {
    clearApiProviders();

    registerTypedApiProvider({
      api: "openai-responses",
      stream() {
        return createProviderEventStream();
      },
      streamSimple() {
        return createProviderEventStream();
      },
    });
    registerExternalApiProvider({
      api: "external-provider-test",
      stream() {
        return createProviderEventStream();
      },
      streamSimple() {
        return createProviderEventStream();
      },
    });

    expect(getTypedApiProvider("openai-responses")?.api).toBe("openai-responses");
    expect(getExternalApiProvider("external-provider-test")?.api).toBe("external-provider-test");
    expect(getApiProvider("openai-responses")?.api).toBe("openai-responses");
    expect(getApiProvider("external-provider-test")?.api).toBe("external-provider-test");

    clearApiProviders();
  });

  test("routes typed built-in APIs through the typed registry even via the compatibility facade", () => {
    clearApiProviders();

    registerApiProvider({
      api: "openai-responses",
      stream() {
        return createProviderEventStream();
      },
      streamSimple() {
        return createProviderEventStream();
      },
    });

    expect(getTypedApiProvider("openai-responses")?.api).toBe("openai-responses");
    expect(getExternalApiProvider("openai-responses")).toBe(undefined);

    clearApiProviders();
  });
});
