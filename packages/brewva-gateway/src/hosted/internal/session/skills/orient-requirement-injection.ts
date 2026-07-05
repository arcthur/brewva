import { matchTraps, TRAP_ENTRIES, type TrapEntry } from "@brewva/brewva-tools/trap-library";
import { resolveRequirementAtoms, type RequirementAtom } from "@brewva/brewva-vocabulary/task";
import { recordRequirementAtoms } from "../runtime-ports.js";

/**
 * Orient-phase atom injection: implicit domain requirements land on the task
 * ledger before a line of code is written. At session orient time (the same
 * `beforeAgentStart` turn point `skill-selection.ts` reads the prompt from),
 * orient-phase traps evaluate against the user prompt and, when a task spec
 * goal is already on the ledger, the goal text too. Every matched trap's
 * `atomCore` is recorded as a `task.requirement.recorded` event with
 * `provenance: "trap"` — deterministically, advisory-only, and deduped so a
 * statement already on the ledger (from ANY provenance) is never re-recorded.
 *
 * This module makes ZERO decisions of its own about mint-vs-amend: it
 * collects candidate `{statement, modality}` entries from matched traps and
 * hands them to the SAME `resolveRequirementAtoms` judgment `task_set_spec`
 * uses (see `@brewva/brewva-vocabulary/task`), so both producers dedupe
 * against the same folded state with the same statement-match rule — one
 * mint/dedup home, two producers.
 *
 * Advisory only (Axiom 18): this lifecycle never returns a result. It does
 * not gate, mutate the prompt, force a skill, or introduce a new event kind
 * — it only ever emits `task.requirement.recorded` via the atom-only
 * `task.requirements.record` port (never `task.spec.set`, which this pass has
 * no spec content to justify emitting).
 */

export interface OrientRequirementInjectionRuntime {
  ops: {
    task: {
      state: {
        get(sessionId: string): {
          requirements: readonly RequirementAtom[];
          spec?: { goal?: string } | null;
        };
      };
      requirements: {
        record(sessionId: string, atoms: readonly RequirementAtom[]): void;
      };
    };
  };
}

export interface OrientRequirementInjectionLifecycle {
  beforeAgentStart: (event: unknown, ctx: unknown) => undefined;
}

function getSessionId(ctx: unknown): string | null {
  if (!ctx || typeof ctx !== "object" || !("sessionManager" in ctx)) {
    return null;
  }
  const sessionManager = (ctx as { sessionManager?: unknown }).sessionManager;
  if (
    !sessionManager ||
    typeof sessionManager !== "object" ||
    !("getSessionId" in sessionManager)
  ) {
    return null;
  }
  const getSessionIdFn = (sessionManager as { getSessionId?: unknown }).getSessionId;
  if (typeof getSessionIdFn !== "function") {
    return null;
  }
  const candidate = getSessionIdFn.call(sessionManager);
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : null;
}

interface TrapAtomCandidate {
  readonly statement: string;
  readonly modality: RequirementAtom["modality"];
}

function collectOrientAtomCores(input: {
  prompt: string;
  taskTaxonomyText: string | null;
  entries: readonly TrapEntry[];
}): TrapAtomCandidate[] {
  const candidates: TrapAtomCandidate[] = [];
  const promptMatches = matchTraps(
    { phase: "orient", kind: "prompt", text: input.prompt },
    input.entries,
  );
  for (const match of promptMatches) {
    if (match.entry.atomCore) {
      candidates.push(match.entry.atomCore);
    }
  }
  if (input.taskTaxonomyText !== null) {
    const taxonomyMatches = matchTraps(
      { phase: "orient", kind: "task_taxonomy", text: input.taskTaxonomyText },
      input.entries,
    );
    for (const match of taxonomyMatches) {
      if (match.entry.atomCore) {
        candidates.push(match.entry.atomCore);
      }
    }
  }
  return candidates;
}

export function createOrientRequirementInjectionLifecycle(
  runtime: OrientRequirementInjectionRuntime,
  options: { entries?: readonly TrapEntry[] } = {},
): OrientRequirementInjectionLifecycle {
  const entries = options.entries ?? TRAP_ENTRIES;
  return {
    beforeAgentStart(event, ctx) {
      const sessionId = getSessionId(ctx);
      if (!sessionId) {
        return undefined;
      }
      const rawEvent = event as { prompt?: unknown };
      const prompt = typeof rawEvent.prompt === "string" ? rawEvent.prompt : "";
      const state = runtime.ops.task.state.get(sessionId);
      const taskTaxonomyText =
        typeof state.spec?.goal === "string" && state.spec.goal.trim().length > 0
          ? state.spec.goal
          : null;
      const candidates = collectOrientAtomCores({ prompt, taskTaxonomyText, entries });
      if (candidates.length === 0) {
        return undefined;
      }
      const resolved = resolveRequirementAtoms(
        state.requirements,
        candidates.map((candidate) => ({
          statement: candidate.statement,
          modality: candidate.modality,
          provenance: "trap" as const,
        })),
      );
      // Only atoms that are genuinely NEW land as events: an amended atom
      // (statement already on the ledger under any provenance) is, by
      // definition, not re-recorded — `resolveRequirementAtoms` already
      // folded the amendment into `resolved.atoms`, but re-emitting an
      // event for every candidate every turn would defeat the idempotency
      // the brief requires. Compare by id: an id already present in the
      // folded state before this call is an amend, not a new atom.
      const existingIds = new Set(state.requirements.map((atom) => atom.id));
      const newAtoms = resolved.atoms.filter((atom) => !existingIds.has(atom.id));
      if (newAtoms.length === 0) {
        return undefined;
      }
      recordRequirementAtoms(runtime, sessionId, newAtoms);
      return undefined;
    },
  };
}
