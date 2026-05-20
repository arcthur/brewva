import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

describe("runtime event registry", () => {
  test("does not keep a global registered event catalog", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    expect(existsSync(resolve(repoRoot, "packages/brewva-runtime/src/events/registry.ts"))).toBe(
      false,
    );
  });
});
