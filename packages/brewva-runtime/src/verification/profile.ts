import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEFAULT_BREWVA_CONFIG } from "../config/defaults.js";
import type {
  BrewvaConfig,
  TaskState,
  VerificationEvidence,
  VerificationLevel,
} from "../contracts/index.js";

export type VerificationEvidenceMatchKind = "lsp_clean" | "test_or_build_passed" | "command_passed";

export interface VerificationPlanCheck {
  name: string;
  command?: string;
  cwd?: string;
  evidenceKind: VerificationEvidenceMatchKind;
  missingLabel: string;
  commandMatch?: string;
}

export interface VerificationPlan {
  checks: VerificationPlanCheck[];
  targetRoots: string[];
}

type PackageScripts = Record<string, string>;

interface PackageManifest {
  scripts: PackageScripts;
  packageManager?: string;
}

function normalizeCommand(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function hasTargetExtension(
  taskState: TaskState | undefined,
  extensions: readonly string[],
): boolean {
  const files = taskState?.spec?.targets?.files ?? [];
  return files.some((file) =>
    extensions.some((extension) => file.toLowerCase().endsWith(extension)),
  );
}

function readPackageManifest(root: string): PackageManifest {
  const packageJsonPath = resolve(root, "package.json");
  if (!existsSync(packageJsonPath)) {
    return { scripts: {} };
  }
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, unknown>;
      packageManager?: unknown;
    };
    const scripts =
      parsed.scripts && typeof parsed.scripts === "object"
        ? Object.fromEntries(
            Object.entries(parsed.scripts).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string" && entry[1].trim().length > 0,
            ),
          )
        : {};
    return {
      scripts,
      packageManager:
        typeof parsed.packageManager === "string" && parsed.packageManager.trim().length > 0
          ? parsed.packageManager.trim()
          : undefined,
    };
  } catch {
    return { scripts: {} };
  }
}

function firstScriptName(root: string, names: readonly string[]): string | undefined {
  const scripts = readPackageManifest(root).scripts;
  for (const name of names) {
    if (typeof scripts[name] === "string" && scripts[name].trim().length > 0) {
      return name;
    }
  }
  return undefined;
}

function resolvePackageManager(
  root: string,
  manifest?: PackageManifest,
): "bun" | "pnpm" | "yarn" | "npm" {
  const packageManager = manifest?.packageManager ?? readPackageManifest(root).packageManager;
  if (packageManager?.startsWith("bun@")) return "bun";
  if (packageManager?.startsWith("pnpm@")) return "pnpm";
  if (packageManager?.startsWith("yarn@")) return "yarn";
  if (packageManager?.startsWith("npm@")) return "npm";
  if (hasFile(root, "bun.lock") || hasFile(root, "bun.lockb")) return "bun";
  if (hasFile(root, "pnpm-lock.yaml")) return "pnpm";
  if (hasFile(root, "yarn.lock")) return "yarn";
  return "npm";
}

function buildPackageScriptCommand(root: string, scriptName: string): string {
  const manifest = readPackageManifest(root);
  const packageManager = resolvePackageManager(root, manifest);
  if (packageManager === "bun") {
    return `bun run ${scriptName}`;
  }
  if (packageManager === "pnpm") {
    return `pnpm run ${scriptName}`;
  }
  if (packageManager === "yarn") {
    return `yarn ${scriptName}`;
  }
  return `npm run ${scriptName}`;
}

function firstScriptCommand(root: string, names: readonly string[]): string | undefined {
  const scriptName = firstScriptName(root, names);
  return scriptName ? buildPackageScriptCommand(root, scriptName) : undefined;
}

function hasFile(root: string, relativePath: string): boolean {
  return existsSync(resolve(root, relativePath));
}

function hasAnyLintConfig(root: string): boolean {
  return [
    ".eslintrc",
    ".eslintrc.js",
    ".eslintrc.cjs",
    ".eslintrc.mjs",
    ".eslintrc.json",
    "eslint.config.js",
    "eslint.config.cjs",
    "eslint.config.mjs",
    "eslint.config.ts",
  ].some((file) => hasFile(root, file));
}

function resolveExplicitCommandChecks(commands: readonly string[]): VerificationPlanCheck[] {
  return commands
    .map((command, index) => {
      const normalized = normalizeCommand(command);
      return {
        name: `command:${index + 1}`,
        command,
        evidenceKind: "command_passed" as const,
        missingLabel: `command:${index + 1}`,
        commandMatch: normalized,
      };
    })
    .filter((entry) => entry.command.trim().length > 0);
}

function isExplicitVerificationCheck(
  config: BrewvaConfig,
  level: VerificationLevel,
  checkName: string,
): boolean {
  const configuredChecks = config.verification.checks[level] ?? [];
  const defaultChecks = DEFAULT_BREWVA_CONFIG.verification.checks[level] ?? [];
  const sameChecks =
    configuredChecks.length === defaultChecks.length &&
    configuredChecks.every((value, index) => value === defaultChecks[index]);
  if (!sameChecks) {
    return true;
  }
  return (
    (config.verification.commands[checkName] ?? "") !==
    (DEFAULT_BREWVA_CONFIG.verification.commands[checkName] ?? "")
  );
}

function buildRootLabel(root: string): string {
  const normalized = resolve(root).replaceAll("\\", "/");
  const segments = normalized.split("/").filter(Boolean);
  const tail = segments.slice(-2).join("-");
  const digest = createHash("sha1").update(normalized).digest("hex").slice(0, 6);
  return `${tail || "root"}-${digest}`.replace(/[^a-z0-9._-]+/giu, "-").toLowerCase();
}

function buildCheckName(baseName: string, root: string, roots: readonly string[]): string {
  if (roots.length <= 1) {
    return baseName;
  }
  return `${baseName}@${buildRootLabel(root)}`;
}

function resolveDefaultChecks(input: {
  config: BrewvaConfig;
  taskState?: TaskState;
  level: VerificationLevel;
  targetRoots: readonly string[];
}): VerificationPlanCheck[] {
  const roots = input.targetRoots.length > 0 ? [...input.targetRoots] : [process.cwd()];
  const hasTypeScriptTargets = hasTargetExtension(input.taskState, [".ts", ".tsx"]);
  const checks: VerificationPlanCheck[] = [];

  for (const root of roots) {
    const hasTypeScriptRoot = hasFile(root, "tsconfig.json") || hasFile(root, "jsconfig.json");
    const hasLintConfigRoot = hasAnyLintConfig(root);
    const typecheckCommand =
      firstScriptCommand(root, ["typecheck", "type-check", "check"]) ??
      input.config.verification.commands["type-check"];
    const lintCommand =
      firstScriptCommand(root, ["lint"]) ??
      (hasLintConfigRoot ? input.config.verification.commands.lint : undefined);
    const testsCommand =
      firstScriptCommand(root, ["test", "build", "verify", "check"]) ??
      input.config.verification.commands.tests;

    for (const name of input.config.verification.checks[input.level] ?? []) {
      const checkName = buildCheckName(name, root, roots);
      if (name === "type-check") {
        if (
          !isExplicitVerificationCheck(input.config, input.level, name) &&
          !hasTypeScriptTargets &&
          !hasTypeScriptRoot
        ) {
          continue;
        }
        checks.push({
          name: checkName,
          command: typecheckCommand,
          cwd: root,
          evidenceKind: "lsp_clean",
          missingLabel: "lsp_diagnostics",
        });
        continue;
      }
      if (name === "tests") {
        checks.push({
          name: checkName,
          command: testsCommand,
          cwd: root,
          evidenceKind: "test_or_build_passed",
          missingLabel: "test_or_build",
        });
        continue;
      }
      if (name === "lint") {
        if (
          !isExplicitVerificationCheck(input.config, input.level, name) &&
          !hasLintConfigRoot &&
          !lintCommand
        ) {
          continue;
        }
        checks.push({
          name: checkName,
          command: lintCommand,
          cwd: root,
          evidenceKind: "command_passed",
          missingLabel: "command_passed",
          commandMatch: lintCommand ? normalizeCommand(lintCommand) : undefined,
        });
        continue;
      }
      if (name === "diff-review") {
        const command = input.config.verification.commands["diff-review"];
        checks.push({
          name: checkName,
          command,
          cwd: root,
          evidenceKind: "command_passed",
          missingLabel: "command_passed",
          commandMatch: normalizeCommand(command ?? ""),
        });
      }
    }
  }

  if (checks.length === 0) {
    checks.push({
      name: "smoke",
      evidenceKind: "command_passed",
      missingLabel: "command_passed",
    });
  }

  return checks;
}

export function matchesVerificationEvidence(
  evidence: VerificationEvidence,
  check: VerificationPlanCheck,
): boolean {
  if (evidence.kind !== check.evidenceKind) {
    return false;
  }
  if (!check.commandMatch) {
    return true;
  }
  return normalizeCommand(evidence.detail ?? "") === check.commandMatch;
}

export function resolveVerificationPlan(input: {
  config: BrewvaConfig;
  taskState?: TaskState;
  level: VerificationLevel;
  targetRoots: readonly string[];
}): VerificationPlan {
  const roots = input.targetRoots.length > 0 ? [...input.targetRoots] : [process.cwd()];
  const explicitCommands = input.taskState?.spec?.verification?.commands ?? [];
  if (explicitCommands.length > 0) {
    const baseChecks = resolveExplicitCommandChecks(explicitCommands);
    const checks: VerificationPlanCheck[] = [];
    if (roots.length <= 1) {
      for (const check of baseChecks) {
        checks.push({
          name: check.name,
          command: check.command,
          cwd: roots[0],
          evidenceKind: check.evidenceKind,
          missingLabel: check.missingLabel,
          commandMatch: check.commandMatch,
        });
      }
    } else {
      for (const root of roots) {
        for (const [index, check] of baseChecks.entries()) {
          const name = buildCheckName(`command:${index + 1}`, root, roots);
          checks.push({
            name,
            command: check.command,
            cwd: root,
            evidenceKind: check.evidenceKind,
            missingLabel: name,
            commandMatch: check.commandMatch,
          });
        }
      }
    }
    return {
      checks,
      targetRoots: roots,
    };
  }

  return {
    checks: resolveDefaultChecks(input),
    targetRoots: roots,
  };
}
