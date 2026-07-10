import type { HarnessManifest } from "@brewva/brewva-vocabulary/harness";

/**
 * Deterministic field-level diff between two harness manifests: dot-path
 * leaves whose canonical JSON differs, `manifestId` stripped (it derives from
 * the content being compared). Lives beside the materialization classifier so
 * the comparison API can derive the changed-field set itself instead of
 * trusting a caller-supplied list.
 */
export function diffHarnessManifestFields(
  base: HarnessManifest,
  candidate: HarnessManifest,
): string[] {
  const fields = new Set<string>();
  collectChangedManifestFields("", base, candidate, fields);
  fields.delete("manifestId");
  return [...fields].toSorted();
}

function collectChangedManifestFields(
  path: string,
  base: unknown,
  candidate: unknown,
  fields: Set<string>,
): void {
  if (stableCompareJson(base) === stableCompareJson(candidate)) return;
  if (!isPlainRecord(base) || !isPlainRecord(candidate)) {
    if (path.length > 0) fields.add(path);
    return;
  }
  for (const key of [...new Set([...Object.keys(base), ...Object.keys(candidate)])].toSorted()) {
    collectChangedManifestFields(
      path.length > 0 ? `${path}.${key}` : key,
      base[key],
      candidate[key],
      fields,
    );
  }
}

function stableCompareJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableCompareJson).join(",")}]`;
  }
  if (!isPlainRecord(value)) {
    return JSON.stringify(value === undefined ? null : value);
  }
  return `{${Object.keys(value)
    .toSorted()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableCompareJson(value[key])}`)
    .join(",")}}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
