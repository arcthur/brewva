import { describe, expect, it } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { scoreDocumentsByTfIdf } from "@brewva/brewva-search";
import { parseSkillDocument } from "@brewva/brewva-vocabulary/session";
import type { SkillCategory } from "@brewva/brewva-vocabulary/session";

// Trigger-quality sets for the pilot skills (RFC skill-discipline-calibration
// Phase 1): the description/when_to_use pair is the activation surface, so its
// retrieval quality is measured, not assumed. Each pilot carries
// should-trigger queries (a real task phrasing must surface the skill) and
// should-not-trigger queries (a task belonging to another skill must rank that
// skill above the pilot). Scoring reuses the exact discover_skills text shape
// and TF-IDF ranking, so a description edit that degrades discovery fails
// here before it ships.

const PROMPT_VISIBLE_CATEGORIES = ["core", "domain", "operator"] as const;
const SHOULD_TRIGGER_TOP_K = 5;

interface TriggerCase {
  readonly query: string;
}

interface ShouldNotTriggerCase {
  readonly query: string;
  /** The skill that actually owns this task and must outrank the pilot. */
  readonly expectedInstead: string;
}

interface PilotTriggerSet {
  readonly skill: string;
  readonly shouldTrigger: readonly TriggerCase[];
  readonly shouldNotTrigger: readonly ShouldNotTriggerCase[];
}

const PILOT_TRIGGER_SETS: readonly PilotTriggerSet[] = [
  {
    skill: "debugging",
    shouldTrigger: [
      { query: "tests fail after my last change and I do not know the root cause" },
      { query: "intermittent runtime crash I cannot reproduce locally" },
      { query: "a regression appeared after recent commits, investigate before patching" },
      { query: "rank hypotheses and confirm the root cause of this failing behavior" },
    ],
    shouldNotTrigger: [
      {
        query: "review this diff for merge readiness and regression risk",
        expectedInstead: "review",
      },
      {
        query: "find repository precedents and prior failure patterns before planning",
        expectedInstead: "learning-research",
      },
    ],
  },
  {
    skill: "review",
    shouldTrigger: [
      { query: "review this diff for merge readiness" },
      { query: "is this change plan safe to merge, assess regression and compatibility risk" },
      { query: "freshly generated code passed verification and needs an adversarial read" },
      { query: "findings-first risk review with a merge decision" },
    ],
    shouldNotTrigger: [
      {
        query: "reproduce this failing test and confirm the root cause before patching",
        expectedInstead: "debugging",
      },
    ],
  },
  {
    skill: "learning-research",
    shouldTrigger: [
      { query: "have we solved this failure class before in this repository" },
      { query: "retrieve repository precedents before non-trivial planning" },
      { query: "prior failure patterns and preventive guidance for this migration" },
    ],
    shouldNotTrigger: [
      {
        query: "confirm the root cause of this failing test before patching",
        expectedInstead: "debugging",
      },
    ],
  },
];

function collectCatalogDocuments(): Array<{ id: string; text: string }> {
  const repoRoot = resolve(import.meta.dirname, "../../..");
  const documents: Array<{ id: string; text: string }> = [];
  for (const category of PROMPT_VISIBLE_CATEGORIES) {
    const categoryDir = join(repoRoot, "skills", category);
    let entries: Array<import("node:fs").Dirent>;
    try {
      entries = readdirSync(categoryDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const filePath = join(categoryDir, entry.name, "SKILL.md");
      try {
        if (!statSync(filePath).isFile()) continue;
      } catch {
        continue;
      }
      const parsed = parseSkillDocument(filePath, category as SkillCategory);
      // Mirror discover_skills' renderSkillSearchText: name, category,
      // description, when_to_use, filePath.
      const text = [
        parsed.name,
        parsed.category,
        parsed.description,
        parsed.card.selection?.whenToUse ?? null,
        parsed.filePath,
      ]
        .filter((value): value is string => Boolean(value))
        .join("\n");
      documents.push({ id: parsed.name, text });
    }
  }
  return documents;
}

function rankedSkillNames(query: string, documents: Array<{ id: string; text: string }>): string[] {
  return scoreDocumentsByTfIdf(query, documents, { limit: documents.length }).map(
    (entry) => entry.document.id,
  );
}

describe("pilot skill trigger quality", () => {
  const documents = collectCatalogDocuments();

  it("indexes every prompt-visible pilot skill", () => {
    const ids = new Set(documents.map((document) => document.id));
    for (const set of PILOT_TRIGGER_SETS) {
      expect(ids.has(set.skill), `catalog must contain '${set.skill}'`).toBe(true);
    }
  });

  for (const set of PILOT_TRIGGER_SETS) {
    it(`surfaces ${set.skill} for its should-trigger queries`, () => {
      for (const testCase of set.shouldTrigger) {
        const ranked = rankedSkillNames(testCase.query, documents);
        const rank = ranked.indexOf(set.skill);
        expect(
          rank >= 0 && rank < SHOULD_TRIGGER_TOP_K,
          `'${set.skill}' must rank in the top ${SHOULD_TRIGGER_TOP_K} for "${testCase.query}" ` +
            `(got rank ${rank < 0 ? "unranked" : rank + 1}; top: ${ranked.slice(0, SHOULD_TRIGGER_TOP_K).join(", ")})`,
        ).toBe(true);
      }
    });

    it(`does not outrank the owning skill on ${set.skill}'s should-not-trigger queries`, () => {
      for (const testCase of set.shouldNotTrigger) {
        const ranked = rankedSkillNames(testCase.query, documents);
        const pilotRank = ranked.indexOf(set.skill);
        const ownerRank = ranked.indexOf(testCase.expectedInstead);
        expect(
          ownerRank >= 0,
          `'${testCase.expectedInstead}' must rank for "${testCase.query}"`,
        ).toBe(true);
        const pilotEffectiveRank = pilotRank < 0 ? Number.POSITIVE_INFINITY : pilotRank;
        expect(
          ownerRank < pilotEffectiveRank,
          `'${testCase.expectedInstead}' must outrank '${set.skill}' for "${testCase.query}" ` +
            `(owner rank ${ownerRank + 1}, pilot rank ${pilotRank < 0 ? "unranked" : pilotRank + 1})`,
        ).toBe(true);
      }
    });
  }
});
