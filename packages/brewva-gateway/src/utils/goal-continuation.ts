import type { BrewvaPromptContentPart } from "@brewva/brewva-substrate/prompt";
import type { BrewvaPromptOptions } from "@brewva/brewva-substrate/session";
import {
  buildGoalBudgetLimitMessage,
  buildGoalContinuationMessage,
  buildGoalContinuationPayload,
  type GoalContinuationPayload,
  type GoalState,
} from "@brewva/brewva-vocabulary/goal";
import type { HostedRuntimeAdapterPort } from "../hosted/api.js";

type GoalContinuationKind = GoalContinuationPayload["kind"];
type GoalContinuationQueueResult = ReturnType<
  HostedRuntimeAdapterPort["ops"]["goal"]["continuation"]["recordQueued"]
>;

export interface EnqueueGoalContinuationInput {
  readonly sessionId: string;
  readonly goal: GoalState;
  readonly kind?: GoalContinuationKind;
  readonly now?: number;
  readonly recordQueued: (
    sessionId: string,
    payload: GoalContinuationPayload,
  ) => GoalContinuationQueueResult;
  readonly prompt: (
    parts: readonly BrewvaPromptContentPart[],
    options?: BrewvaPromptOptions,
  ) => Promise<void> | void;
  readonly promptOptions?: BrewvaPromptOptions;
}

function buildGoalContinuationPromptParts(
  goal: GoalState,
  kind: GoalContinuationKind,
): readonly BrewvaPromptContentPart[] {
  return [
    {
      type: "text",
      text:
        kind === "continue"
          ? buildGoalContinuationMessage(goal)
          : buildGoalBudgetLimitMessage(goal),
    },
  ];
}

export async function enqueueGoalContinuation(
  input: EnqueueGoalContinuationInput,
): Promise<GoalContinuationQueueResult> {
  const kind = input.kind ?? "continue";
  const queued = input.recordQueued(
    input.sessionId,
    buildGoalContinuationPayload(input.goal, kind, { now: input.now }),
  );
  if (!queued.ok) {
    return queued;
  }
  await input.prompt(buildGoalContinuationPromptParts(input.goal, kind), input.promptOptions);
  return queued;
}
