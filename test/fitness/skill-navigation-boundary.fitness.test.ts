import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parseSkillDocument } from "@brewva/brewva-vocabulary/session";

const repoRoot = resolve(import.meta.dir, "../..");

function listSourceFiles(root: string): string[] {
  const absoluteRoot = resolve(repoRoot, root);
  if (!existsSync(absoluteRoot)) return [];
  const pending = [absoluteRoot];
  const files: string[] = [];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    for (const entry of readdirSync(current)) {
      const path = join(current, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        if (entry === "node_modules" || entry === "dist" || entry === ".tmp") continue;
        pending.push(path);
        continue;
      }
      if (stats.isFile() && /\.(?:ts|tsx|js)$/u.test(entry)) {
        files.push(relative(repoRoot, path));
      }
    }
  }
  return files.toSorted();
}

function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/gu)]
    .map((match) => match[1] ?? match[2])
    .filter((value): value is string => typeof value === "string");
}

// Lint A — the derivation-direction invariant proved as an import boundary
// (see docs/reference/skill-routing.md, "Derivation Direction Invariant").
// Runtime/package code must never import the navigation generator or read the
// generated view, and the generator must stay pure dev tooling.
describe("skill navigation import boundary", () => {
  test("no package imports the generator or references the generated view", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles("packages")) {
      const source = readFileSync(resolve(repoRoot, file), "utf8");
      for (const specifier of importSpecifiers(source)) {
        if (specifier.includes("generate-skill-navigation")) {
          offenders.push(`${file} imports ${specifier}`);
        }
      }
      if (/skill-navigation\.md|docs\/reference\/skill-navigation/u.test(source)) {
        offenders.push(`${file} references the generated skill-navigation view`);
      }
    }
    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  test("the navigation generator stays pure dev tooling (no @brewva import)", () => {
    const generator = readFileSync(
      resolve(repoRoot, "script/generate-skill-navigation.ts"),
      "utf8",
    );
    const brewvaImports = importSpecifiers(generator).filter((specifier) =>
      specifier.startsWith("@brewva/"),
    );
    expect(brewvaImports, brewvaImports.join("\n")).toEqual([]);
  });
});

// Lint B — parser non-absorption: parseSkillDocument must leave in-body handoff
// prose in the markdown body and never lift it into the structured SkillCard,
// so the runtime cannot reach handoff edges even by accident.
describe("skill navigation parser non-absorption", () => {
  test("handoff prose stays in the body and never enters the SkillCard", () => {
    const dir = mkdtempSync(join(tmpdir(), "brewva-nav-boundary-"));
    const path = join(dir, "SKILL.md");
    writeFileSync(
      path,
      `---
name: nav-boundary-probe
description: Probe skill for parser non-absorption.
---
# Nav Boundary Probe

Hand off to \`plan\` when the design is ready.
Escalate to \`debugging\` on guard regression.
`,
      "utf8",
    );

    const parsed = parseSkillDocument(path, "core");

    // The card carries only advisory fields; there is no handoff/next/routing field.
    expect(Object.keys(parsed.card).toSorted()).toEqual(["category", "description", "name"]);
    // The handoff prose is preserved in the body (the source of record)...
    expect(parsed.markdown).toContain("Hand off to `plan`");
    // ...but no handoff target leaks into the structured card.
    const serializedCard = JSON.stringify(parsed.card);
    expect(serializedCard).not.toContain("plan");
    expect(serializedCard).not.toContain("debugging");
  });
});
