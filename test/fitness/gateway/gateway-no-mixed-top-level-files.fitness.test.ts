import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { gatewayPath } from "./shared.js";

describe("gateway top-level source layout", () => {
  test("keeps loose root implementation files out of src/", () => {
    const files = readdirSync(gatewayPath(), { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .toSorted();
    expect(files).toEqual(["index.ts"]);
  });
});
