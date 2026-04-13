import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("provider core surface contract", () => {
  test("keeps the public surface focused on Brewva-owned stream primitives", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const packageJsonPath = resolve(repoRoot, "packages", "brewva-provider-core", "package.json");
    const indexPath = resolve(repoRoot, "packages", "brewva-provider-core", "src", "index.ts");
    const cliPath = resolve(repoRoot, "packages", "brewva-provider-core", "src", "cli.ts");
    const oauthPath = resolve(repoRoot, "packages", "brewva-provider-core", "src", "oauth.ts");
    const bedrockProviderPath = resolve(
      repoRoot,
      "packages",
      "brewva-provider-core",
      "src",
      "bedrock-provider.ts",
    );
    const oauthUtilsPath = resolve(
      repoRoot,
      "packages",
      "brewva-provider-core",
      "src",
      "utils",
      "oauth",
    );

    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      exports?: Record<string, unknown>;
    };
    const indexSource = readFileSync(indexPath, "utf8");

    expect(Object.keys(packageJson.exports ?? {})).toEqual(["."]);
    expect(indexSource).toContain('from "./stream.js"');
    expect(indexSource).toContain('from "./types.js"');
    expect(indexSource).toContain('from "./catalog.js"');
    expect(indexSource).toContain('from "./auth.js"');
    expect(indexSource).toContain('from "./api-registry.js"');
    expect(indexSource).not.toContain('from "./models.js"');
    expect(indexSource).not.toContain('from "./env-api-keys.js"');

    expect(indexSource).not.toContain('from "./providers/');
    expect(indexSource).not.toContain('from "./utils/oauth/');
    expect(indexSource).not.toContain('from "./utils/validation.js"');
    expect(indexSource).not.toContain('from "./utils/typebox-helpers.js"');
    expect(indexSource).not.toContain('from "./utils/json-parse.js"');
    expect(indexSource).not.toContain('from "./utils/event-stream.js"');
    expect(indexSource).not.toContain('from "./utils/overflow.js"');
    expect(indexSource).not.toContain('from "@sinclair/typebox"');
    expect(existsSync(cliPath)).toBe(false);
    expect(existsSync(oauthPath)).toBe(false);
    expect(existsSync(bedrockProviderPath)).toBe(false);
    expect(existsSync(oauthUtilsPath)).toBe(false);
  });
});
