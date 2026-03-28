import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type ResearchStatus = "proposed" | "active" | "promoted" | "archived";

const SECTION_HEADERS: Record<ResearchStatus, string> = {
  proposed: "## Proposed notes",
  active: "## Active notes",
  promoted: "## Promoted notes (status pointers)",
  archived: "## Archived / superseded notes",
};

const VALID_STATUSES = new Set<ResearchStatus>(["proposed", "active", "promoted", "archived"]);

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

    for (const fileName of readdirSync(researchDir).filter(
      (entry) => entry.endsWith(".md") && entry !== "README.md",
    )) {
      const repoRelativePath = `docs/research/${fileName}`;
      const markdown = readFileSync(resolve(researchDir, fileName), "utf-8");
      const status = readResearchStatus(markdown);

      if (!status) {
        errors.push(`${repoRelativePath} is missing a valid Status metadata line`);
        continue;
      }

      const listedStatus = listedStatusByPath.get(repoRelativePath);
      if (listedStatus !== status) {
        errors.push(
          `${repoRelativePath} has Status=${status} but README groups it as ${listedStatus ?? "<unlisted>"}`,
        );
      }
    }

    expect(errors, errors.join("\n")).toEqual([]);
  });
});
