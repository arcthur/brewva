import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

describe("provider core surface contract", () => {
  test("preserves the compatibility root while exposing focused subpaths", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const packageJsonPath = resolve(repoRoot, "packages", "brewva-provider-core", "package.json");
    const srcRoot = resolve(repoRoot, "packages", "brewva-provider-core", "src");
    const indexPath = resolve(repoRoot, "packages", "brewva-provider-core", "src", "index.ts");
    const contractsIndexPath = resolve(
      repoRoot,
      "packages",
      "brewva-provider-core",
      "src",
      "contracts",
      "index.ts",
    );
    const cliPath = resolve(repoRoot, "packages", "brewva-provider-core", "src", "cli.ts");
    const oauthPath = resolve(repoRoot, "packages", "brewva-provider-core", "src", "oauth.ts");
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
    const contractsIndexSource = readFileSync(contractsIndexPath, "utf8");
    const rootSourceFiles = readdirSync(srcRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => entry.name)
      .toSorted();

    expect(rootSourceFiles).toEqual(["index.ts"]);
    expect(Object.keys(packageJson.exports ?? {})).toEqual([
      ".",
      "./auth",
      "./cache",
      "./catalog",
      "./contracts",
      "./registry",
      "./stream",
    ]);
    expect(indexSource).toContain('from "./stream/index.js"');
    expect(indexSource).toContain('from "./auth/index.js"');
    expect(indexSource).toContain('from "./cache/index.js"');
    expect(indexSource).toContain('from "./catalog/index.js"');
    expect(indexSource).toContain('from "./contracts/index.js"');
    expect(indexSource).toContain('from "./registry/index.js"');
    expect(indexSource).not.toContain('from "./types.js"');
    expect(indexSource).not.toContain('from "./models.js"');
    expect(indexSource).not.toContain('from "./env-api-keys.js"');
    expect(existsSync(resolve(srcRoot, "auth.ts"))).toBe(false);
    expect(existsSync(resolve(srcRoot, "catalog.ts"))).toBe(false);
    expect(existsSync(resolve(srcRoot, "api-registry.ts"))).toBe(false);
    expect(existsSync(resolve(srcRoot, "stream.ts"))).toBe(false);
    expect(existsSync(resolve(srcRoot, "provider-options.ts"))).toBe(false);
    expect(contractsIndexSource).toContain('from "./event.js"');
    expect(contractsIndexSource).toContain('from "./port.js"');

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
    expect(existsSync(oauthUtilsPath)).toBe(false);
  });

  test("keeps the compatibility root export snapshot explicit", async () => {
    const root = await import("@brewva/brewva-provider-core");

    expect(Object.keys(root).toSorted()).toEqual([
      "DEFAULT_PROVIDER_CACHE_POLICY",
      "GoogleCachedContentError",
      "buildProviderCacheBucketKey",
      "buildRenderBucketKey",
      "calculateCost",
      "clearApiProviderSessions",
      "clearApiProviders",
      "complete",
      "completeSimple",
      "createGoogleCachedContent",
      "deleteGoogleCachedContent",
      "getApiProvider",
      "getApiProviders",
      "getEnvApiKey",
      "getExternalApiProvider",
      "getModel",
      "getModels",
      "getProviders",
      "getTypedApiProvider",
      "modelsAreEqual",
      "normalizeProviderCachePolicy",
      "parseGoogleGeminiCliCredential",
      "registerApiProvider",
      "registerExternalApiProvider",
      "registerTypedApiProvider",
      "resolveAnthropicCacheRender",
      "resolveGoogleCachedContentEndpoint",
      "resolveGoogleGeminiCliCacheRender",
      "resolveOpenAICompletionsCacheRender",
      "resolveOpenAIResponsesCacheRender",
      "resolveProviderCacheCapability",
      "stream",
      "streamSimple",
      "supportsXhigh",
      "supportsXhighModelId",
      "unregisterApiProviders",
    ]);
  });
});
