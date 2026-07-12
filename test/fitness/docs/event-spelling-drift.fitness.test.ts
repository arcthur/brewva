import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// Scans the whole source tree twice (production for the presence gate, docs +
// tests for violations); comfortably over bun's 5s bare-`bun test` default.
setDefaultTimeout(60_000);

// Docs-side spelling-drift tripwire — the docs mirror of the code-side
// event-contract-liveness fitness. The vocabulary owns the canonical spelling of
// every event kind (e.g. TURN_INPUT_RECORDED_EVENT_TYPE = "turn.input.recorded",
// SUBAGENT_SPAWNED_EVENT_TYPE = "subagent_spawned"). When prose or a test fixture
// writes the same concept with the opposite separator — the dotted kind spelled
// with underscores, or vice-versa — the twin is a spelling that is never emitted
// or persisted, so every reader who greps for it hits the recurring "is this
// event dead?" question. This guard derives each canonical's dot<->underscore
// confusion twin and fails on any twin that surfaced in docs/ or the test tree,
// printing the canonical to normalize to.
//
// A twin is flagged only when it is PURE drift: it is not itself a canonical
// literal, AND it does not appear as a real (non-comment) identifier anywhere in
// production source. That production-presence gate is the whole subtlety — the
// codebase has ~two dozen genuinely-underscore canonical kinds plus tool names,
// local event kinds, wire-status reasons, and provider streaming deltas that
// merely COLLIDE with a dotted event's twin. `tape.handoff` is a durable event,
// `tape_handoff` is a real tool name; `session.compact` is the vocabulary event,
// `session_compact` is a real gateway-local delegation kind; `approval.requested`
// is the event, `approval_requested` is a wire-status reason; `message.end` is
// the event, `message_end` is the SDK streaming delta. Each of those underscore
// twins has a real production home, so it is left exactly as written and its
// dotted-twin never fires here.
//
// Deliberate scope holes (logged, not silent):
//   - The vocabulary package is excluded from the presence gate: it is the
//     source of truth, and its comments spell twins on purpose to document past
//     drifts (a comment mentioning the underscore twin of skill.selection.recorded
//     is documentation, not a producer).
//   - Comment lines are excluded from the presence gate: a twin named only in a
//     comment is not a load-bearing identifier.
//   - test/eval is excluded from the violation scan: the recall eval harness
//     drives replay from dataset-instruction tokens (recall_curation_recorded,
//     task_event) that are its own vocabulary, live in .yaml datasets, and are
//     not the tape-event vocabulary this guard governs.
//   - This file excludes itself: its own prose names twins to explain them.

const repoRoot = resolve(import.meta.dir, "../../..");
const VOCAB_INTERNAL_DIR = "packages/brewva-vocabulary/src/internal";

// Any `const NAME_EVENT_TYPE|_KIND = "literal"` (exported or not, `as const` or
// not, literal on the same or next line) counts as a canonical.
const CONSTANT_PATTERN = /\bconst [A-Z0-9_]+(?:_EVENT_TYPE|_KIND)\s*=\s*\n?\s*"([^"]+)"/gu;

const SELF_RELATIVE_PATH = "test/fitness/docs/event-spelling-drift.fitness.test.ts";
// The recall eval harness is a separate underscore vocabulary (dataset-instruction
// tokens, not tape events), so its tree is out of the violation scan.
const EVAL_HARNESS_PREFIX = "test/eval/";

const IGNORED_DIRECTORIES = new Set(["node_modules", "dist", ".tmp"]);

function collectSourceFiles(root: string, accept: (relativePath: string) => boolean): string[] {
  const files: string[] = [];
  const walk = (absoluteDir: string): void => {
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const absolute = join(absoluteDir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        walk(absolute);
        continue;
      }
      const relativePath = relative(repoRoot, absolute);
      if (accept(relativePath)) files.push(relativePath);
    }
  };
  walk(resolve(repoRoot, root));
  return files.toSorted();
}

function collectCanonicalLiterals(): Set<string> {
  const canonicals = new Set<string>();
  const dir = resolve(repoRoot, VOCAB_INTERNAL_DIR);
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".ts")) continue;
    const source = readFileSync(join(dir, entry), "utf8");
    for (const match of source.matchAll(CONSTANT_PATTERN)) {
      const literal = match[1];
      if (literal) canonicals.add(literal);
    }
  }
  return canonicals;
}

// canonical dot<->underscore confusion twin -> the canonical it should normalize
// to. A twin equal to the canonical (single-separator kinds) or that is itself
// another canonical (both spellings are load-bearing) is not a confusion.
function deriveConfusionTwins(canonicals: ReadonlySet<string>): Map<string, string> {
  const twins = new Map<string, string>();
  for (const canonical of canonicals) {
    if (!canonical.includes(".") && !canonical.includes("_")) continue;
    for (const twin of [canonical.replaceAll(".", "_"), canonical.replaceAll("_", ".")]) {
      if (twin === canonical || canonicals.has(twin)) continue;
      if (!twins.has(twin)) twins.set(twin, canonical);
    }
  }
  return twins;
}

const WORD_ADJACENT = /[A-Za-z0-9._]/u;

function containsBoundedToken(line: string, token: string): boolean {
  let index = line.indexOf(token);
  while (index !== -1) {
    // charAt returns "" past either edge, so an edge match reads as bounded.
    const before = line.charAt(index - 1);
    const after = line.charAt(index + token.length);
    if (!WORD_ADJACENT.test(before) && !WORD_ADJACENT.test(after)) return true;
    index = line.indexOf(token, index + token.length);
  }
  return false;
}

function isCommentLine(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

// A twin is a real identifier when non-comment production code (outside the
// vocabulary package) names it as a bounded token. Those are left alone.
function collectProductionPresentTwins(twins: ReadonlyMap<string, string>): Set<string> {
  const present = new Set<string>();
  const productionFiles = collectSourceFiles(
    "packages",
    (relativePath) =>
      relativePath.endsWith(".ts") &&
      !relativePath.endsWith(".test.ts") &&
      relativePath.includes("/src/") &&
      !relativePath.includes("/brewva-vocabulary/"),
  );
  for (const relativePath of productionFiles) {
    const lines = readFileSync(join(repoRoot, relativePath), "utf8").split("\n");
    for (const line of lines) {
      if (isCommentLine(line)) continue;
      for (const twin of twins.keys()) {
        if (!present.has(twin) && containsBoundedToken(line, twin)) present.add(twin);
      }
    }
  }
  return present;
}

interface SpellingViolation {
  readonly location: string;
  readonly twin: string;
  readonly canonical: string;
}

let cache:
  | {
      readonly canonicals: Set<string>;
      readonly twins: Map<string, string>;
      readonly flaggable: Map<string, string>;
      readonly violations: SpellingViolation[];
    }
  | undefined;

function analyze(): NonNullable<typeof cache> {
  if (cache) return cache;
  const canonicals = collectCanonicalLiterals();
  const twins = deriveConfusionTwins(canonicals);
  const productionPresent = collectProductionPresentTwins(twins);
  const flaggable = new Map<string, string>();
  for (const [twin, canonical] of twins) {
    if (!productionPresent.has(twin)) flaggable.set(twin, canonical);
  }

  const scanFiles = [
    ...collectSourceFiles("docs", (relativePath) => relativePath.endsWith(".md")),
    ...collectSourceFiles(
      "test",
      (relativePath) =>
        relativePath.endsWith(".ts") &&
        relativePath !== SELF_RELATIVE_PATH &&
        !relativePath.startsWith(EVAL_HARNESS_PREFIX),
    ),
  ];

  const violations: SpellingViolation[] = [];
  for (const relativePath of scanFiles) {
    const lines = readFileSync(join(repoRoot, relativePath), "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      for (const [twin, canonical] of flaggable) {
        if (containsBoundedToken(line, twin)) {
          violations.push({ location: `${relativePath}:${index + 1}`, twin, canonical });
        }
      }
    }
  }
  violations.sort((left, right) => left.location.localeCompare(right.location));
  cache = { canonicals, twins, flaggable, violations };
  return cache;
}

describe("event spelling drift", () => {
  test("the vocabulary collector and twin generator do not regress", () => {
    const { canonicals, twins, flaggable } = analyze();
    // Floors track the vocabulary as of this guard landing (156 canonicals, 167
    // derived twins). A collapse means the pattern or vocabulary layout drifted
    // and coverage silently shrank — that must go red, not quietly pass.
    expect(canonicals.size).toBeGreaterThanOrEqual(140);
    expect(twins.size).toBeGreaterThanOrEqual(140);
    // The gate must keep the load-bearing underscore identifiers off the flag
    // list (each has a real production home that collides with a dotted twin).
    for (const dottedCanonical of [
      "tape.handoff",
      "session.compact",
      "approval.requested",
      "message.end",
    ]) {
      const collidingTwin = dottedCanonical.replaceAll(".", "_");
      expect(
        twins.has(collidingTwin) && !flaggable.has(collidingTwin),
        `${collidingTwin} must be recognized as a real identifier, not flagged`,
      ).toBe(true);
    }
    // And it must keep a known pure-drift twin flaggable, mapped to its canonical.
    expect(flaggable.get("turn.input.recorded".replaceAll(".", "_"))).toBe("turn.input.recorded");
  });

  test("no dotted-event kind is spelled with its underscore twin in docs or test fixtures", () => {
    const { violations } = analyze();
    const report = violations
      .map(
        (violation) => `  ${violation.location}: "${violation.twin}" -> "${violation.canonical}"`,
      )
      .join("\n");
    expect(
      violations,
      `Event-kind spelling drift — these are dot<->underscore twins of canonical vocabulary kinds, ` +
        `never emitted or persisted, so a reader cannot tell them apart from a dead event. ` +
        `Normalize each to the canonical literal on the right:\n${report}`,
    ).toEqual([]);
  });
});
