import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { CANONICAL_EVENT_TYPES } from "@brewva/brewva-runtime";
import {
  collectInlineCodeValues,
  extractGeneratedSegment,
  readEventsReferenceMarkdown,
} from "./generated-segments.shared.js";

describe("docs/reference events coverage", () => {
  it("generates every canonical runtime event type", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const markdown = readEventsReferenceMarkdown(repoRoot);
    const segment = extractGeneratedSegment(markdown, "event-catalog");
    const documented = collectInlineCodeValues(segment);

    const missing = CANONICAL_EVENT_TYPES.filter((eventType) => !documented.has(eventType));

    expect(
      missing,
      `Missing canonical runtime events in generated event inventory: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
