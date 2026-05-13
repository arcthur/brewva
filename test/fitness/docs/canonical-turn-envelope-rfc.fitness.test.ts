import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");

function readRepoMarkdown(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

describe("canonical hosted turn envelope RFC", () => {
  it("closes the envelope diagnostics durable projection decision", () => {
    const rfc = readRepoMarkdown("docs/research/decisions/canonical-hosted-turn-envelope.md");
    const hostedLoopRfc = readRepoMarkdown(
      "docs/research/decisions/hosted-thread-loop-and-unified-recovery-decisions.md",
    );
    const eventsReference = readRepoMarkdown("docs/reference/events/README.md");

    expect(rfc).toContain("Envelope diagnostics stay process-local");
    expect(rfc).toMatch(/No durable\s+envelope-diagnostics event should be added/u);
    expect(rfc).not.toContain("Remaining Backlog");
    expect(rfc).not.toContain("Decide whether envelope diagnostics");
    expect(hostedLoopRfc).toContain("Detailed recovery history stays process-local");
    expect(hostedLoopRfc).not.toContain("Decide whether detailed recovery history");
    expect(eventsReference).toMatch(
      /No separate durable envelope-diagnostics event is part of the\s+contract/u,
    );
  });
});
