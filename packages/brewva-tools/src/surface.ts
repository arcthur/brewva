import { MANAGED_BREWVA_TOOL_METADATA_BY_NAME } from "./managed-tool-metadata-registry.js";
import type { BrewvaToolSurface } from "./types.js";

export type { BrewvaToolSurface } from "./types.js";

const MANAGED_BREWVA_TOOL_METADATA_ENTRIES = Object.entries(MANAGED_BREWVA_TOOL_METADATA_BY_NAME);

export const BREWVA_TOOL_SURFACE_BY_NAME = Object.fromEntries(
  MANAGED_BREWVA_TOOL_METADATA_ENTRIES.map(([name, entry]) => [name, entry.surface]),
) as Readonly<Record<string, BrewvaToolSurface>>;

function toolNamesBySurface(surface: BrewvaToolSurface): string[] {
  return MANAGED_BREWVA_TOOL_METADATA_ENTRIES.filter((entry) => entry[1].surface === surface)
    .map(([name]) => name)
    .toSorted();
}

export const BASE_BREWVA_TOOL_NAMES = toolNamesBySurface("base");
export const SKILL_BREWVA_TOOL_NAMES = toolNamesBySurface("skill");
export const CONTROL_PLANE_BREWVA_TOOL_NAMES = toolNamesBySurface("control_plane");
export const OPERATOR_BREWVA_TOOL_NAMES = toolNamesBySurface("operator");
export const MANAGED_BREWVA_TOOL_NAMES = Object.keys(
  MANAGED_BREWVA_TOOL_METADATA_BY_NAME,
).toSorted();

export function getBrewvaToolSurface(name: string): BrewvaToolSurface | undefined {
  return BREWVA_TOOL_SURFACE_BY_NAME[name];
}

export function isManagedBrewvaToolName(name: string): boolean {
  return Object.hasOwn(MANAGED_BREWVA_TOOL_METADATA_BY_NAME, name);
}
