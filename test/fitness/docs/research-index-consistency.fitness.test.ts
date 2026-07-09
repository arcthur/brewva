import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

type IncubationStatus = "active" | "archived";

const FORBIDDEN_DECISION_HEADINGS = [
  "## Surface Budget",
  "## Validation Status",
  "## Promoted Contract Checklist",
  "## Closed Posture",
] as const;

const FORBIDDEN_DECISION_PHRASES = [
  "promoted status pointer",
  "promoted pointer",
  "status pointer",
  "the promoted decision is:",
] as const;

const FORBIDDEN_DECISION_BOILERPLATE = [
  "The accepted contract is implemented in code and stable docs; this record preserves the decision provenance without duplicating the full specification.",
  "Future changes should update the stable docs and open a new active note when the decision changes materially.",
  "This record is not a second normative contract or a long-form RFC.",
  "It does not preserve deprecated validation tables, surface budgets, or implementation checklists.",
] as const;

const FORBIDDEN_ACTIVE_LIFECYCLE_PHRASES = ["promoted status pointer", "promoted pointer"] as const;

const INCOMPLETE_TRAILING_STOP_WORDS = [
  "a",
  "an",
  "the",
  "to",
  "of",
  "in",
  "on",
  "at",
  "by",
  "for",
  "with",
  "from",
  "into",
  "onto",
  "upon",
  "over",
  "under",
  "as",
  "about",
  "against",
  "between",
  "among",
  "through",
  "during",
  "before",
  "after",
  "since",
  "until",
  "via",
  "per",
  "and",
  "or",
  "but",
  "nor",
  "yet",
  "so",
  "because",
  "although",
  "though",
  "while",
  "whereas",
  "whether",
  "if",
  "unless",
  "that",
  "which",
  "not",
  "no",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "am",
  "do",
  "does",
  "did",
  "has",
  "have",
  "had",
  "can",
  "could",
  "should",
  "would",
  "may",
  "might",
  "must",
  "will",
  "shall",
  "this",
  "these",
  "those",
  "its",
  "their",
  "our",
  "your",
  "my",
  "his",
  "her",
] as const;

const INCOMPLETE_TRAILING_PATTERN = new RegExp(
  `(?:[,;]|\\b(?:${INCOMPLETE_TRAILING_STOP_WORDS.join("|")}))\\s*$`,
  "i",
);

function readMetadataLine(markdown: string, label: string): string | null {
  const match = markdown.match(new RegExp(`^- ${label}:\\s+(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
}

function readHeadingSection(markdown: string, heading: string): string | null {
  const escapedHeading = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const startMatch = new RegExp(`^## ${escapedHeading}\\s*$`, "m").exec(markdown);
  if (!startMatch) return null;

  const sectionStart = startMatch.index + startMatch[0].length;
  const rest = markdown.slice(sectionStart);
  const nextHeading = /^## /m.exec(rest);
  return (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();
}

function readDecisionSummaryBullets(markdown: string): string[] {
  const section = readHeadingSection(markdown, "Decision Summary");
  if (!section) return [];

  const bullets: string[] = [];
  let current: string | null = null;
  for (const rawLine of section.split("\n")) {
    const line = rawLine.trimEnd();
    const bulletMatch = /^- (.+)$/.exec(line);
    if (bulletMatch) {
      if (current) {
        bullets.push(current.trim().replace(/\s+/g, " "));
      }
      current = bulletMatch[1] ?? "";
      continue;
    }
    if (!current) continue;
    const continuation = line.trim();
    if (continuation) {
      current += ` ${continuation}`;
    }
  }

  if (current) {
    bullets.push(current.trim().replace(/\s+/g, " "));
  }
  return bullets;
}

function readIncubationStatus(markdown: string): IncubationStatus | null {
  const value = readMetadataLine(markdown, "Status")?.replaceAll("`", "");
  if (value === "active" || value === "archived") return value;
  return null;
}

function readPromotionTargets(markdown: string): string[] {
  const sectionMatch = markdown.match(/^- Promotion target:\s*\n((?:  - `[^`]+`\n?)+)/m);
  if (!sectionMatch?.[1]) {
    return [];
  }
  return [...sectionMatch[1].matchAll(/^  - `([^`]+)`$/gm)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  );
}

function listMarkdownFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((entry) => entry.endsWith(".md") && entry !== "README.md")
    .toSorted((left, right) => left.localeCompare(right));
}

function parseDirectoryReadmeLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\]\(\.\/([^)]+\.md)\)/g)]
    .flatMap((match) => (match[1] ? [match[1]] : []))
    .toSorted((left, right) => left.localeCompare(right));
}

function walkMarkdownFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkMarkdownFiles(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("docs/research index consistency", () => {
  it("keeps active, decision, and archive indexes aligned with note metadata", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const researchDir = resolve(repoRoot, "docs/research");
    const errors: string[] = [];

    const rootReadme = readFileSync(resolve(researchDir, "README.md"), "utf-8");
    for (const requiredPath of [
      "docs/research/active/README.md",
      "docs/research/decisions/README.md",
      "docs/research/archive/README.md",
    ]) {
      if (!rootReadme.includes(requiredPath)) {
        errors.push(`docs/research/README.md does not link ${requiredPath}`);
      }
    }

    if (existsSync(resolve(researchDir, "promoted"))) {
      errors.push("docs/research/promoted/ must not exist");
    }

    for (const directory of ["active", "decisions", "archive"] as const) {
      const directoryReadmePath = resolve(researchDir, directory, "README.md");
      const directoryReadmeMarkdown = readFileSync(directoryReadmePath, "utf-8");
      const linkedFiles = new Set(parseDirectoryReadmeLinks(directoryReadmeMarkdown));
      const actualFiles = listMarkdownFiles(resolve(researchDir, directory));

      for (const fileName of actualFiles) {
        if (!linkedFiles.has(fileName)) {
          errors.push(`docs/research/${directory}/README.md does not list ${fileName}`);
        }
      }
    }

    for (const directory of ["active", "archive"] as const) {
      const expectedStatus: IncubationStatus = directory === "active" ? "active" : "archived";
      for (const fileName of listMarkdownFiles(resolve(researchDir, directory))) {
        const repoRelativePath = `docs/research/${directory}/${fileName}`;
        const markdown = readFileSync(resolve(repoRoot, repoRelativePath), "utf-8");
        const status = readIncubationStatus(markdown);
        const owner = readMetadataLine(markdown, "Owner");
        const lastReviewed = readMetadataLine(markdown, "Last reviewed");
        const promotionTargets = readPromotionTargets(markdown);

        if (status !== expectedStatus) {
          errors.push(`${repoRelativePath} has Status=${status ?? "<missing>"}`);
        }
        if (!owner) {
          errors.push(`${repoRelativePath} is missing an Owner metadata line`);
        }
        if (!lastReviewed) {
          errors.push(`${repoRelativePath} is missing a Last reviewed metadata line`);
        }
        if (promotionTargets.length === 0) {
          errors.push(`${repoRelativePath} is missing at least one Promotion target entry`);
        }
        if (directory === "active") {
          const normalized = markdown.toLowerCase();
          for (const phrase of FORBIDDEN_ACTIVE_LIFECYCLE_PHRASES) {
            if (normalized.includes(phrase)) {
              errors.push(`${repoRelativePath} still references removed lifecycle: ${phrase}`);
            }
          }
        }
      }
    }

    for (const fileName of listMarkdownFiles(resolve(researchDir, "decisions"))) {
      const repoRelativePath = `docs/research/decisions/${fileName}`;
      const markdown = readFileSync(resolve(repoRoot, repoRelativePath), "utf-8");

      for (const requiredLine of [
        "- Decision:",
        "- Date:",
        "- Status: accepted",
        "- Stable docs:",
        "- Code anchors:",
      ]) {
        if (!markdown.includes(requiredLine)) {
          errors.push(`${repoRelativePath} is missing ${requiredLine}`);
        }
      }

      const decisionValue = readMetadataLine(markdown, "Decision");
      if (decisionValue && INCOMPLETE_TRAILING_PATTERN.test(decisionValue)) {
        errors.push(`${repoRelativePath} has a truncated Decision metadata line`);
      }

      const summaryBullets = readDecisionSummaryBullets(markdown);
      if (summaryBullets.length === 0) {
        errors.push(`${repoRelativePath} is missing Decision Summary bullets`);
      }
      for (const bullet of summaryBullets) {
        if (INCOMPLETE_TRAILING_PATTERN.test(bullet)) {
          errors.push(`${repoRelativePath} has a truncated Decision Summary bullet: ${bullet}`);
        }
      }

      for (const heading of FORBIDDEN_DECISION_HEADINGS) {
        if (markdown.includes(heading)) {
          errors.push(`${repoRelativePath} must not contain ${heading}`);
        }
      }
      for (const boilerplate of FORBIDDEN_DECISION_BOILERPLATE) {
        if (markdown.includes(boilerplate)) {
          errors.push(`${repoRelativePath} repeats generic decision boilerplate`);
        }
      }
      const normalized = markdown.toLowerCase();
      for (const phrase of FORBIDDEN_DECISION_PHRASES) {
        if (normalized.includes(phrase)) {
          errors.push(`${repoRelativePath} still contains migration placeholder: ${phrase}`);
        }
      }
      if (/^- - /m.test(markdown)) {
        errors.push(`${repoRelativePath} contains a malformed migrated bullet`);
      }
    }

    for (const markdownPath of walkMarkdownFiles(resolve(repoRoot, "docs"))) {
      const markdown = readFileSync(markdownPath, "utf-8");
      if (markdown.includes("docs/research/promoted/") || markdown.includes("Status: `promoted`")) {
        errors.push(`${relative(repoRoot, markdownPath)} still references promoted research state`);
      }
    }

    expect(errors, errors.join("\n")).toEqual([]);
  });
});
