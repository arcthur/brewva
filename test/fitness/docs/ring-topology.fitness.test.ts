import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const systemArchitecture = resolve(repoRoot, "docs/architecture/system-architecture.md");

const RING_TABLE_HEADING = "## Authority Rings And Their Projections";

// The ring/plane double-coordinate-system was collapsed in
// `authority-rings-and-projection-unification`: rings are the single authority
// coordinate beneath the four-owner constitution, and "plane" is retired as a
// projection synonym. The closure is only durable if the suffix grammar is
// machine-checked. Without this guard the topology drifts back into mixed
// Ring / Boundary / Plane suffixes, and `Boundary` re-collides with
// `Effect Boundary` (the tool-invocation execution class). Every authority
// owner in the canonical topology table must therefore end in `Ring`.
function ringTableOwners(): string[] {
  const lines = readFileSync(systemArchitecture, "utf8").split("\n");
  const start = lines.findIndex((line) => line.startsWith(RING_TABLE_HEADING));
  expect(start, `${RING_TABLE_HEADING} section is missing`).toBeGreaterThanOrEqual(0);

  const owners: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("## ")) break; // reached the next section
    // Data rows look like:  | `Owner Name` | owns ... | projection | state |
    const match = /^\|\s*`([^`]+)`\s*\|/u.exec(line);
    if (match) owners.push(match[1]);
  }
  return owners;
}

describe("ring topology: every authority owner is a `* Ring`", () => {
  test("system-architecture ring-table owners all carry the Ring suffix", () => {
    const owners = ringTableOwners();

    // Sanity: the complete topology has eight rings. A lower count means the
    // table moved or the parser broke — fail rather than silently pass.
    expect(owners.length, `parsed owners: ${owners.join(", ")}`).toBeGreaterThanOrEqual(8);

    const offenders = owners.filter((name) => !name.endsWith("Ring"));
    expect(
      offenders,
      `Ring-table owners must end in "Ring"; "Boundary"/"Plane" suffixes are retired: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
