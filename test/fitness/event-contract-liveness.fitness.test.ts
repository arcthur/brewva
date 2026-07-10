import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// Event-contract liveness tripwire. The four-port cutover silently deleted the
// `tool.result.recorded` producer while six features kept consuming it; the
// follow-up audit (2026-07-02) found 33 more vocabulary event types with
// consumers and no producer. All 33 are fixed on this branch: naming drifts
// unified on the vocabulary constants (durable tape spelling wins), missing
// producers rebuilt at the seams that own the data (turn envelope receipts,
// verification ops, WAL observability, scheduler deferral), and abandoned
// consumers deleted together with their constants. This fitness pins the
// inventory EXACTLY — the map is empty and must stay empty: a new dead
// contract makes the set grow (red), so contract deadness can never again
// accumulate silently.
//
// Heuristic (deterministic, not a type checker): a vocabulary literal counts
// as PRODUCED when any production line referencing one of its constants (or
// the raw literal) sits inside a 5-line window containing an emit-shaped call
// (emit*/append/record*/makeEvent/commit/publish*). Known blind spot, kept on
// purpose: a dot-form constant passed through a dispatcher that re-emits an
// underscore kind is credited as produced (the dispatcher call IS
// emit-shaped) — those drifts are caught from the consumer side instead, and
// each verdict below was manually verified against the real emit chain. Two
// more blind spots, both deliberate: a contract whose producer AND consumers
// go through vocabulary-package helpers is invisible in both directions (the
// vocabulary package is excluded), and constants declared WITHOUT ` as const`
// are not collected — widening the pattern would credit the recovery.wal.*
// literals through their never-invoked bridge declarations (a line heuristic
// cannot see that the bridge callbacks have no caller).

const repoRoot = resolve(import.meta.dir, "../..");
const VOCAB_INTERNAL_DIR = "packages/brewva-vocabulary/src/internal";

const CONSTANT_PATTERN =
  /export const ([A-Z0-9_]+(?:_EVENT_TYPE|_KIND))\s*=\s*\n?\s*"([^"]+)" as const/gu;
const PRODUCER_WINDOW_PATTERN =
  /\b(emit\w*|append|record[A-Z]\w*|recordInputPayload|recordSemantic\w*|makeEvent|commit|publish\w*)\s*\(/u;
const IMPORT_EXPORT_LINE = /^\s*(import|export)\b/u;
const PRODUCER_WINDOW_LINES = 4;

// literal -> verdict for any KNOWN dead contract. NAMING_DRIFT = a live
// producer emits a different literal for the same semantic event (consumer is
// dead until the vocabulary is unified); DEAD_CONSUMER = no producer exists in
// any spelling (the consuming feature silently sees zero events). Fix an entry
// by unifying producer and consumer on the vocabulary constant, then delete it
// here — precedent: tool.result.recorded (restored producer, RFC R3), the
// read-path gate family (builder kinds aligned), and the 2026-07-02 audit
// sweep that emptied this map (31 contracts). New entries are acceptable only
// as short-lived acknowledgements with an owner and a fix in flight.
const KNOWN_DEAD_CONTRACTS: Record<string, "NAMING_DRIFT" | "DEAD_CONSUMER"> = {};

function collectVocabularyLiterals(): Map<string, Set<string>> {
  const namesByLiteral = new Map<string, Set<string>>();
  const dir = resolve(repoRoot, VOCAB_INTERNAL_DIR);
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".ts")) continue;
    const source = readFileSync(join(dir, entry), "utf8");
    for (const match of source.matchAll(CONSTANT_PATTERN)) {
      const name = match[1];
      const literal = match[2];
      if (!name || !literal) continue;
      const names = namesByLiteral.get(literal) ?? new Set<string>();
      names.add(name);
      namesByLiteral.set(literal, names);
    }
  }
  return namesByLiteral;
}

function collectProductionSources(): Map<string, string[]> {
  const sources = new Map<string, string[]>();
  const packagesRoot = resolve(repoRoot, "packages");
  function walk(directory: string): void {
    for (const entry of readdirSync(directory)) {
      const absolute = join(directory, entry);
      const stats = statSync(absolute);
      if (stats.isDirectory()) {
        if (entry === "dist" || entry === "node_modules" || entry === ".tmp") continue;
        walk(absolute);
        continue;
      }
      if (!entry.endsWith(".ts") || entry.endsWith(".test.ts")) continue;
      if (!absolute.includes("/src/")) continue;
      if (absolute.includes("/brewva-vocabulary/")) continue;
      sources.set(absolute, readFileSync(absolute, "utf8").split("\n"));
    }
  }
  walk(packagesRoot);
  return sources;
}

let scanCache: string[] | undefined;

function scanConsumedButNeverProduced(): string[] {
  if (scanCache) {
    return scanCache;
  }
  const namesByLiteral = collectVocabularyLiterals();
  // The collector regressing (pattern drift, vocabulary reshuffle) must go red,
  // not silently shrink coverage. Floor = 139 literals after the audit fixes
  // retired ten producerless constants (was 149 before), minus the same
  // slack of four the original 145 floor carried.
  if (namesByLiteral.size < 135) {
    throw new Error(
      `vocabulary literal collector regressed: expected >= 135 literals, found ${namesByLiteral.size}`,
    );
  }
  const sources = collectProductionSources();
  const flagged: string[] = [];
  for (const [literal, names] of [...namesByLiteral.entries()].toSorted(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const tokens = [...names, `"${literal}"`];
    let producers = 0;
    let consumers = 0;
    for (const lines of sources.values()) {
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index] ?? "";
        if (!tokens.some((token) => line.includes(token))) continue;
        if (IMPORT_EXPORT_LINE.test(line) && !line.includes("(")) continue;
        const window = lines
          .slice(Math.max(0, index - PRODUCER_WINDOW_LINES), index + 1)
          .join("\n");
        if (PRODUCER_WINDOW_PATTERN.test(window)) {
          producers += 1;
        } else {
          consumers += 1;
        }
      }
    }
    if (consumers > 0 && producers === 0) {
      flagged.push(literal);
    }
  }
  scanCache = flagged;
  return flagged;
}

describe("event contract liveness", () => {
  test("consumed-but-never-produced vocabulary literals match the audited inventory exactly", () => {
    const flagged = scanConsumedButNeverProduced();
    const expected = Object.keys(KNOWN_DEAD_CONTRACTS).toSorted((a, b) => a.localeCompare(b));

    const newlyDead = flagged.filter((literal) => !(literal in KNOWN_DEAD_CONTRACTS));
    const revived = expected.filter((literal) => !flagged.includes(literal));

    expect(
      newlyDead,
      `New consumed-but-never-produced event contracts (a producer was removed or renamed without its consumers): ${newlyDead.join(", ")}`,
    ).toEqual([]);
    expect(
      revived,
      `These contracts now have producers — remove them from KNOWN_DEAD_CONTRACTS so the tripwire stays exact: ${revived.join(", ")}`,
    ).toEqual([]);
    expect(flagged.toSorted((a, b) => a.localeCompare(b))).toEqual(expected);
  });

  test("the historical regression class stays covered: tool.result.recorded and the read-path gate are live", () => {
    // These were dead contracts fixed on this branch; if they reappear in the
    // scan the producer regressed again. `tool.contract.warning` left the set
    // for good: the read-path hard gate (its only producer) was deleted by the
    // harness-candidate-integrity RFC P2, and the audit convention retires an
    // abandoned consumer together with its constant.
    const flagged = new Set(scanConsumedButNeverProduced());
    expect(flagged.has("tool.result.recorded")).toBe(false);
    expect(flagged.has("tool.read_path.gate.armed")).toBe(false);
  });
});
