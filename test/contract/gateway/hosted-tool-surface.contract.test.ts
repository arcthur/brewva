import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("gateway contract: hosted tool surface", () => {
  test("anchors hosted read/edit/write tools on Brewva-owned substrate definitions", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const hostedSessionFactoryPath = resolve(
      repoRoot,
      "packages",
      "brewva-gateway",
      "src",
      "hosted",
      "internal",
      "session",
      "session-factory.ts",
    );

    const source = readFileSync(hostedSessionFactoryPath, "utf8");

    expect(source).not.toContain("createReadToolDefinition");
    expect(source).not.toContain("createEditToolDefinition");
    expect(source).not.toContain("createWriteToolDefinition");
    expect(source).toContain("createBrewvaReadToolDefinition");
    expect(source).toContain("createBrewvaEditToolDefinition");
    expect(source).toContain("createBrewvaWriteToolDefinition");
  });
});
