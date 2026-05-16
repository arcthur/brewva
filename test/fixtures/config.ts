import { DEFAULT_BREWVA_CONFIG } from "@brewva/brewva-runtime";
import type { BrewvaConfig } from "@brewva/brewva-runtime";

export type DeepPartial<T> = T extends (...args: any[]) => unknown
  ? T
  : T extends Array<infer U>
    ? Array<DeepPartial<U>>
    : T extends object
      ? { [K in keyof T]?: DeepPartial<T[K]> }
      : T;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T>(base: T, patch: DeepPartial<NoInfer<T>> | undefined): T {
  if (patch === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(patch)) {
    return patch as T;
  }

  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const current = merged[key];
    merged[key] =
      isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return merged as T;
}

export function createTestConfig(
  overrides: DeepPartial<BrewvaConfig> = {},
  options: { eventsLevel?: BrewvaConfig["infrastructure"]["events"]["level"] } = {},
): BrewvaConfig {
  const baseConfig: BrewvaConfig = structuredClone(DEFAULT_BREWVA_CONFIG);
  const config = deepMerge(baseConfig, overrides);
  if (options.eventsLevel) {
    config.infrastructure.events.level = options.eventsLevel;
  }
  return config;
}

export function setStaticDynamicTailBudget(config: BrewvaConfig, maxTokens: number): BrewvaConfig {
  config.infrastructure.contextBudget.dynamicTailTokens = maxTokens;
  return config;
}

export function setStaticContextStatusThresholds(
  config: BrewvaConfig,
  input: {
    advisoryRatio?: number;
    hardRatio: number;
  },
): BrewvaConfig {
  const { thresholds } = config.infrastructure.contextBudget;
  const advisoryRatio = input.advisoryRatio ?? Math.min(input.hardRatio, thresholds.advisoryRatio);
  thresholds.hardRatio = input.hardRatio;
  thresholds.advisoryRatio = Math.min(advisoryRatio, input.hardRatio);
  thresholds.headroomTokens = 0;
  return config;
}
