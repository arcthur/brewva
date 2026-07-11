import { isRecord } from "@brewva/brewva-std/unknown";
import type { DeepReadonly } from "./deep-readonly.js";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

export function deepFreezeValue<T>(value: T): DeepReadonly<T> {
  if (Array.isArray(value)) {
    for (const entry of value) {
      deepFreezeValue(entry);
    }
    return Object.freeze(value) as DeepReadonly<T>;
  }
  if (isPlainObject(value)) {
    for (const entry of Object.values(value)) {
      deepFreezeValue(entry);
    }
    return Object.freeze(value) as DeepReadonly<T>;
  }
  return value as DeepReadonly<T>;
}
