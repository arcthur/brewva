import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BREWVA_REGISTERED_EVENT_TYPES } from "@brewva/brewva-runtime";

function collectDocumentedEventTypes(markdown: string): string[] {
  const matches = markdown.matchAll(/`([a-z0-9_]+)`/g);
  const eventTypes = new Set<string>();

  for (const match of matches) {
    const value = match[1];
    if (!value) continue;
    eventTypes.add(value);
  }

  return [...eventTypes].toSorted();
}

describe("docs/reference events coverage", () => {
  it("documents every registered runtime event type", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const markdown = readFileSync(resolve(repoRoot, "docs/reference/events.md"), "utf-8");
    const documented = new Set(collectDocumentedEventTypes(markdown));

    const missing = BREWVA_REGISTERED_EVENT_TYPES.filter((eventType) => !documented.has(eventType));

    expect(
      missing,
      `Missing runtime events in docs/reference/events.md: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
