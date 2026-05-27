import { describe, expect, test } from "bun:test";
import { getEnvApiKey } from "@brewva/brewva-provider-core/auth";

describe("provider auth", () => {
  test("resolves Google GenAI API keys from Gemini Developer API environment variables", () => {
    expect(
      getEnvApiKey("google-genai", {
        GEMINI_API_KEY: "gemini-api-key",
        GOOGLE_API_KEY: "google-api-key",
      }),
    ).toBe("gemini-api-key");

    expect(
      getEnvApiKey("google-genai", {
        GOOGLE_API_KEY: "google-api-key",
      }),
    ).toBe("google-api-key");
  });
});
