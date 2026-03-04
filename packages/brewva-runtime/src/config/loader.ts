import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { BrewvaConfig } from "../types.js";
import { DEFAULT_BREWVA_CONFIG } from "./defaults.js";
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

function collectConfigMigrationHints(errors: string[]): string[] {
  const hints: string[] = [];
  const hasRemovedTelegramBranch = errors.some(
    (entry) =>
      entry.includes('/channels: unknown property "telegram"') ||
      entry.includes("/channels/telegram"),
  );
  if (hasRemovedTelegramBranch) {
    hints.push(
      "Migration: 'channels.telegram' was removed. Telegram skill policy is now built-in; remove the 'channels.telegram' block from brewva.json.",
    );
  }
  return hints;
}

function readConfigFile(configPath: string): Partial<BrewvaConfig> | undefined {
  if (!existsSync(configPath)) return undefined;
  let parsed: unknown;
  try {
    const raw = readFileSync(configPath, "utf8");
    parsed = JSON.parse(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BrewvaConfigLoadError({
      code: "config_parse_error",
      message: `Failed to parse config JSON: ${message}`,
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
      const baseMessage = `Config does not match schema: ${validation.errors.join("; ")}`;
      const migrationHints = collectConfigMigrationHints(validation.errors);
      const message =
        migrationHints.length > 0
          ? `${baseMessage}\n${migrationHints.map((hint) => `Hint: ${hint}`).join("\n")}`
          : baseMessage;
      throw new BrewvaConfigLoadError({
        code: "config_schema_invalid",
        message,
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
