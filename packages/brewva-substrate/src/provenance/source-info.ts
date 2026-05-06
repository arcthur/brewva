export const BREWVA_SOURCE_SCOPES = [
  "builtin",
  "project",
  "user",
  "sdk",
  "runtime-plugin",
] as const;

export type BrewvaSourceScope = (typeof BREWVA_SOURCE_SCOPES)[number];

export interface BrewvaSourceInfo {
  path: string;
  source: string;
  scope: BrewvaSourceScope;
  baseDir?: string;
}

export interface CreateBrewvaSyntheticSourceInfoInput {
  source: string;
  scope: BrewvaSourceScope;
  baseDir?: string;
}

export function createBrewvaSyntheticSourceInfo(
  path: string,
  input: CreateBrewvaSyntheticSourceInfoInput,
): BrewvaSourceInfo {
  return {
    path,
    source: input.source,
    scope: input.scope,
    ...(input.baseDir !== undefined ? { baseDir: input.baseDir } : {}),
  };
}
