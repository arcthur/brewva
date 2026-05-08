import { realpathSync } from "node:fs";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { normalizeSearchText } from "@brewva/brewva-search";
import {
  MIN_DELIMITER_FALLBACK_LENGTH,
  type NormalizedEventRecord,
  type SearchToolName,
} from "./types.js";

export const normalizeSearchAdvisorQuery = normalizeSearchText;

export function normalizeSessionId(sessionId: string | undefined): string | undefined {
  const normalized = sessionId?.trim();
  return normalized ? normalized : undefined;
}

export function normalizeSignalPath(path: string): string {
  const normalized = path
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");
  return normalized.length === 0 ? "." : normalized;
}

export function normalizeSearchAdvisorPath(baseCwd: string, candidate: string): string | undefined {
  const trimmed = candidate.trim();
  if (!trimmed) {
    return undefined;
  }
  const resolvedBase = resolve(baseCwd);
  let normalizedBase = resolvedBase;
  try {
    normalizedBase = realpathSync.native(normalizedBase);
  } catch {
    // ignore
  }
  const absolutePath = isAbsolute(trimmed) ? resolve(trimmed) : resolve(normalizedBase, trimmed);
  let normalizedAbsolute = absolutePath;
  try {
    normalizedAbsolute = realpathSync.native(normalizedAbsolute);
  } catch {
    if (absolutePath === resolvedBase || absolutePath.startsWith(`${resolvedBase}/`)) {
      normalizedAbsolute = `${normalizedBase}${absolutePath.slice(resolvedBase.length)}`;
    }
  }
  const relativePath = relative(normalizedBase, normalizedAbsolute).replaceAll("\\", "/");
  if (relativePath.startsWith("../") || relativePath === "..") {
    return undefined;
  }
  if (relativePath.length === 0) {
    return ".";
  }
  return normalizeSignalPath(relativePath);
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const output: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const normalized = normalizeSignalPath(entry);
    if (!output.includes(normalized)) {
      output.push(normalized);
    }
  }
  return output;
}

export function normalizePayloadRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

export function normalizeEventRecord(value: unknown): NormalizedEventRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const type = typeof record.type === "string" ? record.type : undefined;
  const timestamp = typeof record.timestamp === "number" ? record.timestamp : undefined;
  if (!type || !timestamp) {
    return undefined;
  }
  const id =
    typeof record.id === "string" && record.id.length > 0
      ? record.id
      : `${type}:${timestamp}:${JSON.stringify(record.payload ?? null)}`;
  return {
    id,
    type,
    timestamp,
    payload: normalizePayloadRecord(record.payload),
  };
}

export function buildQueryKey(toolName: SearchToolName, query: string): string | undefined {
  const normalizedQuery = normalizeSearchAdvisorQuery(query);
  if (!normalizedQuery) return undefined;
  return `${toolName}:${normalizedQuery}`;
}

export function buildAncestorDirectories(path: string): string[] {
  const normalized = normalizeSignalPath(path);
  const output: string[] = [];
  const rooted = normalized.startsWith("/");
  let current = posix.dirname(normalized);
  if (current === "") current = rooted ? "/" : ".";
  while (true) {
    if (!output.includes(current)) {
      output.push(current);
    }
    if ((!rooted && current === ".") || (rooted && current === "/")) break;
    const next = posix.dirname(current);
    if (next === current) {
      break;
    }
    current = next === "" ? (rooted ? "/" : ".") : next;
  }
  return output;
}

export function buildDelimiterInsensitivePattern(query: string): string | null {
  const normalized = normalizeSearchAdvisorQuery(query)
    .replace(/[_./:\-\s]+/gu, "")
    .trim();
  if (normalized.length < MIN_DELIMITER_FALLBACK_LENGTH) {
    return null;
  }
  return normalized
    .split("")
    .map((char) => char.replace(/[|\\{}()[\]^$+*?.]/gu, "\\$&"))
    .join("[-_./:\\s]*");
}
