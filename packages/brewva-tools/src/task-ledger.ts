import {
  formatTaskStateBlock,
  TASK_AGENT_ITEM_STATUS_RUNTIME_MAP,
  TASK_AGENT_ITEM_STATUS_VALUES,
  type TaskItemStatus,
} from "@brewva/brewva-runtime";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { buildStringEnumSchema } from "./utils/input-alias.js";
import { failTextResult, textResult } from "./utils/result.js";
import { createRuntimeBoundBrewvaToolFactory } from "./utils/runtime-bound-tool.js";
import { getSessionId } from "./utils/session.js";

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

function toRuntimeTaskAcceptanceStatus(
  value: unknown,
): "pending" | "accepted" | "rejected" | undefined {
  return value === "pending" || value === "accepted" || value === "rejected" ? value : undefined;
}

const taskSetSpecVerificationGuideline =
  "TaskSpec no longer carries a verification profile. Use verification.commands only when the task needs explicit command checks; otherwise the active skill's completion definition controls verification.";

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

        taskSetSpecTool.runtime.authority.task.setSpec(sessionId, {
          schema: "brewva.task.v1",
          goal: params.goal,
          targets: params.targets,
          expectedBehavior: params.expectedBehavior,
          constraints: params.constraints,
          verification: normalizedVerification,
          acceptance: normalizedAcceptance,
        });
        return textResult("TaskSpec recorded.", { ok: true });
      },
    },
    {
      requiredCapabilities: ["authority.task.setSpec"],
    },
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
        const result = taskAddItemTool.runtime.authority.task.addItem(sessionId, {
          id: params.id,
          text: params.text,
          status: toRuntimeTaskItemStatus(params.status),
        });
        if (!result.ok) {
          return failTextResult(`Task item rejected (${result.error ?? "unknown_error"}).`, result);
        }
        return textResult(`Task item added (${result.itemId}).`, result);
      },
    },
    {
      requiredCapabilities: ["authority.task.addItem"],
    },
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
        const result = taskUpdateItemTool.runtime.authority.task.updateItem(sessionId, {
          id: params.id,
          text: params.text,
          status: toRuntimeTaskItemStatus(params.status),
        });
        if (!result.ok) {
          return failTextResult(
            `Task item update rejected (${result.error ?? "unknown_error"}).`,
            result,
          );
        }
        return textResult("Task item updated.", result);
      },
    },
    {
      requiredCapabilities: ["authority.task.updateItem"],
    },
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
        truthFactId: Type.Optional(Type.String()),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const sessionId = getSessionId(ctx);
        const result = taskRecordBlockerTool.runtime.authority.task.recordBlocker(sessionId, {
          id: params.id,
          message: params.message,
          source: params.source,
          truthFactId: params.truthFactId,
        });
        if (!result.ok) {
          return failTextResult(`Blocker rejected (${result.error ?? "unknown_error"}).`, result);
        }
        return textResult(`Blocker recorded (${result.blockerId}).`, result);
      },
    },
    {
      requiredCapabilities: ["authority.task.recordBlocker"],
    },
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
        const result = taskResolveBlockerTool.runtime.authority.task.resolveBlocker(
          sessionId,
          params.id,
        );
        if (!result.ok) {
          return failTextResult(
            `Blocker resolve rejected (${result.error ?? "unknown_error"}).`,
            result,
          );
        }
        return textResult("Blocker resolved.", result);
      },
    },
    {
      requiredCapabilities: ["authority.task.resolveBlocker"],
    },
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
          return failTextResult("Acceptance update rejected (invalid_status).", {
            ok: false,
            error: "invalid_status",
          });
        }
        const result = taskRecordAcceptanceTool.runtime.authority.task.recordAcceptance(sessionId, {
          status,
          decidedBy: params.decidedBy,
          notes: params.notes,
        });
        if (!result.ok) {
          return failTextResult(
            `Acceptance update rejected (${result.error ?? "unknown_error"}).`,
            result,
          );
        }
        return textResult(`Acceptance state recorded (${status}).`, result);
      },
    },
    {
      requiredCapabilities: ["authority.task.recordAcceptance"],
    },
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
      const state = taskViewStateTool.runtime.inspect.task.getState(sessionId);
      const block = formatTaskStateBlock(state);
      return textResult(block || "[TaskLedger]\n(empty)", { ok: true });
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
