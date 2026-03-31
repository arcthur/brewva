import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

interface MatchRecord {
  file: string;
  matches: string[];
}

interface PatternRule {
  label: string;
  regex: RegExp;
}

const INCLUDED_EXTENSIONS = new Set([".md", ".sh", ".py"]);

const LEGACY_PATTERNS: PatternRule[] = [
  { label: "legacy skills/base path", regex: /skills\/base\//g },
  { label: "legacy skills/packs path", regex: /skills\/packs\//g },
  { label: "removed brewva project super-skill path", regex: /skills\/project\/brewva-[\w-]+/g },
  { label: "legacy tier selector", regex: /\bbase\|pack\|project\b/g },
  {
    label: "removed v1 skill token",
    regex:
      /`(?:brainstorming|cartography|compose|execution|exploration|finishing|gh-issues|patching|planning|recovery|tdd|telegram-channel-behavior|telegram-interactive-components|zca-structured-output|brewva-project|brewva-self-improve|brewva-session-logs)`/g,
  },
  {
    label: "removed v1 cascade owner",
    regex:
      /->\s*(?:brainstorming|cartography|compose|execution|exploration|finishing|gh-issues|patching|planning|recovery|tdd|telegram-channel-behavior|telegram-interactive-components|zca-structured-output|brewva-project|brewva-self-improve|brewva-session-logs)\b/g,
  },
];

function repoRoot(): string {
  return resolve(import.meta.dirname, "../../..");
}

function collectSkillSourceFiles(rootDir: string, currentDir: string, files: string[]): void {
  const entries = readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    const absolutePath = join(currentDir, entry.name);
    const repoRelativePath = relative(rootDir, absolutePath);

    if (repoRelativePath.startsWith("skills/internal/")) continue;
    if (repoRelativePath === "skills/meta/skill-authoring/LICENSE.txt") continue;

    if (entry.isDirectory()) {
      collectSkillSourceFiles(rootDir, absolutePath, files);
      continue;
    }

    if (!INCLUDED_EXTENSIONS.has(extname(entry.name))) continue;
    files.push(absolutePath);
  }
}

function findLegacyMatches(rootDir: string, filePath: string): MatchRecord | null {
  const content = readFileSync(filePath, "utf8");
  const matches: string[] = [];

  for (const pattern of LEGACY_PATTERNS) {
    const hits = [...content.matchAll(pattern.regex)].map(
      (match) => `${pattern.label}: ${match[0]}`,
    );
    matches.push(...hits);
  }

  if (matches.length === 0) return null;
  return {
    file: relative(rootDir, filePath),
    matches,
  };
}

describe("skill taxonomy drift guard", () => {
  test("skill references and helper scripts do not reference removed v1 taxonomy", () => {
    const root = repoRoot();
    const files: string[] = [];
    collectSkillSourceFiles(root, resolve(root, "skills"), files);

    const findings = files
      .map((filePath) => findLegacyMatches(root, filePath))
      .filter((entry): entry is MatchRecord => entry !== null);

    const details = findings
      .map((entry) => `${entry.file}\n  - ${entry.matches.join("\n  - ")}`)
      .join("\n");

    expect(details).toBe("");
  });
});
