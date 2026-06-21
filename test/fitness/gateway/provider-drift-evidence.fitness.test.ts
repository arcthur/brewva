import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");

function readSource(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8");
}

// WS3 standing fitness (RFC "Drift Is Evidence, Seam-Wide"): provider-drift samples
// are lossy, non-authoritative diagnoses emitted through the SAME evidence sink the
// cache plane uses, and the inspect view that reads them is explicit-pull and
// read-only — no recall, materialization, routing, or mutation. Drift is diagnosis,
// never replay truth.

describe("provider drift evidence (WS3 standing fitness)", () => {
  test("drift samples are emitted lossy, never durable", () => {
    const source = readSource(
      "packages/brewva-gateway/src/hosted/internal/context/materialization.ts",
    );
    const helperStart = source.indexOf("export function appendProviderDriftSample");
    expect(helperStart).toBeGreaterThan(-1);
    const nextExport = source.indexOf("\nexport function", helperStart + 1);
    const helper = source.slice(helperStart, nextExport === -1 ? undefined : nextExport);
    expect(helper).toContain("asLossy(");
    expect(helper).toContain('kind: "provider_drift_sample"');
  });

  test("the drift inspect view is projection-only with no side effects", () => {
    const source = readSource("packages/brewva-cli/src/operator/inspect/provider-drift.ts");
    expect(source).toContain('sideEffectPolicy: "inspect_projection_only"');
    // Scan code only — the doc comment legitimately names what the view avoids.
    const code = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    for (const forbidden of [
      ".write(",
      "lifecycle.",
      "rememberState",
      "recall",
      "materializ",
      "routeProvider",
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });
});
