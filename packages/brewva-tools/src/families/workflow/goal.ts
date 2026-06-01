import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { formatGoalUsage } from "@brewva/brewva-vocabulary/goal";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { blockGoal, completeGoal, getGoalState } from "../../runtime-port/goal.js";
import { errTextResult, okTextResult } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";

function formatGoalStateText(goal: NonNullable<ReturnType<typeof getGoalState>>): string {
  const remaining =
    goal.tokenBudget === null
      ? "unlimited"
      : String(Math.max(0, goal.tokenBudget - goal.usage.tokens));
  return [
    `Goal: ${goal.objective}`,
    `Status: ${goal.status}`,
    `Usage: ${formatGoalUsage(goal.usage)}`,
    `Token budget remaining: ${remaining}`,
  ].join("\n");
}

export function createGoalTools(options: BrewvaToolOptions): ToolDefinition[] {
  const getGoalTool = createRuntimeBoundBrewvaToolFactory(options.runtime, "get_goal");
  const updateGoalTool = createRuntimeBoundBrewvaToolFactory(options.runtime, "update_goal");

  const getGoal = getGoalTool.define(
    {
      name: "get_goal",
      label: "Get Goal",
      description: "Read the active Brewva goal for this session.",
      promptSnippet:
        "Inspect the active goal, usage, and budget before deciding whether to continue.",
      parameters: Type.Object({}),
      async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
        const sessionId = getSessionId(ctx);
        const goal = getGoalState(getGoalTool.runtime, sessionId);
        if (!goal || goal.status !== "active") {
          return errTextResult("No active goal is set.", {
            ok: false,
            error: "goal_not_active",
          });
        }
        return okTextResult(formatGoalStateText(goal), {
          ok: true,
          goal,
        });
      },
    },
    { surface: "control_plane", actionClass: "runtime_observe" },
  );

  const updateGoal = updateGoalTool.define(
    {
      name: "update_goal",
      label: "Update Goal",
      description: "Mark the active Brewva goal complete or blocked after audit.",
      promptSnippet:
        "Use only after auditing the objective. Blocked requires repeated identical blocker evidence.",
      promptGuidelines: [
        "Do not mark complete merely because budget is low or the turn is ending.",
        "Blocked requires reason and concrete evidence from the same blocker across three goal turns.",
      ],
      parameters: Type.Object({
        status: Type.Union([Type.Literal("complete"), Type.Literal("blocked")]),
        reason: Type.Optional(Type.String()),
        evidence: Type.Optional(Type.Array(Type.String())),
        blockerKey: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const sessionId = getSessionId(ctx);
        const goal = getGoalState(updateGoalTool.runtime, sessionId);
        if (!goal || goal.status !== "active") {
          return errTextResult("Goal update rejected: no active goal is set.", {
            ok: false,
            error: "goal_not_active",
          });
        }
        if (params.status === "complete") {
          const result = completeGoal(updateGoalTool.runtime, sessionId, {
            reason: params.reason,
            evidence: params.evidence ?? [],
          });
          return result.ok
            ? okTextResult("Goal marked complete.", result)
            : errTextResult(`Goal completion rejected (${result.reason}).`, result);
        }
        const reason = params.reason?.trim() ?? "";
        const evidence = params.evidence?.filter((entry) => entry.trim().length > 0) ?? [];
        if (!reason || evidence.length === 0) {
          return errTextResult(
            "Goal block rejected: blocked status requires reason and evidence.",
            {
              ok: false,
              error: "missing_block_evidence",
            },
          );
        }
        const result = blockGoal(updateGoalTool.runtime, sessionId, {
          reason,
          evidence,
          blockerKey: params.blockerKey,
        });
        return result.ok
          ? okTextResult("Goal marked blocked.", result)
          : errTextResult(`Goal block rejected (${result.reason}).`, result);
      },
    },
    { surface: "control_plane", actionClass: "control_state_mutation" },
  );

  return [getGoal, updateGoal];
}
