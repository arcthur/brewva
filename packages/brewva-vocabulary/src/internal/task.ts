import { payloadOf, type BrewvaEventRecord } from "./events.js";
import type { ProtocolRecord } from "./types/foundation.js";

export type { ProtocolRecord } from "./types/foundation.js";

export const TASK_STALL_ADJUDICATED_EVENT_TYPE = "task.stall.adjudicated" as const;

export const TASK_STALL_ADJUDICATION_ERROR_EVENT_TYPE = "task.stall.error" as const;

export const TASK_STUCK_DETECTED_EVENT_TYPE = "task.stuck.detected" as const;

// Runtime-ops task lifecycle events: emitted by the hosted task builder and folded by the
// runtime-ops task projections. Shared so the emit site and the projection never drift on
// the event-type string (a typo or a missed projection branch would silently lose the fold).
export const TASK_SPEC_SET_EVENT_TYPE = "task.spec.set" as const;
export const TASK_ITEM_ADDED_EVENT_TYPE = "task.item.added" as const;
export const TASK_ITEM_UPDATED_EVENT_TYPE = "task.item.updated" as const;
export const TASK_BLOCKER_RECORDED_EVENT_TYPE = "task.blocker.recorded" as const;
export const TASK_BLOCKER_RESOLVED_EVENT_TYPE = "task.blocker.resolved" as const;
export const TASK_ACCEPTANCE_RECORDED_EVENT_TYPE = "task.acceptance.recorded" as const;

// Requirement-atom lifecycle: emitted whenever a requirement is minted or
// amended (see `foldTaskLedgerEvents` below — later same-id events replace).
export const TASK_REQUIREMENT_RECORDED_EVENT_TYPE = "task.requirement.recorded" as const;

export const TASK_AGENT_ITEM_STATUS_VALUES = [
  "pending",
  "in_progress",
  "completed",
  "blocked",
] as const;

export const TASK_AGENT_ITEM_STATUS_RUNTIME_MAP = Object.freeze({
  pending: "pending",
  in_progress: "in_progress",
  completed: "done",
  blocked: "blocked",
});

export type TaskItemStatus = string;

export type TaskPhase = string;

export interface TaskSpec extends ProtocolRecord {
  readonly goal?: string;
  readonly description?: string;
  readonly expectedBehavior?: string;
  readonly constraints?: readonly string[];
}

/**
 * How strongly a requirement binds: `must` gates acceptance, `should` is a
 * strong default that can be knowingly waived, `nice` is discretionary.
 */
export const REQUIREMENT_MODALITIES = ["must", "should", "nice"] as const;

export type RequirementModality = (typeof REQUIREMENT_MODALITIES)[number];

/**
 * Where a requirement atom came from: the original `prompt`, a `trap`
 * (adversarial/edge-case probe), or `review` (surfaced by a finding after the
 * fact — see `ReviewFindingRecordedEventPayload.atomRefs` in
 * `internal/iteration.ts`).
 */
export const REQUIREMENT_PROVENANCES = ["prompt", "trap", "review"] as const;

export type RequirementProvenance = (typeof REQUIREMENT_PROVENANCES)[number];

/**
 * The domain a requirement's risk lives in — informs which fitness
 * projection (Task 12) weighs the atom and how heavily. Optional: minted
 * atoms (from `task_set_spec` or the orient-phase trap injection) may carry
 * no risk class at all; classification is an enrichment pass, not a
 * mint-time obligation.
 */
export const REQUIREMENT_RISK_CLASSES = [
  "runtime",
  "security",
  "ux",
  "packaging",
  "architecture",
] as const;

export type RequirementRiskClass = (typeof REQUIREMENT_RISK_CLASSES)[number];

/**
 * A single requirement as a task-ledger artifact: atomic, independently
 * satisfiable evidence unit. `foldTaskLedgerEvents` keys atoms by `id`; a
 * later `task.requirement.recorded` event with the same id amends the atom
 * in place, so the ledger always reflects the requirement's latest wording.
 *
 * The four enrichment fields below are OPTIONAL and purely additive (W3):
 * a prompt/trap-provenance atom is minted with none of them, and gains them
 * only when a later same-id event supplies enrichment (see
 * `resolveRequirementAtoms`'s "enrichment-by-amendment" behavior). No reader
 * of this shape may assume any of the four are present.
 */
export interface RequirementAtom {
  readonly id: string;
  readonly statement: string;
  readonly modality: RequirementModality;
  readonly provenance: RequirementProvenance;
  /** Which domain this requirement's risk lives in, once classified. */
  readonly riskClass?: RequirementRiskClass;
  /** Concrete, checkable signals that would show this requirement is met. */
  readonly observableSignals?: readonly string[];
  /** Free-text plan for how this requirement's satisfaction gets verified. */
  readonly verificationStrategy?: string | null;
  /** Runtime conditions (permissions, env, services) this requirement assumes. */
  readonly runtimePrerequisites?: readonly string[];
}

/**
 * One incoming `{statement, modality, provenance}` entry to resolve against
 * folded atoms, with the same four OPTIONAL enrichment fields `RequirementAtom`
 * carries — an entry that omits all four mints/amends a bare atom exactly as
 * before W3.
 */
export interface RequirementAtomResolutionEntry {
  readonly statement: string;
  readonly modality: RequirementModality;
  readonly provenance: RequirementProvenance;
  readonly riskClass?: RequirementRiskClass;
  readonly observableSignals?: readonly string[];
  readonly verificationStrategy?: string | null;
  readonly runtimePrerequisites?: readonly string[];
}

export interface ResolvedRequirementAtoms {
  readonly atoms: readonly RequirementAtom[];
  readonly amendedCount: number;
}

/**
 * Builds the four OPTIONAL enrichment fields for a resolved atom from an
 * incoming entry, per the last-writer-wins rule: the entry's own values are
 * the WHOLE enrichment state of the resulting atom — a field the entry
 * doesn't specify is simply absent from the returned object (never copied
 * forward from a previously-enriched atom being amended). This applies
 * identically whether the entry is minting a brand-new atom or amending an
 * existing one, so mint and amend never diverge on enrichment semantics.
 *
 * Keys are omitted (not set to `undefined`) so `Object.hasOwn`/spread-based
 * readers and `toEqual` assertions alike see a bare atom as truly bare.
 */
function buildAtomEnrichmentFields(
  entry: RequirementAtomResolutionEntry,
): Pick<
  RequirementAtom,
  "riskClass" | "observableSignals" | "verificationStrategy" | "runtimePrerequisites"
> {
  const enrichment: {
    riskClass?: RequirementRiskClass;
    observableSignals?: readonly string[];
    verificationStrategy?: string | null;
    runtimePrerequisites?: readonly string[];
  } = {};
  if (entry.riskClass !== undefined) {
    enrichment.riskClass = entry.riskClass;
  }
  if (entry.observableSignals !== undefined) {
    enrichment.observableSignals = entry.observableSignals;
  }
  if (entry.verificationStrategy !== undefined) {
    enrichment.verificationStrategy = entry.verificationStrategy;
  }
  if (entry.runtimePrerequisites !== undefined) {
    enrichment.runtimePrerequisites = entry.runtimePrerequisites;
  }
  return enrichment;
}

/**
 * Resolves each incoming `{statement, modality, provenance}` entry against the
 * currently folded requirement atoms: an entry whose statement exactly equals
 * an existing atom's statement amends that atom (same id, updated modality —
 * provenance of an EXISTING atom is never overwritten by a later amend, since
 * the atom's origin doesn't change just because a later producer restates the
 * same requirement); otherwise it mints `req-<n>` with n = current folded atom
 * count + 1, carrying the entry's own provenance. Minting is derived from
 * `foldedRequirements.length` plus how many atoms this same call has already
 * minted (monotonic, no second counter store) — so repeated statements within
 * one call amend the atom minted earlier in that same call rather than
 * minting a duplicate.
 *
 * Enrichment (W3): every entry's `riskClass` / `observableSignals` /
 * `verificationStrategy` / `runtimePrerequisites` fully REPLACE the target
 * atom's enrichment (last-writer-wins per atom, not per field) — an omitted
 * enrichment field on the entry means "not specified now," so the resolved
 * atom drops it even if the atom being amended had it. This is deliberate:
 * enrichment is a restatement of what's currently known about the
 * requirement, not a sparse patch, so two enrichment calls never need to be
 * merged field-by-field to reconstruct the atom's current truth.
 *
 * Single-homed: this is the ONE mint/dedup/enrichment-merge judgment for
 * requirement atoms, shared by every producer (task_set_spec, the
 * orient-phase trap injection, and any future producer) — dedup is by
 * statement across ALL provenances, so an atom already on the ledger (from
 * `prompt`, `trap`, or `review`) is never re-recorded regardless of which
 * producer calls this function next, and enrichment survives amendment
 * (a review-minted or prompt atom later enriched keeps its id).
 */
export function resolveRequirementAtoms(
  foldedRequirements: readonly RequirementAtom[],
  entries: readonly RequirementAtomResolutionEntry[],
): ResolvedRequirementAtoms {
  const byStatement = new Map(foldedRequirements.map((atom) => [atom.statement, atom]));
  let nextMintNumber = foldedRequirements.length + 1;
  let amendedCount = 0;
  const atoms = entries.map((entry): RequirementAtom => {
    const existing = byStatement.get(entry.statement);
    if (existing) {
      amendedCount += 1;
      const atom: RequirementAtom = {
        id: existing.id,
        statement: existing.statement,
        modality: entry.modality,
        provenance: existing.provenance,
        ...buildAtomEnrichmentFields(entry),
      };
      byStatement.set(entry.statement, atom);
      return atom;
    }
    const atom: RequirementAtom = {
      id: `req-${nextMintNumber}`,
      statement: entry.statement,
      modality: entry.modality,
      provenance: entry.provenance,
      ...buildAtomEnrichmentFields(entry),
    };
    nextMintNumber += 1;
    byStatement.set(entry.statement, atom);
    return atom;
  });
  return { atoms, amendedCount };
}

export interface TaskState {
  readonly blockers: Array<{
    readonly id?: string;
    readonly message?: string;
    readonly [key: string]: unknown;
  }>;
  readonly spec?: TaskSpec | null;
  readonly status?: TaskStatus;
  readonly acceptance?: TaskAcceptanceState;
  readonly items: unknown[];
  readonly requirements: readonly RequirementAtom[];
  readonly updatedAt?: number | null;
  readonly [key: string]: unknown;
}

export type TaskAcceptanceRecordResult =
  | { readonly ok: true; readonly status: TaskAcceptanceState["status"] }
  | { readonly ok: false; readonly reason: string };

export interface TaskAcceptanceState extends ProtocolRecord {
  readonly status?: "pending" | "accepted" | "rejected";
}

export type TaskBlockerRecordResult =
  | { readonly ok: true; readonly blockerId: string }
  | { readonly ok: false; readonly reason: string };

export type TaskBlockerResolveResult =
  | { readonly ok: true; readonly blockerId?: string }
  | { readonly ok: false; readonly reason: string };

export interface TaskItem extends ProtocolRecord {
  readonly id: string;
  readonly text: string;
  readonly status?: TaskItemStatus;
}

export type TaskItemAddResult =
  | { readonly ok: true; readonly itemId: string; readonly item: TaskItem }
  | { readonly ok: false; readonly reason: string };

export type TaskItemUpdateResult =
  | { readonly ok: true; readonly itemId: string; readonly item: TaskItem }
  | { readonly ok: false; readonly reason: string };

export interface TaskLedgerEventPayload extends ProtocolRecord {}

export interface TaskStatus extends ProtocolRecord {
  readonly phase?: string;
  readonly health?: string;
}

export interface TaskTargetDescriptor extends ProtocolRecord {}

export interface TaskStallAdjudicatedPayload extends ProtocolRecord {
  readonly detectedAt: number;
  readonly baselineProgressAt: number;
  readonly adjudicatedAt?: number;
  readonly decision: "accepted" | "rejected" | "pending";
  readonly source: string;
  readonly rationale?: string | null;
  readonly signalSummary: string[];
  readonly verificationLastOutcome?: "pass" | "fail" | "skipped" | null;
}

export type TaskStallAdjudicationDecision = string;

export interface TaskStuckDetectedPayload extends ProtocolRecord {
  readonly detectedAt: number;
  readonly baselineProgressAt: number;
  readonly thresholdMs: number;
  readonly idleMs: number;
  readonly openItemCount: number;
  readonly reason?: string | null;
}

export function createEmptyTaskState(): TaskState {
  return { items: [], blockers: [], requirements: [], status: { phase: "pending" } };
}

export function normalizeTaskSpec(value: unknown): TaskSpec {
  return typeof value === "object" && value !== null
    ? (value as ProtocolRecord)
    : {
        description: typeof value === "string" ? value : value == null ? "" : JSON.stringify(value),
      };
}

export function reduceTaskState(state: TaskState, payload: TaskLedgerEventPayload): TaskState {
  return { ...state, lastEvent: payload };
}

/**
 * Validates only the CORE fields (id/statement/modality/provenance) — the
 * fields that were required before W3 enrichment existed. Enrichment fields
 * are validated and coerced separately (`coerceRequirementAtomEnrichment`)
 * so a malformed enrichment field never fails the whole atom: enrichment is
 * best-effort, core identity is not.
 */
function isRequirementAtom(value: unknown): value is RequirementAtom {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as ProtocolRecord;
  return (
    typeof record.id === "string" &&
    typeof record.statement === "string" &&
    (REQUIREMENT_MODALITIES as readonly unknown[]).includes(record.modality) &&
    (REQUIREMENT_PROVENANCES as readonly unknown[]).includes(record.provenance)
  );
}

/** True for a value that would be a legal `readonly string[]` entry. */
function isStringArrayEntry(value: unknown): value is string {
  return typeof value === "string";
}

/**
 * Coerces the four OPTIONAL enrichment fields off an already-core-validated
 * atom candidate: an unrecognized `riskClass` is omitted rather than kept, a
 * non-array `observableSignals`/`runtimePrerequisites` is omitted rather than
 * defaulted to `[]` (the field simply wasn't specified, which is different
 * from "specified as empty"), and non-string entries inside either array are
 * filtered out one at a time rather than discarding the whole field. None of
 * this ever rejects the atom itself — enrichment is additive and best-effort
 * per the W3 contract; only the core fields gate atom validity.
 */
function coerceRequirementAtomEnrichment(
  record: ProtocolRecord,
): Pick<
  RequirementAtom,
  "riskClass" | "observableSignals" | "verificationStrategy" | "runtimePrerequisites"
> {
  const enrichment: {
    riskClass?: RequirementRiskClass;
    observableSignals?: readonly string[];
    verificationStrategy?: string | null;
    runtimePrerequisites?: readonly string[];
  } = {};
  if ((REQUIREMENT_RISK_CLASSES as readonly unknown[]).includes(record.riskClass)) {
    enrichment.riskClass = record.riskClass as RequirementRiskClass;
  }
  if (Array.isArray(record.observableSignals)) {
    enrichment.observableSignals = record.observableSignals.filter(isStringArrayEntry);
  }
  if (typeof record.verificationStrategy === "string" || record.verificationStrategy === null) {
    enrichment.verificationStrategy = record.verificationStrategy;
  }
  if (Array.isArray(record.runtimePrerequisites)) {
    enrichment.runtimePrerequisites = record.runtimePrerequisites.filter(isStringArrayEntry);
  }
  return enrichment;
}

/** The wire payload of a `task.requirement.recorded` event is `{ atom }`, not the atom flattened. */
function readRequirementAtomFromPayload(payload: ProtocolRecord): RequirementAtom | null {
  if (!isRequirementAtom(payload.atom)) {
    return null;
  }
  const record = payload.atom as unknown as ProtocolRecord;
  return {
    id: payload.atom.id,
    statement: payload.atom.statement,
    modality: payload.atom.modality,
    provenance: payload.atom.provenance,
    ...coerceRequirementAtomEnrichment(record),
  };
}

/**
 * Requirement atoms are keyed by `id`; a later event with the same id amends
 * the atom's content in place while preserving first-appearance order (the
 * amendment replaces WHAT the atom says, never WHERE it sits in the ledger).
 */
function reduceRequirementAtoms(
  requirements: readonly RequirementAtom[],
  atom: RequirementAtom,
): readonly RequirementAtom[] {
  const existingIndex = requirements.findIndex((entry) => entry.id === atom.id);
  if (existingIndex === -1) {
    return [...requirements, atom];
  }
  return requirements.map((entry, index) => (index === existingIndex ? atom : entry));
}

function reduceTaskLedgerEvent(state: TaskState, entry: BrewvaEventRecord): TaskState {
  const payload = payloadOf(entry);
  if (entry.type === TASK_REQUIREMENT_RECORDED_EVENT_TYPE) {
    const atom = readRequirementAtomFromPayload(payload);
    if (atom) {
      return { ...state, requirements: reduceRequirementAtoms(state.requirements, atom) };
    }
  }
  return reduceTaskState(state, payload);
}

export function foldTaskLedgerEvents(events: readonly BrewvaEventRecord[]): TaskState {
  return events.reduce(reduceTaskLedgerEvent, createEmptyTaskState());
}

export function formatTaskStateBlock(state: TaskState): string {
  return JSON.stringify(state, null, 2);
}

export function formatTaskVerificationLevelForSurface(level: unknown): string {
  return typeof level === "string" && level.trim().length > 0 ? level : "none";
}

export const TASK_STALL_ADJUDICATION_SCHEMA = "brewva.task.stall-adjudication.v1" as const;

export function buildTaskStallAdjudicatedPayload(
  input: ProtocolRecord,
): TaskStallAdjudicatedPayload {
  return {
    schema: TASK_STALL_ADJUDICATION_SCHEMA,
    ...input,
  } as unknown as TaskStallAdjudicatedPayload;
}

export function coerceTaskStallAdjudicatedPayload(
  value: unknown,
): TaskStallAdjudicatedPayload | null {
  return typeof value === "object" && value !== null
    ? (value as TaskStallAdjudicatedPayload)
    : null;
}

export function toTaskWatchdogEventPayload(input: ProtocolRecord): ProtocolRecord {
  return input;
}

export const readTaskStallAdjudicatedEventPayload = (event: {
  readonly payload?: ProtocolRecord;
}): TaskStallAdjudicatedPayload | null =>
  event.payload ? (event.payload as TaskStallAdjudicatedPayload) : null;

export const readTaskStuckDetectedEventPayload = (event: {
  readonly payload?: ProtocolRecord;
}): TaskStuckDetectedPayload | null =>
  event.payload ? (event.payload as TaskStuckDetectedPayload) : null;
