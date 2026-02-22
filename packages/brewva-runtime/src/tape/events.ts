import type { TaskSpec, TaskState, TruthState } from "../types.js";
import { isRecord, normalizeNonEmptyString } from "../utils/coerce.js";

export const TAPE_ANCHOR_EVENT_TYPE = "anchor";
export const TAPE_CHECKPOINT_EVENT_TYPE = "checkpoint";

export const TAPE_ANCHOR_SCHEMA = "brewva.tape.anchor.v1" as const;
export const TAPE_CHECKPOINT_SCHEMA = "brewva.tape.checkpoint.v1" as const;

const TASK_ITEM_STATUSES = ["todo", "doing", "done", "blocked"] as const;
const TASK_PHASES = ["align", "investigate", "execute", "verify", "blocked", "done"] as const;
const TASK_HEALTH_VALUES = [
  "ok",
  "needs_spec",
  "blocked",
  "verification_failed",
  "budget_pressure",
  "unknown",
] as const;
const TRUTH_FACT_STATUSES = ["active", "resolved"] as const;
const TRUTH_FACT_SEVERITIES = ["info", "warn", "error"] as const;

export interface TapeAnchorPayload {
  schema: typeof TAPE_ANCHOR_SCHEMA;
  name: string;
  summary?: string;
  nextSteps?: string;
  createdAt: number;
}

export interface TapeCheckpointPayload {
  schema: typeof TAPE_CHECKPOINT_SCHEMA;
  state: {
    task: TaskState;
    truth: TruthState;
  };
  basedOnEventId?: string;
  latestAnchorEventId?: string;
  reason: string;
  createdAt: number;
}

function normalizeFiniteNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function normalizeOptionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeFiniteNumber(value) ?? undefined;
}

function normalizeStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    const normalized = normalizeNonEmptyString(item);
    if (!normalized) return null;
    out.push(normalized);
  }
  return out;
}

function isTaskItemStatus(value: unknown): value is TaskState["items"][number]["status"] {
  return typeof value === "string" && (TASK_ITEM_STATUSES as readonly string[]).includes(value);
}

function isTaskPhase(value: unknown): value is NonNullable<TaskState["status"]>["phase"] {
  return typeof value === "string" && (TASK_PHASES as readonly string[]).includes(value);
}

function isTaskHealth(value: unknown): value is NonNullable<TaskState["status"]>["health"] {
  return typeof value === "string" && (TASK_HEALTH_VALUES as readonly string[]).includes(value);
}

function isTruthFactStatus(value: unknown): value is TruthState["facts"][number]["status"] {
  return typeof value === "string" && (TRUTH_FACT_STATUSES as readonly string[]).includes(value);
}

function isTruthFactSeverity(value: unknown): value is TruthState["facts"][number]["severity"] {
  return typeof value === "string" && (TRUTH_FACT_SEVERITIES as readonly string[]).includes(value);
}

function coerceCheckpointTaskState(value: unknown): TaskState | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.items) || !Array.isArray(value.blockers)) return null;

  const items: TaskState["items"] = [];
  for (const rawItem of value.items) {
    if (!isRecord(rawItem)) return null;
    const id = normalizeNonEmptyString(rawItem.id);
    const text = normalizeNonEmptyString(rawItem.text);
    const createdAt = normalizeFiniteNumber(rawItem.createdAt);
    const updatedAt = normalizeFiniteNumber(rawItem.updatedAt);
    const status = isTaskItemStatus(rawItem.status) ? rawItem.status : null;
    if (!id || !text || createdAt === null || updatedAt === null || !status) return null;
    items.push({
      id,
      text,
      status,
      createdAt,
      updatedAt,
    });
  }

  const blockers: TaskState["blockers"] = [];
  for (const rawBlocker of value.blockers) {
    if (!isRecord(rawBlocker)) return null;
    const id = normalizeNonEmptyString(rawBlocker.id);
    const message = normalizeNonEmptyString(rawBlocker.message);
    const createdAt = normalizeFiniteNumber(rawBlocker.createdAt);
    const source = normalizeNonEmptyString(rawBlocker.source);
    const truthFactId = normalizeNonEmptyString(rawBlocker.truthFactId);
    if (!id || !message || createdAt === null) return null;
    blockers.push({
      id,
      message,
      createdAt,
      source,
      truthFactId,
    });
  }

  let spec: TaskState["spec"] | undefined;
  if (value.spec !== undefined) {
    if (!isRecord(value.spec)) return null;
    if (value.spec.schema !== "brewva.task.v1") return null;
    const goal = normalizeNonEmptyString(value.spec.goal);
    if (!goal) return null;
    const rawSpec = value.spec;
    let targets: TaskSpec["targets"];
    if (rawSpec.targets !== undefined) {
      if (!isRecord(rawSpec.targets)) return null;
      targets = {
        files: Array.isArray(rawSpec.targets.files)
          ? rawSpec.targets.files.filter(
              (item: unknown): item is string => typeof item === "string",
            )
          : undefined,
        symbols: Array.isArray(rawSpec.targets.symbols)
          ? rawSpec.targets.symbols.filter(
              (item: unknown): item is string => typeof item === "string",
            )
          : undefined,
      };
    }
    const expectedBehavior = normalizeNonEmptyString(rawSpec.expectedBehavior);
    const constraints = Array.isArray(rawSpec.constraints)
      ? rawSpec.constraints.filter((item: unknown): item is string => typeof item === "string")
      : undefined;
    let verification: TaskSpec["verification"];
    if (rawSpec.verification !== undefined) {
      if (!isRecord(rawSpec.verification)) return null;
      verification = {
        level:
          typeof rawSpec.verification.level === "string" &&
          (["quick", "standard", "strict"] as readonly string[]).includes(
            rawSpec.verification.level,
          )
            ? (rawSpec.verification.level as "quick" | "standard" | "strict")
            : undefined,
        commands: Array.isArray(rawSpec.verification.commands)
          ? rawSpec.verification.commands.filter(
              (item: unknown): item is string => typeof item === "string",
            )
          : undefined,
      };
    }
    spec = {
      schema: "brewva.task.v1",
      goal,
      targets,
      expectedBehavior,
      constraints,
      verification,
    };
  }

  let status: TaskState["status"] | undefined;
  if (value.status !== undefined) {
    if (!isRecord(value.status)) return null;
    const phase = isTaskPhase(value.status.phase) ? value.status.phase : null;
    const health = isTaskHealth(value.status.health) ? value.status.health : null;
    const updatedAt = normalizeFiniteNumber(value.status.updatedAt);
    if (!phase || !health || updatedAt === null) return null;
    let truthFactIds: string[] | undefined;
    if (value.status.truthFactIds !== undefined) {
      const normalizedTruthFactIds = normalizeStringArray(value.status.truthFactIds);
      if (!normalizedTruthFactIds) return null;
      truthFactIds = normalizedTruthFactIds;
    }
    status = {
      phase,
      health,
      reason: normalizeNonEmptyString(value.status.reason),
      updatedAt,
      truthFactIds,
    };
  }

  let updatedAt: number | null = null;
  if (value.updatedAt !== null && value.updatedAt !== undefined) {
    const normalized = normalizeFiniteNumber(value.updatedAt);
    if (normalized === null) return null;
    updatedAt = normalized;
  }

  return {
    spec,
    status,
    items,
    blockers,
    updatedAt,
  };
}

function coerceCheckpointTruthState(value: unknown): TruthState | null {
  if (!isRecord(value)) return null;
  if (!Array.isArray(value.facts)) return null;

  const facts: TruthState["facts"] = [];
  for (const rawFact of value.facts) {
    if (!isRecord(rawFact)) return null;
    const id = normalizeNonEmptyString(rawFact.id);
    const kind = normalizeNonEmptyString(rawFact.kind);
    const status = isTruthFactStatus(rawFact.status) ? rawFact.status : null;
    const severity = isTruthFactSeverity(rawFact.severity) ? rawFact.severity : null;
    const summary = normalizeNonEmptyString(rawFact.summary);
    const evidenceIds = normalizeStringArray(rawFact.evidenceIds);
    const firstSeenAt = normalizeFiniteNumber(rawFact.firstSeenAt);
    const lastSeenAt = normalizeFiniteNumber(rawFact.lastSeenAt);
    const resolvedAt = normalizeOptionalFiniteNumber(rawFact.resolvedAt);
    if (
      !id ||
      !kind ||
      !status ||
      !severity ||
      !summary ||
      !evidenceIds ||
      firstSeenAt === null ||
      lastSeenAt === null
    ) {
      return null;
    }

    facts.push({
      id,
      kind,
      status,
      severity,
      summary,
      evidenceIds,
      details: isRecord(rawFact.details)
        ? (rawFact.details as TruthState["facts"][number]["details"])
        : undefined,
      firstSeenAt,
      lastSeenAt,
      resolvedAt,
    });
  }

  let updatedAt: number | null = null;
  if (value.updatedAt !== null && value.updatedAt !== undefined) {
    const normalized = normalizeFiniteNumber(value.updatedAt);
    if (normalized === null) return null;
    updatedAt = normalized;
  }

  return {
    facts,
    updatedAt,
  };
}

export function buildTapeAnchorPayload(input: {
  name: string;
  summary?: string;
  nextSteps?: string;
  createdAt?: number;
}): TapeAnchorPayload {
  return {
    schema: TAPE_ANCHOR_SCHEMA,
    name: input.name,
    summary: input.summary,
    nextSteps: input.nextSteps,
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function buildTapeCheckpointPayload(input: {
  taskState: TaskState;
  truthState: TruthState;
  basedOnEventId?: string;
  latestAnchorEventId?: string;
  reason: string;
  createdAt?: number;
}): TapeCheckpointPayload {
  return {
    schema: TAPE_CHECKPOINT_SCHEMA,
    state: {
      task: input.taskState,
      truth: input.truthState,
    },
    basedOnEventId: input.basedOnEventId,
    latestAnchorEventId: input.latestAnchorEventId,
    reason: input.reason,
    createdAt: input.createdAt ?? Date.now(),
  };
}

export function coerceTapeAnchorPayload(value: unknown): TapeAnchorPayload | null {
  if (!isRecord(value)) return null;
  if (value.schema !== TAPE_ANCHOR_SCHEMA) return null;
  const name = normalizeNonEmptyString(value.name);
  const createdAt =
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
      ? value.createdAt
      : null;
  if (!name || createdAt === null) return null;
  const summary = normalizeNonEmptyString(value.summary);
  const nextSteps = normalizeNonEmptyString(value.nextSteps);
  return {
    schema: TAPE_ANCHOR_SCHEMA,
    name,
    summary,
    nextSteps,
    createdAt,
  };
}

export function coerceTapeCheckpointPayload(value: unknown): TapeCheckpointPayload | null {
  if (!isRecord(value)) return null;
  if (value.schema !== TAPE_CHECKPOINT_SCHEMA) return null;
  if (!isRecord(value.state)) return null;
  const task = coerceCheckpointTaskState(value.state.task);
  const truth = coerceCheckpointTruthState(value.state.truth);
  if (!task || !truth) return null;

  const reason = normalizeNonEmptyString(value.reason);
  const createdAt =
    typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
      ? value.createdAt
      : null;
  if (!reason || createdAt === null) return null;

  const basedOnEventId = normalizeNonEmptyString(value.basedOnEventId);
  const latestAnchorEventId = normalizeNonEmptyString(value.latestAnchorEventId);

  return {
    schema: TAPE_CHECKPOINT_SCHEMA,
    state: {
      task,
      truth,
    },
    basedOnEventId,
    latestAnchorEventId,
    reason,
    createdAt,
  };
}
