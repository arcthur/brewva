import { describe, expect, test } from "bun:test";
import { clearApiProviders, getApiProviders, type ApiProvider } from "@brewva/brewva-provider-core";
import { BUILT_IN_API_PROVIDER_APIS } from "../../../packages/brewva-provider-core/src/providers/built-in-api-ids.js";
import { registerBuiltInApiProviders } from "../../../packages/brewva-provider-core/src/providers/register-builtins.js";

describe("provider core built-in api catalog", () => {
  test("keeps one canonical built-in API list and registers exactly that set", () => {
    expect(new Set(BUILT_IN_API_PROVIDER_APIS).size).toBe(BUILT_IN_API_PROVIDER_APIS.length);

    clearApiProviders();
    registerBuiltInApiProviders();

    const registeredApis = getApiProviders().map((provider: ApiProvider) => provider.api);

    expect(registeredApis).toEqual([...BUILT_IN_API_PROVIDER_APIS]);
  });
});
