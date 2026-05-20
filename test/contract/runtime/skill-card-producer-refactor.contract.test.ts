import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getProducerOutputContracts,
  listProducerOutputs,
  parseProducerContractFile,
  parseSkillDocument,
} from "@brewva/brewva-runtime/protocol";

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "brewva-skill-card-"));
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

describe("SkillCard and ProducerContract cutover", () => {
  test("rejects removed authority fields in SkillCard frontmatter", () => {
    const path = tempFile(
      "SKILL.md",
      `---
name: legacy
description: Legacy skill.
intent:
  outputs:
    - report
---
# Legacy
`,
    );

    expect(() => parseSkillDocument(path, "core")).toThrow(/field 'intent' has been removed/);
  });

  test("accepts a minimal advisory SkillCard", () => {
    const path = tempFile(
      "SKILL.md",
      `---
name: advisory
description: Advisory only.
selection:
  when_to_use: Use when advisory context is relevant.
  triggers:
    - advisory
  path_globs:
    - docs/**
references:
  - references/example.md
---
# Advisory
`,
    );

    const parsed = parseSkillDocument(path, "core");

    expect(parsed.card).toEqual({
      name: "advisory",
      category: "core",
      description: "Advisory only.",
      selection: {
        whenToUse: "Use when advisory context is relevant.",
        triggers: ["advisory"],
        pathGlobs: ["docs/**"],
      },
    });
    expect(parsed.resources.references).toEqual(["references/example.md"]);
  });

  test("parses producer contracts independently from SkillCard", () => {
    const path = tempFile(
      "producer.yaml",
      `producer: review
outputs:
  - root_cause
output_contracts:
  root_cause:
    kind: text
    min_words: 20
`,
    );

    const producer = parseProducerContractFile(path, {
      rootDir: "/tmp/root",
      skillDir: "/tmp/root/skills",
      source: "system_root",
    });

    expect(listProducerOutputs(producer)).toEqual(["root_cause"]);
    expect(getProducerOutputContracts(producer)).toEqual({
      root_cause: {
        kind: "text",
        minWords: 20,
      },
    });
  });
});
