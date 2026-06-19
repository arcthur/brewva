import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type {
  RuntimeSessionHydration,
  RuntimeSessionIntegrity,
} from "@brewva/brewva-tools/contracts";

const repoRoot = resolve(import.meta.dir, "../..");

// Standing fitness #1 (RFC "Prefer Standing Fitness Over One-Time Gates"):
// no evidence-bearing status is returned without evidence refs and a source cursor.
// The invariant is enforced at the type level by a discriminated union — an
// evidence-bearing status (`ready`/`degraded`/`cold`/`healthy`) must carry a cursor;
// a non-claim (`unavailable`/`inconclusive`) must carry a reason and a null cursor.
// This fitness blocks the two ways that guarantee can rot: an `as` cast that
// fabricates a status, and a future loosening of the union.

function listSourceFiles(relativeDir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(resolve(repoRoot, relativeDir))) {
    if (entry === "node_modules" || entry === "dist" || entry === ".tmp") continue;
    const relativePath = `${relativeDir}/${entry}`;
    const stats = statSync(resolve(repoRoot, relativePath));
    if (stats.isDirectory()) {
      files.push(...listSourceFiles(relativePath));
    } else if (stats.isFile() && relativePath.endsWith(".ts") && !relativePath.endsWith(".d.ts")) {
      files.push(relativePath);
    }
  }
  return files;
}

describe("recovery status evidence invariant (RFC WS0 standing fitness)", () => {
  test("a non-claim posture is evidence-free and reason-bearing by construction", () => {
    // No constructor indirection: the union itself forces these shapes. A non-claim
    // literal must carry a reason and a null cursor or it fails to type-check.
    const hydration: RuntimeSessionHydration = {
      status: "unavailable",
      hydratedAt: null,
      cursor: null,
      reason: "projector not implemented",
      issues: [],
    };
    expect(hydration.cursor).toBeNull();
    if (hydration.status !== "unavailable") throw new Error("expected unavailable");
    expect(hydration.reason.length).toBeGreaterThan(0);

    const integrity: RuntimeSessionIntegrity = {
      status: "inconclusive",
      cursor: null,
      reason: "checks not implemented",
      issues: [],
    };
    expect(integrity.cursor).toBeNull();
    if (integrity.status !== "inconclusive") throw new Error("expected inconclusive");
    expect(integrity.reason.length).toBeGreaterThan(0);
  });

  test("the union makes an evidence-bearing status without a cursor unrepresentable", () => {
    // @ts-expect-error a `ready` hydration must carry a cursor; this must not compile.
    const illegalHydration: RuntimeSessionHydration = {
      status: "ready",
      hydratedAt: 1,
      cursor: null,
      reason: null,
      issues: [],
    };
    // @ts-expect-error a `healthy` integrity must carry a cursor; this must not compile.
    const illegalIntegrity: RuntimeSessionIntegrity = {
      status: "healthy",
      cursor: null,
      reason: null,
      issues: [],
    };
    void illegalHydration;
    void illegalIntegrity;
    expect(true).toBe(true);
  });

  test("no source bypasses the discriminated union with an `as` cast", () => {
    const castPattern = /\bas\s+RuntimeSession(?:Hydration|Integrity)\w*/u;
    const contractFile = "packages/brewva-tools/src/contracts/runtime.ts";
    const offenders = listSourceFiles("packages")
      .filter((file) => file.includes("/src/") && file !== contractFile)
      .filter((file) => castPattern.test(readFileSync(resolve(repoRoot, file), "utf-8")))
      .toSorted();
    expect(offenders).toEqual([]);
  });
});
