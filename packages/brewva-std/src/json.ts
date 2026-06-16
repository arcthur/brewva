export type JsonPrimitive = string | number | boolean | null;
export type JsonArray = JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonValue = JsonPrimitive | JsonArray | JsonObject;

function compareKeys(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function sortJsonValue<T extends JsonValue>(value: T): T;
export function sortJsonValue(value: unknown): unknown;
export function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => sortJsonValue(entry));
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => compareKeys(left, right))
      .map(([key, child]) => [key, sortJsonValue(child)]),
  );
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(sortJsonValue(toJsonValue(value))) ?? "null";
}

export function safeParseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

export function cloneJsonValue<T extends JsonValue>(value: T): T {
  return structuredClone(value);
}

export function toJsonValue(value: unknown): JsonValue {
  return toJsonValueInner(value, new WeakSet<object>());
}

function toJsonValueInner(value: unknown, seen: WeakSet<object>): JsonValue {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "undefined":
      return null;
    case "bigint":
      return value.toString();
    case "symbol":
      return value.description ?? value.toString();
    case "function":
      return value.name ? `[function ${value.name}]` : "[function]";
    case "object": {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
      if (Array.isArray(value)) {
        const out = value.map((item) => toJsonValueInner(item, seen));
        // Remove from the path set so a shared (aliased) array elsewhere in
        // the tree serializes as its value, not as a false "[Circular]".
        seen.delete(value);
        return out;
      }
      const out: Record<string, JsonValue> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (item === undefined) continue;
        out[key] = toJsonValueInner(item, seen);
      }
      seen.delete(value);
      return out;
    }
    default:
      return null;
  }
}
