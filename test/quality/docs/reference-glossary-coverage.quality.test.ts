import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const EXPECTED_TERMS = [
  "Runtime Plugin",
  "Invocation Spine",
  "Context Compaction Gate",
  "Workbench",
  "Working State",
  "Working Projection",
  "Iteration Fact",
  "Subagent",
  "Delegation",
  "WorkerResult",
  "CapabilityView",
  "PersonaProfile",
  "Kernel Ring",
  "Deliberation Ring",
  "Experience Ring",
];

describe("docs/reference glossary coverage", () => {
  it("defines the core stable architecture and delegation terms", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const markdown = readFileSync(resolve(repoRoot, "docs/reference/glossary.md"), "utf-8");

    const missing = EXPECTED_TERMS.filter((term) => !markdown.includes(`${term}:`));

    expect(
      missing,
      `Missing glossary terms in docs/reference/glossary.md: ${missing.join(", ")}`,
    ).toEqual([]);
  });
});
