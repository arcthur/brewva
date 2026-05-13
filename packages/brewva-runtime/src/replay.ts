import { ReasoningReplayEngine as InternalReasoningReplayEngine } from "./domain/tape/api.js";
import { TurnReplayEngine as InternalTurnReplayEngine } from "./domain/tape/api.js";
import { createBoundExtensionPort, type ExtensionPort } from "./runtime/runtime-extensions.js";

const REASONING_REPLAY_ENGINE_METHODS = [
  "replay",
  "observeEvent",
  "getActiveState",
  "listCheckpoints",
  "getCheckpoint",
  "listReverts",
  "canRevertTo",
  "invalidate",
  "clear",
] as const satisfies readonly (keyof InstanceType<typeof InternalReasoningReplayEngine>)[];
const TURN_REPLAY_ENGINE_METHODS = [
  "replay",
  "observeEvent",
  "getTaskState",
  "getClaimState",
  "getCostSummary",
  "getCostSkillLastTurnByName",
  "getRecentToolFailures",
  "getCheckpointEvidenceState",
  "getCheckpointProjectionState",
  "invalidate",
  "clear",
  "hasSession",
] as const satisfies readonly (keyof InstanceType<typeof InternalTurnReplayEngine>)[];

export type ReasoningReplayEngine = ExtensionPort<
  "replay.reasoning",
  Pick<
    InstanceType<typeof InternalReasoningReplayEngine>,
    (typeof REASONING_REPLAY_ENGINE_METHODS)[number]
  >
>;
export type TurnReplayEngine = ExtensionPort<
  "replay.turn",
  Pick<InstanceType<typeof InternalTurnReplayEngine>, (typeof TURN_REPLAY_ENGINE_METHODS)[number]>
>;

export function createReasoningReplayEngine(
  ...args: ConstructorParameters<typeof InternalReasoningReplayEngine>
): ReasoningReplayEngine {
  return createBoundExtensionPort({
    name: "replay.reasoning",
    instance: new InternalReasoningReplayEngine(...args),
    methods: REASONING_REPLAY_ENGINE_METHODS,
  });
}

export function createTurnReplayEngine(
  ...args: ConstructorParameters<typeof InternalTurnReplayEngine>
): TurnReplayEngine {
  return createBoundExtensionPort({
    name: "replay.turn",
    instance: new InternalTurnReplayEngine(...args),
    methods: TURN_REPLAY_ENGINE_METHODS,
  });
}
