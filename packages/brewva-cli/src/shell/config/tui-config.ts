import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  parseJsonc,
  resolveGlobalBrewvaRootDir,
  resolvePathInput,
  resolveProjectBrewvaRootDir,
} from "@brewva/brewva-runtime/config";
import { isRecord } from "@brewva/brewva-std/unknown";
import type {
  BrewvaShortcutValue,
  BrewvaTuiConfig,
  BrewvaTuiLargePasteThreshold,
  BrewvaTuiScrollAcceleration,
} from "../domain/tui.js";

export type BrewvaTuiConfigFile = Partial<{
  theme: BrewvaTuiConfig["theme"];
  keymap: Partial<{
    leader: string;
    leaderTimeoutMs: number;
    bindings: Record<string, BrewvaShortcutValue>;
  }>;
  view: Partial<{
    showThinking: boolean;
    toolDetails: boolean;
    diff: Partial<BrewvaTuiConfig["view"]["diff"]>;
  }>;
  input: Partial<{
    largePasteThreshold: Partial<BrewvaTuiLargePasteThreshold>;
  }>;
  scroll: Partial<{
    acceleration: Partial<BrewvaTuiScrollAcceleration>;
  }>;
}>;

export type BrewvaTuiConfigWarningCode =
  | "invalid_config"
  | "invalid_shape"
  | "read_failed"
  | "unknown_binding";

export interface BrewvaTuiConfigWarning {
  readonly code: BrewvaTuiConfigWarningCode;
  readonly path: string;
  readonly message: string;
}

export interface LoadBrewvaTuiConfigOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly knownBindingIds?: ReadonlySet<string>;
}

export interface BrewvaTuiConfigResolution {
  readonly config: BrewvaTuiConfig;
  readonly consultedPaths: readonly string[];
  readonly warnings: readonly BrewvaTuiConfigWarning[];
}

export const DEFAULT_BREWVA_TUI_CONFIG: BrewvaTuiConfig = {
  theme: "auto",
  keymap: {
    leader: "ctrl+x",
    leaderTimeoutMs: 1000,
    bindings: {},
  },
  view: {
    showThinking: true,
    toolDetails: true,
    diff: {
      style: "auto",
      wrapMode: "word",
    },
  },
  input: {
    largePasteThreshold: {
      minLines: 3,
      minCharacters: 150,
    },
  },
  scroll: {
    acceleration: {
      type: "linear",
      speed: 3,
    },
  },
};

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isRecord(base) || !isRecord(patch)) {
    return patch === undefined ? base : (patch as T);
  }
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = output[key];
    output[key] = isRecord(current) && isRecord(value) ? deepMerge(current, value) : value;
  }
  return output as T;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function normalizeDiffStyle(value: unknown, fallback: "auto" | "stacked"): "auto" | "stacked" {
  return value === "auto" || value === "stacked" ? value : fallback;
}

function normalizeDiffWrapMode(value: unknown, fallback: "word" | "none"): "word" | "none" {
  return value === "word" || value === "none" ? value : fallback;
}

function normalizeScrollAcceleration(
  value: BrewvaTuiScrollAcceleration,
): BrewvaTuiScrollAcceleration {
  const fallback = DEFAULT_BREWVA_TUI_CONFIG.scroll.acceleration;
  return {
    type: value.type === "linear" || value.type === "exponential" ? value.type : fallback.type,
    speed:
      typeof value.speed === "number" && Number.isFinite(value.speed) && value.speed > 0
        ? value.speed
        : fallback.speed,
  };
}

function normalizeShortcutValue(value: unknown): BrewvaShortcutValue | undefined {
  if (value === "none" || typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value;
  }
  return undefined;
}

function normalizeBindings(
  input: unknown,
  ctx: {
    path: string;
    knownBindingIds?: ReadonlySet<string>;
    warnings: BrewvaTuiConfigWarning[];
  },
): Record<string, BrewvaShortcutValue> {
  if (!isRecord(input)) {
    return {};
  }
  const output: Record<string, BrewvaShortcutValue> = {};
  for (const [id, value] of Object.entries(input)) {
    if (ctx.knownBindingIds && !ctx.knownBindingIds.has(id)) {
      ctx.warnings.push({
        code: "unknown_binding",
        path: ctx.path,
        message: `Unknown TUI keymap binding id '${id}' was ignored.`,
      });
      continue;
    }
    const normalized = normalizeShortcutValue(value);
    if (normalized !== undefined) {
      output[id] = normalized;
    }
  }
  return output;
}

function normalizeConfigFile(
  input: unknown,
  ctx: {
    path: string;
    knownBindingIds?: ReadonlySet<string>;
    warnings: BrewvaTuiConfigWarning[];
  },
): BrewvaTuiConfigFile {
  if (!isRecord(input)) {
    ctx.warnings.push({
      code: "invalid_shape",
      path: ctx.path,
      message: "TUI config must be a JSON object.",
    });
    return {};
  }
  const keymap = isRecord(input.keymap) ? input.keymap : {};
  const view = isRecord(input.view) ? input.view : {};
  const diff = isRecord(view.diff) ? view.diff : {};
  const textInput = isRecord(input.input) ? input.input : {};
  const largePasteThreshold = isRecord(textInput.largePasteThreshold)
    ? textInput.largePasteThreshold
    : {};
  const scroll = isRecord(input.scroll) ? input.scroll : {};
  const acceleration = isRecord(scroll.acceleration) ? scroll.acceleration : {};
  return {
    ...(typeof input.theme === "string" ? { theme: input.theme } : {}),
    keymap: {
      ...(typeof keymap.leader === "string" ? { leader: keymap.leader } : {}),
      ...(typeof keymap.leaderTimeoutMs === "number"
        ? { leaderTimeoutMs: keymap.leaderTimeoutMs }
        : {}),
      bindings: normalizeBindings(keymap.bindings, ctx),
    },
    view: {
      ...(typeof view.showThinking === "boolean" ? { showThinking: view.showThinking } : {}),
      ...(typeof view.toolDetails === "boolean" ? { toolDetails: view.toolDetails } : {}),
      diff: {
        ...(typeof diff.style === "string" ? { style: diff.style as "auto" | "stacked" } : {}),
        ...(typeof diff.wrapMode === "string"
          ? { wrapMode: diff.wrapMode as "word" | "none" }
          : {}),
      },
    },
    input: {
      largePasteThreshold: {
        ...(typeof largePasteThreshold.minLines === "number"
          ? { minLines: largePasteThreshold.minLines }
          : {}),
        ...(typeof largePasteThreshold.minCharacters === "number"
          ? { minCharacters: largePasteThreshold.minCharacters }
          : {}),
      },
    },
    scroll: {
      acceleration: {
        ...(typeof acceleration.type === "string"
          ? { type: acceleration.type as BrewvaTuiScrollAcceleration["type"] }
          : {}),
        ...(typeof acceleration.speed === "number" ? { speed: acceleration.speed } : {}),
      },
    },
  };
}

function normalizeResolvedConfig(input: BrewvaTuiConfig): BrewvaTuiConfig {
  return {
    theme: input.theme,
    keymap: {
      leader: normalizeString(input.keymap.leader, DEFAULT_BREWVA_TUI_CONFIG.keymap.leader),
      leaderTimeoutMs: normalizePositiveInteger(
        input.keymap.leaderTimeoutMs,
        DEFAULT_BREWVA_TUI_CONFIG.keymap.leaderTimeoutMs,
      ),
      bindings: { ...input.keymap.bindings },
    },
    view: {
      showThinking: normalizeBoolean(
        input.view.showThinking,
        DEFAULT_BREWVA_TUI_CONFIG.view.showThinking,
      ),
      toolDetails: normalizeBoolean(
        input.view.toolDetails,
        DEFAULT_BREWVA_TUI_CONFIG.view.toolDetails,
      ),
      diff: {
        style: normalizeDiffStyle(input.view.diff.style, DEFAULT_BREWVA_TUI_CONFIG.view.diff.style),
        wrapMode: normalizeDiffWrapMode(
          input.view.diff.wrapMode,
          DEFAULT_BREWVA_TUI_CONFIG.view.diff.wrapMode,
        ),
      },
    },
    input: {
      largePasteThreshold: {
        minLines: normalizePositiveInteger(
          input.input.largePasteThreshold.minLines,
          DEFAULT_BREWVA_TUI_CONFIG.input.largePasteThreshold.minLines,
        ),
        minCharacters: normalizePositiveInteger(
          input.input.largePasteThreshold.minCharacters,
          DEFAULT_BREWVA_TUI_CONFIG.input.largePasteThreshold.minCharacters,
        ),
      },
    },
    scroll: {
      acceleration: normalizeScrollAcceleration(input.scroll.acceleration),
    },
  };
}

function readTuiConfigFile(
  path: string,
  ctx: {
    knownBindingIds?: ReadonlySet<string>;
    warnings: BrewvaTuiConfigWarning[];
  },
): BrewvaTuiConfigFile {
  if (!existsSync(path)) {
    return {};
  }
  try {
    return normalizeConfigFile(parseJsonc(readFileSync(path, "utf8")), {
      path,
      knownBindingIds: ctx.knownBindingIds,
      warnings: ctx.warnings,
    });
  } catch (error) {
    ctx.warnings.push({
      code: "invalid_config",
      path,
      message: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

function resolveExplicitTuiConfigPath(cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  const value = env.BREWVA_TUI_CONFIG;
  return typeof value === "string" && value.trim().length > 0
    ? resolvePathInput(cwd, value)
    : undefined;
}

export function loadBrewvaTuiConfig(
  options: LoadBrewvaTuiConfigOptions,
): BrewvaTuiConfigResolution {
  const env = options.env ?? process.env;
  const warnings: BrewvaTuiConfigWarning[] = [];
  const globalPath = resolve(resolveGlobalBrewvaRootDir(env), "tui.json");
  const projectPath = resolve(resolveProjectBrewvaRootDir(options.cwd), "tui.json");
  const explicitPath = resolveExplicitTuiConfigPath(options.cwd, env);
  const paths = [globalPath, projectPath, ...(explicitPath ? [explicitPath] : [])];
  let config = DEFAULT_BREWVA_TUI_CONFIG;
  for (const path of paths) {
    const patch = readTuiConfigFile(path, {
      knownBindingIds: options.knownBindingIds,
      warnings,
    });
    config = deepMerge(config, patch);
  }
  return {
    config: normalizeResolvedConfig(config),
    consultedPaths: paths,
    warnings,
  };
}

export function resolveBrewvaTuiConfigFileBaseDir(configPath: string): string {
  return dirname(configPath);
}
