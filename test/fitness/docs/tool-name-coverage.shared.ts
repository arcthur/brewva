import { MANAGED_BREWVA_TOOL_NAMES } from "@brewva/brewva-tools/registry";

export function collectDefinedToolNames(_sourceRoot: string): string[] {
  return [...MANAGED_BREWVA_TOOL_NAMES].toSorted((left, right) => left.localeCompare(right));
}
