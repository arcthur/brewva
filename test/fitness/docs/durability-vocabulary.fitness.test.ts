import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DURABILITY_LEVELS, EFFECT_DELIVERY } from "@brewva/brewva-vocabulary/session";

const repoRoot = resolve(import.meta.dir, "../../..");

// Drift guard: the durability terms are named once, in the vocabulary. The
// journey doc and the runtime reference must cite those exact values, so a
// rename cannot silently leave the docs describing a guarantee the code no
// longer provides.
describe("durability vocabulary is cited by the durability docs", () => {
  const docs = ["docs/journeys/internal/wal-and-crash-recovery.md", "docs/reference/runtime.md"];

  for (const doc of docs) {
    test(`${doc} cites every durability term`, () => {
      const markdown = readFileSync(resolve(repoRoot, doc), "utf8");
      for (const level of DURABILITY_LEVELS) {
        expect(markdown).toContain(level);
      }
      expect(markdown).toContain(EFFECT_DELIVERY);
    });
  }
});
