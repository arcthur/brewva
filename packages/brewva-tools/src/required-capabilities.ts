import { normalizeToolName } from "@brewva/brewva-runtime";
import {
  MANAGED_BREWVA_TOOL_METADATA_BY_NAME,
  type ManagedBrewvaToolMetadataRegistryEntry,
} from "./managed-tool-metadata-registry.js";
import type { BrewvaToolRequiredCapability } from "./types.js";

const MANAGED_BREWVA_TOOL_METADATA_ENTRIES = Object.entries(
  MANAGED_BREWVA_TOOL_METADATA_BY_NAME,
) as Array<[string, ManagedBrewvaToolMetadataRegistryEntry]>;

export const TOOL_REQUIRED_CAPABILITIES_BY_NAME = Object.fromEntries(
  MANAGED_BREWVA_TOOL_METADATA_ENTRIES.filter((entry) => {
    const requiredCapabilities = entry[1].requiredCapabilities;
    return Array.isArray(requiredCapabilities) && requiredCapabilities.length > 0;
  }).map(([name, entry]) => {
    const requiredCapabilities = entry.requiredCapabilities ?? [];
    return [
      name,
      [...new Set(requiredCapabilities)].toSorted((left, right) => left.localeCompare(right)),
    ];
  }),
) as Readonly<Record<string, readonly BrewvaToolRequiredCapability[]>>;

export type ManagedBrewvaToolName = keyof typeof MANAGED_BREWVA_TOOL_METADATA_BY_NAME;

export type DeclaredBrewvaToolRequiredCapabilities<TToolName extends ManagedBrewvaToolName> =
  (typeof MANAGED_BREWVA_TOOL_METADATA_BY_NAME)[TToolName] extends {
    requiredCapabilities: readonly BrewvaToolRequiredCapability[];
  }
    ? (typeof MANAGED_BREWVA_TOOL_METADATA_BY_NAME)[TToolName]["requiredCapabilities"][number]
    : never;

function cloneRequiredCapabilities(
  input: readonly BrewvaToolRequiredCapability[] | undefined,
): BrewvaToolRequiredCapability[] | undefined {
  if (!input || input.length === 0) {
    return undefined;
  }
  return [...new Set(input)].toSorted();
}

export function getExactBrewvaToolRequiredCapabilities(
  toolName: string,
): readonly BrewvaToolRequiredCapability[] | undefined {
  const normalizedName = normalizeToolName(toolName);
  if (!normalizedName) {
    return undefined;
  }
  return cloneRequiredCapabilities(TOOL_REQUIRED_CAPABILITIES_BY_NAME[normalizedName]);
}

export function getBrewvaToolRequiredCapabilities(
  toolName: string,
): BrewvaToolRequiredCapability[] {
  return getExactBrewvaToolRequiredCapabilities(toolName)?.slice() ?? [];
}
