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

export interface NormalizeExplicitBrewvaConfigOptions {
  sourceLabel?: string;
}

export interface BrewvaConfigMetadata {
  skills: {
    routing: {
      enabledExplicit: boolean;
      scopesExplicit: boolean;
    };
  };
}

export interface BrewvaConfigResolution {
  config: BrewvaConfig;
  metadata: BrewvaConfigMetadata;
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

function createDefaultBrewvaConfigMetadata(): BrewvaConfigMetadata {
  return {
    skills: {
      routing: {
        enabledExplicit: false,
        scopesExplicit: false,
      },
    },
  };
}

function collectBrewvaConfigMetadata(config: unknown): BrewvaConfigMetadata {
  const metadata = createDefaultBrewvaConfigMetadata();
  if (!isRecord(config)) {
    return metadata;
  }

  const skills = isRecord(config.skills) ? config.skills : null;
  const routing = skills && isRecord(skills.routing) ? skills.routing : null;
  metadata.skills.routing.enabledExplicit = Boolean(routing && Object.hasOwn(routing, "enabled"));
  metadata.skills.routing.scopesExplicit = Boolean(routing && Object.hasOwn(routing, "scopes"));
  return metadata;
}

function mergeBrewvaConfigMetadata(
  current: BrewvaConfigMetadata,
  next: BrewvaConfigMetadata,
): BrewvaConfigMetadata {
  return {
    skills: {
      routing: {
        enabledExplicit:
          current.skills.routing.enabledExplicit || next.skills.routing.enabledExplicit,
        scopesExplicit: current.skills.routing.scopesExplicit || next.skills.routing.scopesExplicit,
      },
    },
  };
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

function validateConfigObject(parsed: unknown, configPath: string): Record<string, unknown> {
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

  return stripMetaFields(parsed);
}

export function normalizeExplicitBrewvaConfig(
  config: unknown,
  options: NormalizeExplicitBrewvaConfigOptions = {},
): BrewvaConfig {
  return normalizeExplicitBrewvaConfigResolution(config, options).config;
}

export function normalizeExplicitBrewvaConfigResolution(
  config: unknown,
  options: NormalizeExplicitBrewvaConfigOptions = {},
): BrewvaConfigResolution {
  const sourceLabel = options.sourceLabel ?? "<direct runtime config>";
  // Preserve explicit migration/prohibition diagnostics already encoded in the
  // normalizer before schema validation rejects unknown keys generically.
  normalizeBrewvaConfig(config, DEFAULT_BREWVA_CONFIG);
  const validated = validateConfigObject(config, sourceLabel);
  return {
    config: normalizeBrewvaConfig(validated as Partial<BrewvaConfig>, DEFAULT_BREWVA_CONFIG),
    metadata: collectBrewvaConfigMetadata(validated),
  };
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

  const cleaned = validateConfigObject(parsed, configPath);
  return resolveConfigRelativeSkillRoots(cleaned as Partial<BrewvaConfig>, configPath);
}

export function loadBrewvaConfig(options: LoadConfigOptions = {}): BrewvaConfig {
  return loadBrewvaConfigResolution(options).config;
}

export function loadBrewvaConfigResolution(
  options: LoadConfigOptions = {},
): BrewvaConfigResolution {
  const cwd = resolve(options.cwd ?? process.cwd());
  const defaults = structuredClone(DEFAULT_BREWVA_CONFIG);

  const configPaths = options.configPath
    ? [resolve(cwd, options.configPath)]
    : [resolveGlobalBrewvaConfigPath(), resolveProjectBrewvaConfigPath(cwd)];

  let merged = defaults;
  let metadata = createDefaultBrewvaConfigMetadata();
  for (const configPath of configPaths) {
    const parsed = readConfigFile(configPath);
    if (!parsed) continue;
    merged = deepMerge(merged, parsed);
    metadata = mergeBrewvaConfigMetadata(metadata, collectBrewvaConfigMetadata(parsed));
  }

  return {
    config: normalizeBrewvaConfig(merged, DEFAULT_BREWVA_CONFIG),
    metadata,
  };
}
