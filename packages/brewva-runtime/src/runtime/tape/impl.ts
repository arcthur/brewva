import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { redactedStableJsonSha256Hex } from "@brewva/brewva-std/hash";
import { toJsonValue } from "@brewva/brewva-std/json";
import { forEachUtf8LineSync } from "@brewva/brewva-std/node/fs";
import { isSupportedToolOutcomeVersion } from "@brewva/brewva-std/tool-outcome-version";
import type {
  Baseline,
  CanonicalEvent,
  CanonicalEventType,
  CustomEventPayload,
  CostSummaryView,
  RecoveryHistoryView,
  RuntimeRecoveryCause,
  StepProjectionAuthority,
  StepProjectionRecord,
  StepProjectionView,
  TapeCommitPort,
  TapePort,
  TapeQuery,
  TapeView,
  TapeViewName,
  ToolCommitmentsView,
  TurnStateView,
} from "../runtime-api.js";
import { CANONICAL_EVENT_TYPES } from "../runtime-api.js";

type TapeCommitInput = Parameters<TapeCommitPort["commit"]>[0];

export interface RuntimeTapePersistence {
  readonly cwd: string;
  readonly tapeDir: string;
  readonly enabled: boolean;
  readonly initialEvents?: readonly CanonicalEvent[];
}

function freezeJsonValue<TValue>(value: TValue): TValue {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      freezeJsonValue(item);
    }
    return Object.freeze(value) as TValue;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    freezeJsonValue(entry);
  }
  return Object.freeze(value) as TValue;
}

function freezeCanonicalEvent(event: CanonicalEvent): CanonicalEvent {
  if (event.payload !== undefined) {
    freezeJsonValue(event.payload);
  }
  return Object.freeze(event);
}

function cloneEvent(event: CanonicalEvent): CanonicalEvent {
  return event;
}

function normalizeCanonicalPayload(payload: unknown): unknown {
  if (payload === undefined) {
    return undefined;
  }
  return freezeJsonValue(toJsonValue(payload));
}

function cloneInitialEvent(event: CanonicalEvent): CanonicalEvent {
  const payload = event.payload === undefined ? undefined : structuredClone(event.payload);
  return {
    ...event,
    ...(payload === undefined ? {} : { payload }),
  } as CanonicalEvent;
}

function normalizeWindowCount(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.trunc(value));
}

function filterEvents(
  events: readonly CanonicalEvent[],
  query: TapeQuery | undefined,
): readonly CanonicalEvent[] {
  if (!query) {
    return events.map(cloneEvent);
  }
  const after =
    typeof query?.after === "number" && Number.isFinite(query.after) ? query.after : null;
  const before =
    typeof query?.before === "number" && Number.isFinite(query.before) ? query.before : null;
  const last = normalizeWindowCount(query?.last);
  const offset = normalizeWindowCount(query?.offset);
  const limit = normalizeWindowCount(query?.limit);

  const matchesQuery = (event: CanonicalEvent): boolean => {
    if (query?.type && event.type !== query.type) {
      return false;
    }
    if (after !== null && event.timestamp <= after) {
      return false;
    }
    if (before !== null && event.timestamp >= before) {
      return false;
    }
    return true;
  };

  if (last !== null) {
    if (last === 0) {
      return [];
    }
    const tail: CanonicalEvent[] = [];
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (!event || !matchesQuery(event)) {
        continue;
      }
      tail.push(event);
      if (tail.length >= last) {
        break;
      }
    }
    tail.reverse();
    let window = tail;
    if (offset !== null && offset > 0) {
      window = window.slice(offset);
    }
    if (limit !== null) {
      window = window.slice(0, limit);
    }
    return window.map(cloneEvent);
  }

  const matches: CanonicalEvent[] = [];
  for (const event of events) {
    if (matchesQuery(event)) {
      matches.push(event);
    }
  }

  let window = matches;
  if (offset !== null && offset > 0) {
    window = window.slice(offset);
  }
  if (limit !== null) {
    window = window.slice(0, limit);
  }
  return window.map(cloneEvent);
}

function extractCause(event: CanonicalEvent): RuntimeRecoveryCause | null {
  if (
    event.type === "turn.ended" ||
    event.type === "runtime.suspended" ||
    event.type === "checkpoint.committed"
  ) {
    const payload = event.payload;
    if (payload && typeof payload === "object" && "cause" in payload) {
      const cause = (payload as { cause?: unknown }).cause;
      return typeof cause === "string" ? (cause as RuntimeRecoveryCause) : null;
    }
  }
  return null;
}

function projectTurnState(sessionId: string, events: readonly CanonicalEvent[]): TurnStateView {
  const lastEvent = events.at(-1) ?? null;
  const reversedEvents = events.toReversed();
  const lastCause = reversedEvents.map(extractCause).find(Boolean) ?? null;
  const lastStarted = reversedEvents.find((event) => event.type === "turn.started");
  const lastEnded = reversedEvents.find((event) => event.type === "turn.ended");
  return Object.freeze({
    sessionId,
    active: Boolean(lastStarted && (!lastEnded || lastStarted.timestamp > lastEnded.timestamp)),
    lastCause,
    lastEvent: lastEvent ? cloneEvent(lastEvent) : null,
  });
}

function projectToolCommitments(
  sessionId: string,
  events: readonly CanonicalEvent[],
): ToolCommitmentsView {
  return Object.freeze({
    sessionId,
    proposed: filterEvents(events, { type: "tool.proposed" }),
    committed: filterEvents(events, { type: "tool.committed" }),
    aborted: filterEvents(events, { type: "tool.aborted" }),
  });
}

function stableHash(value: unknown): string {
  return `sha256:redacted-stable-json:v1:${redactedStableJsonSha256Hex(value)}`;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function readOutcomeKind(value: unknown): "ok" | "err" | "inconclusive" | undefined {
  const record = isRecord(value) ? value : undefined;
  return record?.kind === "ok" || record?.kind === "err" || record?.kind === "inconclusive"
    ? record.kind
    : undefined;
}

function readOutcomeVersion(result: Record<string, unknown>): string | undefined {
  const metadata = isRecord(result.metadata) ? result.metadata : undefined;
  return isSupportedToolOutcomeVersion(metadata?.outcomeVersion)
    ? metadata.outcomeVersion
    : undefined;
}

function readAuthority(value: unknown): StepProjectionAuthority | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const authority: StepProjectionAuthority = {
    effects: readStringArray(value.effects),
    ...(optionalString(value.actionClass)
      ? { actionClass: optionalString(value.actionClass) }
      : {}),
    ...(value.receiptPolicy !== undefined
      ? { receiptPolicy: toJsonValue(value.receiptPolicy) }
      : {}),
    ...(value.recoveryPolicy !== undefined
      ? { recoveryPolicy: toJsonValue(value.recoveryPolicy) }
      : {}),
    ...(optionalString(value.source) ? { source: optionalString(value.source) } : {}),
    ...(optionalString(value.boundary) ? { boundary: optionalString(value.boundary) } : {}),
  };
  return authority;
}

function mergeStepRecord(
  records: Map<string, StepProjectionRecord>,
  commitmentId: string,
  next: Omit<StepProjectionRecord, "stepId" | "commitmentId">,
): void {
  const previous = records.get(commitmentId);
  records.set(commitmentId, {
    ...(previous ?? { stepId: commitmentId, commitmentId, status: next.status }),
    ...next,
    status: next.status,
  });
}

function projectStepProjection(
  sessionId: string,
  events: readonly CanonicalEvent[],
): StepProjectionView {
  const records = new Map<string, StepProjectionRecord>();
  for (const event of events) {
    if (
      event.type !== "tool.proposed" &&
      event.type !== "tool.committed" &&
      event.type !== "tool.aborted"
    ) {
      continue;
    }
    const payload: Record<string, unknown> = isRecord(event.payload) ? event.payload : {};
    const commitmentId = optionalString(payload.commitmentId);
    if (!commitmentId) {
      continue;
    }
    const call: Record<string, unknown> = isRecord(payload.call)
      ? payload.call
      : isRecord(payload.attemptedCall)
        ? payload.attemptedCall
        : {};
    if (event.type === "tool.proposed") {
      mergeStepRecord(records, commitmentId, {
        status: "proposed",
        proposedEventId: event.id,
        toolCallId: optionalString(call.toolCallId),
        toolName: optionalString(call.toolName),
        turnId: optionalString(call.turnId),
        inputHash: stableHash(call.args ?? {}),
        authority: readAuthority(payload.authority),
      });
      continue;
    }
    if (event.type === "tool.committed") {
      const result: Record<string, unknown> = isRecord(payload.result) ? payload.result : {};
      mergeStepRecord(records, commitmentId, {
        status: "committed",
        committedEventId: event.id,
        toolCallId: optionalString(call.toolCallId),
        toolName: optionalString(call.toolName),
        turnId: optionalString(call.turnId),
        inputHash: stableHash(call.args ?? {}),
        outputHash: stableHash(result),
        outcomeKind: readOutcomeKind(result.outcome),
        outcomeVersion: readOutcomeVersion(result),
      });
      continue;
    }
    const authority = readAuthority(payload.authority);
    mergeStepRecord(records, commitmentId, {
      status: "aborted",
      abortedEventId: event.id,
      toolCallId: optionalString(call.toolCallId),
      toolName: optionalString(call.toolName),
      turnId: optionalString(call.turnId),
      inputHash: stableHash(call.args ?? {}),
      ...(authority ? { authority } : {}),
    });
  }
  return Object.freeze({
    sessionId,
    steps: Object.freeze([...records.values()]),
  });
}

function projectRecoveryHistory(
  sessionId: string,
  events: readonly CanonicalEvent[],
): RecoveryHistoryView {
  return Object.freeze({
    sessionId,
    causes: events
      .map(extractCause)
      .filter((cause): cause is RuntimeRecoveryCause => Boolean(cause)),
  });
}

function projectCostSummary(sessionId: string, events: readonly CanonicalEvent[]): CostSummaryView {
  return Object.freeze({
    sessionId,
    events: filterEvents(events, { type: "cost.observed" }),
  });
}

function replayBaseline(sessionId: string, events: readonly CanonicalEvent[]): Baseline {
  const checkpointIndex = events.findLastIndex((event) => event.type === "checkpoint.committed");
  const checkpoint = checkpointIndex >= 0 ? (events[checkpointIndex] ?? null) : null;
  const replayEvents = checkpoint ? events.slice(checkpointIndex) : events;
  return Object.freeze({
    sessionId,
    checkpoint: checkpoint ? cloneEvent(checkpoint) : null,
    events: replayEvents.map(cloneEvent),
  });
}

export interface RuntimeTape {
  readonly tape: TapePort;
  readonly commit: TapeCommitPort;
  loadFromDisk(): readonly string[];
  listSessionIds(): readonly string[];
  close(): Promise<void>;
}

function tapeRoot(persistence: RuntimeTapePersistence): string {
  return resolve(persistence.cwd, persistence.tapeDir);
}

function tapePath(persistence: RuntimeTapePersistence, sessionId: string): string {
  return resolve(tapeRoot(persistence), `${encodeURIComponent(sessionId)}.jsonl`);
}

function parsePersistedEvent(line: string, filePath: string): CanonicalEvent {
  let parsed: Partial<CanonicalEvent>;
  try {
    parsed = JSON.parse(line) as Partial<CanonicalEvent>;
  } catch {
    throw new Error(
      `unsupported_tape_schema:malformed Remove or archive ${filePath}, then rebuild derived session-index state.`,
    );
  }
  if (
    typeof parsed.id !== "string" ||
    typeof parsed.sessionId !== "string" ||
    typeof parsed.type !== "string" ||
    !isCanonicalEventType(parsed.type) ||
    typeof parsed.timestamp !== "number"
  ) {
    const type = typeof parsed.type === "string" ? parsed.type : "missing_type";
    throw new Error(
      `unsupported_tape_schema:${type} Remove or archive ${filePath}, then rebuild derived session-index state.`,
    );
  }
  const event = freezeCanonicalEvent(parsed as CanonicalEvent);
  try {
    assertCanonicalEventPayload(event);
  } catch {
    throw new Error(
      `unsupported_tape_schema:${event.type} Remove or archive ${filePath}, then rebuild derived session-index state.`,
    );
  }
  return event;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCustomEventPayload(value: unknown): value is CustomEventPayload {
  if (!isRecord(value)) {
    return false;
  }
  const authority = value.authority;
  return (
    typeof value.namespace === "string" &&
    value.namespace.trim().length > 0 &&
    typeof value.kind === "string" &&
    value.kind.trim().length > 0 &&
    typeof value.version === "number" &&
    Number.isInteger(value.version) &&
    value.version > 0 &&
    (authority === "none" || authority === "advisory") &&
    "payload" in value
  );
}

function isStrictJsonValue(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null) {
    return true;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (typeof value !== "object") {
    return false;
  }
  if (seen.has(value)) {
    return false;
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.every((entry) => isStrictJsonValue(entry, seen));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return false;
  }
  return Object.values(value).every((entry) => isStrictJsonValue(entry, seen));
}

function isToolOutcome(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (value.kind === "ok") {
    return "value" in value && isStrictJsonValue(value.value);
  }
  if (value.kind === "err") {
    return "error" in value && isStrictJsonValue(value.error);
  }
  if (value.kind === "inconclusive") {
    return (
      (value.reason === undefined || typeof value.reason === "string") &&
      (value.value === undefined || isStrictJsonValue(value.value)) &&
      (value.evidenceRefs === undefined ||
        (Array.isArray(value.evidenceRefs) &&
          value.evidenceRefs.every((entry) => typeof entry === "string")))
    );
  }
  return false;
}

function hasLegacyToolResultFields(result: Record<string, unknown>): boolean {
  return "ok" in result || "isError" in result || "details" in result;
}

function hasUnsupportedToolOutcomeVersion(result: Record<string, unknown>): boolean {
  const metadata = isRecord(result.metadata) ? result.metadata : undefined;
  if (!metadata || !Object.prototype.hasOwnProperty.call(metadata, "outcomeVersion")) {
    return false;
  }
  return !isSupportedToolOutcomeVersion(metadata.outcomeVersion);
}

function assertCanonicalEventPayload(event: CanonicalEvent): void {
  if (event.type === "custom" && !isCustomEventPayload(event.payload)) {
    throw new Error("invalid_custom_event_payload");
  }
  if (event.type === "tool.committed") {
    const payload = isRecord(event.payload) ? event.payload : undefined;
    const result = isRecord(payload?.result) ? payload?.result : undefined;
    if (
      !result ||
      hasLegacyToolResultFields(result) ||
      hasUnsupportedToolOutcomeVersion(result) ||
      !isToolOutcome(result.outcome)
    ) {
      throw new Error("invalid_tool_committed_payload");
    }
  }
}

export function createRuntimeTape(persistence?: RuntimeTapePersistence): RuntimeTape {
  const eventsBySession = new Map<string, CanonicalEvent[]>();
  const eventsById = new Map<string, CanonicalEvent>();
  const appendFileDescriptors = new Map<string, number>();
  let rootReady = false;
  let recoveredSessions: readonly string[] = [];

  function sessionEvents(sessionId: string): CanonicalEvent[] {
    let events = eventsBySession.get(sessionId);
    if (!events) {
      events = [];
      eventsBySession.set(sessionId, events);
    }
    return events;
  }

  function ensureTapeRoot(): void {
    if (!persistence?.enabled || rootReady) {
      return;
    }
    mkdirSync(tapeRoot(persistence), { recursive: true });
    rootReady = true;
  }

  function getAppendFileDescriptor(sessionId: string): number {
    if (!persistence?.enabled) {
      throw new Error("tape_persistence_disabled");
    }
    const filePath = tapePath(persistence, sessionId);
    const existing = appendFileDescriptors.get(filePath);
    if (existing !== undefined) {
      return existing;
    }
    ensureTapeRoot();
    const fd = openSync(filePath, "a");
    appendFileDescriptors.set(filePath, fd);
    return fd;
  }

  function persistEvent(event: CanonicalEvent): void {
    if (!persistence?.enabled) {
      return;
    }
    writeSync(getAppendFileDescriptor(event.sessionId), `${JSON.stringify(event)}\n`);
  }

  function appendEventToMemory(event: CanonicalEvent): CanonicalEvent {
    const existing = eventsById.get(event.id);
    if (existing) {
      return cloneEvent(existing);
    }
    sessionEvents(event.sessionId).push(event);
    eventsById.set(event.id, event);
    return cloneEvent(event);
  }

  for (const event of persistence?.initialEvents ?? []) {
    const replayEvent = freezeCanonicalEvent(cloneInitialEvent(event));
    assertCanonicalEventPayload(replayEvent);
    appendEventToMemory(replayEvent);
  }

  const commit: TapeCommitPort = Object.freeze({
    commit(input: TapeCommitInput) {
      assertCanonicalEventPayload(input as CanonicalEvent);
      const event = freezeCanonicalEvent({
        ...input,
        ...(input.payload !== undefined
          ? { payload: normalizeCanonicalPayload(input.payload) }
          : {}),
        id: input.id ?? `evt_${randomUUID()}`,
        timestamp: input.timestamp ?? Date.now(),
      } as CanonicalEvent);
      assertCanonicalEventPayload(event);
      const existing = eventsById.get(event.id);
      if (existing) {
        return cloneEvent(existing);
      }
      const committed = appendEventToMemory(event);
      persistEvent(event);
      return committed;
    },
  });

  const tape: TapePort = Object.freeze({
    list(sessionId: string, query?: TapeQuery) {
      loadFromDisk();
      return filterEvents(sessionEvents(sessionId), query);
    },
    project<TName extends TapeViewName>(sessionId: string, name: TName): TapeView<TName> {
      loadFromDisk();
      const events = sessionEvents(sessionId);
      switch (name) {
        case "turn_state":
          return projectTurnState(sessionId, events) as TapeView<TName>;
        case "tool_commitments":
          return projectToolCommitments(sessionId, events) as TapeView<TName>;
        case "step_projection":
          return projectStepProjection(sessionId, events) as TapeView<TName>;
        case "recovery_history":
          return projectRecoveryHistory(sessionId, events) as TapeView<TName>;
        case "cost_summary":
          return projectCostSummary(sessionId, events) as TapeView<TName>;
        case "baseline":
          return replayBaseline(sessionId, events) as TapeView<TName>;
        default:
          throw new Error(`unknown_tape_view:${String(name)}`);
      }
    },
    replayBaseline(sessionId: string) {
      loadFromDisk();
      return replayBaseline(sessionId, sessionEvents(sessionId));
    },
  });

  function loadFromDisk(): readonly string[] {
    if (!persistence?.enabled) {
      return recoveredSessions;
    }
    const root = tapeRoot(persistence);
    if (!existsSync(root)) {
      recoveredSessions = [];
      return recoveredSessions;
    }

    const recovered = new Set<string>(recoveredSessions);
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      const filePath = resolve(root, entry.name);
      forEachUtf8LineSync(filePath, (line) => {
        const trimmed = line.trim();
        if (!trimmed) {
          return;
        }
        const event = parsePersistedEvent(trimmed, filePath);
        appendEventToMemory(event);
        recovered.add(event.sessionId);
      });
    }
    recoveredSessions = [...recovered].toSorted();
    return recoveredSessions;
  }

  function listSessionIds(): readonly string[] {
    loadFromDisk();
    return [...eventsBySession.keys()].toSorted();
  }

  async function close(): Promise<void> {
    for (const fd of appendFileDescriptors.values()) {
      closeSync(fd);
    }
    appendFileDescriptors.clear();
  }

  return Object.freeze({ tape, commit, loadFromDisk, listSessionIds, close });
}

export function isCanonicalEventType(value: string): value is CanonicalEventType {
  return CANONICAL_EVENT_TYPES.includes(value as CanonicalEventType);
}
