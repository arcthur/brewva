import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("provider core built-in registration structure contract", () => {
  test("keeps built-in registry and lazy loader in one canonical module", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const builtinsPath = resolve(
      repoRoot,
      "packages",
      "brewva-provider-core",
      "src",
      "registry",
      "builtins.ts",
    );
    const builtinsRuntimePath = resolve(
      repoRoot,
      "packages",
      "brewva-provider-core",
      "src",
      "registry",
      "builtins-runtime.ts",
    );
    const providerLoaderRuntimePath = resolve(
      repoRoot,
      "packages",
      "brewva-provider-core",
      "src",
      "providers",
      "provider-loader-runtime.ts",
    );
    const builtinsSource = readFileSync(builtinsPath, "utf8");

    expect(existsSync(builtinsRuntimePath)).toBe(false);
    expect(existsSync(providerLoaderRuntimePath)).toBe(false);
    expect(builtinsSource).toContain("BUILT_IN_API_PROVIDER_APIS");
    expect(builtinsSource).toContain("STANDARD_BUILT_IN_PROVIDER_REGISTRATION_FACTORIES");
    expect(builtinsSource).toContain("registerBuiltInApiProviders");
    expect(builtinsSource).toContain("createCachedModuleLoader");
    expect(builtinsSource).toContain("createProviderModuleLoader");
    expect(builtinsSource).toContain("createLazyStream");
    expect(builtinsSource).toContain("loadModule().then");
    expect(builtinsSource).toContain("for (const registration");
    expect(builtinsSource).not.toContain("built-in-api-provider-manifest");
    expect(builtinsSource).not.toContain("builtins-runtime");
    expect(builtinsSource).not.toContain("registrations[0]");
    expect(builtinsSource).not.toContain("registrations[1]");
  });
});
