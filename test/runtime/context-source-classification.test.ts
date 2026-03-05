import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

describe("context source classification removal", () => {
  test("drop_recall classifier module is removed", () => {
    const filePath = join(
      process.cwd(),
      "packages",
      "brewva-runtime",
      "src",
      "context",
      "source-classification.ts",
    );
    expect(existsSync(filePath)).toBe(false);
  });
});
