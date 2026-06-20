import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");

describe("generated axiom enforcement", () => {
  it("is fresh and passes referential-integrity checks", () => {
    const result = spawnSync("bun", ["run", "docs:axiom-enforcement:check"], {
      cwd: repoRoot,
      encoding: "utf-8",
    });

    expect(result.status, [result.stdout, result.stderr].filter(Boolean).join("\n")).toBe(0);
  });

  it("covers every axiom and surfaces negative space as ground-truth anchors", () => {
    // Ground-truth anchors so a "both sides wrong the same way" drift cannot pass
    // the freshness check alone. Completeness (every axiom has a row), one stable
    // tag->axiom join (the attention rules sit under axiom 1), the negative-space
    // branch, and precedent re-grounding (the derivation-direction-invariant
    // decision under its own axiom 18) each guard a distinct generator path.
    const view = readFileSync(resolve(repoRoot, "docs/reference/axiom-enforcement.md"), "utf-8");

    for (let axiom = 1; axiom <= 18; axiom++) {
      expect(view).toContain(`### Axiom ${axiom} — `);
    }
    expect(view).toMatch(/### Axiom 1 —[\s\S]*?`attention_options`[\s\S]*?### Axiom 2 —/u);
    expect(view).toContain("Enforced by: _no tagged rule — negative space._");
    expect(view).toMatch(
      /### Axiom 18 —[\s\S]*?derivation-direction-invariant-and-skill-navigation/u,
    );
  });
});
