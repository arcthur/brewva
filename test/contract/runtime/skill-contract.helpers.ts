import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SkillContract } from "@brewva/brewva-runtime";

export function repoRoot(): string {
  return process.cwd();
}

export function createContract(
  input: Partial<SkillContract> & Pick<SkillContract, "name" | "category">,
): SkillContract {
  const defaultLease = input.resources?.defaultLease ?? {
    maxToolCalls: 50,
    maxTokens: 100000,
  };
  const hardCeiling = input.resources?.hardCeiling ?? defaultLease;
  return {
    name: input.name,
    category: input.category,
    routing: input.routing,
    intent: input.intent,
    effects: input.effects ?? {
      allowedEffects: ["workspace_read"],
      deniedEffects: [],
    },
    resources: input.resources ?? {
      defaultLease,
      hardCeiling,
    },
    executionHints: input.executionHints ?? {
      preferredTools: ["read"],
      fallbackTools: [],
      costHint: "medium",
    },
    composableWith: input.composableWith,
    consumes: input.consumes,
    requires: input.requires,
    stability: input.stability,
    description: input.description,
  };
}

export function createTempSkillDocument(
  prefix: string,
  relativePath: string,
  lines: string[],
): string {
  const workspace = mkdtempSync(join(tmpdir(), prefix));
  const filePath = join(workspace, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, lines.join("\n"), "utf8");
  return filePath;
}
