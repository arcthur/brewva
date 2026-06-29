import { describe, expect, test } from "bun:test";
import { createModelAvailabilityMemory } from "../../../packages/brewva-cli/src/shell/domain/model-availability-memory.js";

describe("createModelAvailabilityMemory", () => {
  test("remembers a per-model unavailability reason", () => {
    const memory = createModelAvailabilityMemory();
    expect(memory.getUnavailableReason("openai-codex", "gpt-5.1-codex-max")).toBe(undefined);
    memory.markUnavailable("openai-codex", "gpt-5.1-codex-max", "not available on your plan");
    expect(memory.getUnavailableReason("openai-codex", "gpt-5.1-codex-max")).toBe(
      "not available on your plan",
    );
  });

  test("scopes the reason to the exact provider and model", () => {
    const memory = createModelAvailabilityMemory();
    memory.markUnavailable("openai-codex", "gpt-5.1-codex-max", "blocked");
    expect(memory.getUnavailableReason("openai-codex", "gpt-5.1-codex")).toBe(undefined);
    expect(memory.getUnavailableReason("deepseek", "gpt-5.1-codex-max")).toBe(undefined);
  });

  test("clears a remembered reason once the model works again", () => {
    const memory = createModelAvailabilityMemory();
    memory.markUnavailable("openai-codex", "gpt-5.1-codex-max", "blocked");
    memory.clear("openai-codex", "gpt-5.1-codex-max");
    expect(memory.getUnavailableReason("openai-codex", "gpt-5.1-codex-max")).toBe(undefined);
  });
});
