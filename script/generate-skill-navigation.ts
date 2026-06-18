import type { Dirent } from "node:fs";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// Tier-1 derived view generator for the cross-skill handoff graph.
//
// Skill bodies are the source of record (see docs/reference/skill-routing.md,
// "Derivation Direction Invariant"). This script parses handoff prose out of
// each SKILL.md body and emits an aggregate navigation view. It is build-time
// tooling only: runtime packages must never import this script or read the
// generated view — it is kept out of the runtime by the import-boundary fitness
// lint. Referential integrity is enforced fail-closed; cycles are legitimate
// (two skills may hand off to each other under different conditions) and are
// surfaced explicitly rather than rejected.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const HANDOFF_VERBS = ["escalate to", "hand off to", "route to"] as const;

// Authoritative skill universe: the same tier set the doc inventory enumerates.
// `project/overlays` re-declares core/operator skills as project specializations,
// so a logical skill name may be backed by more than one SKILL.md.
const SKILL_TIERS = ["core", "domain", "operator", "meta", "project/overlays"] as const;

const NAV_DOC_PATH = "docs/reference/skill-navigation.md";
const NAV_BLOCK_NAME = "skill-navigation";

// Case-insensitive over the whole body: handoff verbs are natural prose, often
// sentence-initial ("Hand off to ...", "Route to ..."), and a verb may soft-wrap
// before its backticked target. The "hand off" / "handoff" spelling is accepted
// either way. The verb is not captured — only the target skill name (group 1).
const VERB_ALTERNATION = HANDOFF_VERBS.map((verb) => verb.replace("hand off", "hand ?off")).join(
  "|",
);
const HANDOFF_PATTERN = new RegExp(`\\b(?:${VERB_ALTERNATION})\\s+\`([a-z][a-z0-9-]*)\``, "gi");

interface SkillSource {
  readonly name: string;
  readonly path: string;
}

interface HandoffEdge {
  readonly from: string;
  readonly to: string;
  readonly sourcePath: string;
  readonly line: number;
}

function discoverSkillSources(): SkillSource[] {
  const skillsRoot = resolve(repoRoot, "skills");
  const sources: SkillSource[] = [];
  for (const tier of SKILL_TIERS) {
    const tierDir = join(skillsRoot, tier);
    let entries: Dirent[];
    try {
      entries = readdirSync(tierDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillPath = join(tierDir, entry.name, "SKILL.md");
      try {
        if (statSync(skillPath).isFile()) {
          sources.push({ name: entry.name, path: skillPath });
        }
      } catch {
        // Not a skill folder; ignore.
      }
    }
  }
  return sources.toSorted((left, right) => left.path.localeCompare(right.path));
}

function frontmatterEndIndex(lines: readonly string[]): number {
  if (lines[0]?.trim() !== "---") return 0;
  for (let index = 1; index < lines.length; index++) {
    if (lines[index]?.trim() === "---") return index + 1;
  }
  return 0;
}

function extractHandoffEdges(source: SkillSource): HandoffEdge[] {
  const lines = readFileSync(source.path, "utf-8").replace(/\r\n?/g, "\n").split("\n");
  const bodyStart = frontmatterEndIndex(lines);
  const body = lines.slice(bodyStart).join("\n");
  const edges: HandoffEdge[] = [];
  for (const match of body.matchAll(HANDOFF_PATTERN)) {
    const offset = match.index ?? 0;
    const lineWithinBody = body.slice(0, offset).split("\n").length;
    edges.push({
      from: source.name,
      to: match[1] ?? "",
      sourcePath: source.path,
      line: bodyStart + lineWithinBody,
    });
  }
  return edges;
}

function dedupeEdges(edges: readonly HandoffEdge[]): HandoffEdge[] {
  const byKey = new Map<string, HandoffEdge>();
  for (const edge of edges) {
    const key = `${edge.from}\t${edge.to}`;
    if (!byKey.has(key)) byKey.set(key, edge);
  }
  return [...byKey.values()];
}

function validateEdges(edges: readonly HandoffEdge[], skillNames: ReadonlySet<string>): string[] {
  const errors: string[] = [];
  for (const edge of edges) {
    const where = `${relative(repoRoot, edge.sourcePath)}:${edge.line}`;
    if (!skillNames.has(edge.to)) {
      errors.push(`${where}: handoff target \`${edge.to}\` is not a known skill`);
    }
    if (edge.from === edge.to) {
      errors.push(`${where}: skill \`${edge.from}\` hands off to itself`);
    }
  }
  return errors;
}

// Strongly-connected components of size > 1 are circular handoff groups. They
// are expected, not errors; the view surfaces them so the cycle stays explicit.
function circularGroups(edges: readonly HandoffEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const edge of edges) {
    nodes.add(edge.from);
    nodes.add(edge.to);
    const targets = adjacency.get(edge.from) ?? [];
    targets.push(edge.to);
    adjacency.set(edge.from, targets);
  }

  let counter = 0;
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const groups: string[][] = [];

  function connect(v: string): void {
    index.set(v, counter);
    lowLink.set(v, counter);
    counter += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of (adjacency.get(v) ?? []).toSorted((a, b) => a.localeCompare(b))) {
      if (!index.has(w)) {
        connect(w);
        lowLink.set(v, Math.min(lowLink.get(v) ?? 0, lowLink.get(w) ?? 0));
      } else if (onStack.has(w)) {
        lowLink.set(v, Math.min(lowLink.get(v) ?? 0, index.get(w) ?? 0));
      }
    }
    if (lowLink.get(v) === index.get(v)) {
      const component: string[] = [];
      let popped = "";
      do {
        popped = stack.pop() ?? "";
        onStack.delete(popped);
        component.push(popped);
      } while (popped !== v);
      if (component.length > 1) {
        groups.push(component.toSorted((a, b) => a.localeCompare(b)));
      }
    }
  }

  for (const node of [...nodes].toSorted((a, b) => a.localeCompare(b))) {
    if (!index.has(node)) connect(node);
  }
  return groups.toSorted((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
}

function renderNavigation(edges: readonly HandoffEdge[], skillNames: ReadonlySet<string>): string {
  const unique = dedupeEdges(edges);
  const byFrom = new Map<string, string[]>();
  for (const edge of unique) {
    const targets = byFrom.get(edge.from) ?? [];
    targets.push(edge.to);
    byFrom.set(edge.from, targets);
  }
  const adjacencyLines = [...byFrom.keys()]
    .toSorted((left, right) => left.localeCompare(right))
    .map((from) => {
      const targets = (byFrom.get(from) ?? [])
        .toSorted((left, right) => left.localeCompare(right))
        .map((target) => `\`${target}\``)
        .join(", ");
      return `- \`${from}\` -> ${targets}`;
    });

  const groups = circularGroups(unique);
  const cycleLines =
    groups.length > 0
      ? groups.map((group) => `- ${group.map((name) => `\`${name}\``).join(", ")}`)
      : ["_None._"];

  return [
    "> Generated by `bun run docs:skill-navigation`. Do not edit this block by hand.",
    "",
    `Skills: ${skillNames.size}. Handoff edges: ${unique.length}.`,
    "",
    "### Handoff Graph",
    "",
    ...(adjacencyLines.length > 0
      ? adjacencyLines
      : ["_No cross-skill handoff references found._"]),
    "",
    "### Circular Handoffs",
    "",
    "Strongly-connected handoff groups. Two skills may legitimately hand off to",
    "each other under different conditions, so cycles are surfaced here rather",
    "than rejected.",
    "",
    ...cycleLines,
  ].join("\n");
}

function replaceGeneratedBlock(markdown: string, blockName: string, content: string): string {
  const startMarker = `<!-- generated:${blockName} start -->`;
  const endMarker = `<!-- generated:${blockName} end -->`;
  const start = markdown.indexOf(startMarker);
  const end = markdown.indexOf(endMarker);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`Missing generated markers for ${blockName} in ${NAV_DOC_PATH}`);
  }
  const before = markdown.slice(0, start + startMarker.length);
  const after = markdown.slice(end);
  return `${before}\n\n${content}\n${after}`;
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

  const sources = discoverSkillSources();
  const skillNames = new Set(sources.map((source) => source.name));
  const edges = sources.flatMap(extractHandoffEdges);

  const errors = validateEdges(edges, skillNames);
  if (errors.length > 0) {
    console.error(
      ["Skill handoff graph is invalid:", ...errors.map((line) => `- ${line}`)].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  const docPath = resolve(repoRoot, NAV_DOC_PATH);
  const markdown = readFileSync(docPath, "utf-8");
  const next = replaceGeneratedBlock(markdown, NAV_BLOCK_NAME, renderNavigation(edges, skillNames));
  const changed = next !== markdown;

  if (values.check && changed) {
    console.error("Generated skill navigation view is stale. Run `bun run docs:skill-navigation`.");
    process.exitCode = 1;
    return;
  }
  if (values.write) {
    if (changed) {
      writeFileSync(docPath, next);
      console.log("Updated generated skill navigation view.");
    } else {
      console.log("Generated skill navigation view is already up to date.");
    }
  }
}

main();
