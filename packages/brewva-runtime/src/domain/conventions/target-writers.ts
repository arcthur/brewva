import { posix } from "node:path";
import type { PatchSet } from "../patching/api.js";
import type { ConventionTarget } from "./types.js";

const ALLOWED_RUNTIME_CONFIG_PREFIXES = [
  "verification.",
  "skills.roots",
  "skills.disabled",
  "capabilities.",
  "security.actionAdmissionOverrides.",
] as const;

const ALLOWED_RUNTIME_CONFIG_FILES = [
  ".brewva/config.json",
  ".brewva/config.jsonc",
  "brewva.config.json",
  "brewva.config.jsonc",
] as const;

function normalizeTargetPath(filePath: string): string | undefined {
  const rawPath = filePath.replaceAll("\\", "/");
  if (rawPath.startsWith("/")) return undefined;
  const normalized = posix.normalize(rawPath.replace(/^\.\/+/, ""));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    return undefined;
  }
  return normalized;
}

function isProjectGuidancePath(filePath: string): boolean {
  const normalized = normalizeTargetPath(filePath);
  return Boolean(normalized?.startsWith("skills/project/shared/") && normalized.endsWith(".md"));
}

function isSkillCardPath(filePath: string): boolean {
  const normalized = normalizeTargetPath(filePath);
  return Boolean(normalized && (normalized.endsWith("/SKILL.md") || normalized === "SKILL.md"));
}

function isRuntimeConfigFile(filePath: string): boolean {
  const normalized = normalizeTargetPath(filePath);
  return Boolean(
    normalized && (ALLOWED_RUNTIME_CONFIG_FILES as readonly string[]).includes(normalized),
  );
}

function assertNever(value: never): never {
  throw new Error(`unsupported_convention_target:${String(value)}`);
}

export function validateConventionTargetPatchSet(input: {
  target: ConventionTarget;
  patchSet: PatchSet;
}): string | undefined {
  if (input.patchSet.changes.length === 0) {
    return "empty_patchset";
  }
  switch (input.target.kind) {
    case "project_guidance": {
      const targetPath = normalizeTargetPath(input.target.path);
      if (!targetPath || !isProjectGuidancePath(targetPath)) {
        return "project_guidance_path_out_of_scope";
      }
      return input.patchSet.changes.every(
        (change) => normalizeTargetPath(change.path) === targetPath,
      )
        ? undefined
        : "project_guidance_path_out_of_scope";
    }
    case "skill_card": {
      const targetPath = normalizeTargetPath(input.target.path);
      if (!targetPath || !isSkillCardPath(targetPath)) {
        return "skill_card_path_out_of_scope";
      }
      return input.patchSet.changes.every(
        (change) => normalizeTargetPath(change.path) === targetPath,
      )
        ? undefined
        : "skill_card_path_out_of_scope";
    }
    case "runtime_config": {
      if (!isRuntimeConfigFile(input.target.path)) {
        return "runtime_config_file_out_of_scope";
      }
      const allConfigPathsAllowed = input.target.configPaths.every((path) =>
        ALLOWED_RUNTIME_CONFIG_PREFIXES.some((prefix) => path.startsWith(prefix)),
      );
      if (!allConfigPathsAllowed) {
        return "runtime_config_path_out_of_scope";
      }
      const targetPath = normalizeTargetPath(input.target.path);
      return input.patchSet.changes.every(
        (change) => normalizeTargetPath(change.path) === targetPath,
      )
        ? undefined
        : "runtime_config_file_out_of_scope";
    }
    default:
      return assertNever(input.target);
  }
}
