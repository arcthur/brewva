import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { SKILL_SELECTION_RECORDED_EVENT_TYPE } from "@brewva/brewva-vocabulary/harness";
import { parseSkillDocument } from "@brewva/brewva-vocabulary/session";
import type { SkillDocument, SkillRegistryLoadReport } from "@brewva/brewva-vocabulary/session";
import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

type SkillCatalogSnapshot = {
  readonly skills: SkillDocument[];
  readonly report: SkillRegistryLoadReport;
};

export function buildSkillsRuntimeOps(
  ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["skills"] {
  return {
    catalog: {
      list: () => loadSkillCatalog(ctx).skills,
      get: (name) => loadSkillCatalog(ctx).skills.find((skill) => skill.name === name),
      getLoadReport: () => loadSkillCatalog(ctx).report,
    },
    selection: {
      latest: (sessionId) =>
        ctx.latestRecordedPayload(sessionId, SKILL_SELECTION_RECORDED_EVENT_TYPE),
      record(sessionId, payload) {
        return ctx.emit(sessionId, SKILL_SELECTION_RECORDED_EVENT_TYPE, payload);
      },
    },
  };
}

function collectSkillDocumentPaths(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const paths: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (entry.isFile() && entry.name === "SKILL.md") {
        paths.push(absolutePath);
      }
    }
  };
  visit(root);
  return paths.toSorted((left, right) => left.localeCompare(right));
}

function skillCategoryFromPath(root: string, filePath: string): string {
  const [category] = relative(root, filePath).split(/[\\/]/u);
  return category && category.length > 0 ? category : "core";
}

function loadSkillCatalog(ctx: HostedRuntimeOpsContext): SkillCatalogSnapshot {
  const workspaceRoot = ctx.runtime.identity.workspaceRoot;
  const roots = [
    { root: join(process.cwd(), "skills"), overlay: false },
    { root: join(workspaceRoot, ".brewva", "skills"), overlay: true },
  ];
  const byName = new Map<string, SkillDocument>();
  const overlaySkills = new Set<string>();
  const failed: Array<{ readonly filePath: string; readonly error: string }> = [];
  for (const root of roots) {
    for (const filePath of collectSkillDocumentPaths(root.root)) {
      try {
        const category = skillCategoryFromPath(root.root, filePath);
        const parsed = parseSkillDocument(filePath, category);
        const existing = byName.get(parsed.name);
        if (root.overlay) {
          overlaySkills.add(parsed.name);
        }
        byName.set(parsed.name, {
          ...existing,
          ...parsed,
          category,
          filePath,
        });
      } catch (error) {
        failed.push({
          filePath,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
  const skills = [...byName.values()].toSorted((left, right) =>
    left.name.localeCompare(right.name),
  );
  const loadedSkills = skills.map((skill) => skill.name);
  return {
    skills,
    report: {
      loadedSkills,
      selectableSkills: loadedSkills,
      overlaySkills: [...overlaySkills].toSorted((left, right) => left.localeCompare(right)),
      roots: roots.map((root) => root.root).filter((root) => existsSync(root)),
      failed,
    },
  };
}
