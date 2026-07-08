import type { RequirementModality, RequirementRiskClass } from "@brewva/brewva-vocabulary/task";
// Type-only: names the deterministic adapters an atomCore may declare. No
// runtime cycle — the static-guard PRODUCER imports this module's entries,
// while this module needs only the lens-id type.
import type { StaticGuardLens } from "../static-guard/predicates.js";
import { TRAP_ENTRIES } from "./entries.js";

/**
 * Trap library: compiled domain hindsight, matched deterministically against
 * a single query at a time.
 *
 * A `TrapEntry` is auditable, serializable data (never a function) that pairs
 * a `phase` (when it may fire in the orient/write/verify/retro loop) with an
 * `input` (what kind of text it matches against) and a `trigger` (the
 * deterministic predicate over that text). `matchTraps` is the only way to
 * evaluate entries against a query: it is pure and does no I/O — the CALLER
 * is responsible for reading the prompt/file/diff/tape content and passing
 * it in as `text`.
 *
 * LENS != VERDICT — the single most misunderstood thing about traps, so it
 * is documented here rather than only in the RFC:
 *
 * A `write`/`verify`-phase trap that matches surfaces a LENS: an advisory
 * "look here with this stance" for a reviewer (human or model) to apply.
 * It does NOT assert that a defect exists. The canonical example is the
 * event-tap trigger keyed on `CGEvent.tapCreate` presence: it fires on every
 * file that creates an event tap, including a CORRECTLY keycode-scoped one,
 * because the lens ("verify suppression is keycode-scoped and callback
 * ownership uses passUnretained") is exactly as useful for confirming
 * correctness as it is for catching the over-broad/leaking variants. A trap
 * firing is an invitation to look, not a finding. Precision — i.e. telling
 * fixture-correct code apart from fixture-broken code — is NOT this engine's
 * job; that discrimination belongs to the W3 fitness join, which reasons
 * over verification evidence, not over trigger matches. Do not add
 * "does-not-fire-on-the-correct-file" logic to a lens-surfacing trap: that
 * would be solving the wrong layer's problem here.
 *
 * An `orient`-phase trap instead injects an `atomCore` — a requirement atom
 * seed — onto the task ledger before any code is written, so the implicit
 * requirement the trap encodes becomes an explicit, trackable one.
 */

/**
 * The deterministic predicate a `TrapEntry` evaluates over `text`. Kept as
 * data (a discriminated union), never a function, so entries stay
 * serializable and auditable — this is the minimal set of arms the seed
 * entries in `entries.ts` need; add a new kind only when a seed entry
 * requires it.
 */
export type TrapTrigger =
  | { readonly kind: "substring_any"; readonly needles: readonly string[] }
  | { readonly kind: "pattern"; readonly pattern: string };

export interface TrapEntry {
  readonly id: string;
  /** When the trap may fire in the orient/write/verify/retro loop. */
  readonly phase: "orient" | "write" | "verify" | "retro";
  /** What kind of text the trap matches against. */
  readonly input: "prompt" | "task_taxonomy" | "diff" | "file" | "tape";
  /** Deterministic predicate over the matched input's text. */
  readonly trigger: TrapTrigger;
  /** Review stance text surfaced on match (write/verify phases). Advisory — see module doc comment: lens != verdict. */
  readonly lens?: string;
  /**
   * Requirement atom seed injected onto the task ledger on match (orient phase
   * only). `riskClass` is the trap's compiled hindsight about the atom's risk
   * domain: a domain trap fires precisely because it encodes a failure mode
   * worth grading, so the seed carries the class that drives the fitness join's
   * min-grade cap (a `runtime`/`security` atom cannot be satisfied by
   * presence-only evidence). Omitted when the trap makes no risk claim.
   */
  readonly atomCore?: {
    readonly statement: string;
    readonly modality: RequirementModality;
    readonly riskClass?: RequirementRiskClass;
    /**
     * The deterministic adapter(s) whose checked property IS this atom's
     * statement — the trap's compiled hindsight promoted to code. The
     * static-guard producer joins a trap-minted ledger atom (`provenance:
     * "trap"`, verbatim statement) back to this declaration and attributes the
     * lens verdict at `property` coverage: a pass at grade discharges the atom,
     * a fail convicts it. Declared here (the curation home) so attribution is
     * a declaration, never statement-keyword inference.
     */
    readonly staticGuards?: readonly StaticGuardLens[];
  };
  /** Tape/run reference this entry was distilled from. */
  readonly provenance: string;
  /** Condition under which this entry should be retired. */
  readonly retirement: string;
}

/** A single query against the trap library: phase + input kind + the caller-supplied text to match. */
export interface TrapQuery {
  readonly phase: TrapEntry["phase"];
  readonly kind: TrapEntry["input"];
  readonly text: string;
  readonly path?: string;
}

export interface TrapMatch {
  readonly entry: TrapEntry;
}

function evaluateTrigger(trigger: TrapTrigger, text: string): boolean {
  switch (trigger.kind) {
    case "substring_any": {
      const haystack = text.toLowerCase();
      return trigger.needles.some((needle) => haystack.includes(needle.toLowerCase()));
    }
    case "pattern": {
      const regex = new RegExp(trigger.pattern, "iu");
      return regex.test(text);
    }
    default: {
      const exhaustive: never = trigger;
      throw new Error(`unhandled TrapTrigger kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Match `entries` against a single `input` query. Pure and deterministic:
 * no I/O, no clock, no randomness. Only entries whose `phase` AND `input`
 * equal the query's are evaluated at all; among those, the entry's
 * `trigger` predicate runs over `input.text`. Matches are returned in the
 * same order as `entries` (entry order is the ordering contract — callers
 * that want a different order sort the result themselves).
 */
export function matchTraps(input: TrapQuery, entries: readonly TrapEntry[]): TrapMatch[] {
  const matches: TrapMatch[] = [];
  for (const entry of entries) {
    if (entry.phase !== input.phase || entry.input !== input.kind) {
      continue;
    }
    if (evaluateTrigger(entry.trigger, input.text)) {
      matches.push({ entry });
    }
  }
  return matches;
}

/** One distinct write/verify lens that fired on a file's content, plus the entry that first surfaced it. */
export interface FileLensMatch {
  readonly entry: TrapEntry;
  readonly lens: string;
}

/**
 * THE single "which write/verify lenses fire on this file's content" fold,
 * shared by every caller that needs it — the attention-option card source
 * (one candidate card per distinct match) and `review_request`'s lens preload
 * (auto-appended stance text) both call this instead of each re-deriving the
 * write+verify union and its dedup rule (Task 9's "no redundancy" constraint).
 *
 * File content stands in for BOTH query shapes a write/verify trap can be
 * declared against: `phase: "write", kind: "diff"` and `phase: "verify",
 * kind: "file"` (mirroring the seed library's own coordinated pairs — see
 * `entries.ts`, where the write/diff and verify/file rows of one requirement
 * share the identical lens text). Querying both against the SAME file text is
 * deliberate: a caller with only a file's current content (not a diff) still
 * wants every lens that would fire whichever phase produced this file.
 *
 * Deduplicated by LENS TEXT, not by entry id: the tap lens is declared on two
 * separate entries (`event-tap-write-diff`, `event-tap-verify-file`) with the
 * identical advisory string, and a caller must not see that one lens twice.
 * An entry with no `lens` (an orient-phase atomCore entry misfiled into this
 * query shape, which should never happen given the phase gate, but stays
 * defensive) contributes nothing. Order is deterministic: first-seen-wins,
 * write-phase entries before verify-phase entries, entry order within each —
 * the same ordering contract `matchTraps` documents.
 */
export function matchFileAgainstWriteVerifyTraps(
  text: string,
  entries: readonly TrapEntry[] = TRAP_ENTRIES,
): FileLensMatch[] {
  const matches = [
    ...matchTraps({ phase: "write", kind: "diff", text }, entries),
    ...matchTraps({ phase: "verify", kind: "file", text }, entries),
  ];
  const seenLenses = new Set<string>();
  const deduped: FileLensMatch[] = [];
  for (const match of matches) {
    const lens = match.entry.lens;
    if (!lens || seenLenses.has(lens)) {
      continue;
    }
    seenLenses.add(lens);
    deduped.push({ entry: match.entry, lens });
  }
  return deduped;
}

// Re-exported here (as the binding already imported above for
// matchFileAgainstWriteVerifyTraps's default) so this file is the one public
// barrel for the module (the package's `./trap-library` export points at this
// file, not at `entries.ts` directly): a cross-package consumer (e.g. the
// gateway's orient-phase injection) needs both the engine and the seed data
// from one import. Type-only in the other direction (`entries.ts` imports
// only `TrapEntry` as a type from here), so this does not create a runtime
// circular import.
export { TRAP_ENTRIES };
