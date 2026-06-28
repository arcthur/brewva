import { type BrewvaEventRecord } from "./events.js";
import type { ProtocolRecord } from "./types/foundation.js";

export type { ProtocolRecord } from "./types/foundation.js";

// A user model is a projection the model authored and the tape preserved — graded,
// explicit-pull, and authority-free. A `user_fact` is model-authored advisory material:
// it grants no capability, routes no model, and bypasses no gate (axioms 11, 18). The
// projection folds those events; losing it changes diagnostics only, never replay truth
// (axiom 6).

export const USER_FACT_RECORDED_EVENT_TYPE = "user.fact.recorded" as const;

// `user` = a global trait (preference, role, communication style); `project` = a
// constraint scoped to the current repository/project. The Open Question on finer scoping
// stays open — these two cover the v1 cases without committing further.
export const USER_FACT_SCOPES = ["user", "project"] as const;

export type UserFactScope = (typeof USER_FACT_SCOPES)[number];

// The honesty grade (the candidate axiom's account/grade/calibrate, made literal on a user
// fact). A fresh fact is authored `estimated`; the projection's cross-session fold promotes
// it (`buildUserModelProjection`). The grade is evidence; it never gates anything.
export const USER_FACT_GRADES = ["measured", "estimated", "inconclusive"] as const;

export type UserFactGrade = (typeof USER_FACT_GRADES)[number];

export interface UserFactEntry extends ProtocolRecord {
  readonly id: string;
  readonly scope: UserFactScope;
  /** Stable key the fact revises latest-wins, e.g. `communication_style`. */
  readonly factKey: string;
  readonly value: string;
  readonly grade: UserFactGrade;
  readonly sourceRefs: readonly string[];
  readonly reason: string;
  /** Prior {@link UserFactEntry.id} this entry explicitly revises (auditable; the fold is
   * key-based, so this is recorded evidence, not load-bearing in v1). */
  readonly supersedesId?: string;
  readonly createdAt: number;
}

export function isUserFactEntry(value: unknown): value is UserFactEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Partial<UserFactEntry>;
  return (
    typeof record.id === "string" &&
    typeof record.factKey === "string" &&
    record.factKey.length > 0 &&
    typeof record.value === "string" &&
    typeof record.reason === "string" &&
    typeof record.createdAt === "number" &&
    typeof record.scope === "string" &&
    USER_FACT_SCOPES.includes(record.scope) &&
    typeof record.grade === "string" &&
    USER_FACT_GRADES.includes(record.grade) &&
    Array.isArray(record.sourceRefs)
  );
}

export function parseUserFactEvent(record: BrewvaEventRecord): UserFactEntry | null {
  return isUserFactEntry(record.payload) ? record.payload : null;
}

/**
 * Build a `UserFactEntry` from model-authored input plus a recorder-supplied id and
 * timestamp. A fresh fact is always graded `estimated`; the projection's cross-session fold
 * calibrates it (`buildUserModelProjection`). The authored grade is domain logic and lives
 * here, not at the emit site — the model authors the fact, the system grades it (never the
 * model asserting certainty).
 */
export function buildUserFactEntry(
  input: {
    readonly scope: UserFactScope;
    readonly factKey: string;
    readonly value: string;
    readonly reason: string;
    readonly sourceRefs?: readonly string[];
    readonly supersedesId?: string;
  },
  identity: { readonly id: string; readonly createdAt: number },
): UserFactEntry {
  return {
    id: identity.id,
    scope: input.scope,
    factKey: input.factKey,
    value: input.value,
    grade: "estimated",
    sourceRefs: [...(input.sourceRefs ?? [])],
    reason: input.reason,
    ...(input.supersedesId ? { supersedesId: input.supersedesId } : {}),
    createdAt: identity.createdAt,
  };
}

// --- Projection -----------------------------------------------------------------------

export const USER_MODEL_PROJECTION_SCHEMA_V1 = "brewva.user-model.projection.v1" as const;

export interface UserModelFact extends ProtocolRecord {
  readonly scope: UserFactScope;
  readonly factKey: string;
  readonly value: string;
  readonly grade: UserFactGrade;
  /** The id of the entry that authored the current value. */
  readonly entryId: string;
  readonly reason: string;
  readonly sourceRefs: readonly string[];
  /** When this `(scope, factKey)` was first authored. */
  readonly createdAt: number;
  /** When the current value was authored. */
  readonly updatedAt: number;
  /** Superseded entry ids for this `(scope, factKey)`, oldest first — retained for audit
   * and calibration, never erased (the revised preference keeps its history). */
  readonly supersededEntryIds: readonly string[];
}

export interface UserModelProjection extends ProtocolRecord {
  readonly schema: typeof USER_MODEL_PROJECTION_SCHEMA_V1;
  readonly version: 1;
  readonly facts: readonly UserModelFact[];
}

// ASCII Unit Separator (US): a control char that never occurs in a scope or a
// model-authored factKey, so the composite key is unambiguous without escaping. Written as
// an escape, never a literal byte -- a literal separator byte makes Git treat this source
// as binary (no readable diff/blame/patch).
const FACT_KEY_SEPARATOR = "\x1f";

function compositeKey(scope: UserFactScope, factKey: string): string {
  return `${scope}${FACT_KEY_SEPARATOR}${factKey}`;
}

interface UserModelAccumulator {
  latest: UserFactEntry;
  readonly firstCreatedAt: number;
  readonly supersededEntryIds: string[];
  /** Value -> the distinct sessions that authored it, for cross-session grading. */
  readonly valueSessions: Map<string, Set<string>>;
}

/**
 * Grade the current value of a `(scope, factKey)` from cross-session corroboration:
 * `measured` when >=2 distinct sessions independently authored the current value;
 * `inconclusive` when a competing value exists and the current one is not yet corroborated
 * (unsettled); `estimated` for a single session. The honest floor: with no cross-session
 * evidence the grade stays `estimated`, never claiming more than one session's word — so a
 * fact restated twice in the *same* session is still `estimated`, not promoted.
 */
function gradeUserFact(agreeingSessions: number, distinctValues: number): UserFactGrade {
  if (agreeingSessions >= 2) {
    return "measured";
  }
  if (distinctValues >= 2) {
    return "inconclusive";
  }
  return "estimated";
}

/**
 * Deterministic, rebuildable fold of `user_fact` events into the current user model:
 * latest-wins per `(scope, factKey)`, with each superseded entry id retained so a revised
 * preference does not erase its history. The honesty grade is computed from cross-session
 * corroboration of the current value (see {@link gradeUserFact}), never copied from the
 * authored entry (which is always `estimated`).
 *
 * The caller passes events in tape (append) order: latest-wins follows input order, so the
 * fold is deterministic for a given ordered input but is NOT order-independent. The
 * production path is already ordered -- `SessionIndex.listTapeEventsByType` returns events by
 * `(timestamp asc, source_sequence asc)`, the tape's append order. Never replay truth
 * (axiom 6).
 *
 * The grade calibrates only when the event set spans sessions: a session-local fold (one
 * sessionId) always grades `estimated`, the honest floor when no cross-session evidence is
 * in scope.
 */
export function buildUserModelProjection(
  events: readonly BrewvaEventRecord[],
): UserModelProjection {
  const byKey = new Map<string, UserModelAccumulator>();
  for (const event of events) {
    if (event.type !== USER_FACT_RECORDED_EVENT_TYPE) {
      continue;
    }
    const entry = parseUserFactEvent(event);
    if (entry === null) {
      continue;
    }
    const key = compositeKey(entry.scope, entry.factKey);
    const existing = byKey.get(key);
    const accumulator: UserModelAccumulator = existing ?? {
      latest: entry,
      firstCreatedAt: entry.createdAt,
      supersededEntryIds: [],
      valueSessions: new Map(),
    };
    if (existing) {
      accumulator.supersededEntryIds.push(accumulator.latest.id);
      accumulator.latest = entry;
    }
    const sessions = accumulator.valueSessions.get(entry.value) ?? new Set<string>();
    sessions.add(event.sessionId);
    accumulator.valueSessions.set(entry.value, sessions);
    if (!existing) {
      byKey.set(key, accumulator);
    }
  }
  const facts = [...byKey.values()]
    .map((accumulator): UserModelFact => {
      const { latest } = accumulator;
      const agreeingSessions = accumulator.valueSessions.get(latest.value)?.size ?? 1;
      return {
        scope: latest.scope,
        factKey: latest.factKey,
        value: latest.value,
        grade: gradeUserFact(agreeingSessions, accumulator.valueSessions.size),
        entryId: latest.id,
        reason: latest.reason,
        sourceRefs: [...latest.sourceRefs],
        createdAt: accumulator.firstCreatedAt,
        updatedAt: latest.createdAt,
        supersededEntryIds: accumulator.supersededEntryIds,
      };
    })
    .toSorted((left, right) =>
      compositeKey(left.scope, left.factKey).localeCompare(
        compositeKey(right.scope, right.factKey),
      ),
    );
  return { schema: USER_MODEL_PROJECTION_SCHEMA_V1, version: 1, facts };
}
