import type { IdentifierOccurrence } from "../parsing/index.js";

export function summarizeOccurrences(
  name: string,
  occurrences: readonly IdentifierOccurrence[],
): { text: string; payload: Record<string, unknown> } {
  const valueDefinitions = occurrences.filter((o) => o.kind === "value_definition").length;
  const valueReferences = occurrences.filter((o) => o.kind === "value_reference").length;
  const valueWrites = occurrences.filter((o) => o.kind === "value_write").length;
  const typeDefinitions = occurrences.filter((o) => o.kind === "type_definition").length;
  const typeReferences = occurrences.filter((o) => o.kind === "type_reference").length;
  const text = `Rename available for '${name}'. Single-file occurrences: ${occurrences.length} (value defs: ${valueDefinitions}, value reads: ${valueReferences}, value writes: ${valueWrites}, type defs: ${typeDefinitions}, type refs: ${typeReferences}).`;
  return {
    text,
    payload: {
      occurrences: occurrences.length,
      valueDefinitions,
      valueWrites,
      valueReferences,
      typeDefinitions,
      typeReferences,
    },
  };
}
