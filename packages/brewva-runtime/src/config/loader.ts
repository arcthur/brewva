import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BrewvaConfig } from "../contracts/index.js";
import { DEFAULT_BREWVA_CONFIG } from "./defaults.js";
export * from "./errors.js";
import type { BrewvaForensicConfigWarning } from "./errors.js";
import { BrewvaConfigLoadError } from "./errors.js";
import { parseJsonc } from "./jsonc.js";
import { deepMerge } from "./merge.js";
import { normalizeBrewvaConfig } from "./normalize.js";
import {
  forensicallyValidateLoadedBrewvaConfigObject,
  validateLoadedBrewvaConfigObject,
} from "./object-validation.js";
import { resolveGlobalBrewvaConfigPath, resolveProjectBrewvaConfigPath } from "./paths.js";
import { assertExplicitBrewvaConfigSemantics } from "./semantic-validation.js";

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

export interface BrewvaForensicConfigResolution extends BrewvaConfigResolution {
  consultedPaths: string[];
  warnings: BrewvaForensicConfigWarning[];
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
  assertExplicitBrewvaConfigSemantics(config);
  const validated = validateLoadedBrewvaConfigObject(config, sourceLabel);
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

  const cleaned = validateLoadedBrewvaConfigObject(parsed, configPath);
  return resolveConfigRelativeSkillRoots(cleaned as Partial<BrewvaConfig>, configPath);
}

function readConfigFileForInspect(configPath: string): {
  parsed?: Partial<BrewvaConfig>;
  metadata: BrewvaConfigMetadata;
  warnings: BrewvaForensicConfigWarning[];
} {
  const metadata = createDefaultBrewvaConfigMetadata();
  if (!existsSync(configPath)) {
    return { metadata, warnings: [] };
  }

  let parsed: unknown;
  try {
    parsed = parseJsonc(readFileSync(configPath, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      metadata,
      warnings: [
        {
          code: "config_parse_skipped",
          configPath,
          message: `Skipped inspect config after parse failure: ${message}`,
        },
      ],
    };
  }

  if (!isRecord(parsed)) {
    return {
      metadata,
      warnings: [
        {
          code: "config_not_object_skipped",
          configPath,
          message: "Skipped inspect config because the top-level value is not an object.",
        },
      ],
    };
  }

  const forensicValidation = forensicallyValidateLoadedBrewvaConfigObject(parsed, configPath);
  if (!forensicValidation.parsed) {
    return {
      metadata,
      warnings: forensicValidation.warnings,
    };
  }

  try {
    normalizeBrewvaConfig(forensicValidation.parsed, DEFAULT_BREWVA_CONFIG);
  } catch (error) {
    const warnings = [...forensicValidation.warnings];
    warnings.push({
      code: "config_normalize_skipped",
      configPath,
      message: `Skipped inspect config because normalization still failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return {
      metadata,
      warnings,
    };
  }

  return {
    parsed: resolveConfigRelativeSkillRoots(
      forensicValidation.parsed as Partial<BrewvaConfig>,
      configPath,
    ),
    metadata: collectBrewvaConfigMetadata(forensicValidation.parsed),
    warnings: forensicValidation.warnings,
  };
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

export function loadBrewvaInspectConfigResolution(
  options: LoadConfigOptions = {},
): BrewvaForensicConfigResolution {
  const cwd = resolve(options.cwd ?? process.cwd());
  const defaults = structuredClone(DEFAULT_BREWVA_CONFIG);
  const configPaths = options.configPath
    ? [resolve(cwd, options.configPath)]
    : [resolveGlobalBrewvaConfigPath(), resolveProjectBrewvaConfigPath(cwd)];

  let merged = defaults;
  let metadata = createDefaultBrewvaConfigMetadata();
  const warnings: BrewvaForensicConfigWarning[] = [];
  for (const configPath of configPaths) {
    const forensicRead = readConfigFileForInspect(configPath);
    warnings.push(...forensicRead.warnings);
    if (!forensicRead.parsed) {
      continue;
    }
    merged = deepMerge(merged, forensicRead.parsed);
    metadata = mergeBrewvaConfigMetadata(metadata, forensicRead.metadata);
  }

  return {
    config: normalizeBrewvaConfig(merged, DEFAULT_BREWVA_CONFIG),
    metadata,
    consultedPaths: [...configPaths],
    warnings,
  };
}
