import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const decisionsDir = resolve(repoRoot, "docs/research/decisions");

// Decisions are case law over the constitution. From this date forward every
// decision must cite the axioms it obeys or overrides, so a doc cannot silently
// widen authority. Decisions before the cutoff are grandfathered as-is.
const CITATION_CUTOFF = "2026-06-13";

// The one decision dated on the cutoff that predates the convention.
const GRANDFATHERED = new Set(["delegation-plane-hardening-and-envelope-archetype-cutover.md"]);

function decisionDate(source: string): string | null {
  return /Date:\s*`(\d{4}-\d{2}-\d{2})`/u.exec(source)?.[1] ?? null;
}

describe("decision records cite the axioms they answer to", () => {
  test("decisions dated on or after the cutoff reference design-axioms.md and an ## Axioms section", () => {
    const offenders = readdirSync(decisionsDir)
      .filter((name) => name.endsWith(".md") && name !== "README.md" && !GRANDFATHERED.has(name))
      .filter((name) => {
        const source = readFileSync(join(decisionsDir, name), "utf8");
        const date = decisionDate(source);
        if (!date || date < CITATION_CUTOFF) {
          return false;
        }
        const citesAxioms = source.includes("design-axioms.md") && /^##\s+Axioms\b/mu.test(source);
        return !citesAxioms;
      });

    expect(offenders).toEqual([]);
  });
});
