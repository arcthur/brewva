import { createHash } from "node:crypto";
import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { composeSkillCatalog } from "../../../packages/brewva-gateway/src/hosted/internal/session/runtime-ops-builders/skills.js";
import type { SelfEvalPilotSkill, SelfEvalSkillArm, SelfEvalSkillIdentity } from "./types.js";

export const PILOT_SKILL_NAMES = ["debugging", "learning-research", "review"] as const;

const STRICT_SCAFFOLD_MARKER = "strict-protocol.md";

function listFiles(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  visit(root);
  // Code-unit ordering (never locale-sensitive `localeCompare`): this feeds the
  // `skillCorpusDigest`/`contentDigest` a cross-host comparator must reproduce.
  return files.toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

function digestTree(root: string): string {
  const hash = createHash("sha256");
  for (const file of listFiles(root)) {
    hash.update(relative(root, file));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function removeStrictScaffold(skillRoot: string): void {
  rmSync(join(skillRoot, "references", "strict-protocol.md"), { force: true });
  const skillPath = join(skillRoot, "SKILL.md");
  const withoutDefaultBlock = readFileSync(skillPath, "utf8").replace(
    /<!-- self-eval-strict-scaffold:start -->[\s\S]*?<!-- self-eval-strict-scaffold:end -->\n?/gu,
    "",
  );
  const filtered = withoutDefaultBlock
    .split("\n")
    .filter((line) => !line.includes(STRICT_SCAFFOLD_MARKER))
    .join("\n");
  writeFileSync(skillPath, filtered, "utf8");
}

export function materializeSelfEvalSkillArm(input: {
  readonly arm: SelfEvalSkillArm;
  readonly pilotSkill: SelfEvalPilotSkill;
  readonly sourceRoot: string;
  readonly workspace: string;
}): {
  readonly loadedSkills: readonly SelfEvalSkillIdentity[];
  readonly skillCorpusDigest: string;
} {
  const installRoot = join(input.workspace, "skills");
  for (const skill of PILOT_SKILL_NAMES) {
    if (skill === input.pilotSkill && input.arm === "no_skill") continue;
    const source = join(input.sourceRoot, "skills", "core", skill);
    if (!existsSync(join(source, "SKILL.md"))) {
      throw new Error(`Self-eval pilot skill ${skill} is missing at ${source}.`);
    }
    const target = join(installRoot, "core", skill);
    cpSync(source, target, { recursive: true, errorOnExist: true });
    if (skill === input.pilotSkill && input.arm === "kernel_only") removeStrictScaffold(target);
  }

  const catalog = composeSkillCatalog({
    workspaceRoot: input.workspace,
    roots: [{ root: installRoot, overlay: false, projectRoot: input.workspace }],
  });
  const failures = Array.isArray(catalog.report.failed)
    ? catalog.report.failed.filter(
        (failure): failure is { filePath: string; error: string } =>
          typeof failure === "object" &&
          failure !== null &&
          typeof (failure as { filePath?: unknown }).filePath === "string" &&
          typeof (failure as { error?: unknown }).error === "string",
      )
    : [];
  if (failures.length > 0) {
    throw new Error(
      `Self-eval skill catalog failed to load: ${failures
        .map((failure) => `${failure.filePath}: ${failure.error}`)
        .join("; ")}`,
    );
  }
  const expected = PILOT_SKILL_NAMES.filter(
    (skill) => skill !== input.pilotSkill || input.arm !== "no_skill",
  );
  if (catalog.report.loadedSkills.join("\n") !== expected.join("\n")) {
    throw new Error(
      `Self-eval arm ${input.arm} loaded [${catalog.report.loadedSkills.join(", ")}], ` +
        `expected [${expected.join(", ")}].`,
    );
  }
  const loadedSkills = catalog.report.loadedSkills.map((name) => ({
    name,
    contentDigest: digestTree(join(installRoot, "core", name)),
  }));
  return {
    loadedSkills,
    skillCorpusDigest: digestTree(installRoot),
  };
}
