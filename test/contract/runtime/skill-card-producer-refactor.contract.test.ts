import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillDocument } from "@brewva/brewva-vocabulary/session";

function tempFile(name: string, content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "brewva-skill-card-"));
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

describe("SkillCard cutover", () => {
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

  test("rejects removed SkillCard selection trigger metadata", () => {
    const path = tempFile(
      "SKILL.md",
      `---
name: legacy-trigger
description: Legacy trigger skill.
selection:
  triggers:
    - advisory
---
# Legacy Trigger
`,
    );

    expect(() => parseSkillDocument(path, "core")).toThrow(
      /field 'selection\.triggers' has been removed/,
    );
  });

  test("accepts a minimal advisory SkillCard", () => {
    const path = tempFile(
      "SKILL.md",
      `---
name: advisory
description: Advisory only.
selection:
  when_to_use: Use when advisory context is relevant.
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
        pathGlobs: ["docs/**"],
      },
    });
    expect(parsed.resources.references).toEqual(["references/example.md"]);
  });

  test("parses SkillCard frontmatter through the shared markdown parser", () => {
    const path = tempFile(
      "SKILL.md",
      "\uFEFF---\r\nname: bom-crlf\r\ndescription: Shared parser skill.\r\n---\r\n# Shared Parser\r\n",
    );

    const parsed = parseSkillDocument(path, "core");

    expect(parsed.card.name).toBe("bom-crlf");
    expect(parsed.card.description).toBe("Shared parser skill.");
    expect(parsed.markdown).toBe("# Shared Parser\n");
  });
});
