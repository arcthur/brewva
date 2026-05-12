import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  resolveBrewvaAgentDir,
  resolveGlobalBrewvaConfigPath,
  resolveGlobalBrewvaRootDir,
  resolveProjectBrewvaConfigPath,
  type BrewvaRuntime,
} from "@brewva/brewva-runtime";

export interface BrewvaUpdatePromptInput {
  runtime: Pick<BrewvaRuntime, "cwd" | "workspaceRoot">;
  rawArgs?: string;
}

export interface BrewvaUpdateExecutionScope {
  workspaceRoot: string;
  workingDirectory: string;
  globalRoot: string;
  globalConfigPath: string;
  globalAgentDir: string;
  projectConfigPath: string;
  lockKey: string;
  lockTarget: string;
}

interface WorkspacePackageSummary {
  name?: string;
  scripts: string[];
}

function normalizeText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function readWorkspacePackageSummary(workspaceRoot: string): WorkspacePackageSummary {
  const packageJsonPath = join(workspaceRoot, "package.json");
  if (!existsSync(packageJsonPath)) {
    return { scripts: [] };
  }

  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      name?: unknown;
      scripts?: unknown;
    };
    const name =
      typeof parsed.name === "string" && parsed.name.trim() ? parsed.name.trim() : undefined;
    const scripts =
      parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)
        ? Object.keys(parsed.scripts).filter((key) => key.trim().length > 0)
        : [];
    return { name, scripts };
  } catch {
    return { scripts: [] };
  }
}

function resolveValidationHints(workspaceRoot: string): string[] {
  const workspacePackage = readWorkspacePackageSummary(workspaceRoot);
  const scriptSet = new Set(workspacePackage.scripts);
  const looksLikeBrewvaRepo =
    workspacePackage.name === "brewva" &&
    scriptSet.has("check") &&
    scriptSet.has("test") &&
    scriptSet.has("test:dist");

  if (looksLikeBrewvaRepo) {
    return [
      "This workspace looks like the Brewva repository. If the update touched repository code, packaging, or public exports, run `bun run check`, `bun test`, and `bun run test:dist` before claiming success.",
      "If you only updated a globally installed Brewva binary and local Brewva config/state outside this repository, keep validation to install/config smoke tests unless the changelog requires broader verification.",
    ];
  }

  return [
    "Always run `brewva --version` and `brewva --help` after the upgrade.",
    "If the update migrated project-local `.brewva` files, run the smallest Brewva smoke flow that proves config loading still works in this workspace.",
    "Prefer targeted validation over repository-wide test suites unless the changelog or changed files justify a broader run.",
  ];
}

function resolveChangelogHints(workspaceRoot: string): string[] {
  const localCandidates = [
    join(workspaceRoot, "CHANGELOG.md"),
    join(workspaceRoot, "changelog.md"),
  ].filter((path) => existsSync(path));
  if (localCandidates.length > 0) {
    return localCandidates.map((path) => `Prefer local changelog source: ${path}`);
  }
  return [
    "If no local changelog is present, fetch authoritative Brewva release notes from the release source you detect (for example repository releases or package registry metadata).",
  ];
}

function formatHintLines(rawArgs: string | undefined): string[] {
  const normalized = normalizeText(rawArgs);
  if (!normalized) {
    return ["- none"];
  }
  return normalized
    .split(/\r?\n/u)
    .map((line) => `- ${line.trim()}`)
    .filter((line) => line !== "- ");
}

export function resolveBrewvaUpdateExecutionScope(
  runtime: Pick<BrewvaRuntime, "cwd" | "workspaceRoot">,
): BrewvaUpdateExecutionScope {
  const globalRoot = resolveGlobalBrewvaRootDir();
  const globalConfigPath = resolveGlobalBrewvaConfigPath();
  const projectConfigPath = resolveProjectBrewvaConfigPath(runtime.cwd);
  const globalAgentDir = resolveBrewvaAgentDir();
  return {
    workspaceRoot: runtime.workspaceRoot,
    workingDirectory: runtime.cwd,
    globalRoot,
    globalConfigPath,
    globalAgentDir,
    projectConfigPath,
    lockKey: `global-root:${globalRoot}`,
    lockTarget: globalRoot,
  };
}

export function buildBrewvaUpdatePrompt(input: BrewvaUpdatePromptInput): string {
  const updateScope = resolveBrewvaUpdateExecutionScope(input.runtime);
  const changelogHints = resolveChangelogHints(input.runtime.workspaceRoot);
  const validationHints = resolveValidationHints(input.runtime.workspaceRoot);

  return [
    "Run a Brewva update workflow for this environment.",
    "",
    "Success criteria:",
    "- Review the relevant changelog or release notes before mutating binaries, config, or state.",
    "- Fail closed if you cannot collect authoritative release evidence for every version jump you plan to cross.",
    "- Apply only the schema/config/state migrations required by the versions you cross.",
    "- Do not claim the update is complete until validation has passed.",
    "",
    "Environment anchors:",
    `- Workspace root: ${updateScope.workspaceRoot}`,
    `- Working directory: ${updateScope.workingDirectory}`,
    `- Global Brewva root: ${updateScope.globalRoot}`,
    `- Global config: ${updateScope.globalConfigPath}`,
    `- Global agent dir: ${updateScope.globalAgentDir}`,
    `- Project config: ${updateScope.projectConfigPath}`,
    `- Update execution lock: ${updateScope.lockKey}`,
    "",
    "Required workflow:",
    "1. Detect the currently installed Brewva version and the installation method in use (npm, bun, pnpm, local symlink, repository checkout, or another concrete path).",
    "2. Determine the target version. Default to the latest stable Brewva release unless the operator hint says otherwise.",
    "3. Resolve changelog sources in this order: local workspace changelog, installed package metadata or bundled release notes, package-manager cache or already-downloaded artifacts, then authoritative remote release notes.",
    "4. Read changelog or release-note entries for every version jump you plan to cross. If no authoritative source covers the full version span, stop and report `upgrade_blocked_missing_release_evidence` instead of upgrading blind.",
    "5. Identify required migrations for global config, project `.brewva` files, bundled skills, agent state, or any other Brewva-owned local artifacts.",
    "6. Before mutating anything, record a rollback point for every binary, symlink, config file, or state file you will change using the install-method-specific guidance below.",
    "7. Perform the upgrade with the install method you detected.",
    "8. Apply the required migrations with the smallest auditable diff possible.",
    "9. Validate the result. Always run `brewva --version` and `brewva --help`, then run the smallest additional changelog-driven checks that prove the changed surfaces are healthy.",
    "10. Report the starting version, target version, changelog entries reviewed, migrations applied, validations run, rollback artifacts captured, and any remaining manual follow-up.",
    "",
    "Changelog guidance:",
    ...changelogHints.map((line) => `- ${line}`),
    "",
    "Rollback guidance:",
    "- Global npm, pnpm, or bun installs: record the current version, resolved binary path, package manager, and global install root. Prefer capturing a reinstallable tarball snapshot from local cache or a package-manager equivalent such as `npm pack`. If no exact snapshot can be produced, state clearly that rollback is version-only rather than file-exact.",
    "- Local symlink installs: record the current symlink target and copy the existing launcher or target before replacing it.",
    "- Repository checkouts or editable installs: record the current git revision and dirty-state summary, then back up Brewva-owned config or state files before migration.",
    "- Schema, config, or state migrations: copy the pre-migration files or directories to a rollback location and record the exact restore step.",
    "",
    "Offline and network-failure guidance:",
    "- Prefer the local changelog source when present.",
    "- If the network is unavailable, fall back to installed package metadata, package-manager cache, or already-downloaded release artifacts.",
    "- If you still cannot verify the target version or review authoritative release evidence, stop and report `upgrade_blocked_missing_release_evidence`.",
    "- Do not treat a failed fetch as permission to skip changelog review, rollback planning, or migration analysis.",
    "",
    "Validation guidance:",
    ...validationHints.map((line) => `- ${line}`),
    "",
    "Operator hints:",
    ...formatHintLines(input.rawArgs),
  ].join("\n");
}
