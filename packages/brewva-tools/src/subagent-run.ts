import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type {
  BrewvaToolOptions,
  DelegationPacket,
  DelegationTaskPacket,
  DelegationCompletionPredicate,
  SubagentDelegationMode,
  SubagentExecutionShape,
  SubagentReturnMode,
  SubagentOutcome,
  SubagentRunRequest,
  SubagentExecutionBoundary,
} from "./types.js";
import { buildStringEnumSchema } from "./utils/input-alias.js";
import { failTextResult, textResult, withVerdict } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

const SUBAGENT_MODE_VALUES = ["single", "parallel"] as const;
const SUBAGENT_BOUNDARY_VALUES = ["safe", "effectful"] as const;
const SUBAGENT_RETURN_MODE_VALUES = ["text_only", "supplemental"] as const;
const SUBAGENT_WAIT_MODE_VALUES = ["completion", "start"] as const;

const ModeSchema = buildStringEnumSchema(
  SUBAGENT_MODE_VALUES,
  {},
  {
    guidance: "Use single for one delegated run and parallel for fan-out execution.",
  },
);

const BoundarySchema = buildStringEnumSchema(
  SUBAGENT_BOUNDARY_VALUES,
  {},
  {
    guidance: "Safe is the default. Effectful is reserved for isolated write-capable runners.",
  },
);

const ReturnModeSchema = buildStringEnumSchema(
  SUBAGENT_RETURN_MODE_VALUES,
  {},
  {
    guidance: "Use supplemental for same-turn hidden reinjection only.",
  },
);

const WaitModeSchema = buildStringEnumSchema(
  SUBAGENT_WAIT_MODE_VALUES,
  {},
  {
    guidance:
      "Use completion to wait for delegated results in the current turn, or start to launch background delegation and inspect it later with subagent_status/subagent_cancel.",
  },
);

const ResultModeSchema = buildStringEnumSchema(
  ["exploration", "review", "verification", "patch"] as const,
  {},
  {
    guidance: "Choose the delegated result contract the child must satisfy.",
  },
);

const ManagedToolModeSchema = buildStringEnumSchema(
  ["direct", "extension"] as const,
  {},
  {
    guidance: "Direct is default. Extension may only narrow within the chosen preset.",
  },
);

const ContextRefSchema = Type.Object({
  kind: Type.Union(
    [
      Type.Literal("event"),
      Type.Literal("ledger"),
      Type.Literal("artifact"),
      Type.Literal("projection"),
      Type.Literal("workspace_span"),
      Type.Literal("task"),
      Type.Literal("truth"),
      Type.Literal("tool_result"),
    ],
    { description: "Reference kinds made available to the delegated run." },
  ),
  locator: Type.String({ minLength: 1, maxLength: 1000 }),
  summary: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  sourceSessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  hash: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
});

const ExecutionHintsSchema = Type.Object({
  preferredTools: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 24 }),
  ),
  fallbackTools: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 24 }),
  ),
  preferredSkills: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 24 }),
  ),
});

const ExecutionShapeSchema = Type.Object({
  resultMode: Type.Optional(ResultModeSchema),
  boundary: Type.Optional(BoundarySchema),
  model: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
  managedToolMode: Type.Optional(ManagedToolModeSchema),
});

const CompletionPredicateSchema = Type.Union([
  Type.Object({
    source: Type.Literal("events"),
    type: Type.String({ minLength: 1, maxLength: 200 }),
    match: Type.Optional(
      Type.Record(
        Type.String({ minLength: 1, maxLength: 200 }),
        Type.Union([
          Type.String({ minLength: 1, maxLength: 500 }),
          Type.Number(),
          Type.Boolean(),
          Type.Null(),
        ]),
      ),
    ),
    policy: Type.Literal("cancel_when_true"),
  }),
  Type.Object({
    source: Type.Literal("worker_results"),
    workerId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
    status: Type.Optional(
      buildStringEnumSchema(
        ["ok", "error", "skipped"] as const,
        {},
        { guidance: "Worker result status to match." },
      ),
    ),
    policy: Type.Literal("cancel_when_true"),
  }),
]);

const PacketFields = {
  objective: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  deliverable: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  constraints: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
      maxItems: 24,
    }),
  ),
  sharedNotes: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), {
      maxItems: 24,
    }),
  ),
  activeSkillName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  entrySkill: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  requiredOutputs: Type.Optional(
    Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
      maxItems: 24,
    }),
  ),
  executionHints: Type.Optional(ExecutionHintsSchema),
  contextRefs: Type.Optional(Type.Array(ContextRefSchema, { maxItems: 48 })),
  contextBudget: Type.Optional(
    Type.Object({
      maxInjectionTokens: Type.Optional(Type.Integer({ minimum: 1 })),
      maxTurnTokens: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
  ),
  completionPredicate: Type.Optional(CompletionPredicateSchema),
  effectCeiling: Type.Optional(
    Type.Object({
      boundary: Type.Optional(BoundarySchema),
    }),
  ),
} as const;

const TaskPacketSchema = Type.Object({
  label: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  objective: Type.String({ minLength: 1, maxLength: 4000 }),
  deliverable: PacketFields.deliverable,
  constraints: PacketFields.constraints,
  sharedNotes: PacketFields.sharedNotes,
  activeSkillName: PacketFields.activeSkillName,
  entrySkill: PacketFields.entrySkill,
  requiredOutputs: PacketFields.requiredOutputs,
  executionHints: PacketFields.executionHints,
  contextRefs: PacketFields.contextRefs,
  contextBudget: PacketFields.contextBudget,
  completionPredicate: PacketFields.completionPredicate,
  effectCeiling: PacketFields.effectCeiling,
});

function hasSinglePacketInput(params: Record<string, unknown>): boolean {
  return (
    typeof params.objective === "string" ||
    typeof params.deliverable === "string" ||
    Array.isArray(params.constraints) ||
    Array.isArray(params.sharedNotes) ||
    typeof params.activeSkillName === "string" ||
    typeof params.entrySkill === "string" ||
    Array.isArray(params.requiredOutputs) ||
    typeof params.executionHints === "object" ||
    Array.isArray(params.contextRefs) ||
    typeof params.contextBudget === "object" ||
    typeof params.completionPredicate === "object" ||
    typeof params.effectCeiling === "object"
  );
}

function toPacket(packet: {
  objective?: unknown;
  deliverable?: unknown;
  constraints?: unknown;
  sharedNotes?: unknown;
  activeSkillName?: unknown;
  entrySkill?: unknown;
  requiredOutputs?: unknown;
  executionHints?: unknown;
  contextRefs?: unknown;
  contextBudget?: unknown;
  completionPredicate?: unknown;
  effectCeiling?: unknown;
}): DelegationPacket | undefined {
  const objective = typeof packet.objective === "string" ? packet.objective.trim() : "";
  if (!objective) {
    return undefined;
  }
  const boundary = normalizeBoundary(
    typeof packet.effectCeiling === "object" && packet.effectCeiling !== null
      ? (packet.effectCeiling as { boundary?: unknown }).boundary
      : undefined,
  );
  return {
    objective,
    deliverable: typeof packet.deliverable === "string" ? packet.deliverable : undefined,
    constraints: Array.isArray(packet.constraints) ? packet.constraints : undefined,
    sharedNotes: Array.isArray(packet.sharedNotes) ? packet.sharedNotes : undefined,
    activeSkillName:
      typeof packet.activeSkillName === "string" ? packet.activeSkillName : undefined,
    entrySkill: typeof packet.entrySkill === "string" ? packet.entrySkill : undefined,
    requiredOutputs: Array.isArray(packet.requiredOutputs) ? packet.requiredOutputs : undefined,
    executionHints:
      typeof packet.executionHints === "object" && packet.executionHints !== null
        ? {
            preferredTools: Array.isArray(
              (packet.executionHints as { preferredTools?: unknown }).preferredTools,
            )
              ? ((packet.executionHints as { preferredTools: string[] }).preferredTools ?? [])
              : undefined,
            fallbackTools: Array.isArray(
              (packet.executionHints as { fallbackTools?: unknown }).fallbackTools,
            )
              ? ((packet.executionHints as { fallbackTools: string[] }).fallbackTools ?? [])
              : undefined,
            preferredSkills: Array.isArray(
              (packet.executionHints as { preferredSkills?: unknown }).preferredSkills,
            )
              ? ((packet.executionHints as { preferredSkills: string[] }).preferredSkills ?? [])
              : undefined,
          }
        : undefined,
    contextRefs: Array.isArray(packet.contextRefs) ? packet.contextRefs : undefined,
    contextBudget:
      typeof packet.contextBudget === "object" && packet.contextBudget !== null
        ? {
            maxInjectionTokens:
              typeof (packet.contextBudget as { maxInjectionTokens?: unknown })
                .maxInjectionTokens === "number"
                ? (packet.contextBudget as { maxInjectionTokens: number }).maxInjectionTokens
                : undefined,
            maxTurnTokens:
              typeof (packet.contextBudget as { maxTurnTokens?: unknown }).maxTurnTokens ===
              "number"
                ? (packet.contextBudget as { maxTurnTokens: number }).maxTurnTokens
                : undefined,
          }
        : undefined,
    completionPredicate: toCompletionPredicate(packet.completionPredicate),
    effectCeiling: boundary ? { boundary } : undefined,
  };
}

function toExecutionShape(value: unknown): SubagentExecutionShape | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const resultMode =
    (value as { resultMode?: unknown }).resultMode === "exploration" ||
    (value as { resultMode?: unknown }).resultMode === "review" ||
    (value as { resultMode?: unknown }).resultMode === "verification" ||
    (value as { resultMode?: unknown }).resultMode === "patch"
      ? ((value as { resultMode: SubagentExecutionShape["resultMode"] }).resultMode ?? undefined)
      : undefined;
  const boundary = normalizeBoundary((value as { boundary?: unknown }).boundary);
  const model =
    typeof (value as { model?: unknown }).model === "string"
      ? (value as { model: string }).model
      : undefined;
  const managedToolMode =
    (value as { managedToolMode?: unknown }).managedToolMode === "direct" ||
    (value as { managedToolMode?: unknown }).managedToolMode === "extension"
      ? ((value as { managedToolMode: SubagentExecutionShape["managedToolMode"] })
          .managedToolMode ?? undefined)
      : undefined;
  if (!resultMode && !boundary && !model && !managedToolMode) {
    return undefined;
  }
  return {
    resultMode,
    boundary,
    model,
    managedToolMode,
  };
}

function toCompletionPredicate(value: unknown): DelegationCompletionPredicate | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  if ((value as { source?: unknown }).source === "events") {
    const type =
      typeof (value as { type?: unknown }).type === "string"
        ? (value as { type: string }).type
        : undefined;
    if (!type) {
      return undefined;
    }
    const match =
      typeof (value as { match?: unknown }).match === "object" &&
      (value as { match?: unknown }).match !== null &&
      !Array.isArray((value as { match?: unknown }).match)
        ? (Object.fromEntries(
            Object.entries((value as { match: Record<string, unknown> }).match).filter(
              ([, entry]) =>
                typeof entry === "string" ||
                typeof entry === "number" ||
                typeof entry === "boolean" ||
                entry === null,
            ),
          ) as Record<string, string | number | boolean | null>)
        : undefined;
    return {
      source: "events",
      type,
      match,
      policy: "cancel_when_true",
    };
  }
  if ((value as { source?: unknown }).source === "worker_results") {
    const status =
      (value as { status?: unknown }).status === "ok" ||
      (value as { status?: unknown }).status === "error" ||
      (value as { status?: unknown }).status === "skipped"
        ? ((value as { status: "ok" | "error" | "skipped" }).status ?? undefined)
        : undefined;
    return {
      source: "worker_results",
      workerId:
        typeof (value as { workerId?: unknown }).workerId === "string"
          ? (value as { workerId: string }).workerId
          : undefined,
      status,
      policy: "cancel_when_true",
    };
  }
  return undefined;
}

function normalizeBoundary(value: unknown): SubagentExecutionBoundary | undefined {
  return value === "safe" || value === "effectful" ? value : undefined;
}

function resolveMode(value: unknown, tasks: unknown): SubagentDelegationMode {
  if (value === "parallel") {
    return "parallel";
  }
  if (value === "single") {
    return "single";
  }
  return Array.isArray(tasks) ? "parallel" : "single";
}

function resolveReturnMode(value: unknown): SubagentReturnMode {
  return value === "supplemental" || value === "text_only" ? value : "text_only";
}

function resolveWaitMode(value: unknown): "completion" | "start" {
  return value === "start" ? "start" : "completion";
}

function includesSupplementalReturn(mode: SubagentReturnMode): boolean {
  return mode === "supplemental";
}

function toTask(task: Record<string, unknown>): DelegationTaskPacket {
  const packet = toPacket(task);
  if (!packet) {
    throw new Error("parallel task objective is required");
  }
  return {
    label: typeof task.label === "string" ? task.label : undefined,
    ...packet,
  };
}

function summarizeOutcome(outcome: SubagentOutcome): string {
  if (!outcome.ok) {
    return `- ${outcome.label ?? outcome.runId}: failed (${outcome.error})`;
  }
  const totals = [
    outcome.metrics.totalTokens ? `tokens=${outcome.metrics.totalTokens}` : null,
    typeof outcome.metrics.costUsd === "number"
      ? `cost=$${outcome.metrics.costUsd.toFixed(4)}`
      : null,
  ].filter(Boolean);
  const detailSuffix = totals.length > 0 ? ` [${totals.join(", ")}]` : "";
  return `- ${outcome.label ?? outcome.runId}: ${outcome.kind}${detailSuffix}\n  ${outcome.summary}`;
}

function summarizeOutcomeForDelivery(outcome: SubagentOutcome): string {
  if (!outcome.ok) {
    return `- ${outcome.label ?? outcome.runId}: ${outcome.status} (${outcome.error})`;
  }
  const parts = [
    outcome.kind,
    outcome.workerSessionId ? `worker=${outcome.workerSessionId}` : null,
    typeof outcome.metrics.totalTokens === "number"
      ? `tokens=${outcome.metrics.totalTokens}`
      : null,
    typeof outcome.metrics.costUsd === "number"
      ? `cost=$${outcome.metrics.costUsd.toFixed(4)}`
      : null,
  ].filter(Boolean);
  return `- ${outcome.label ?? outcome.runId}: ${parts.join(" ")}\n  ${outcome.summary}`;
}

function buildDeliveryContent(input: {
  profile: string;
  mode: SubagentDelegationMode;
  result: {
    ok: boolean;
    outcomes: SubagentOutcome[];
  };
}): string {
  const lines = [
    `Delegation outcome for profile=${input.profile}`,
    `Mode: ${input.mode}`,
    ...input.result.outcomes.slice(0, 8).map((outcome) => summarizeOutcomeForDelivery(outcome)),
  ];
  if (input.result.outcomes.length > 8) {
    lines.push(`- ${input.result.outcomes.length - 8} additional delegated outcomes omitted`);
  }
  return lines.join("\n").trim();
}

function summarizeStartedRun(run: {
  runId: string;
  profile: string;
  status: string;
  label?: string;
  kind?: string;
  live?: boolean;
  cancelable?: boolean;
}): string {
  const parts = [
    `status=${run.status}`,
    run.kind ? `kind=${run.kind}` : null,
    run.live ? "live=yes" : "live=no",
    run.cancelable ? "cancelable=yes" : "cancelable=no",
  ].filter(Boolean);
  const prefix = run.label ?? run.runId;
  return `- ${prefix}: ${parts.join(" ")}`;
}

function deliverSubagentOutcome(input: {
  runtime: BrewvaToolOptions["runtime"];
  sessionId: string;
  profile: string;
  mode: SubagentDelegationMode;
  outcomes: SubagentOutcome[];
  returnMode: SubagentReturnMode;
  returnLabel?: string;
  returnScopeId?: string;
}): {
  supplemental?: {
    attempted: boolean;
    accepted: boolean;
    truncated?: boolean;
    finalTokens?: number;
    droppedReason?: "hard_limit" | "budget_exhausted";
  };
} {
  const content = buildDeliveryContent({
    profile: input.profile,
    mode: input.mode,
    result: {
      ok: input.outcomes.every((outcome) => outcome.ok),
      outcomes: input.outcomes,
    },
  });
  const delivery: {
    supplemental?: {
      attempted: boolean;
      accepted: boolean;
      truncated?: boolean;
      finalTokens?: number;
      droppedReason?: "hard_limit" | "budget_exhausted";
    };
  } = {};

  if (includesSupplementalReturn(input.returnMode)) {
    const decision = input.runtime.context?.appendSupplementalInjection?.(
      input.sessionId,
      content,
      undefined,
      input.returnScopeId ?? `subagent:${input.profile}`,
    );
    delivery.supplemental = {
      attempted: true,
      accepted: decision?.accepted ?? false,
      truncated: decision?.truncated,
      finalTokens: decision?.finalTokens,
      droppedReason: decision?.droppedReason,
    };
  }

  return delivery;
}

function validateDeliveryConfiguration(
  runtime: BrewvaToolOptions["runtime"],
  returnMode: SubagentReturnMode,
): { ok: true } | { ok: false; message: string } {
  if (includesSupplementalReturn(returnMode) && !runtime.context?.appendSupplementalInjection) {
    return {
      ok: false,
      message:
        "Error: runtime supplemental context delivery is unavailable for supplemental returnMode.",
    };
  }
  return { ok: true };
}

function buildDeliveryRequest(
  returnMode: SubagentReturnMode,
  params: Record<string, unknown>,
): SubagentRunRequest["delivery"] | undefined {
  if (returnMode === "text_only") {
    return undefined;
  }
  return {
    returnMode,
    returnLabel: typeof params.returnLabel === "string" ? params.returnLabel : undefined,
    returnScopeId: typeof params.returnScopeId === "string" ? params.returnScopeId : undefined,
  };
}

function buildRunRequestFromParams(input: {
  params: Record<string, unknown>;
  mode: SubagentDelegationMode;
}): { ok: true; request: SubagentRunRequest } | { ok: false; message: string } {
  const profile =
    typeof input.params.profile === "string" && input.params.profile.trim().length > 0
      ? input.params.profile
      : undefined;
  const executionShape = toExecutionShape(input.params.executionShape);
  if (!profile && !executionShape?.resultMode) {
    return {
      ok: false,
      message: "Error: profile or executionShape.resultMode is required.",
    };
  }
  const request: SubagentRunRequest = {
    profile,
    executionShape,
    mode: input.mode,
    timeoutMs: typeof input.params.timeoutMs === "number" ? input.params.timeoutMs : undefined,
  };

  if (input.mode === "single") {
    const packet = toPacket(input.params);
    if (!packet) {
      return {
        ok: false,
        message: "Error: objective is required for mode=single.",
      };
    }
    request.packet = packet;
    return { ok: true, request };
  }

  if (!Array.isArray(input.params.tasks) || input.params.tasks.length === 0) {
    return {
      ok: false,
      message: "Error: tasks is required for mode=parallel.",
    };
  }
  if (hasSinglePacketInput(input.params)) {
    const sharedPacket = toPacket(input.params);
    if (sharedPacket) {
      request.packet = sharedPacket;
    }
  }
  try {
    request.tasks = input.params.tasks.map((task) => toTask(task as Record<string, unknown>));
  } catch (error) {
    return {
      ok: false,
      message: `Error: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
  return { ok: true, request };
}

async function executeSubagentToolWithRequest(input: {
  options: BrewvaToolOptions;
  sessionId: string;
  profile: string;
  mode: SubagentDelegationMode;
  waitMode: "completion" | "start";
  returnMode: SubagentReturnMode;
  request: SubagentRunRequest;
  adapter: NonNullable<NonNullable<BrewvaToolOptions["runtime"]["orchestration"]>["subagents"]>;
  completionVerb: string;
  startVerb: string;
  delivery?: NonNullable<SubagentRunRequest["delivery"]>;
}): Promise<ReturnType<typeof textResult>> {
  if (input.waitMode === "start") {
    if (!input.adapter.start) {
      return failTextResult("Subagent background start is unavailable in this session.", {
        ok: false,
      });
    }
    if (input.returnMode === "supplemental") {
      return failTextResult(
        "Background subagent delivery must be text_only; inspect durable results later with subagent_status or worker_results_*.",
        {
          ok: false,
        },
      );
    }
    if (input.delivery) {
      input.request.delivery = input.delivery;
    }

    const started = await input.adapter.start({
      fromSessionId: input.sessionId,
      request: input.request,
    });
    const lines = [
      input.mode === "single"
        ? `${input.startVerb} for profile=${input.profile}`
        : `${input.startVerb} for profile=${input.profile} (${started.runs.length} runs)`,
      ...started.runs.map((run) =>
        summarizeStartedRun({
          runId: run.runId,
          profile: run.profile,
          status: run.status,
          label: run.label,
          kind: run.kind,
          live: false,
          cancelable: run.status === "pending" || run.status === "running",
        }),
      ),
    ];
    return textResult(
      lines.join("\n"),
      started.ok
        ? (started as unknown as Record<string, unknown>)
        : withVerdict(started as unknown as Record<string, unknown>, "fail"),
    );
  }

  const result = await input.adapter.run({
    fromSessionId: input.sessionId,
    request: input.request,
  });
  if (!result.ok) {
    return failTextResult(
      `${input.completionVerb} failed for profile=${input.profile}: ${result.error ?? "unknown_error"}`,
      result as unknown as Record<string, unknown>,
    );
  }

  const failures = result.outcomes.filter((outcome) => !outcome.ok);
  const header =
    input.mode === "single"
      ? `${input.completionVerb} completed for profile=${input.profile}`
      : `${input.completionVerb} completed for profile=${input.profile} (${result.outcomes.length} runs)`;
  const delivery =
    result.outcomes.length > 0 && input.returnMode !== "text_only"
      ? deliverSubagentOutcome({
          runtime: input.options.runtime,
          sessionId: input.sessionId,
          profile: input.profile,
          mode: input.mode,
          outcomes: result.outcomes,
          returnMode: input.returnMode,
          returnLabel: input.delivery?.returnLabel,
          returnScopeId: input.delivery?.returnScopeId,
        })
      : undefined;
  const lines = [header, ...result.outcomes.map((outcome) => summarizeOutcome(outcome))];
  if (delivery?.supplemental?.attempted) {
    lines.push(
      delivery.supplemental.accepted
        ? `supplemental delivery accepted${delivery.supplemental.truncated ? " (truncated)" : ""}`
        : `supplemental delivery skipped (${delivery.supplemental.droppedReason ?? "unavailable"})`,
    );
  }
  const details = {
    ...(result as unknown as Record<string, unknown>),
    delivery,
  };
  return textResult(lines.join("\n"), failures.length > 0 ? withVerdict(details, "fail") : details);
}

export function createSubagentRunTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "subagent_run",
    label: "Subagent Run",
    description:
      "Delegate a bounded task to an isolated subagent profile and return structured results.",
    promptSnippet:
      "Use isolated delegated runs for focused exploration, review, or verification without polluting the main context window.",
    promptGuidelines: [
      "Prefer canonical profiles explore, plan, review, and general for the default delegated posture.",
      "Delegate when the task needs cross-3+-file investigation, an independent review pass, or parallel slice exploration.",
      "Use single for one delegated run and parallel to fan out multiple independent slices.",
      "Keep objectives specific, pass only the context references the child needs, and avoid broad parent-context dumps.",
    ],
    parameters: Type.Object({
      profile: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      executionShape: Type.Optional(ExecutionShapeSchema),
      mode: Type.Optional(ModeSchema),
      objective: PacketFields.objective,
      deliverable: PacketFields.deliverable,
      constraints: PacketFields.constraints,
      sharedNotes: PacketFields.sharedNotes,
      activeSkillName: PacketFields.activeSkillName,
      entrySkill: PacketFields.entrySkill,
      requiredOutputs: PacketFields.requiredOutputs,
      executionHints: PacketFields.executionHints,
      contextRefs: PacketFields.contextRefs,
      contextBudget: PacketFields.contextBudget,
      completionPredicate: PacketFields.completionPredicate,
      effectCeiling: PacketFields.effectCeiling,
      waitMode: Type.Optional(WaitModeSchema),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
      returnMode: Type.Optional(ReturnModeSchema),
      returnLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
      returnScopeId: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
      tasks: Type.Optional(Type.Array(TaskPacketSchema, { minItems: 1, maxItems: 12 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const adapter = options.runtime.orchestration?.subagents;
      if (!adapter) {
        return failTextResult("Subagent orchestration is unavailable in this session.", {
          ok: false,
        });
      }

      const mode = resolveMode(params.mode, params.tasks);
      const waitMode = resolveWaitMode(params.waitMode);
      const returnMode = resolveReturnMode(params.returnMode);
      const deliveryValidation = validateDeliveryConfiguration(options.runtime, returnMode);
      if (!deliveryValidation.ok) {
        return failTextResult(deliveryValidation.message, { ok: false });
      }
      const builtRequest = buildRunRequestFromParams({
        params: params as Record<string, unknown>,
        mode,
      });
      if (!builtRequest.ok) {
        return failTextResult(builtRequest.message, { ok: false });
      }
      const sessionId = getSessionId(ctx);
      return executeSubagentToolWithRequest({
        options,
        sessionId,
        profile:
          builtRequest.request.profile ??
          builtRequest.request.executionShape?.resultMode ??
          "derived",
        mode,
        waitMode,
        returnMode,
        request: builtRequest.request,
        adapter,
        completionVerb: "subagent_run",
        startVerb: "subagent_run started",
        delivery: buildDeliveryRequest(returnMode, params as Record<string, unknown>),
      });
    },
  });
}

export function createSubagentFanoutTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "subagent_fanout",
    label: "Subagent Fanout",
    description:
      "Launch multiple isolated delegated runs under one profile for independent slices of work.",
    promptSnippet:
      "Use this for explicit fan-out when several repository slices or verification lanes can run independently under the same delegated profile.",
    promptGuidelines: [
      "Prefer canonical profiles explore, plan, review, and general unless a narrower internal profile is explicitly required.",
      "Use this when tasks are independent and a shared packet plus per-task objectives is clearer than one large delegated run.",
      "Keep each task label and objective specific so the parent can inspect outcomes separately.",
      "Prefer read-only profiles unless the workflow is explicitly ready to inspect and merge isolated patch results.",
    ],
    parameters: Type.Object({
      profile: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      executionShape: Type.Optional(ExecutionShapeSchema),
      objective: PacketFields.objective,
      deliverable: PacketFields.deliverable,
      constraints: PacketFields.constraints,
      sharedNotes: PacketFields.sharedNotes,
      activeSkillName: PacketFields.activeSkillName,
      entrySkill: PacketFields.entrySkill,
      requiredOutputs: PacketFields.requiredOutputs,
      executionHints: PacketFields.executionHints,
      contextRefs: PacketFields.contextRefs,
      contextBudget: PacketFields.contextBudget,
      completionPredicate: PacketFields.completionPredicate,
      effectCeiling: PacketFields.effectCeiling,
      waitMode: Type.Optional(WaitModeSchema),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
      returnMode: Type.Optional(ReturnModeSchema),
      returnLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
      returnScopeId: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
      tasks: Type.Array(TaskPacketSchema, { minItems: 1, maxItems: 12 }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const adapter = options.runtime.orchestration?.subagents;
      if (!adapter) {
        return failTextResult("Subagent orchestration is unavailable in this session.", {
          ok: false,
        });
      }

      const waitMode = resolveWaitMode(params.waitMode);
      const returnMode = resolveReturnMode(params.returnMode);
      const deliveryValidation = validateDeliveryConfiguration(options.runtime, returnMode);
      if (!deliveryValidation.ok) {
        return failTextResult(deliveryValidation.message, { ok: false });
      }
      const builtRequest = buildRunRequestFromParams({
        params: { ...(params as Record<string, unknown>), mode: "parallel" },
        mode: "parallel",
      });
      if (!builtRequest.ok) {
        return failTextResult(builtRequest.message, { ok: false });
      }
      const sessionId = getSessionId(ctx);
      return executeSubagentToolWithRequest({
        options,
        sessionId,
        profile:
          builtRequest.request.profile ??
          builtRequest.request.executionShape?.resultMode ??
          "derived",
        mode: "parallel",
        waitMode,
        returnMode,
        request: builtRequest.request,
        adapter,
        completionVerb: "subagent_fanout",
        startVerb: "subagent_fanout started",
        delivery: buildDeliveryRequest(returnMode, params as Record<string, unknown>),
      });
    },
  });
}
