import { normalizeStringList } from "@brewva/brewva-std/text";

export { readNonEmptyString as normalizeNonEmptyString } from "@brewva/brewva-std/text";
export { isRecord } from "@brewva/brewva-std/unknown";

export function normalizeStringArray(value: unknown): string[] | undefined {
  const items = normalizeStringList(value);
  return items.length > 0 ? items : undefined;
}
