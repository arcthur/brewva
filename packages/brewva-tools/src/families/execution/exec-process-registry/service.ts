import { BrewvaBoundaryFailure } from "@brewva/brewva-effect";
import {
  BrewvaContext,
  BrewvaEffect,
  BrewvaLayer,
  BrewvaStream,
} from "@brewva/brewva-effect/primitives";
import { startManagedBoxExecEffect, terminateRunningBoxSessionEffect } from "./box.js";
import { startManagedExecEffect, terminateRunningSessionEffect } from "./host.js";
import {
  cleanupExpiredFinishedSessions,
  createManagedExecProcessRegistryState,
  disposeManagedExecProcessRegistry,
  getManagedSession,
  type ManagedExecProcessRegistryState,
} from "./internal/state.js";
import {
  consumeManagedSessionOutputEffect,
  deleteManagedSession,
  getFinishedBoxSession,
  getFinishedSession,
  getRunningBoxSession,
  getRunningSession,
  listFinishedBackgroundSessions,
  listFinishedBoxBackgroundSessions,
  listRunningBackgroundSessions,
  listRunningBoxBackgroundSessions,
  markSessionBackgrounded,
  streamManagedSessionOutput,
  waitForManagedSessionActivityEffect,
} from "./sessions.js";
import type {
  ManagedBoxExecFinishedSession,
  ManagedBoxExecRunningSession,
  ManagedBoxExecStartInput,
  ManagedBoxExecStartResult,
  ManagedExecFinishedSession,
  ManagedExecOutputEvent,
  ManagedExecRunningSession,
  ManagedExecSessionNotFoundError,
  ManagedExecStartError,
  ManagedExecStartInput,
  ManagedExecStartResult,
  ManagedSession,
} from "./types.js";

export interface ManagedExecProcessRegistry {
  readonly startHost: (
    input: ManagedExecStartInput,
  ) => BrewvaEffect.Effect<ManagedExecStartResult, ManagedExecStartError>;
  readonly startBox: (
    input: ManagedBoxExecStartInput,
  ) => BrewvaEffect.Effect<ManagedBoxExecStartResult, ManagedExecStartError>;
  readonly getManaged: (
    ownerSessionId: string,
    sessionId: string,
  ) => BrewvaEffect.Effect<ManagedSession | undefined>;
  readonly getRunning: (
    ownerSessionId: string,
    sessionId: string,
  ) => BrewvaEffect.Effect<ManagedExecRunningSession | undefined>;
  readonly getRunningBox: (
    ownerSessionId: string,
    sessionId: string,
  ) => BrewvaEffect.Effect<ManagedBoxExecRunningSession | undefined>;
  readonly getFinished: (
    ownerSessionId: string,
    sessionId: string,
  ) => BrewvaEffect.Effect<ManagedExecFinishedSession | undefined>;
  readonly getFinishedBox: (
    ownerSessionId: string,
    sessionId: string,
  ) => BrewvaEffect.Effect<ManagedBoxExecFinishedSession | undefined>;
  readonly listRunningBackground: (
    ownerSessionId: string,
  ) => BrewvaEffect.Effect<ManagedExecRunningSession[]>;
  readonly listRunningBoxBackground: (
    ownerSessionId: string,
  ) => BrewvaEffect.Effect<ManagedBoxExecRunningSession[]>;
  readonly listFinishedBackground: (
    ownerSessionId: string,
  ) => BrewvaEffect.Effect<ManagedExecFinishedSession[]>;
  readonly listFinishedBoxBackground: (
    ownerSessionId: string,
  ) => BrewvaEffect.Effect<ManagedBoxExecFinishedSession[]>;
  readonly markBackgrounded: (
    ownerSessionId: string,
    sessionId: string,
  ) => BrewvaEffect.Effect<boolean>;
  readonly delete: (ownerSessionId: string, sessionId: string) => BrewvaEffect.Effect<boolean>;
  readonly terminateHost: (
    session: ManagedExecRunningSession,
    force?: boolean,
  ) => BrewvaEffect.Effect<boolean>;
  readonly terminateBox: (
    session: ManagedBoxExecRunningSession,
    force?: boolean,
  ) => BrewvaEffect.Effect<boolean, BrewvaBoundaryFailure>;
  readonly streamOutput: (
    ownerSessionId: string,
    sessionId: string,
  ) => BrewvaStream.Stream<ManagedExecOutputEvent, ManagedExecSessionNotFoundError>;
  readonly consumeOutput: <E = never, R = never>(
    ownerSessionId: string,
    sessionId: string,
    sink: (event: ManagedExecOutputEvent) => BrewvaEffect.Effect<void, E, R> | void,
  ) => BrewvaEffect.Effect<void, ManagedExecSessionNotFoundError | E, R>;
  readonly waitActivity: (
    ownerSessionId: string,
    sessionId: string,
    timeoutMs: number,
  ) => BrewvaEffect.Effect<void>;
  readonly cleanupExpired: (now?: number) => BrewvaEffect.Effect<void>;
  readonly dispose: () => BrewvaEffect.Effect<void>;
}

function makeManagedExecProcessRegistryFromState(
  state: ManagedExecProcessRegistryState,
): ManagedExecProcessRegistry {
  return {
    startHost: (input) => startManagedExecEffect(state, input),
    startBox: (input) => startManagedBoxExecEffect(state, input),
    getManaged: (ownerSessionId, sessionId) =>
      BrewvaEffect.sync(() => getManagedSession(state, ownerSessionId, sessionId)),
    getRunning: (ownerSessionId, sessionId) =>
      BrewvaEffect.sync(() => getRunningSession(state, ownerSessionId, sessionId)),
    getRunningBox: (ownerSessionId, sessionId) =>
      BrewvaEffect.sync(() => getRunningBoxSession(state, ownerSessionId, sessionId)),
    getFinished: (ownerSessionId, sessionId) =>
      BrewvaEffect.sync(() => getFinishedSession(state, ownerSessionId, sessionId)),
    getFinishedBox: (ownerSessionId, sessionId) =>
      BrewvaEffect.sync(() => getFinishedBoxSession(state, ownerSessionId, sessionId)),
    listRunningBackground: (ownerSessionId) =>
      BrewvaEffect.sync(() => listRunningBackgroundSessions(state, ownerSessionId)),
    listRunningBoxBackground: (ownerSessionId) =>
      BrewvaEffect.sync(() => listRunningBoxBackgroundSessions(state, ownerSessionId)),
    listFinishedBackground: (ownerSessionId) =>
      BrewvaEffect.sync(() => listFinishedBackgroundSessions(state, ownerSessionId)),
    listFinishedBoxBackground: (ownerSessionId) =>
      BrewvaEffect.sync(() => listFinishedBoxBackgroundSessions(state, ownerSessionId)),
    markBackgrounded: (ownerSessionId, sessionId) =>
      BrewvaEffect.sync(() => markSessionBackgrounded(state, ownerSessionId, sessionId)),
    delete: (ownerSessionId, sessionId) =>
      BrewvaEffect.sync(() => deleteManagedSession(state, ownerSessionId, sessionId)),
    terminateHost: terminateRunningSessionEffect,
    terminateBox: terminateRunningBoxSessionEffect,
    streamOutput: (ownerSessionId, sessionId) =>
      streamManagedSessionOutput(state, ownerSessionId, sessionId),
    consumeOutput: (ownerSessionId, sessionId, sink) =>
      consumeManagedSessionOutputEffect(state, ownerSessionId, sessionId, sink),
    waitActivity: (ownerSessionId, sessionId, timeoutMs) =>
      waitForManagedSessionActivityEffect(state, ownerSessionId, sessionId, timeoutMs),
    cleanupExpired: (now) =>
      BrewvaEffect.sync(() => cleanupExpiredFinishedSessions(state, now ?? Date.now())),
    dispose: () => BrewvaEffect.promise(() => disposeManagedExecProcessRegistry(state)),
  };
}

const makeManagedExecProcessRegistry = BrewvaEffect.fn("tools.exec.processRegistry.make")(
  function* () {
    const state = createManagedExecProcessRegistryState();
    const registry = makeManagedExecProcessRegistryFromState(state);
    yield* BrewvaEffect.addFinalizer(() => registry.dispose());
    return registry;
  },
);

export class ManagedExecProcessRegistryService extends BrewvaContext.Service<
  ManagedExecProcessRegistryService,
  ManagedExecProcessRegistry
>()("@brewva/Tools/ManagedExecProcessRegistry") {
  static layer() {
    return BrewvaLayer.effect(this, makeManagedExecProcessRegistry());
  }
}
