import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import {
  formatTaskStateBlock,
  TASK_AGENT_ITEM_STATUS_RUNTIME_MAP,
  TASK_AGENT_ITEM_STATUS_VALUES,
} from "@brewva/brewva-vocabulary/task";
import type { TaskItemStatus } from "@brewva/brewva-vocabulary/task";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { buildStringEnumSchema } from "../../registry/string-enum-contract.js";
import {
  addTaskItem,
  getTaskState,
  recordTaskAcceptance,
  recordTaskBlocker,
  recordTaskSpec,
  resolveTaskBlocker,
  updateTaskItem,
} from "../../runtime-port/task-ledger.js";
import { errTextResult, okTextResult } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";

const TaskItemStatusSchema = buildStringEnumSchema(TASK_AGENT_ITEM_STATUS_VALUES, {
  recommendedValue: "pending",
  guidance:
    "Use pending for not-started work, in_progress for active work, blocked for waiting, and done for finished work.",
  runtimeValueMap: TASK_AGENT_ITEM_STATUS_RUNTIME_MAP,
});

function toRuntimeTaskItemStatus(value: unknown): TaskItemStatus | undefined {
  return value === "todo" || value === "doing" || value === "done" || value === "blocked"
    ? value
    : undefined;
}

function invalidTaskStatusResult(toolAction: "add" | "update", status: unknown) {
  return errTextResult(
    `Task item ${toolAction} rejected (invalid_status). status must be one of pending, in_progress, done, blocked; use done instead of completed.`,
    {
      ok: false,
      error: "invalid_status",
      status,
    },
  );
}

function toRuntimeTaskAcceptanceStatus(
  value: unknown,
): "pending" | "accepted" | "rejected" | undefined {
  return value === "pending" || value === "accepted" || value === "rejected" ? value : undefined;
}

const taskSetSpecVerificationGuideline =
  "TaskSpec no longer carries a verification profile. Use verification.commands only when the task needs explicit command checks; otherwise verification is derived from task acceptance and recorded evidence.";

const taskItemStatusGuideline =
  "Status values are pending, in_progress, blocked, or done; use pending for not-started work and in_progress for active work.";

const taskItemCanonicalGuideline =
  "Prefer canonical statuses pending, in_progress, blocked, and done so task state stays consistent.";

const TASK_ACCEPTANCE_STATUS_VALUES = ["pending", "accepted", "rejected"] as const;
const TaskAcceptanceStatusSchema = buildStringEnumSchema(TASK_ACCEPTANCE_STATUS_VALUES, {
  guidance:
    "Use accepted when an operator closes the task, rejected when the result is not yet acceptable, and pending to reopen acceptance after new work.",
});

export function createTaskLedgerTools(options: BrewvaToolOptions): ToolDefinition[] {
  const taskSetSpecTool = createRuntimeBoundBrewvaToolFactory(options.runtime, "task_set_spec");
  const taskAddItemTool = createRuntimeBoundBrewvaToolFactory(options.runtime, "task_add_item");
  const taskUpdateItemTool = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "task_update_item",
  );
  const taskRecordBlockerTool = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "task_record_blocker",
  );
  const taskResolveBlockerTool = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "task_resolve_blocker",
  );
  const taskRecordAcceptanceTool = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "task_record_acceptance",
  );
  const taskViewStateTool = createRuntimeBoundBrewvaToolFactory(options.runtime, "task_view_state");

  const taskSetSpec = taskSetSpecTool.define(
    {
      name: "task_set_spec",
      label: "Task Set Spec",
      description: "Set or update the TaskSpec (event-sourced Task Ledger).",
      promptSnippet: "Record or refine the task goal, constraints, targets, and verification plan.",
      promptGuidelines: [
        "Use this early when the objective, constraints, or verification plan need to be made explicit.",
        taskSetSpecVerificationGuideline,
      ],
      parameters: Type.Object({
        goal: Type.String(),
        targets: Type.Optional(
          Type.Object({
            files: Type.Optional(Type.Array(Type.String())),
            symbols: Type.Optional(Type.Array(Type.String())),
          }),
        ),
        expectedBehavior: Type.Optional(Type.String()),
        constraints: Type.Optional(Type.Array(Type.String())),
        verification: Type.Optional(
          Type.Object({
            commands: Type.Optional(Type.Array(Type.String())),
          }),
        ),
        acceptance: Type.Optional(
          Type.Object({
            required: Type.Optional(Type.Boolean()),
            criteria: Type.Optional(Type.Array(Type.String())),
          }),
        ),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const sessionId = getSessionId(ctx);
        const normalizedVerification = params.verification?.commands
          ? {
              commands: params.verification?.commands,
            }
          : undefined;
        const normalizedAcceptance =
          params.acceptance?.required !== undefined || params.acceptance?.criteria !== undefined
            ? {
                required: params.acceptance?.required,
                criteria: params.acceptance?.criteria,
              }
            : undefined;

        recordTaskSpec(taskSetSpecTool.runtime, sessionId, {
          schema: "brewva.task.v1",
          goal: params.goal,
          targets: params.targets,
          expectedBehavior: params.expectedBehavior,
          constraints: params.constraints,
          verification: normalizedVerification,
          acceptance: normalizedAcceptance,
        });
        return okTextResult("TaskSpec recorded.", { ok: true });
      },
    },
    {},
  );

  const taskAddItem = taskAddItemTool.define(
    {
      name: "task_add_item",
      label: "Task Add Item",
      description: "Add a task item to the Task Ledger.",
      promptSnippet:
        "Add a concrete task item to the Task Ledger instead of tracking it only in prose.",
      promptGuidelines: [taskItemStatusGuideline],
      parameters: Type.Object({
        id: Type.Optional(Type.String()),
        text: Type.String(),
        status: Type.Optional(TaskItemStatusSchema),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const sessionId = getSessionId(ctx);
        const status = toRuntimeTaskItemStatus(params.status);
        if (params.status !== undefined && status === undefined) {
          return invalidTaskStatusResult("add", params.status);
        }
        const result = addTaskItem(taskAddItemTool.runtime, sessionId, {
          id: params.id,
          text: params.text,
          status,
        });
        if (!result.ok) {
          return errTextResult(`Task item rejected (${result.reason ?? "unknown_error"}).`, result);
        }
        return okTextResult(`Task item added (${result.itemId}).`, result);
      },
    },
    {},
  );

  const taskUpdateItem = taskUpdateItemTool.define(
    {
      name: "task_update_item",
      label: "Task Update Item",
      description: "Update a task item in the Task Ledger.",
      promptSnippet: "Update task item text or status as work progresses.",
      promptGuidelines: [taskItemCanonicalGuideline],
      parameters: Type.Object({
        id: Type.String(),
        text: Type.Optional(Type.String()),
        status: Type.Optional(TaskItemStatusSchema),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const sessionId = getSessionId(ctx);
        const status = toRuntimeTaskItemStatus(params.status);
        if (params.status !== undefined && status === undefined) {
          return invalidTaskStatusResult("update", params.status);
        }
        const result = updateTaskItem(taskUpdateItemTool.runtime, sessionId, {
          id: params.id,
          text: params.text,
          status,
        });
        if (!result.ok) {
          return errTextResult(
            `Task item update rejected (${result.reason ?? "unknown_error"}).`,
            result,
          );
        }
        return okTextResult("Task item updated.", result);
      },
    },
    {},
  );

  const taskRecordBlocker = taskRecordBlockerTool.define(
    {
      name: "task_record_blocker",
      label: "Task Record Blocker",
      description: "Record a blocker in the Task Ledger.",
      promptSnippet: "Record a concrete blocker so task state and risk stay explicit.",
      parameters: Type.Object({
        id: Type.Optional(Type.String()),
        message: Type.String(),
        source: Type.Optional(Type.String()),
        claimId: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const sessionId = getSessionId(ctx);
        const result = recordTaskBlocker(taskRecordBlockerTool.runtime, sessionId, {
          id: params.id,
          message: params.message,
          source: params.source,
          claimId: params.claimId,
        });
        if (!result.ok) {
          return errTextResult(`Blocker rejected (${result.reason ?? "unknown_error"}).`, result);
        }
        return okTextResult(`Blocker recorded (${result.blockerId}).`, result);
      },
    },
    {},
  );

  const taskResolveBlocker = taskResolveBlockerTool.define(
    {
      name: "task_resolve_blocker",
      label: "Task Resolve Blocker",
      description: "Resolve (remove) a blocker from the Task Ledger.",
      promptSnippet: "Clear a blocker once the blocking condition is resolved.",
      parameters: Type.Object({
        id: Type.String(),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const sessionId = getSessionId(ctx);
        const result = resolveTaskBlocker(taskResolveBlockerTool.runtime, sessionId, params.id);
        if (!result.ok) {
          return errTextResult(
            `Blocker resolve rejected (${result.reason ?? "unknown_error"}).`,
            result,
          );
        }
        return okTextResult("Blocker resolved.", result);
      },
    },
    {},
  );

  const taskRecordAcceptance = taskRecordAcceptanceTool.define(
    {
      name: "task_record_acceptance",
      label: "Task Record Acceptance",
      description: "Record operator-visible acceptance state for task closure.",
      promptSnippet:
        "Use this only for explicit operator acceptance closure, not for self-approval by the model.",
      promptGuidelines: [
        "Record accepted only when the operator accepts the current result as closure.",
        "Use rejected to reopen the task with a clear closure gap, or pending to clear a previous decision.",
      ],
      parameters: Type.Object({
        status: TaskAcceptanceStatusSchema,
        decidedBy: Type.Optional(Type.String()),
        notes: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const sessionId = getSessionId(ctx);
        const status = toRuntimeTaskAcceptanceStatus(params.status);
        if (!status) {
          return errTextResult("Acceptance update rejected (invalid_status).", {
            ok: false,
            error: "invalid_status",
          });
        }
        const result = recordTaskAcceptance(taskRecordAcceptanceTool.runtime, sessionId, {
          status,
          decidedBy: params.decidedBy,
          notes: params.notes,
        });
        if (!result.ok) {
          return errTextResult(
            `Acceptance update rejected (${result.reason ?? "unknown_error"}).`,
            result,
          );
        }
        return okTextResult(`Acceptance state recorded (${status}).`, result);
      },
    },
    {},
  );

  const taskViewState = taskViewStateTool.define({
    name: "task_view_state",
    label: "Task View State",
    description: "Show the current folded Task Ledger state.",
    promptSnippet: "Show the current folded task state before planning or resuming work.",
    promptGuidelines: [
      "Use this to resync with the recorded plan before adding or changing task items.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const state = getTaskState(taskViewStateTool.runtime, sessionId);
      const block = formatTaskStateBlock(state);
      return okTextResult(block || "[TaskLedger]\n(empty)", { ok: true });
    },
  });

  return [
    taskSetSpec,
    taskAddItem,
    taskUpdateItem,
    taskRecordBlocker,
    taskResolveBlocker,
    taskRecordAcceptance,
    taskViewState,
  ];
}
