import type { EvidenceCoverage } from "@brewva/brewva-vocabulary/fitness";
import type { EvidenceItem } from "@brewva/brewva-vocabulary/iteration";
import { TRAP_ENTRIES, type TrapEntry } from "../trap-library/index.js";
import {
  runStaticGuard,
  STATIC_GUARD_DOMAINS,
  STATIC_GUARD_EVIDENCE_KIND,
  STATIC_GUARD_LENSES,
  type StaticGuardLens,
} from "./predicates.js";

export interface StaticGuardAtom {
  readonly id: string;
  readonly statement: string;
  /** The atom's recorded provenance; `"trap"` enables the trap-declared join. */
  readonly provenance?: string;
  /** The atom's own declared, checkable constructs — the facet-binding side. */
  readonly observableSignals?: readonly string[];
}

export interface StaticGuardFile {
  readonly path: string;
  readonly content: string;
}

/**
 * The static-guard PRODUCER (R3c): run every deterministic adapter ONCE over the
 * fresh-touched files, then attribute each lens verdict to atoms through DECLARED
 * bindings only, producing `deterministic`-source, `static_guard`-grade
 * {@link EvidenceItem}s the receipt/assembler carries into the fitness join.
 *
 * Discovery and attribution are SEPARATE concerns:
 *
 * - DISCOVERY is atom-independent. Each lens runs per file (never a concatenated
 *   blob — a guard token in file A can never satisfy a defect in file B, and the
 *   anchor names the deciding file). Any applicable FAIL decides the lens
 *   (findings own violations); otherwise the first applicable file's pass stands;
 *   a lens whose subject is absent from every file has no outcome.
 *
 * - ATTRIBUTION is by declaration, never statement-prose inference (an item's
 *   effective grade is min(verdict grade, attribution grade) — see
 *   {@link STATIC_GUARD_DOMAINS}). Two declared sources bind a lens to an atom:
 *   1. `property` — a trap entry declares the adapter (`atomCore.staticGuards`)
 *      and the ledger atom is that trap's mint (`provenance: "trap"`, verbatim
 *      statement). The lens property IS the atom's statement: a pass at grade
 *      discharges, a fail convicts.
 *   2. `facet` — the atom's own `observableSignals` name a construct in the
 *      lens's domain. The atom is broader than the lens property: a fail still
 *      convicts (the atom's declared evidence basis is deterministically
 *      broken), but a pass is trail-only (one facet can never satisfy the whole
 *      statement — the fitness join enforces this via `coverage`).
 *
 * - An applicable FAIL that NO atom binds is still emitted, with empty
 *   `atomRefs`: the deterministic signal stays on the receipt for the model's
 *   attention without guessing an owner (axiom 7). Unbound passes are noise and
 *   are not emitted.
 *
 * PURE: atoms + files in, evidence items out. The effectful caller reads the
 * fresh-touched files and records the returned items through the verification
 * receipt seam — the grade is earned by the predicate RUNNING, not by a model
 * claiming a result.
 */
export function buildStaticGuardEvidenceItems(input: {
  readonly atoms: readonly StaticGuardAtom[];
  readonly files: readonly StaticGuardFile[];
  /** Trap entries to join `property` bindings against; the seed library by default. */
  readonly trapEntries?: readonly TrapEntry[];
}): EvidenceItem[] {
  const trapEntries = input.trapEntries ?? TRAP_ENTRIES;
  const outcomes = resolveLensOutcomes(input.files);
  const items: EvidenceItem[] = [];
  const boundLenses = new Set<StaticGuardLens>();
  for (const atom of input.atoms) {
    for (const [lens, coverage] of resolveStaticGuardBindings(atom, trapEntries)) {
      const outcome = outcomes.get(lens);
      if (!outcome) {
        continue;
      }
      boundLenses.add(lens);
      items.push({
        id: `static-guard:${lens}:${atom.id}`,
        atomRefs: [atom.id],
        evidenceKind: STATIC_GUARD_EVIDENCE_KIND,
        verdict: outcome.verdict,
        coverage,
        anchors: [outcome.anchor],
        statement: `static-guard ${lens}: ${atom.statement}`,
      });
    }
  }
  for (const [lens, outcome] of outcomes) {
    if (outcome.verdict !== "fail" || boundLenses.has(lens)) {
      continue;
    }
    items.push({
      id: `static-guard:${lens}:unbound`,
      atomRefs: [],
      evidenceKind: STATIC_GUARD_EVIDENCE_KIND,
      verdict: "fail",
      anchors: [outcome.anchor],
      statement: `static-guard ${lens}: deterministic conflict; no requirement atom declares this construct`,
    });
  }
  return items;
}

/** One lens's atom-independent verdict over the file set, with its deciding anchor. */
interface LensOutcome {
  readonly verdict: "pass" | "fail";
  readonly anchor: string;
}

/**
 * DISCOVERY: run each lens once over every file. Fail-first across files, else
 * the first applicable file's pass; no applicable file means no outcome.
 */
function resolveLensOutcomes(
  files: readonly StaticGuardFile[],
): ReadonlyMap<StaticGuardLens, LensOutcome> {
  const outcomes = new Map<StaticGuardLens, LensOutcome>();
  for (const lens of STATIC_GUARD_LENSES) {
    const applicable = files
      .map((file) => ({ path: file.path, result: runStaticGuard(lens, file.content) }))
      .filter((entry) => entry.result.applicable);
    if (applicable.length === 0) {
      continue;
    }
    const chosen = applicable.find((entry) => entry.result.verdict === "fail") ?? applicable[0]!;
    outcomes.set(lens, {
      verdict: chosen.result.verdict,
      anchor: `${chosen.path}: ${chosen.result.anchors[0] ?? lens}`,
    });
  }
  return outcomes;
}

/**
 * ATTRIBUTION: resolve one atom's declared lens bindings. `property` bindings
 * (trap-declared, in trap-declaration order) come first and win over a `facet`
 * binding to the same lens; facet bindings follow in the registry's lens order
 * — emission is deterministic either way.
 *
 * The property join keys on VERBATIM statement identity alone — deliberately
 * NOT gated on `provenance === "trap"`: the statement IS the trap's compiled
 * property, so an atom holding it verbatim declares that property whichever
 * producer minted it first (the orient injection amends an existing
 * same-statement atom WITHOUT overwriting its provenance, so a provenance gate
 * would silently deny property coverage to exactly that atom).
 */
export function resolveStaticGuardBindings(
  atom: StaticGuardAtom,
  trapEntries: readonly TrapEntry[] = TRAP_ENTRIES,
): ReadonlyMap<StaticGuardLens, EvidenceCoverage> {
  const bindings = new Map<StaticGuardLens, EvidenceCoverage>();
  for (const entry of trapEntries) {
    if (entry.atomCore?.statement !== atom.statement) {
      continue;
    }
    for (const lens of entry.atomCore.staticGuards ?? []) {
      bindings.set(lens, "property");
    }
  }
  const signals = atom.observableSignals ?? [];
  if (signals.length > 0) {
    for (const lens of STATIC_GUARD_LENSES) {
      if (bindings.has(lens)) {
        continue;
      }
      if (signals.some((signal) => STATIC_GUARD_DOMAINS[lens].test(signal))) {
        bindings.set(lens, "facet");
      }
    }
  }
  return bindings;
}

/**
 * The effectful producer's testable core: read each fresh-touched source path
 * through the injected reader into a per-file set, then run the adapters. `readSource`
 * is injected so this stays testable without a real filesystem; the caller
 * (`verification_record`, which already reads workspace files) supplies the real
 * reader. Returns `[]` when there are no atoms, no paths, or no readable source.
 */
export function collectStaticGuardEvidence(input: {
  readonly atoms: readonly StaticGuardAtom[];
  readonly sourcePaths: readonly string[];
  readonly readSource: (path: string) => string | null;
}): EvidenceItem[] {
  // Zero atoms stays FULLY inert (no unbound emission either): with no
  // requirement ledger there is no requirement governance to annotate — the
  // unbound channel exists to keep a signal visible NEXT TO the atoms it could
  // not be pinned to, not to grade sessions that never declared requirements.
  if (input.atoms.length === 0 || input.sourcePaths.length === 0) {
    return [];
  }
  const files = input.sourcePaths
    .map((path) => ({ path, content: input.readSource(path) ?? "" }))
    .filter((file) => file.content.length > 0);
  if (files.length === 0) {
    return [];
  }
  return buildStaticGuardEvidenceItems({ atoms: input.atoms, files });
}
