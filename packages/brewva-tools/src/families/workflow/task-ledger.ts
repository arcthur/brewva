import { readStringList } from "@brewva/brewva-std/text";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import {
  formatTaskStateBlock,
  REQUIREMENT_MODALITIES,
  REQUIREMENT_RISK_CLASSES,
  resolveRequirementAtoms,
  TASK_AGENT_ITEM_STATUS_RUNTIME_MAP,
  TASK_AGENT_ITEM_STATUS_VALUES,
} from "@brewva/brewva-vocabulary/task";
import type {
  RequirementModality,
  RequirementRiskClass,
  ResolvedRequirementAtoms,
  TaskItemStatus,
} from "@brewva/brewva-vocabulary/task";
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
import { readLiteral } from "../../utils/literal.js";
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

const taskSetSpecObservableSignalsGuideline =
  "In requirements[].observableSignals, name the concrete API constructs that would evidence the requirement (e.g. the specific functions, types, or config keys a reviewer would grep for) — a machine-legible hint for what to look at, never a gate.";

const taskItemStatusGuideline =
  "Status values are pending, in_progress, blocked, or done; use pending for not-started work and in_progress for active work.";

const taskItemCanonicalGuideline =
  "Prefer canonical statuses pending, in_progress, blocked, and done so task state stays consistent.";

const TASK_ACCEPTANCE_STATUS_VALUES = ["pending", "accepted", "rejected"] as const;
const TaskAcceptanceStatusSchema = buildStringEnumSchema(TASK_ACCEPTANCE_STATUS_VALUES, {
  guidance:
    "Use accepted when an operator closes the task, rejected when the result is not yet acceptable, and pending to reopen acceptance after new work.",
});

const RequirementModalitySchema = Type.Union(
  REQUIREMENT_MODALITIES.map((value) => Type.Literal(value)),
);

const RequirementRiskClassSchema = Type.Union(
  REQUIREMENT_RISK_CLASSES.map((value) => Type.Literal(value)),
);

interface RequirementAtomEntryInput {
  readonly statement: string;
  readonly modality: RequirementModality;
  readonly riskClass?: RequirementRiskClass;
  readonly observableSignals?: readonly string[];
  readonly verificationStrategy?: string | null;
  readonly runtimePrerequisites?: readonly string[];
}

/**
 * Builds the four OPTIONAL enrichment fields for one incoming requirement
 * entry. Per the W3 contract, malformed enrichment COERCES rather than
 * rejecting the call: `observableSignals` / `runtimePrerequisites` fall back
 * to `readStringList` (non-array or non-string entries drop silently, same
 * idiom `verification_record` uses for its own optional string-list
 * params), and `verificationStrategy` accepts a string or explicit `null`
 * and is otherwise omitted. Only `riskClass` gates the whole call (see
 * `readRequirementAtomEntries`) because it is a closed enum the model must
 * pick correctly, not free-form text or a list.
 */
function readRequirementAtomEnrichment(entry: {
  readonly observableSignals?: unknown;
  readonly verificationStrategy?: unknown;
  readonly runtimePrerequisites?: unknown;
}): Pick<
  RequirementAtomEntryInput,
  "observableSignals" | "verificationStrategy" | "runtimePrerequisites"
> {
  const enrichment: {
    observableSignals?: readonly string[];
    verificationStrategy?: string | null;
    runtimePrerequisites?: readonly string[];
  } = {};
  if (entry.observableSignals !== undefined) {
    enrichment.observableSignals = readStringList(entry.observableSignals);
  }
  if (typeof entry.verificationStrategy === "string" || entry.verificationStrategy === null) {
    enrichment.verificationStrategy = entry.verificationStrategy;
  }
  if (entry.runtimePrerequisites !== undefined) {
    enrichment.runtimePrerequisites = readStringList(entry.runtimePrerequisites);
  }
  return enrichment;
}

/**
 * Validates every incoming requirement entry up front and either returns the
 * whole list typed, or names exactly one offending entry. Matches the
 * file-local idiom in `verification-record.ts`: an invalid entry rejects the
 * WHOLE call rather than being silently dropped, so the result text never
 * under-reports how many atoms were actually recorded. `riskClass` follows
 * `modality`'s all-or-nothing enum rule (an unrecognized value rejects the
 * whole call); the remaining three enrichment fields coerce instead
 * (`readRequirementAtomEnrichment`) since they are free-form text/lists, not
 * closed enums.
 */
function readRequirementAtomEntries(
  entries: readonly {
    readonly statement?: unknown;
    readonly modality?: unknown;
    readonly riskClass?: unknown;
    readonly observableSignals?: unknown;
    readonly verificationStrategy?: unknown;
    readonly runtimePrerequisites?: unknown;
  }[],
):
  | { readonly ok: true; readonly entries: readonly RequirementAtomEntryInput[] }
  | {
      readonly ok: false;
      readonly message: string;
    } {
  const resolved: RequirementAtomEntryInput[] = [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry.statement !== "string") {
      return {
        ok: false,
        message: `Task set spec rejected (invalid_requirement_statement). requirements[${index}].statement must be a string; got ${JSON.stringify(entry.statement)}.`,
      };
    }
    const modality = readLiteral(entry.modality, REQUIREMENT_MODALITIES);
    if (!modality) {
      return {
        ok: false,
        message:
          `Task set spec rejected (invalid_requirement_modality). requirements[${index}] ` +
          `("${entry.statement}") has modality ${JSON.stringify(entry.modality)}; ` +
          `must be one of ${REQUIREMENT_MODALITIES.join(", ")}.`,
      };
    }
    let riskClass: RequirementRiskClass | undefined;
    if (entry.riskClass !== undefined) {
      riskClass = readLiteral(entry.riskClass, REQUIREMENT_RISK_CLASSES);
      if (!riskClass) {
        return {
          ok: false,
          message:
            `Task set spec rejected (invalid_requirement_risk_class). requirements[${index}] ` +
            `("${entry.statement}") has riskClass ${JSON.stringify(entry.riskClass)}; ` +
            `must be one of ${REQUIREMENT_RISK_CLASSES.join(", ")}.`,
        };
      }
    }
    resolved.push({
      statement: entry.statement,
      modality,
      ...(riskClass !== undefined ? { riskClass } : {}),
      ...readRequirementAtomEnrichment(entry),
    });
  }
  return { ok: true, entries: resolved };
}

/**
 * `task_set_spec`'s own entries carry provenance "prompt" — the author typed
 * or otherwise directly authored these requirements via this tool call. The
 * mint/dedup judgment itself is single-homed in
 * `resolveRequirementAtoms` (`@brewva/brewva-vocabulary/task`).
 */
function resolvePromptRequirementAtoms(
  foldedRequirements: Parameters<typeof resolveRequirementAtoms>[0],
  entries: readonly RequirementAtomEntryInput[],
): ResolvedRequirementAtoms {
  return resolveRequirementAtoms(
    foldedRequirements,
    entries.map((entry) => ({ ...entry, provenance: "prompt" as const })),
  );
}

function formatRequirementAtomsResultSuffix(resolved: ResolvedRequirementAtoms): string {
  if (resolved.atoms.length === 0) {
    return "";
  }
  const amendedSuffix = resolved.amendedCount > 0 ? ` (${resolved.amendedCount} amended)` : "";
  return ` ${resolved.atoms.length} requirement atoms recorded${amendedSuffix}.`;
}

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
        taskSetSpecObservableSignalsGuideline,
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
        requirements: Type.Optional(
          Type.Array(
            Type.Object({
              statement: Type.String(),
              modality: RequirementModalitySchema,
              riskClass: Type.Optional(RequirementRiskClassSchema),
              observableSignals: Type.Optional(Type.Array(Type.String())),
              verificationStrategy: Type.Optional(Type.Union([Type.String(), Type.Null()])),
              runtimePrerequisites: Type.Optional(Type.Array(Type.String())),
            }),
          ),
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
        const requirementEntriesResult = readRequirementAtomEntries(params.requirements ?? []);
        if (!requirementEntriesResult.ok) {
          return errTextResult(requirementEntriesResult.message, {
            ok: false,
            error: "invalid_requirement",
          });
        }
        const requirementEntries = requirementEntriesResult.entries;
        const foldedRequirements = getTaskState(taskSetSpecTool.runtime, sessionId).requirements;
        const resolvedRequirements = resolvePromptRequirementAtoms(
          foldedRequirements,
          requirementEntries,
        );

        recordTaskSpec(taskSetSpecTool.runtime, sessionId, {
          spec: {
            schema: "brewva.task.v1",
            goal: params.goal,
            targets: params.targets,
            expectedBehavior: params.expectedBehavior,
            constraints: params.constraints,
            verification: normalizedVerification,
            acceptance: normalizedAcceptance,
          },
          requirements: resolvedRequirements.atoms,
        });
        return okTextResult(
          `TaskSpec recorded.${formatRequirementAtomsResultSuffix(resolvedRequirements)}`,
          { ok: true },
        );
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
