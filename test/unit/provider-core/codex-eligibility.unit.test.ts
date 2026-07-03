import { describe, expect, test } from "bun:test";
import { isCodexEligibleModelId } from "../../../packages/brewva-provider-core/src/quirks/index.js";

// Pins the Codex-channel entitlement probed live against the ChatGPT backend
// (2026-07-03): mainline gpt-5.4+ (including -mini) stream; every -codex/-pro
// variant and every pre-5.4 id is rejected with "not supported when using
// Codex with a ChatGPT account". The synthesized openai-codex catalog must
// not offer models that can only ever 400.

describe("isCodexEligibleModelId", () => {
  test("admits the probed-working mainline ids", () => {
    for (const id of ["gpt-5.4", "gpt-5.4-mini", "gpt-5.5", "gpt-5.6", "gpt-6.0"]) {
      expect(isCodexEligibleModelId(id)).toBe(true);
    }
  });

  test("rejects every probed-400 id", () => {
    for (const id of [
      "gpt-5.5-pro",
      "gpt-5.5-codex",
      "gpt-5.4-pro",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2",
      "gpt-5.2-codex",
      "gpt-5.1",
      "gpt-5.1-codex",
      "gpt-5.1-codex-max",
      "gpt-5.1-codex-mini",
    ]) {
      expect(isCodexEligibleModelId(id)).toBe(false);
    }
  });

  test("rejects pre-5.4 and non-gpt ids", () => {
    for (const id of ["gpt-5", "gpt-5-mini", "gpt-4.1", "o4-mini", "claude-opus-4-8"]) {
      expect(isCodexEligibleModelId(id)).toBe(false);
    }
  });
});
