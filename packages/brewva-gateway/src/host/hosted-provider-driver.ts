import {
  createFetchProviderCompletionDriver,
  type BrewvaProviderCompletionDriver,
} from "@brewva/brewva-substrate";

const DEFAULT_HOSTED_PROVIDER_DRIVER = createFetchProviderCompletionDriver();

export function createHostedProviderDriver(): BrewvaProviderCompletionDriver {
  return DEFAULT_HOSTED_PROVIDER_DRIVER;
}
