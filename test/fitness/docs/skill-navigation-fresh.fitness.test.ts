import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");

describe("generated skill navigation", () => {
  it("is fresh and passes referential-integrity checks", () => {
    const result = spawnSync("bun", ["run", "docs:skill-navigation:check"], {
      cwd: repoRoot,
      encoding: "utf-8",
    });

    expect(result.status, [result.stdout, result.stderr].filter(Boolean).join("\n")).toBe(0);
  });

  it("captures sentence-initial handoff verbs and surfaces cycles explicitly", () => {
    // Ground-truth anchors so a "both sides wrong the same way" drift cannot pass
    // the freshness check alone. `office-hours` reaches its targets through
    // capitalized, partly one-word "Handoff to" prose, so its presence as a
    // source guards both the case-insensitive parse and the `hand ?off` one-word
    // variant; the discovery/office-hours/strategy SCC guards explicit cycle
    // surfacing.
    const view = readFileSync(resolve(repoRoot, "docs/reference/skill-navigation.md"), "utf-8");

    expect(view).toContain("- `office-hours` ->");
    expect(view).toContain("### Circular Handoffs");
    expect(view).toContain("- `discovery`, `office-hours`, `strategy`");
  });
});
