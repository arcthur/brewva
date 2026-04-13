import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("provider core built-in registration structure contract", () => {
  test("keeps registration entrypoint thin and delegates manifest and loaders", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const registerBuiltinsPath = resolve(
      repoRoot,
      "packages",
      "brewva-provider-core",
      "src",
      "providers",
      "register-builtins.ts",
    );
    const manifestPath = resolve(
      repoRoot,
      "packages",
      "brewva-provider-core",
      "src",
      "providers",
      "built-in-api-provider-manifest.ts",
    );
    const loadersPath = resolve(
      repoRoot,
      "packages",
      "brewva-provider-core",
      "src",
      "providers",
      "built-in-provider-loaders.ts",
    );
    const runtimePath = resolve(
      repoRoot,
      "packages",
      "brewva-provider-core",
      "src",
      "providers",
      "provider-loader-runtime.ts",
    );
    const bedrockLoaderPath = resolve(
      repoRoot,
      "packages",
      "brewva-provider-core",
      "src",
      "providers",
      "bedrock-provider-loader.ts",
    );

    const registerBuiltinsSource = readFileSync(registerBuiltinsPath, "utf8");
    const manifestSource = readFileSync(manifestPath, "utf8");
    const loadersSource = readFileSync(loadersPath, "utf8");
    const runtimeSource = readFileSync(runtimePath, "utf8");
    const bedrockLoaderSource = readFileSync(bedrockLoaderPath, "utf8");

    expect(registerBuiltinsSource).toContain('from "./built-in-api-provider-manifest.js"');
    expect(registerBuiltinsSource).not.toContain('import("./anthropic.js")');
    expect(registerBuiltinsSource).not.toContain("createLazyStream(");

    expect(manifestSource).toContain('from "./built-in-provider-loaders.js"');
    expect(manifestSource).toContain('from "./bedrock-provider-loader.js"');
    expect(manifestSource).toContain("getStandardBuiltInApiProviderRegistrations");
    expect(manifestSource).not.toContain("loadAnthropicProviderModule");

    expect(loadersSource).toContain('from "./provider-loader-runtime.js"');
    expect(loadersSource).toContain("createNamedProviderModuleLoader");
    expect(loadersSource).toContain("STANDARD_BUILT_IN_PROVIDER_REGISTRATION_DESCRIPTORS");
    expect(loadersSource).not.toContain("export const loadAnthropicProviderModule");
    expect(loadersSource).not.toContain("setBedrockProviderModule(");

    expect(runtimeSource).toContain("createLazyStream");
    expect(runtimeSource).toContain("createCachedModuleLoader");
    expect(runtimeSource).toContain("createNamedProviderModuleLoader");

    expect(bedrockLoaderSource).toContain("setBedrockProviderModule");
    expect(bedrockLoaderSource).toContain('importNodeOnlyProvider("./amazon-bedrock.js")');
  });
});
