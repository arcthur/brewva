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

export type BrewvaForensicConfigWarningCode =
  | "config_parse_skipped"
  | "config_not_object_skipped"
  | "config_unknown_fields_stripped"
  | "config_removed_fields_stripped"
  | "config_schema_skipped"
  | "config_normalize_skipped";

export interface BrewvaForensicConfigWarning {
  code: BrewvaForensicConfigWarningCode;
  configPath: string;
  message: string;
  fields?: string[];
}

export interface BrewvaForensicConfigResolution extends BrewvaConfigResolution {
  consultedPaths: string[];
  warnings: BrewvaForensicConfigWarning[];
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

function decodeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function deletePropertyAtPointer(
  root: Record<string, unknown>,
  pointer: string,
  property: string,
): boolean {
  const segments =
    pointer === "/" || pointer.length === 0
      ? []
      : pointer
          .split("/")
          .slice(1)
          .map((segment) => decodeJsonPointerSegment(segment));
  let cursor: unknown = root;
  for (const segment of segments) {
    if (!isRecord(cursor)) {
      return false;
    }
    cursor = cursor[segment];
  }
  if (!isRecord(cursor) || !Object.hasOwn(cursor, property)) {
    return false;
  }
  delete cursor[property];
  return true;
}

function collectUnknownPropertyErrors(
  errors: ReadonlyArray<string>,
): Array<{ pointer: string; property: string }> {
  const output: Array<{ pointer: string; property: string }> = [];
  for (const error of errors) {
    const match = error.match(/^(.*): unknown property "([^"]+)"$/);
    if (!match) {
      continue;
    }
    const pointer = match[1]?.trim();
    const property = match[2]?.trim();
    if (!pointer || !property) {
      continue;
    }
    output.push({ pointer, property });
  }
  return output;
}

function stripForensicRemovedFields(root: Record<string, unknown>): string[] {
  const stripped: string[] = [];
  const projection = isRecord(root["projection"]) ? root["projection"] : null;
  if (projection) {
    for (const key of Object.keys(projection)) {
      if (!REMOVED_PROJECTION_FIELDS.has(key)) {
        continue;
      }
      delete projection[key];
      stripped.push(`/projection/${key}`);
    }
  }
  const skills = isRecord(root["skills"]) ? root["skills"] : null;
  if (skills && Object.hasOwn(skills, "cascade")) {
    delete skills["cascade"];
    stripped.push("/skills/cascade");
  }
  return stripped;
}

function stripUnknownPropertiesForForensics(root: Record<string, unknown>): string[] {
  const stripped = new Set<string>();
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const validation = validateBrewvaConfigFile(root);
    if (validation.ok) {
      break;
    }
    const unknownProperties = collectUnknownPropertyErrors(validation.errors);
    if (unknownProperties.length === 0) {
      break;
    }
    let changed = false;
    for (const unknownProperty of unknownProperties) {
      if (deletePropertyAtPointer(root, unknownProperty.pointer, unknownProperty.property)) {
        stripped.add(
          `${unknownProperty.pointer === "/" ? "" : unknownProperty.pointer}/${unknownProperty.property}`,
        );
        changed = true;
      }
    }
    if (!changed) {
      break;
    }
  }
  return [...stripped].toSorted((left, right) => left.localeCompare(right));
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

  const sanitized = stripMetaFields(structuredClone(parsed));
  const warnings: BrewvaForensicConfigWarning[] = [];
  const removedFields = stripForensicRemovedFields(sanitized);
  if (removedFields.length > 0) {
    warnings.push({
      code: "config_removed_fields_stripped",
      configPath,
      message:
        "Stripped removed config fields while loading inspect runtime; old semantics remain disabled.",
      fields: removedFields,
    });
  }

  const unknownFields = stripUnknownPropertiesForForensics(sanitized);
  if (unknownFields.length > 0) {
    warnings.push({
      code: "config_unknown_fields_stripped",
      configPath,
      message: "Stripped unknown config fields while loading inspect runtime.",
      fields: unknownFields,
    });
  }

  const validation = validateBrewvaConfigFile(sanitized);
  if (!validation.ok) {
    warnings.push({
      code: "config_schema_skipped",
      configPath,
      message: `Skipped inspect config after forensic stripping because validation still failed: ${
        validation.errors.length > 0
          ? formatSchemaInvalidMessage(validation.errors)
          : (validation.error ?? "schema validation unavailable")
      }`,
    });
    return {
      metadata,
      warnings,
    };
  }

  try {
    normalizeBrewvaConfig(sanitized, DEFAULT_BREWVA_CONFIG);
  } catch (error) {
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
    parsed: resolveConfigRelativeSkillRoots(sanitized as Partial<BrewvaConfig>, configPath),
    metadata: collectBrewvaConfigMetadata(sanitized),
    warnings,
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
