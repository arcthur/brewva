import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SkillCard } from "@brewva/brewva-vocabulary/session";

export function repoRoot(): string {
  return process.cwd();
}

export function createContract(
  input: Partial<SkillCard> & Pick<SkillCard, "name" | "category">,
): SkillCard {
  return {
    name: input.name,
    category: input.category,
    description: input.description ?? input.name,
    selection: input.selection,
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
