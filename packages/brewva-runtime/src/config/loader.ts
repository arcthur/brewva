import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { isRecord, toErrorMessage } from "@brewva/brewva-std/unknown";
import { DEFAULT_BREWVA_CONFIG } from "./defaults.js";
import type { BrewvaConfig } from "./types.js";
export {
  BrewvaConfigLoadError,
  type BrewvaConfigLoadErrorCode,
  type BrewvaForensicConfigWarning,
  type BrewvaForensicConfigWarningCode,
} from "./errors.js";
import type { BrewvaForensicConfigWarning } from "./errors.js";
import { BrewvaConfigLoadError } from "./errors.js";
import { parseJsonc } from "./jsonc.js";
import { deepMerge } from "./merge.js";
import { normalizeBrewvaConfig } from "./normalize.js";
import {
  forensicallyValidateLoadedBrewvaConfigObject,
  validateLoadedBrewvaConfigObject,
} from "./object-validation.js";
import {
  findWorkspaceRootDir,
  resolveGlobalBrewvaConfigPath,
  resolvePathInput,
  resolveProjectBrewvaConfigPath,
  resolveWorkspaceRootDir,
} from "./paths.js";

export interface LoadConfigOptions {
  cwd?: string;
  configPath?: string;
}

export interface NormalizeExplicitBrewvaConfigOptions {
  sourceLabel?: string;
}

export interface BrewvaConfigMetadata {
  skills: Record<string, never>;
}

export interface BrewvaConfigResolution {
  config: BrewvaConfig;
  metadata: BrewvaConfigMetadata;
  /**
   * Load-time advisories (e.g. removed config fields stripped with their old
   * semantics disabled). Never fatal: fatal problems throw BrewvaConfigLoadError.
   */
  warnings: BrewvaForensicConfigWarning[];
}

export interface BrewvaForensicConfigResolution extends BrewvaConfigResolution {
  consultedPaths: string[];
}

/** Render a load warning in the CLI's `[config:*]` stderr convention. */
export function formatBrewvaConfigWarning(warning: BrewvaForensicConfigWarning): string {
  const fields =
    warning.fields && warning.fields.length > 0 ? ` (${warning.fields.join(", ")})` : "";
  return `[config:warning] ${warning.configPath}: ${warning.message}${fields}`;
}

function createDefaultBrewvaConfigMetadata(): BrewvaConfigMetadata {
  return {
    skills: {},
  };
}

function collectBrewvaConfigMetadata(config: unknown): BrewvaConfigMetadata {
  const metadata = createDefaultBrewvaConfigMetadata();
  void config;
  return metadata;
}

function mergeBrewvaConfigMetadata(
  _current: BrewvaConfigMetadata,
  _next: BrewvaConfigMetadata,
): BrewvaConfigMetadata {
  return {
    skills: {},
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

function resolveConfigRelativeBoxHome(
  config: Partial<BrewvaConfig>,
  configPath: string,
): Partial<BrewvaConfig> {
  const security = config.security as Partial<BrewvaConfig["security"]> | undefined;
  const execution = security?.execution as
    | Partial<BrewvaConfig["security"]["execution"]>
    | undefined;
  const box = execution?.box as Partial<BrewvaConfig["security"]["execution"]["box"]> | undefined;
  const home = box?.home;
  if (typeof home !== "string" || home.trim().length === 0) {
    return config;
  }

  return {
    ...config,
    security: {
      ...security,
      execution: {
        ...execution,
        box: {
          ...box,
          home: resolvePathInput(dirname(configPath), home),
        },
      },
    },
  } as Partial<BrewvaConfig>;
}

function resolveConfigRelativePaths(
  config: Partial<BrewvaConfig>,
  configPath: string,
): Partial<BrewvaConfig> {
  return resolveConfigRelativeBoxHome(
    resolveConfigRelativeSkillRoots(config, configPath),
    configPath,
  );
}

export function normalizeExplicitBrewvaConfig(
  config: unknown,
  options: NormalizeExplicitBrewvaConfigOptions = {},
): BrewvaConfig {
  const resolution = normalizeExplicitBrewvaConfigResolution(config, options);
  emitBrewvaConfigWarningsToStderr(resolution.warnings);
  return resolution.config;
}

export function normalizeExplicitBrewvaConfigResolution(
  config: unknown,
  options: NormalizeExplicitBrewvaConfigOptions = {},
): BrewvaConfigResolution {
  const sourceLabel = options.sourceLabel ?? "<direct runtime config>";
  const validated = validateLoadedBrewvaConfigObject(config, sourceLabel);
  return {
    config: normalizeBrewvaConfig(validated.value as Partial<BrewvaConfig>, DEFAULT_BREWVA_CONFIG),
    metadata: collectBrewvaConfigMetadata(validated.value),
    warnings: validated.warnings,
  };
}

function readConfigFile(configPath: string):
  | {
      parsed: Partial<BrewvaConfig>;
      warnings: BrewvaForensicConfigWarning[];
      canonicalPath: string;
    }
  | undefined {
  if (!existsSync(configPath)) return undefined;
  let canonicalPath: string;
  let parsed: unknown;
  try {
    canonicalPath = realpathSync.native(configPath);
    const raw = readFileSync(canonicalPath, "utf8");
    parsed = parseJsonc(raw);
  } catch (error) {
    const message = toErrorMessage(error);
    throw new BrewvaConfigLoadError({
      code: "config_parse_error",
      message: `Failed to parse config JSONC: ${message}`,
      configPath,
    });
  }

  const cleaned = validateLoadedBrewvaConfigObject(parsed, configPath);
  return {
    parsed: resolveConfigRelativePaths(cleaned.value as Partial<BrewvaConfig>, configPath),
    warnings: cleaned.warnings,
    canonicalPath,
  };
}

function readConfigFileForInspect(configPath: string): {
  parsed?: Partial<BrewvaConfig>;
  metadata: BrewvaConfigMetadata;
  warnings: BrewvaForensicConfigWarning[];
  canonicalPath?: string;
} {
  const metadata = createDefaultBrewvaConfigMetadata();
  if (!existsSync(configPath)) {
    return { metadata, warnings: [] };
  }

  let parsed: unknown;
  let canonicalPath: string;
  try {
    canonicalPath = realpathSync.native(configPath);
    parsed = parseJsonc(readFileSync(canonicalPath, "utf8"));
  } catch (error) {
    const message = toErrorMessage(error);
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
      message: `Skipped inspect config because normalization still failed: ${toErrorMessage(
        error,
      )}`,
    });
    return {
      metadata,
      warnings,
    };
  }

  return {
    parsed: resolveConfigRelativePaths(
      forensicValidation.parsed as Partial<BrewvaConfig>,
      configPath,
    ),
    metadata: collectBrewvaConfigMetadata(forensicValidation.parsed),
    warnings: forensicValidation.warnings,
    canonicalPath,
  };
}

/**
 * Convenience forms are visible-by-default: a caller that only wants a config
 * has not signed up to route advisories, and a silently stripped removed field
 * is a config the user believes is active. Callers that capture warnings use
 * the Resolution forms, which stay pure.
 */
function emitBrewvaConfigWarningsToStderr(warnings: readonly BrewvaForensicConfigWarning[]): void {
  for (const warning of warnings) {
    console.error(formatBrewvaConfigWarning(warning));
  }
}

function isPathInsideDir(childPath: string, dir: string): boolean {
  const rel = relative(dir, childPath);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function canonicalizePath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function configSourceIsWorkspaceBound(input: {
  readonly logicalPath: string;
  readonly canonicalPath: string;
  readonly activeWorkspaceRoot: string;
  /** True only for an explicit, caller-supplied `--config` (see below). */
  readonly explicitConfigSource: boolean;
}): boolean {
  const activeWorkspaceRoot = canonicalizePath(input.activeWorkspaceRoot);
  if (
    isPathInsideDir(input.logicalPath, input.activeWorkspaceRoot) ||
    isPathInsideDir(input.canonicalPath, activeWorkspaceRoot)
  ) {
    return true;
  }

  // The any-workspace-tree scan applies ONLY to an explicit `--config`, the one
  // caller-steerable source: a child process can point it at a DIFFERENT
  // (model-writable) workspace than the caller's cwd — or an outside symlink
  // resolving there — so an explicit source is trustworthy only when neither
  // spelling lives in a discovered workspace tree. The auto-resolved paths are
  // not caller-steerable and must not be scanned: the project config is already
  // caught by the active-workspace containment above, and the global config is
  // operator-owned by construction. Scanning it would strip a legitimate global
  // policy merely because the operator version-controls their config directory
  // (e.g. a git-tracked ~/.config), contradicting "a global config is an
  // operator source".
  if (!input.explicitConfigSource) {
    return false;
  }
  return (
    findWorkspaceRootDir(dirname(input.logicalPath)) !== undefined ||
    findWorkspaceRootDir(dirname(input.canonicalPath)) !== undefined
  );
}

/**
 * The operator-source barrier. `security.unattendedApproval` grants a headless
 * run authority to auto-answer approvals, so it must originate from the OPERATOR,
 * not from state the model can rewrite. A config file INSIDE the workspace tree
 * is model-writable (a model with workspace-write could widen its own envelope,
 * and a child brewva it spawns would read the widened file), so its
 * `unattendedApproval` is stripped here — honored only from an operator source
 * outside the workspace (the global config, or an explicit `--config` outside the
 * project). Mutates `parsed` in place and returns a warning when a non-empty
 * in-workspace policy was dropped. (Granting `local_exec` remains host execution,
 * a separate trust boundary this barrier does not close.)
 */
function stripWorkspaceUnattendedApproval(
  parsed: Partial<BrewvaConfig>,
  configPath: string,
  canonicalConfigPath: string,
  workspaceRoot: string,
  explicitConfigSource: boolean,
): BrewvaForensicConfigWarning | undefined {
  if (
    !configSourceIsWorkspaceBound({
      logicalPath: configPath,
      canonicalPath: canonicalConfigPath,
      activeWorkspaceRoot: workspaceRoot,
      explicitConfigSource,
    })
  ) {
    return undefined;
  }
  const security = parsed.security;
  if (!isRecord(security)) return undefined;
  const policy = (security as Record<string, unknown>).unattendedApproval;
  if (!isRecord(policy) || Object.keys(policy).length === 0) return undefined;
  delete (security as Record<string, unknown>).unattendedApproval;
  return {
    code: "config_workspace_unattended_approval_stripped",
    configPath,
    message:
      "security.unattendedApproval was ignored: an approval envelope must come from an operator " +
      "source OUTSIDE every workspace tree (a global config, or an explicit --config outside any " +
      "project). Workspace config sources and symlinks resolving into them are model-writable, so " +
      "honoring one would let a model widen its own authority. Move the policy to an operator-owned " +
      "non-workspace path to activate it.",
    fields: Object.keys(policy).map((key) => `security.unattendedApproval.${key}`),
  };
}

export function loadBrewvaConfig(options: LoadConfigOptions = {}): BrewvaConfig {
  const resolution = loadBrewvaConfigResolution(options);
  emitBrewvaConfigWarningsToStderr(resolution.warnings);
  return resolution.config;
}

export function loadBrewvaConfigResolution(
  options: LoadConfigOptions = {},
): BrewvaConfigResolution {
  const cwd = resolve(options.cwd ?? process.cwd());
  const defaults = structuredClone(DEFAULT_BREWVA_CONFIG);

  const configPaths = options.configPath
    ? [resolve(cwd, options.configPath)]
    : [resolveGlobalBrewvaConfigPath(), resolveProjectBrewvaConfigPath(cwd)];

  const workspaceRoot = resolveWorkspaceRootDir(cwd);
  let merged = defaults;
  let metadata = createDefaultBrewvaConfigMetadata();
  const warnings: BrewvaForensicConfigWarning[] = [];
  for (const configPath of configPaths) {
    const read = readConfigFile(configPath);
    if (!read) continue;
    warnings.push(...read.warnings);
    const stripped = stripWorkspaceUnattendedApproval(
      read.parsed,
      configPath,
      read.canonicalPath,
      workspaceRoot,
      options.configPath !== undefined,
    );
    if (stripped) warnings.push(stripped);
    merged = deepMerge(merged, read.parsed);
    metadata = mergeBrewvaConfigMetadata(metadata, collectBrewvaConfigMetadata(read.parsed));
  }

  return {
    config: normalizeBrewvaConfig(merged, DEFAULT_BREWVA_CONFIG),
    metadata,
    warnings,
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

  const workspaceRoot = resolveWorkspaceRootDir(cwd);
  let merged = defaults;
  let metadata = createDefaultBrewvaConfigMetadata();
  const warnings: BrewvaForensicConfigWarning[] = [];
  for (const configPath of configPaths) {
    const forensicRead = readConfigFileForInspect(configPath);
    warnings.push(...forensicRead.warnings);
    if (!forensicRead.parsed) {
      continue;
    }
    const stripped = stripWorkspaceUnattendedApproval(
      forensicRead.parsed,
      configPath,
      forensicRead.canonicalPath ?? configPath,
      workspaceRoot,
      options.configPath !== undefined,
    );
    if (stripped) warnings.push(stripped);
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
