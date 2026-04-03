import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BrewvaConfig } from "../contracts/index.js";
import { DEFAULT_BREWVA_CONFIG } from "./defaults.js";
import { parseJsonc } from "./jsonc.js";
import { deepMerge } from "./merge.js";
import { normalizeBrewvaConfig } from "./normalize.js";
import { resolveGlobalBrewvaConfigPath, resolveProjectBrewvaConfigPath } from "./paths.js";
import { validateBrewvaConfigFile } from "./validate.js";

export type BrewvaConfigLoadErrorCode =
  | "config_parse_error"
  | "config_not_object"
  | "config_schema_unavailable"
  | "config_schema_invalid";

export interface LoadConfigOptions {
  cwd?: string;
  configPath?: string;
}

export class BrewvaConfigLoadError extends Error {
  readonly code: BrewvaConfigLoadErrorCode;
  readonly configPath: string;

  constructor(input: { code: BrewvaConfigLoadErrorCode; configPath: string; message: string }) {
    super(input.message);
    this.name = "BrewvaConfigLoadError";
    this.code = input.code;
    this.configPath = input.configPath;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveConfigRelativeSkillRoots(
  config: Partial<BrewvaConfig>,
  configPath: string,
): Partial<BrewvaConfig> {
  const skills = config.skills;
  if (!skills) {
    return config;
  }

  const skillRoots = skills.roots;
  if (!Array.isArray(skillRoots) || skillRoots.length === 0) {
    return config;
  }

  const baseDir = dirname(configPath);
  return {
    ...config,
    skills: {
      ...skills,
      roots: skillRoots.map((entry) => {
        if (typeof entry !== "string") return entry;
        const trimmed = entry.trim();
        if (!trimmed) return entry;
        return resolve(baseDir, trimmed);
      }),
    },
  };
}

function stripMetaFields(value: Record<string, unknown>): Record<string, unknown> {
  const output = { ...value };
  // Used for editor completion/validation, ignored by runtime.
  delete output["$schema"];
  return output;
}

const REMOVED_PROJECTION_FIELDS = new Set<string>([
  "dailyRefreshHourLocal",
  "crystalMinUnits",
  "retrievalTopK",
  "retrievalWeights",
  "recallMode",
  "externalRecall",
  "evolvesMode",
  "cognitive",
  "global",
]);

function formatSchemaInvalidMessage(errors: ReadonlyArray<string>): string {
  return `Config does not match schema: ${errors.join("; ")}`;
}

function collectRemovedFieldErrors(parsed: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const projection = parsed["projection"];
  if (!isRecord(projection)) return errors;

  for (const key of Object.keys(projection)) {
    if (!REMOVED_PROJECTION_FIELDS.has(key)) continue;
    errors.push(`/projection: unknown property "${key}"`);
  }

  return errors;
}

function readConfigFile(configPath: string): Partial<BrewvaConfig> | undefined {
  if (!existsSync(configPath)) return undefined;
  let parsed: unknown;
  try {
    const raw = readFileSync(configPath, "utf8");
    parsed = parseJsonc(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BrewvaConfigLoadError({
      code: "config_parse_error",
      message: `Failed to parse config JSONC: ${message}`,
      configPath,
    });
  }

  if (!isRecord(parsed)) {
    throw new BrewvaConfigLoadError({
      code: "config_not_object",
      message: "Config must be a JSON object at the top-level.",
      configPath,
    });
  }

  const removedFieldErrors = collectRemovedFieldErrors(parsed);
  if (removedFieldErrors.length > 0) {
    throw new BrewvaConfigLoadError({
      code: "config_schema_invalid",
      message: formatSchemaInvalidMessage(removedFieldErrors),
      configPath,
    });
  }

  const validation = validateBrewvaConfigFile(parsed);
  if (!validation.ok) {
    if (validation.error) {
      throw new BrewvaConfigLoadError({
        code: "config_schema_unavailable",
        message: `Schema validation is unavailable: ${validation.error}`,
        configPath,
      });
    }

    if (validation.errors.length > 0) {
      throw new BrewvaConfigLoadError({
        code: "config_schema_invalid",
        message: formatSchemaInvalidMessage(validation.errors),
        configPath,
      });
    }
  }

  const cleaned = stripMetaFields(parsed);
  return resolveConfigRelativeSkillRoots(cleaned as Partial<BrewvaConfig>, configPath);
}

export function loadBrewvaConfig(options: LoadConfigOptions = {}): BrewvaConfig {
  const cwd = resolve(options.cwd ?? process.cwd());
  const defaults = structuredClone(DEFAULT_BREWVA_CONFIG);

  const configPaths = options.configPath
    ? [resolve(cwd, options.configPath)]
    : [resolveGlobalBrewvaConfigPath(), resolveProjectBrewvaConfigPath(cwd)];

  let merged = defaults;
  for (const configPath of configPaths) {
    const parsed = readConfigFile(configPath);
    if (!parsed) continue;
    merged = deepMerge(merged, parsed);
  }

  return normalizeBrewvaConfig(merged, DEFAULT_BREWVA_CONFIG);
}
