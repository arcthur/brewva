import { isRecord } from "@brewva/brewva-std/unknown";
import type {
  BrewvaRuntime,
  BrewvaRuntimeOptions,
  CanonicalEvent,
  RuntimePhysicsDeclaration,
  RuntimeProviderPort,
  RuntimeReplaySource,
  RuntimeReplayTarget,
  RuntimeToolExecutorPort,
  SessionId,
  TapeCommitPort,
  TurnFrame,
} from "../runtime-api.js";
import { createTurnRunner } from "./impl.js";

function isProviderPort(value: unknown): value is RuntimeProviderPort {
  return isRecord(value) && typeof value.stream === "function";
}

function isToolExecutorPort(value: unknown): value is RuntimeToolExecutorPort {
  return isRecord(value) && typeof value.execute === "function";
}

function isReplaySource(value: unknown): value is RuntimeReplaySource {
  return isRecord(value) && Array.isArray(value.events);
}

function isReplayTarget(value: unknown): value is RuntimeReplayTarget {
  return isRecord(value) && typeof value.sessionId === "string" && value.sessionId.length > 0;
}

function assertProviderPort(value: unknown, reason: string): RuntimeProviderPort {
  if (!isProviderPort(value)) {
    throw new Error(reason);
  }
  return value;
}

function assertToolExecutorPort(value: unknown, reason: string): RuntimeToolExecutorPort {
  if (!isToolExecutorPort(value)) {
    throw new Error(reason);
  }
  return value;
}

function assertReplaySource(value: unknown, reason: string): RuntimeReplaySource {
  if (!isReplaySource(value)) {
    throw new Error(reason);
  }
  return value;
}

function assertReplayTarget(value: unknown): RuntimeReplayTarget {
  if (!isReplayTarget(value)) {
    throw new Error("runtime_physics_replay_target_required");
  }
  return value;
}

export function normalizeRuntimePhysics(
  value: BrewvaRuntimeOptions["physics"],
): RuntimePhysicsDeclaration {
  if (!isRecord(value) || typeof value.mode !== "string") {
    throw new Error("runtime_physics_required");
  }
  switch (value.mode) {
    case "real":
      assertProviderPort(value.provider, "runtime_physics_real_requires_provider");
      assertToolExecutorPort(value.toolExecutor, "runtime_physics_real_requires_tool_executor");
      return value;
    case "replay":
      if ("provider" in value || "toolExecutor" in value || "resolveToolAuthority" in value) {
        throw new Error("runtime_physics_replay_is_read_only");
      }
      assertReplaySource(value.source, "runtime_physics_replay_requires_source");
      return value;
    case "replay-then-real":
      assertReplaySource(value.source, "runtime_physics_replay_requires_source");
      assertReplayTarget(value.target);
      assertProviderPort(value.provider, "runtime_physics_replay_then_real_requires_provider");
      assertToolExecutorPort(
        value.toolExecutor,
        "runtime_physics_replay_then_real_requires_tool_executor",
      );
      if (typeof value.divergeAt !== "string" || value.divergeAt.length === 0) {
        throw new Error("runtime_physics_replay_diverge_at_required");
      }
      if (value.source.sessionId && value.source.sessionId === value.target.sessionId) {
        throw new Error("runtime_physics_replay_target_must_fork_session");
      }
      return value;
    case "noop":
      if ("provider" in value || "toolExecutor" in value || "resolveToolAuthority" in value) {
        throw new Error("runtime_physics_noop_has_no_world_ports");
      }
      return value;
    default:
      throw new Error("unknown_runtime_physics");
  }
}

function selectReplaySourceEvents(source: RuntimeReplaySource): readonly CanonicalEvent[] {
  if (!source.sessionId) {
    return [...source.events];
  }
  return source.events.filter((event) => event.sessionId === source.sessionId);
}

function selectReplayEventsThroughDivergence(input: {
  readonly source: RuntimeReplaySource;
  readonly divergeAt: string;
}): readonly CanonicalEvent[] {
  const replayEvents: CanonicalEvent[] = [];
  for (const event of selectReplaySourceEvents(input.source)) {
    replayEvents.push(event);
    if (event.id === input.divergeAt) {
      return replayEvents;
    }
  }
  throw new Error("runtime_physics_replay_diverge_event_not_found");
}

function cloneReplayEventForTarget(
  event: CanonicalEvent,
  targetSessionId: SessionId,
  eventIdMap: ReadonlyMap<string, string>,
): CanonicalEvent {
  const payload =
    event.payload === undefined
      ? undefined
      : remapReplayEventIdReferences(structuredClone(event.payload), eventIdMap);
  return {
    ...event,
    id: eventIdMap.get(event.id) ?? forkReplayEventId(event.id, targetSessionId),
    sessionId: targetSessionId,
    ...(payload === undefined ? {} : { payload }),
  } as CanonicalEvent;
}

function forkReplayEventId(sourceEventId: string, targetSessionId: SessionId): string {
  return `evt_replay_${encodeURIComponent(targetSessionId)}_${sourceEventId}`;
}

function remapReplayEventIdReferences(
  value: unknown,
  eventIdMap: ReadonlyMap<string, string>,
): unknown {
  if (typeof value === "string") {
    return eventIdMap.get(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => remapReplayEventIdReferences(item, eventIdMap));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        remapReplayEventIdReferences(entry, eventIdMap),
      ]),
    );
  }
  return value;
}

function cloneReplayEventsForTarget(
  events: readonly CanonicalEvent[],
  targetSessionId: SessionId,
): readonly CanonicalEvent[] {
  const eventIdMap = new Map(
    events.map((event) => [event.id, forkReplayEventId(event.id, targetSessionId)]),
  );
  return events.map((event) => cloneReplayEventForTarget(event, targetSessionId, eventIdMap));
}

export function replayEventsForRuntimePhysics(
  physics: RuntimePhysicsDeclaration,
): readonly CanonicalEvent[] {
  if (physics.mode === "replay") {
    return selectReplaySourceEvents(physics.source);
  }
  if (physics.mode === "replay-then-real") {
    const replayPrefix = selectReplayEventsThroughDivergence({
      source: physics.source,
      divergeAt: physics.divergeAt,
    });
    return cloneReplayEventsForTarget(replayPrefix, physics.target.sessionId);
  }
  return [];
}

export function runtimePhysicsUsesDurableTape(physics: RuntimePhysicsDeclaration): boolean {
  return physics.mode !== "replay";
}

function replaySessionIds(events: readonly CanonicalEvent[]): readonly SessionId[] {
  return [...new Set(events.map((event) => event.sessionId))].toSorted();
}

export function recoveredSessionsForRuntimePhysics(input: {
  readonly physics: RuntimePhysicsDeclaration;
  readonly replayEvents: readonly CanonicalEvent[];
}): readonly SessionId[] | undefined {
  return input.physics.mode === "replay" ? replaySessionIds(input.replayEvents) : undefined;
}

function createDisabledTapeCommitPort(reason: string): TapeCommitPort {
  return Object.freeze({
    commit(): never {
      throw new Error(reason);
    },
  });
}

export function createRuntimePhysicsCommitPort(input: {
  readonly physics: RuntimePhysicsDeclaration;
  readonly commit: TapeCommitPort;
}): TapeCommitPort {
  return input.physics.mode === "replay"
    ? createDisabledTapeCommitPort("runtime_physics_replay_is_read_only")
    : input.commit;
}

function createNoopTurnRunner(): BrewvaRuntime["turn"] {
  return function runNoopTurn(): AsyncIterable<TurnFrame> {
    throw new Error("runtime_physics_noop_turn_disabled");
  };
}

function createReplayTurnRunner(input: {
  readonly tape: BrewvaRuntime["tape"];
  readonly source: RuntimeReplaySource;
}): BrewvaRuntime["turn"] {
  return async function* runReplayTurn(turn): AsyncIterable<TurnFrame> {
    if (input.source.sessionId && turn.sessionId !== input.source.sessionId) {
      throw new Error("runtime_physics_replay_session_mismatch");
    }
    for (const event of input.tape.list(turn.sessionId)) {
      yield { type: "runtime.event", event };
    }
  };
}

function createReplayThenRealTurnRunner(input: {
  readonly target: RuntimeReplayTarget;
  readonly replayEvents: readonly CanonicalEvent[];
  readonly realTurn: BrewvaRuntime["turn"];
}): BrewvaRuntime["turn"] {
  let replayEmitted = false;
  return async function* runReplayThenRealTurn(turn): AsyncIterable<TurnFrame> {
    if (turn.sessionId !== input.target.sessionId) {
      throw new Error("runtime_physics_replay_target_session_mismatch");
    }
    if (!replayEmitted) {
      replayEmitted = true;
      for (const event of input.replayEvents) {
        yield { type: "runtime.event", event };
      }
    }
    yield* input.realTurn(turn);
  };
}

export function createRuntimePhysicsTurnRunner(input: {
  readonly physics: RuntimePhysicsDeclaration;
  readonly replayEvents: readonly CanonicalEvent[];
  readonly tape: BrewvaRuntime["tape"];
  readonly commit: TapeCommitPort;
  readonly kernel: BrewvaRuntime["kernel"];
  readonly model: BrewvaRuntime["model"];
}): BrewvaRuntime["turn"] {
  if (input.physics.mode === "noop") {
    return createNoopTurnRunner();
  }
  if (input.physics.mode === "replay") {
    return createReplayTurnRunner({ tape: input.tape, source: input.physics.source });
  }
  const realTurn = createTurnRunner({
    tape: input.commit,
    kernel: input.kernel,
    model: input.model,
    provider: input.physics.provider,
    toolExecutor: input.physics.toolExecutor,
  });
  if (input.physics.mode === "replay-then-real") {
    return createReplayThenRealTurnRunner({
      target: input.physics.target,
      replayEvents: input.replayEvents,
      realTurn,
    });
  }
  return realTurn;
}
