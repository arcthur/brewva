import type { BrewvaSessionId } from "@brewva/brewva-runtime";

export {
  resolveManagedSessionBootstrapPhase,
  resolveRecoveryCrashAnchor,
  subscribeManagedSessionWireHydration,
  type ManagedSessionBootstrapSink,
  type ManagedSessionBootstrapStorePort,
} from "./bootstrap.js";
export {
  ManagedSessionPhaseCoordinator,
  type ManagedSessionPhaseCoordinatorOptions,
} from "./coordinator.js";
export {
  deriveCompatibilityValidationEvent,
  deriveSessionPhaseFromLifecycleSnapshot,
  inferRecoveryCrashPoint,
  resolveModelCallId,
  resolvePhaseTurn,
  sameSessionPhase,
} from "./projection.js";
export {
  deriveSessionPhaseFromRuntimeFactFrame,
  deriveSessionPhaseFromRuntimeFactHistory,
  type RuntimeFactSessionPhaseProjection,
} from "./runtime-facts.js";

export type HostedSessionPhase =
  | { kind: "init"; sessionId?: BrewvaSessionId }
  | {
      kind: "provider-bound";
      sessionId: BrewvaSessionId;
      providerApi: string;
    }
  | { kind: "tool-bound"; sessionId: BrewvaSessionId; toolNames: readonly string[] }
  | { kind: "ready"; sessionId: BrewvaSessionId }
  | { kind: "turn-active"; sessionId: BrewvaSessionId; turnId: string }
  | { kind: "recovering"; sessionId: BrewvaSessionId; cause: string }
  | { kind: "closing"; sessionId: BrewvaSessionId; reason: string }
  | { kind: "closed"; sessionId: BrewvaSessionId; reason: string };
