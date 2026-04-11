import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

type ResearchStatus = "proposed" | "active" | "promoted" | "archived";

const SECTION_HEADERS: Record<ResearchStatus, string> = {
  proposed: "## Proposed notes",
  active: "## Active notes",
  promoted: "## Promoted notes (status pointers)",
  archived: "## Archived / superseded notes",
};

const VALID_STATUSES = new Set<ResearchStatus>(["proposed", "active", "promoted", "archived"]);
const ROOT_INDEXED_STATUSES = new Set<ResearchStatus>(["proposed", "active"]);

function parseReadmeLists(markdown: string): Record<ResearchStatus, string[]> {
  const lists: Record<ResearchStatus, string[]> = {
    proposed: [],
    active: [],
    promoted: [],
    archived: [],
  };

  let currentSection: ResearchStatus | null = null;

  for (const line of markdown.split("\n")) {
    const matchedSection = (
      Object.entries(SECTION_HEADERS) as Array<[ResearchStatus, string]>
    ).find(([, header]) => line === header);
    if (matchedSection) {
      currentSection = matchedSection[0];
      continue;
    }

    if (line.startsWith("## ")) {
      currentSection = null;
      continue;
    }

    if (!currentSection) continue;

    const match = line.match(/^- `([^`]+)`$/);
    if (!match?.[1]) continue;
    lists[currentSection].push(match[1]);
  }

  return lists;
}

function readResearchStatus(markdown: string): ResearchStatus | null {
  const match = markdown.match(/^- Status: `([^`]+)`/m);
  const value = match?.[1];
  return value && VALID_STATUSES.has(value as ResearchStatus) ? (value as ResearchStatus) : null;
}

function readMetadataLine(markdown: string, label: string): string | null {
  const match = markdown.match(new RegExp(`^- ${label}:\\s+(.+)$`, "m"));
  return match?.[1]?.trim() ?? null;
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

function listResearchNotePaths(researchDir: string): string[] {
  const directories = ["active", "promoted", "archive"];
  const files: string[] = [];

  for (const directory of directories) {
    const absoluteDir = resolve(researchDir, directory);
    for (const fileName of readdirSync(absoluteDir).filter(
      (entry) => entry.endsWith(".md") && entry !== "README.md",
    )) {
      files.push(relative(resolve(researchDir, "..", ".."), resolve(absoluteDir, fileName)));
    }
  }

  return files.toSorted((left, right) => left.localeCompare(right));
}

function parseDirectoryReadmeLinks(markdown: string): string[] {
  return [...markdown.matchAll(/\]\(\.\/([^)]+\.md)\)/g)]
    .flatMap((match) => (match[1] ? [match[1]] : []))
    .toSorted((left, right) => left.localeCompare(right));
}

describe("docs/research index consistency", () => {
  it("keeps README sections aligned with research note status metadata", () => {
    const repoRoot = resolve(import.meta.dirname, "../../..");
    const researchDir = resolve(repoRoot, "docs/research");
    const readmePath = resolve(researchDir, "README.md");
    const readmeMarkdown = readFileSync(readmePath, "utf-8");
    const readmeLists = parseReadmeLists(readmeMarkdown);
    const errors: string[] = [];
    const listedStatusByPath = new Map<string, ResearchStatus>();

    for (const [status, header] of Object.entries(SECTION_HEADERS) as Array<
      [ResearchStatus, string]
    >) {
      if (!readmeMarkdown.includes(header)) {
        errors.push(`docs/research/README.md is missing section "${header}"`);
      }

      for (const relativePath of readmeLists[status]) {
        const resolvedPath = resolve(repoRoot, relativePath);

        if (!existsSync(resolvedPath)) {
          errors.push(`docs/research/README.md lists missing file ${relativePath}`);
          continue;
        }

        const previousStatus = listedStatusByPath.get(relativePath);
        if (previousStatus) {
          errors.push(
            `${relativePath} is listed in both "${previousStatus}" and "${status}" sections of docs/research/README.md`,
          );
          continue;
        }
        listedStatusByPath.set(relativePath, status);

        const actualStatus = readResearchStatus(readFileSync(resolvedPath, "utf-8"));
        if (actualStatus !== status) {
          errors.push(
            `${relativePath} has Status=${actualStatus ?? "<missing>"} but is listed under ${status}`,
          );
        }
      }
    }

    for (const repoRelativePath of listResearchNotePaths(researchDir)) {
      const markdown = readFileSync(resolve(repoRoot, repoRelativePath), "utf-8");
      const status = readResearchStatus(markdown);
      const owner = readMetadataLine(markdown, "Owner");
      const lastReviewed = readMetadataLine(markdown, "Last reviewed");
      const promotionTargets = readPromotionTargets(markdown);

      if (!status) {
        errors.push(`${repoRelativePath} is missing a valid Status metadata line`);
        continue;
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

      const listedStatus = listedStatusByPath.get(repoRelativePath);
      if (ROOT_INDEXED_STATUSES.has(status) && listedStatus !== status) {
        errors.push(
          `${repoRelativePath} has Status=${status} but README groups it as ${listedStatus ?? "<unlisted>"}`,
        );
      }
    }

    for (const directory of ["active", "promoted", "archive"] as const) {
      const directoryReadmePath = resolve(researchDir, directory, "README.md");
      const directoryReadmeMarkdown = readFileSync(directoryReadmePath, "utf-8");
      const linkedFiles = new Set(parseDirectoryReadmeLinks(directoryReadmeMarkdown));
      const actualFiles = readdirSync(resolve(researchDir, directory))
        .filter((entry) => entry.endsWith(".md") && entry !== "README.md")
        .toSorted((left, right) => left.localeCompare(right));

      for (const fileName of actualFiles) {
        if (!linkedFiles.has(fileName)) {
          errors.push(`docs/research/${directory}/README.md does not list ${fileName}`);
        }
      }
    }

    expect(errors, errors.join("\n")).toEqual([]);
  });
});
