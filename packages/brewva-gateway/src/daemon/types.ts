export type DaemonLifecycleEvent =
  | { kind: "starting"; pidFilePath: string }
  | { kind: "listening"; host: string; port: number }
  | { kind: "scheduler-paused"; reason: string }
  | { kind: "scheduler-resumed" }
  | { kind: "stopping"; reason: string }
  | { kind: "stopped"; reason: string };

export type WorkerLifecycleState =
  | { kind: "spawned"; workerId: string; sessionId: string }
  | { kind: "ready"; workerId: string; sessionId: string }
  | { kind: "busy"; workerId: string; sessionId: string; turnId: string }
  | { kind: "recovering"; workerId: string; sessionId: string; reason: string }
  | { kind: "closing"; workerId: string; sessionId: string; reason: string }
  | { kind: "closed"; workerId: string; sessionId: string; reason: string };

export function createDaemonStartingEvent(pidFilePath: string): DaemonLifecycleEvent {
  return { kind: "starting", pidFilePath };
}

export function createDaemonListeningEvent(host: string, port: number): DaemonLifecycleEvent {
  return { kind: "listening", host, port };
}

export function createDaemonSchedulerPausedEvent(reason: string): DaemonLifecycleEvent {
  return { kind: "scheduler-paused", reason };
}

export function createDaemonSchedulerResumedEvent(): DaemonLifecycleEvent {
  return { kind: "scheduler-resumed" };
}

export function createDaemonStoppingEvent(reason: string): DaemonLifecycleEvent {
  return { kind: "stopping", reason };
}

export function createDaemonStoppedEvent(reason: string): DaemonLifecycleEvent {
  return { kind: "stopped", reason };
}

export function createWorkerSpawnedState(
  workerId: string,
  sessionId: string,
): WorkerLifecycleState {
  return { kind: "spawned", workerId, sessionId };
}

export function createWorkerReadyState(workerId: string, sessionId: string): WorkerLifecycleState {
  return { kind: "ready", workerId, sessionId };
}

export function createWorkerBusyState(
  workerId: string,
  sessionId: string,
  turnId: string,
): WorkerLifecycleState {
  return { kind: "busy", workerId, sessionId, turnId };
}

export function createWorkerRecoveringState(
  workerId: string,
  sessionId: string,
  reason: string,
): WorkerLifecycleState {
  return { kind: "recovering", workerId, sessionId, reason };
}

export function createWorkerClosingState(
  workerId: string,
  sessionId: string,
  reason: string,
): WorkerLifecycleState {
  return { kind: "closing", workerId, sessionId, reason };
}

export function createWorkerClosedState(
  workerId: string,
  sessionId: string,
  reason: string,
): WorkerLifecycleState {
  return { kind: "closed", workerId, sessionId, reason };
}
