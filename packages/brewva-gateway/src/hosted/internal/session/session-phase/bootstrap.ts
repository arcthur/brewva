import type { SessionPhase } from "@brewva/brewva-substrate/session";
import type { SessionLifecycleSnapshot } from "@brewva/brewva-vocabulary/session";
import type { SessionWireFrame } from "@brewva/brewva-vocabulary/wire";
import { deriveSessionPhaseFromLifecycleSnapshot, inferRecoveryCrashPoint } from "./projection.js";
import {
  deriveSessionPhaseFromRuntimeFactFrame,
  deriveSessionPhaseFromRuntimeFactHistory,
} from "./runtime-facts.js";

export interface ManagedSessionBootstrapStorePort {
  getSessionId(): string;
  readLifecycle?(): SessionLifecycleSnapshot | undefined;
  querySessionWire?(): SessionWireFrame[];
  subscribeSessionWire?(listener: (frame: SessionWireFrame) => void): () => void;
}

export interface ManagedSessionBootstrapSink {
  resolvePhaseTurn(): number;
  reconcileSessionPhase(phase: SessionPhase): Promise<void>;
  transitionCrashAndResume(anchor: string): Promise<void>;
  getSessionPhase(): SessionPhase;
  syncContextState(): Promise<void>;
}

export function resolveManagedSessionBootstrapPhase(
  store: ManagedSessionBootstrapStorePort,
  fallbackTurn: number,
): SessionPhase | null {
  const lifecycleSnapshot = store.readLifecycle?.();
  const lifecycleProjection = lifecycleSnapshot
    ? deriveSessionPhaseFromLifecycleSnapshot(lifecycleSnapshot, fallbackTurn)
    : null;
  if (lifecycleProjection) {
    return lifecycleProjection.phase;
  }
  const runtimeFactHistory = store.querySessionWire?.();
  if (!runtimeFactHistory || runtimeFactHistory.length === 0) {
    return null;
  }
  return deriveSessionPhaseFromRuntimeFactHistory(store.getSessionId(), runtimeFactHistory).phase;
}

export function subscribeManagedSessionWireHydration(
  store: ManagedSessionBootstrapStorePort,
  sink: ManagedSessionBootstrapSink,
): (() => void) | null {
  return (
    store.subscribeSessionWire?.((frame) => {
      void hydrateManagedSessionWireFrame(frame, sink);
    }) ?? null
  );
}

async function hydrateManagedSessionWireFrame(
  frame: SessionWireFrame,
  sink: ManagedSessionBootstrapSink,
): Promise<void> {
  if (
    frame.type === "turn.transition" &&
    frame.status === "entered" &&
    frame.family === "recovery" &&
    frame.reason === "wal_recovery_resume" &&
    sink.getSessionPhase().kind !== "crashed" &&
    sink.getSessionPhase().kind !== "recovering" &&
    sink.getSessionPhase().kind !== "terminated"
  ) {
    await sink.transitionCrashAndResume(`transition:${frame.reason}`);
  }

  const next = deriveSessionPhaseFromRuntimeFactFrame(
    sink.getSessionPhase(),
    frame,
    sink.resolvePhaseTurn(),
  );
  if (!next) {
    return;
  }
  await sink.reconcileSessionPhase(next.phase);
  await sink.syncContextState();
}

export function resolveRecoveryCrashAnchor(phase: SessionPhase): string {
  return `transition:${inferRecoveryCrashPoint(phase)}`;
}
