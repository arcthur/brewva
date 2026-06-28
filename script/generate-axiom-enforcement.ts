import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Tier-1 derived view generator for axiom enforcement.
//
// The design axioms (docs/architecture/design-axioms.md) plus the `(axiom N)`
// source tags in the project rule docs are the source of record (see
// design-axioms.md, axiom 18, "Descriptive metadata derives views, never
// authority", and docs/reference/skill-navigation.md for the same derivation
// discipline). This script parses those tags and emits an axiom -> enforcing-rule
// view. It is build-time tooling only: runtime packages must never import this
// script or read the generated view. Referential integrity is enforced
// fail-closed; an axiom with no enforcing rule is surfaced as negative space
// rather than hidden.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const AXIOMS_DOC = "docs/architecture/design-axioms.md";
const RULE_DOCS = [
  "skills/project/shared/critical-rules.md",
  "skills/project/shared/anti-patterns.md",
] as const;
const DECISIONS_DIR = "docs/research/decisions";
const OUT_DOC = "docs/reference/axiom-enforcement.md";
const BLOCK_NAME = "axiom-enforcement";

interface Axiom {
  readonly number: number;
  readonly statement: string;
}

interface EnforcingRule {
  readonly axiom: number;
  readonly source: string;
  readonly text: string;
}

interface Precedent {
  readonly axiom: number;
  readonly decision: string;
}

function readDoc(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf-8").replace(/\r\n?/g, "\n");
}

// Body of a `## Heading` section: everything up to the next `## ` heading.
function sectionBody(markdown: string, heading: string): string | null {
  const start = new RegExp(`^${heading}\\s*$`, "m").exec(markdown);
  if (!start) return null;
  const rest = markdown.slice(start.index + start[0].length);
  const next = /^##\s/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

function parseAxioms(): Axiom[] {
  const body = sectionBody(readDoc(AXIOMS_DOC), "## Axioms");
  if (!body) {
    throw new Error(`Missing "## Axioms" section in ${AXIOMS_DOC}`);
  }
  const axioms: Axiom[] = [];
  for (const match of body.matchAll(/^(\d+)\.\s+`([^`]+)`/gm)) {
    axioms.push({ number: Number(match[1]), statement: match[2] ?? "" });
  }
  return axioms.toSorted((left, right) => left.number - right.number);
}

// A bullet is a top-level "- " line plus its indented continuation lines.
function parseBullets(markdown: string): string[] {
  const bullets: string[] = [];
  let current: string | null = null;
  const flush = (): void => {
    if (current !== null) bullets.push(current.replace(/\s+/g, " ").trim());
    current = null;
  };
  for (const line of markdown.split("\n")) {
    if (line.startsWith("- ")) {
      flush();
      current = line.slice(2);
    } else if (current !== null && /^\s+\S/.test(line)) {
      current += ` ${line.trim()}`;
    } else {
      flush();
    }
  }
  flush();
  return bullets;
}

function parseEnforcingRules(): EnforcingRule[] {
  const rules: EnforcingRule[] = [];
  for (const doc of RULE_DOCS) {
    const source = basename(doc);
    for (const bullet of parseBullets(readDoc(doc))) {
      const axioms = [...bullet.matchAll(/\(axiom (\d+)\)/g)].map((match) => Number(match[1]));
      if (axioms.length === 0) continue;
      const text = bullet.replace(/\s*\(axiom \d+\)/g, "").trim();
      for (const axiom of axioms) {
        rules.push({ axiom, source, text });
      }
    }
  }
  return rules;
}

function parsePrecedents(): Precedent[] {
  const dir = resolve(repoRoot, DECISIONS_DIR);
  const precedents: Precedent[] = [];
  for (const file of readdirSync(dir).toSorted((left, right) => left.localeCompare(right))) {
    if (!file.endsWith(".md") || file === "README.md") continue;
    const body = sectionBody(readDoc(`${DECISIONS_DIR}/${file}`), "## Axioms");
    if (!body) continue;
    const cited = new Set<number>();
    // The decision `## Axioms` convention writes one citation per bullet:
    // `- Obeys|Defers|Overrides|Introduces axiom N (Name): ...`. Anchor on that
    // verb so a stray "axiom" in surrounding prose cannot mint a spurious
    // precedent link.
    for (const line of body.split("\n")) {
      if (!/^\s*-\s+(?:Obeys|Defers|Overrides|Introduces)\b/u.test(line)) continue;
      for (const match of line.matchAll(/\baxioms?\s+(\d+)/gi)) {
        cited.add(Number(match[1]));
      }
    }
    for (const axiom of cited) {
      precedents.push({ axiom, decision: file.replace(/\.md$/, "") });
    }
  }
  return precedents;
}

function validate(
  axioms: readonly Axiom[],
  rules: readonly EnforcingRule[],
  precedents: readonly Precedent[],
): string[] {
  const errors: string[] = [];
  if (axioms.length === 0) {
    return [`No axioms parsed from ${AXIOMS_DOC}`];
  }
  axioms.forEach((axiom, index) => {
    if (axiom.number !== index + 1) {
      errors.push(
        `Axiom numbering gap in ${AXIOMS_DOC}: expected ${index + 1}, found ${axiom.number}`,
      );
    }
  });
  const known = new Set(axioms.map((axiom) => axiom.number));
  for (const rule of rules) {
    if (!known.has(rule.axiom)) {
      errors.push(
        `${rule.source}: rule tags unknown axiom ${rule.axiom} (1..${axioms.length}): ${rule.text}`,
      );
    }
  }
  for (const precedent of precedents) {
    if (!known.has(precedent.axiom)) {
      errors.push(
        `${precedent.decision}: decision cites unknown axiom ${precedent.axiom} (1..${axioms.length})`,
      );
    }
  }
  return errors;
}

function render(
  axioms: readonly Axiom[],
  rules: readonly EnforcingRule[],
  precedents: readonly Precedent[],
): string {
  const rulesByAxiom = new Map<number, EnforcingRule[]>();
  for (const rule of rules) {
    rulesByAxiom.set(rule.axiom, [...(rulesByAxiom.get(rule.axiom) ?? []), rule]);
  }
  const precedentsByAxiom = new Map<number, string[]>();
  for (const precedent of precedents) {
    const list = precedentsByAxiom.get(precedent.axiom) ?? [];
    if (!list.includes(precedent.decision)) {
      precedentsByAxiom.set(precedent.axiom, [...list, precedent.decision]);
    }
  }

  const negativeSpace = axioms.filter(
    (axiom) => (rulesByAxiom.get(axiom.number) ?? []).length === 0,
  );

  const lines: string[] = [
    "> Generated by `bun run docs:axiom-enforcement`. Do not edit this block by hand.",
    "",
    `Axioms: ${axioms.length}. Tagged rules: ${rules.length}. Axioms with no enforcing rule (negative space): ${negativeSpace.length}.`,
    "",
  ];

  for (const axiom of axioms) {
    const enforcing = (rulesByAxiom.get(axiom.number) ?? []).toSorted(
      (left, right) =>
        left.source.localeCompare(right.source) || left.text.localeCompare(right.text),
    );
    const cited = (precedentsByAxiom.get(axiom.number) ?? []).toSorted((left, right) =>
      left.localeCompare(right),
    );

    lines.push(`### Axiom ${axiom.number} — \`${axiom.statement}\``, "");
    if (enforcing.length > 0) {
      lines.push("Enforced by:", "");
      for (const rule of enforcing) {
        lines.push(`- \`${rule.source}\` — ${rule.text}`);
      }
      lines.push("");
    } else {
      lines.push("Enforced by: _no tagged rule — negative space._", "");
    }
    lines.push(
      cited.length > 0
        ? `Precedent decisions: ${cited.map((slug) => `\`${slug}\``).join(", ")}`
        : "Precedent decisions: _none._",
      "",
    );
  }

  return lines.join("\n").trimEnd();
}

function replaceGeneratedBlock(markdown: string, content: string): string {
  const startMarker = `<!-- generated:${BLOCK_NAME} start -->`;
  const endMarker = `<!-- generated:${BLOCK_NAME} end -->`;
  const start = markdown.indexOf(startMarker);
  const end = markdown.indexOf(endMarker);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`Missing generated markers for ${BLOCK_NAME} in ${OUT_DOC}`);
  }
  const before = markdown.slice(0, start + startMarker.length);
  const after = markdown.slice(end);
  // Symmetric blank lines around the block: oxfmt requires the closing HTML
  // comment to be its own block, separated from the trailing paragraph.
  return `${before}\n\n${content}\n\n${after}`;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      write: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
    },
  });
  if (values.write === values.check) {
    throw new Error("Use exactly one mode: --write or --check.");
  }

  const axioms = parseAxioms();
  const rules = parseEnforcingRules();
  const precedents = parsePrecedents();

  const errors = validate(axioms, rules, precedents);
  if (errors.length > 0) {
    console.error(
      ["Axiom enforcement view is invalid:", ...errors.map((line) => `- ${line}`)].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  const docPath = resolve(repoRoot, OUT_DOC);
  const markdown = readFileSync(docPath, "utf-8");
  const next = replaceGeneratedBlock(markdown, render(axioms, rules, precedents));
  const changed = next !== markdown;

  if (values.check && changed) {
    console.error(
      "Generated axiom enforcement view is stale. Run `bun run docs:axiom-enforcement`.",
    );
    process.exitCode = 1;
    return;
  }
  if (values.write) {
    if (changed) {
      writeFileSync(docPath, next);
      console.log("Updated generated axiom enforcement view.");
    } else {
      console.log("Generated axiom enforcement view is already up to date.");
    }
  }
}

main();
