export const WORKBENCH_EVICTION_SPAN_REF_PREFIXES = [
  "entry",
  "event",
  "message",
  "tool",
  "turn",
] as const;

export type WorkbenchEvictionSpanRefPrefix = (typeof WORKBENCH_EVICTION_SPAN_REF_PREFIXES)[number];

const WORKBENCH_EVICTION_SPAN_REF_PREFIX_SET = new Set<string>(
  WORKBENCH_EVICTION_SPAN_REF_PREFIXES,
);

export interface ParsedWorkbenchEvictionSpanRef {
  prefix: WorkbenchEvictionSpanRefPrefix;
  value: string;
  normalized: string;
}

export function parseWorkbenchEvictionSpanRef(ref: string): ParsedWorkbenchEvictionSpanRef | null {
  const trimmed = ref.trim();
  const separator = trimmed.indexOf(":");
  if (separator <= 0 || separator === trimmed.length - 1) {
    return null;
  }

  const prefix = trimmed.slice(0, separator).toLowerCase();
  const value = trimmed.slice(separator + 1).trim();
  if (!WORKBENCH_EVICTION_SPAN_REF_PREFIX_SET.has(prefix) || value.length === 0) {
    return null;
  }

  return {
    prefix: prefix as WorkbenchEvictionSpanRefPrefix,
    value,
    normalized: `${prefix}:${value}`,
  };
}

export function normalizeWorkbenchEvictionSpanRefs(refs: readonly string[]): string[] {
  return [
    ...new Set(
      refs
        .map((ref) => parseWorkbenchEvictionSpanRef(ref)?.normalized)
        .filter((ref): ref is string => Boolean(ref)),
    ),
  ];
}

export function listInvalidWorkbenchEvictionSpanRefs(refs: readonly string[]): string[] {
  return refs.filter((ref) => parseWorkbenchEvictionSpanRef(ref) === null);
}
