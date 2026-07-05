import type { EvidenceItem } from "@brewva/brewva-vocabulary/iteration";
import {
  routeAtomToStaticGuardLens,
  runStaticGuard,
  STATIC_GUARD_EVIDENCE_KIND,
} from "./predicates.js";

export interface StaticGuardAtom {
  readonly id: string;
  readonly statement: string;
}

export interface StaticGuardFile {
  readonly path: string;
  readonly content: string;
}

/**
 * The static-guard PRODUCER (R3c): run the deterministic adapters PER FILE for each
 * atom that routes to a lens, producing `deterministic`-source, `static_guard`-grade
 * {@link EvidenceItem}s the receipt/assembler carries into the fitness join. A PASS
 * can satisfy a high-risk atom presence-only evidence cannot; a FAIL is a real
 * `deterministic_conflict`. An atom whose lens finds no subject in any file, or that
 * routes nowhere, contributes nothing (it stays presence-graded).
 *
 * Per-file (not a concatenated blob): a guard token in file A can never satisfy a
 * defect in file B, and the anchor names the deciding file. Any applicable FAIL
 * fails the atom (findings own violations); otherwise the first applicable file's
 * pass stands.
 *
 * PURE: files in, evidence items out. The effectful caller reads the fresh-touched
 * files and records the returned items through the verification receipt seam — the
 * grade is earned by the predicate RUNNING, not by a model claiming a result.
 */
export function buildStaticGuardEvidenceItems(input: {
  readonly atoms: readonly StaticGuardAtom[];
  readonly files: readonly StaticGuardFile[];
}): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  for (const atom of input.atoms) {
    const lens = routeAtomToStaticGuardLens(atom.statement);
    if (!lens) {
      continue;
    }
    const applicable = input.files
      .map((file) => ({ path: file.path, result: runStaticGuard(lens, file.content) }))
      .filter((entry) => entry.result.applicable);
    if (applicable.length === 0) {
      continue;
    }
    const chosen = applicable.find((entry) => entry.result.verdict === "fail") ?? applicable[0]!;
    items.push({
      id: `static-guard:${lens}:${atom.id}`,
      atomRefs: [atom.id],
      evidenceKind: STATIC_GUARD_EVIDENCE_KIND,
      verdict: chosen.result.verdict,
      anchors: [`${chosen.path}: ${chosen.result.anchors[0] ?? lens}`],
      statement: `static-guard ${lens}: ${atom.statement}`,
    });
  }
  return items;
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
