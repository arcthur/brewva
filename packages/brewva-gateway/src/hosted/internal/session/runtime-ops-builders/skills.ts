import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { toErrorMessage } from "@brewva/brewva-std/unknown";
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

/**
 * Project-category skills are project-specific tightening (see
 * docs/guide/category-and-skills.md); they only apply to sessions whose
 * workspace lives inside the project that owns the catalog root.
 */
const WORKSPACE_SCOPED_CATEGORIES: ReadonlySet<string> = new Set(["project"]);

export type SkillCatalogRoot = {
  /** Directory scanned for SKILL.md documents. */
  readonly root: string;
  /** Overlay roots re-tighten skills shipped by earlier roots. */
  readonly overlay: boolean;
  /** The project this root belongs to; scopes project-category skills. */
  readonly projectRoot: string;
};

function isPathInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  if (resolvedPath === resolvedRoot) {
    return true;
  }
  const prefix = resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`;
  return resolvedPath.startsWith(prefix);
}

export function composeSkillCatalog(input: {
  readonly workspaceRoot: string;
  readonly roots: readonly SkillCatalogRoot[];
}): SkillCatalogSnapshot {
  const byName = new Map<string, SkillDocument>();
  const overlaySkills = new Set<string>();
  const outOfScopeSkills = new Set<string>();
  const failed: Array<{ readonly filePath: string; readonly error: string }> = [];
  for (const root of input.roots) {
    const projectInScope = isPathInsideRoot(input.workspaceRoot, root.projectRoot);
    for (const filePath of collectSkillDocumentPaths(root.root)) {
      try {
        const category = skillCategoryFromPath(root.root, filePath);
        const parsed = parseSkillDocument(filePath, category);
        if (WORKSPACE_SCOPED_CATEGORIES.has(category) && !projectInScope) {
          outOfScopeSkills.add(parsed.name);
          continue;
        }
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
          error: toErrorMessage(error),
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
      roots: input.roots.map((root) => root.root).filter((root) => existsSync(root)),
      outOfScopeSkills: [...outOfScopeSkills]
        .filter((name) => !byName.has(name))
        .toSorted((left, right) => left.localeCompare(right)),
      failed,
    },
  };
}

function loadSkillCatalog(ctx: HostedRuntimeOpsContext): SkillCatalogSnapshot {
  const workspaceRoot = ctx.runtime.identity.workspaceRoot;
  const installRoot = process.cwd();
  return composeSkillCatalog({
    workspaceRoot,
    roots: [
      { root: join(installRoot, "skills"), overlay: false, projectRoot: installRoot },
      {
        root: join(workspaceRoot, ".brewva", "skills"),
        overlay: true,
        projectRoot: workspaceRoot,
      },
    ],
  });
}
