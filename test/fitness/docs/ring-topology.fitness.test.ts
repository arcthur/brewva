import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const systemArchitecture = resolve(repoRoot, "docs/architecture/system-architecture.md");
const designAxioms = resolve(repoRoot, "docs/architecture/design-axioms.md");
const glossary = resolve(repoRoot, "docs/reference/glossary.md");

const RING_TABLE_HEADING = "## Authority Rings And Their Projections";

// The ring/plane double-coordinate-system was collapsed in
// `authority-rings-and-projection-unification`: rings are the single authority
// coordinate beneath the four-owner constitution, and "plane" is retired as a
// projection synonym. The closure is only durable if the suffix grammar is
// machine-checked. Without this guard the topology drifts back into mixed
// Ring / Boundary / Plane suffixes, and `Boundary` re-collides with
// `Effect Boundary` (the tool-invocation execution class). Every authority
// owner in the canonical topology table must therefore end in `Ring`.
interface RingTableRow {
  readonly owner: string;
  readonly owns: string;
}

function ringTableRows(): RingTableRow[] {
  const lines = readFileSync(systemArchitecture, "utf8").split("\n");
  const start = lines.findIndex((line) => line.startsWith(RING_TABLE_HEADING));
  expect(start, `${RING_TABLE_HEADING} section is missing`).toBeGreaterThanOrEqual(0);

  const rows: RingTableRow[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break; // reached the next section
    // Data rows look like:  | `Owner Name` | owns ... | projection | state |
    const match = /^\|\s*`([^`]+)`\s*\|\s*([^|]+)\|/u.exec(line);
    const owner = match?.[1];
    const owns = match?.[2]?.trim();
    if (owner && owns) rows.push({ owner, owns });
  }
  return rows;
}

describe("ring topology: every authority owner is a `* Ring`", () => {
  test("system-architecture ring-table owners all carry the Ring suffix", () => {
    const owners = ringTableRows().map((row) => row.owner);

    // Sanity: the complete topology has eight rings. A lower count means the
    // table moved or the parser broke — fail rather than silently pass.
    expect(owners.length, `parsed owners: ${owners.join(", ")}`).toBeGreaterThanOrEqual(8);

    const offenders = owners.filter((name) => !name.endsWith("Ring"));
    expect(
      offenders,
      `Ring-table owners must end in "Ring"; "Boundary"/"Plane" suffixes are retired: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  test("runtime turn execution and between-turn session coordination have distinct owners", () => {
    const rows = ringTableRows();
    const runtimeTurn = rows.find((row) => row.owner === "Runtime Turn Ring");
    const substrate = rows.find((row) => row.owner === "Substrate Ring");

    expect(runtimeTurn?.owns).toContain("within one accepted turn");
    expect(substrate?.owns).toContain("between-turn session coordination");
    expect(substrate?.owns).not.toContain("runtime.turn");
  });

  test("Boundary and Plane restrictions stay scoped to ring vocabulary", () => {
    const axioms = readFileSync(designAxioms, "utf8");
    const glossarySource = readFileSync(glossary, "utf8");

    expect(axioms).toContain("`Boundary` is not a ring suffix");
    expect(axioms).toMatch(/`Plane` is not an authority coordinate or\s+projection suffix/u);
    expect(glossarySource).toContain("`Control Plane Ring`");
  });
});
