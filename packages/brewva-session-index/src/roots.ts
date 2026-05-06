import { resolve } from "node:path";
import { uniqueStrings } from "./collections.js";

export function normalizeRoot(value: string | undefined, fallback: string): string {
  return resolve(value ?? fallback);
}

export function normalizeRoots(roots: readonly string[] | undefined, fallback: string): string[] {
  const normalized = uniqueStrings(
    (roots ?? [])
      .map((root) => root.trim())
      .filter((root) => root.length > 0)
      .map((root) => resolve(root)),
  );
  return normalized.length > 0 ? normalized : [resolve(fallback)];
}
