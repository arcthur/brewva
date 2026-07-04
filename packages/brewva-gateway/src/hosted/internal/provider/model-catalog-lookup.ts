import { getModels } from "@brewva/brewva-provider-core/catalog";
import type { KnownProvider } from "@brewva/brewva-provider-core/contracts";

/**
 * By-id catalog lookup tolerant of unknown providers and models. The typed
 * `getModel` overloads require literal model ids; runtime metadata carries
 * plain strings, so consumers share this single tolerant resolver instead of
 * re-rolling `getModels().find()` at each site.
 */
export function findCatalogModel(
  provider: string,
  modelId: string,
): ReturnType<typeof getModels>[number] | undefined {
  try {
    return getModels(provider as KnownProvider).find((entry) => entry.id === modelId);
  } catch {
    return undefined;
  }
}
