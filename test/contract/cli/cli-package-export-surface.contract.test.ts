import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("cli package export surface", () => {
  test("keeps root narrow and exposes explicit experience subpaths", () => {
    const packageJson = JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, "../../../packages/brewva-cli/package.json"),
        "utf8",
      ),
    ) as {
      exports?: Record<string, unknown>;
    };
    const exportsMap = packageJson.exports ?? {};

    expect(Object.keys(exportsMap).toSorted()).toEqual([
      ".",
      "./channel",
      "./commands",
      "./entry",
      "./extensions",
      "./internal-shell-runtime",
      "./io/json-lines",
    ]);
    expect(exportsMap).not.toHaveProperty("./shell/state");
  });
});
