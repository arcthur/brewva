import { normalizeToolName } from "@brewva/brewva-runtime";
import { MANAGED_BREWVA_TOOL_METADATA_BY_NAME } from "./managed-tool-metadata-registry.js";
import type { BrewvaToolRequiredCapability } from "./types.js";

const MANAGED_BREWVA_TOOL_METADATA_ENTRIES = Object.entries(MANAGED_BREWVA_TOOL_METADATA_BY_NAME);

function hasRequiredCapabilities(
  entry: (typeof MANAGED_BREWVA_TOOL_METADATA_ENTRIES)[number][1],
): entry is (typeof MANAGED_BREWVA_TOOL_METADATA_ENTRIES)[number][1] & {
  requiredCapabilities: readonly BrewvaToolRequiredCapability[];
} {
  return (
    "requiredCapabilities" in entry &&
    Array.isArray(entry.requiredCapabilities) &&
    entry.requiredCapabilities.length > 0
  );
}

export const TOOL_REQUIRED_CAPABILITIES_BY_NAME = Object.fromEntries(
  MANAGED_BREWVA_TOOL_METADATA_ENTRIES.filter(
    (
      entry,
    ): entry is [
      string,
      (typeof MANAGED_BREWVA_TOOL_METADATA_ENTRIES)[number][1] & {
        requiredCapabilities: readonly BrewvaToolRequiredCapability[];
      },
    ] => hasRequiredCapabilities(entry[1]),
  ).map(([name, entry]) => [
    name,
    [...new Set(entry.requiredCapabilities)].toSorted((left, right) => left.localeCompare(right)),
  ]),
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
