import { describe, expect, test } from "bun:test";
import { clearApiProviders, getApiProviders } from "@brewva/brewva-provider-core/registry";
import {
  BUILT_IN_API_PROVIDER_APIS,
  getStandardBuiltInApiProviderRegistrations,
  registerBuiltInApiProviders,
} from "../../../packages/brewva-provider-core/src/registry/builtins.js";

describe("provider core built-in api catalog", () => {
  test("keeps one canonical built-in API list and registers exactly that set", () => {
    expect(new Set(BUILT_IN_API_PROVIDER_APIS).size).toBe(BUILT_IN_API_PROVIDER_APIS.length);

    clearApiProviders();
    registerBuiltInApiProviders();

    const registeredApis = getApiProviders().map((provider) => provider.api);

    expect(registeredApis).toEqual([...BUILT_IN_API_PROVIDER_APIS]);
  });

  test("builds registration objects in canonical order before mutating the registry", () => {
    const registrations = getStandardBuiltInApiProviderRegistrations();

    expect(registrations.map((provider) => provider.api)).toEqual([...BUILT_IN_API_PROVIDER_APIS]);
    expect(
      registrations.find((provider) => provider.api === "openai-codex-responses")?.sessionResources,
    ).toBeDefined();
  });
});
