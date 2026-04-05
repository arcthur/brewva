import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  appendToolRuntimeSupplementalInjection,
  canAppendToolRuntimeSupplementalInjection,
} from "./runtime-internal.js";
import type {
  AdvisorConsultBrief,
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
import { failTextResult, textResult, toolDetails, withVerdict } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

const SUBAGENT_MODE_VALUES = ["single", "parallel"] as const;
const SUBAGENT_BOUNDARY_VALUES = ["safe", "effectful"] as const;
const SUBAGENT_RETURN_MODE_VALUES = ["text_only", "supplemental"] as const;
const SUBAGENT_WAIT_MODE_VALUES = ["completion", "start"] as const;
const LEGACY_DELEGATION_FIELDS = new Set(["profile", "entrySkill", "requiredOutputs"] as const);

const ModeSchema = buildStringEnumSchema(SUBAGENT_MODE_VALUES, {
  guidance: "Use single for one delegated run and parallel for fan-out execution.",
});

const BoundarySchema = buildStringEnumSchema(SUBAGENT_BOUNDARY_VALUES, {
  guidance: "Safe is the default. Effectful is reserved for isolated write-capable runners.",
});

const ReturnModeSchema = buildStringEnumSchema(SUBAGENT_RETURN_MODE_VALUES, {
  guidance: "Use supplemental for same-turn hidden reinjection only.",
});

const WaitModeSchema = buildStringEnumSchema(SUBAGENT_WAIT_MODE_VALUES, {
  guidance:
    "Use completion to wait for delegated results in the current turn, or start to launch background delegation and inspect it later with subagent_status/subagent_cancel.",
});

const ResultModeSchema = buildStringEnumSchema(["consult", "qa", "patch"] as const, {
  guidance: "Choose the delegated result contract the child must satisfy.",
});

const ConsultKindSchema = buildStringEnumSchema(
  ["investigate", "diagnose", "design", "review"] as const,
  {
    guidance: "Required for consult runs. Choose the type of advisory reasoning to delegate.",
  },
);

const ManagedToolModeSchema = buildStringEnumSchema(["direct", "runtime_plugin"] as const, {
  guidance: "Direct is default. Runtime plugin mode may only narrow within the chosen preset.",
});

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
      buildStringEnumSchema(["ok", "error", "skipped"] as const, {
        guidance: "Worker result status to match.",
      }),
    ),
    policy: Type.Literal("cancel_when_true"),
  }),
]);

const PacketFields = {
  objective: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
  deliverable: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  consultBrief: Type.Optional(
    Type.Object(
      {
        decision: Type.String({ minLength: 1, maxLength: 2000 }),
        successCriteria: Type.String({ minLength: 1, maxLength: 2000 }),
        currentBestGuess: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
        assumptions: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 16 }),
        ),
        rejectedPaths: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 16 }),
        ),
        focusAreas: Type.Optional(
          Type.Array(Type.String({ minLength: 1, maxLength: 1000 }), { maxItems: 16 }),
        ),
      },
      { additionalProperties: false },
    ),
  ),
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
  executionHints: PacketFields.executionHints,
  contextRefs: PacketFields.contextRefs,
  contextBudget: PacketFields.contextBudget,
  completionPredicate: PacketFields.completionPredicate,
  effectCeiling: PacketFields.effectCeiling,
});

const SharedPacketSchema = Type.Object(PacketFields);

const SubagentRunParamsSchema = Type.Object({
  agentSpec: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  envelope: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  skillName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  consultKind: Type.Optional(ConsultKindSchema),
  fallbackResultMode: Type.Optional(ResultModeSchema),
  executionShape: Type.Optional(ExecutionShapeSchema),
  mode: Type.Optional(ModeSchema),
  objective: PacketFields.objective,
  deliverable: PacketFields.deliverable,
  consultBrief: PacketFields.consultBrief,
  constraints: PacketFields.constraints,
  sharedNotes: PacketFields.sharedNotes,
  activeSkillName: PacketFields.activeSkillName,
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
});

const SubagentFanoutParamsSchema = Type.Object({
  agentSpec: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  envelope: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  skillName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  consultKind: Type.Optional(ConsultKindSchema),
  fallbackResultMode: Type.Optional(ResultModeSchema),
  executionShape: Type.Optional(ExecutionShapeSchema),
  objective: PacketFields.objective,
  deliverable: PacketFields.deliverable,
  consultBrief: PacketFields.consultBrief,
  constraints: PacketFields.constraints,
  sharedNotes: PacketFields.sharedNotes,
  activeSkillName: PacketFields.activeSkillName,
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
});

type SharedPacketInput = Static<typeof SharedPacketSchema>;
type ExecutionShapeInput = Static<typeof ExecutionShapeSchema>;
type CompletionPredicateInput = Static<typeof CompletionPredicateSchema>;
type TaskPacketInput = Static<typeof TaskPacketSchema>;
type SubagentRunParams = Static<typeof SubagentRunParamsSchema>;
type SubagentFanoutParams = Static<typeof SubagentFanoutParamsSchema>;

function decodeToolParams<TSchemaValue extends TSchema>(
  schema: TSchemaValue,
  value: unknown,
): Static<TSchemaValue> {
  const cleaned = Value.Clean(schema, value);
  if (!Value.Check(schema, cleaned)) {
    throw new Error("validated subagent params failed schema decode");
  }
  return Value.Clone(cleaned);
}

function collectLegacyDelegationFieldPaths(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const record = value as Record<string, unknown>;
  const paths: string[] = [];

  for (const field of LEGACY_DELEGATION_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(record, field)) {
      paths.push(field);
    }
  }

  if (Array.isArray(record.tasks)) {
    for (const [index, task] of record.tasks.entries()) {
      if (!task || typeof task !== "object" || Array.isArray(task)) {
        continue;
      }
      for (const field of LEGACY_DELEGATION_FIELDS) {
        if (Object.prototype.hasOwnProperty.call(task, field)) {
          paths.push(`tasks[${index}].${field}`);
        }
      }
    }
  }

  return paths;
}

function legacyDelegationFieldMessage(paths: readonly string[]): string {
  const rendered = paths.join(", ");
  return `Error: removed legacy delegation fields are not supported (${rendered}). Use agentSpec, envelope, skillName, consultKind, fallbackResultMode, and canonical packet fields.`;
}

function hasSinglePacketInput(params: SharedPacketInput): boolean {
  return (
    params.objective !== undefined ||
    params.deliverable !== undefined ||
    params.consultBrief !== undefined ||
    params.constraints !== undefined ||
    params.sharedNotes !== undefined ||
    params.activeSkillName !== undefined ||
    params.executionHints !== undefined ||
    params.contextRefs !== undefined ||
    params.contextBudget !== undefined ||
    params.completionPredicate !== undefined ||
    params.effectCeiling !== undefined
  );
}

function buildExecutionHints(
  value: SharedPacketInput["executionHints"],
): DelegationPacket["executionHints"] | undefined {
  if (!value) {
    return undefined;
  }
  const preferredTools = value.preferredTools;
  const fallbackTools = value.fallbackTools;
  const preferredSkills = value.preferredSkills;
  if (!preferredTools && !fallbackTools && !preferredSkills) {
    return undefined;
  }
  return {
    preferredTools,
    fallbackTools,
    preferredSkills,
  };
}

function buildConsultBrief(
  value: SharedPacketInput["consultBrief"],
): AdvisorConsultBrief | undefined {
  if (!value) {
    return undefined;
  }
  return {
    decision: value.decision,
    successCriteria: value.successCriteria,
    currentBestGuess: value.currentBestGuess,
    ...(value.assumptions?.length ? { assumptions: [...value.assumptions] } : {}),
    ...(value.rejectedPaths?.length ? { rejectedPaths: [...value.rejectedPaths] } : {}),
    ...(value.focusAreas?.length ? { focusAreas: [...value.focusAreas] } : {}),
  };
}

function buildCompletionPredicate(
  value: CompletionPredicateInput | undefined,
): DelegationCompletionPredicate | undefined {
  if (!value) {
    return undefined;
  }
  if (value.source === "events") {
    return {
      source: "events",
      type: value.type,
      match: value.match && Object.keys(value.match).length > 0 ? value.match : undefined,
      policy: "cancel_when_true",
    };
  }
  return {
    source: "worker_results",
    workerId: value.workerId,
    status:
      value.status === "ok" || value.status === "error" || value.status === "skipped"
        ? value.status
        : undefined,
    policy: "cancel_when_true",
  };
}

function buildPacket(packet: SharedPacketInput): DelegationPacket | undefined {
  const objective = packet.objective?.trim() ?? "";
  if (!objective) {
    return undefined;
  }
  const contextBudget =
    packet.contextBudget &&
    (packet.contextBudget.maxInjectionTokens !== undefined ||
      packet.contextBudget.maxTurnTokens !== undefined)
      ? {
          maxInjectionTokens: packet.contextBudget.maxInjectionTokens,
          maxTurnTokens: packet.contextBudget.maxTurnTokens,
        }
      : undefined;
  const boundary = normalizeBoundary(packet.effectCeiling?.boundary);
  const effectCeiling = boundary ? { boundary } : undefined;
  return {
    objective,
    deliverable: packet.deliverable,
    consultBrief: buildConsultBrief(packet.consultBrief),
    constraints: packet.constraints,
    sharedNotes: packet.sharedNotes,
    activeSkillName: packet.activeSkillName,
    executionHints: buildExecutionHints(packet.executionHints),
    contextRefs: packet.contextRefs,
    contextBudget,
    completionPredicate: buildCompletionPredicate(packet.completionPredicate),
    effectCeiling,
  };
}

function buildExecutionShape(
  value: ExecutionShapeInput | undefined,
): SubagentExecutionShape | undefined {
  if (!value) {
    return undefined;
  }
  const resultMode =
    value.resultMode === "consult" || value.resultMode === "qa" || value.resultMode === "patch"
      ? value.resultMode
      : undefined;
  const boundary = normalizeBoundary(value.boundary);
  const model = typeof value.model === "string" ? value.model : undefined;
  const managedToolMode =
    value.managedToolMode === "direct" || value.managedToolMode === "runtime_plugin"
      ? value.managedToolMode
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

function normalizeBoundary(value: unknown): SubagentExecutionBoundary | undefined {
  return value === "safe" || value === "effectful" ? value : undefined;
}

function resolveMode(
  value: unknown,
  tasks: readonly TaskPacketInput[] | undefined,
): SubagentDelegationMode {
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

function toTask(task: TaskPacketInput): DelegationTaskPacket {
  const packet = buildPacket(task);
  if (!packet) {
    throw new Error("parallel task objective is required");
  }
  return {
    label: task.label,
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
  delegate: string;
  mode: SubagentDelegationMode;
  result: {
    ok: boolean;
    outcomes: SubagentOutcome[];
  };
}): string {
  const lines = [
    `Delegation outcome for delegate=${input.delegate}`,
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
  delegate: string;
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
  delegate: string;
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
    delegate: input.delegate,
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
    const decision = appendToolRuntimeSupplementalInjection(
      input.runtime,
      input.sessionId,
      content,
      input.returnScopeId ?? `subagent:${input.delegate}`,
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
  if (
    includesSupplementalReturn(returnMode) &&
    !canAppendToolRuntimeSupplementalInjection(runtime)
  ) {
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
  params: Pick<SubagentRunParams, "returnLabel" | "returnScopeId">,
): SubagentRunRequest["delivery"] | undefined {
  if (returnMode === "text_only") {
    return undefined;
  }
  return {
    returnMode,
    returnLabel: params.returnLabel,
    returnScopeId: params.returnScopeId,
  };
}

function resolveDelegationLabel(
  request: Pick<
    SubagentRunRequest,
    "agentSpec" | "envelope" | "skillName" | "consultKind" | "fallbackResultMode" | "executionShape"
  >,
): string {
  return (
    request.agentSpec ??
    request.envelope ??
    request.consultKind ??
    request.skillName ??
    request.executionShape?.resultMode ??
    request.fallbackResultMode ??
    "ad-hoc"
  );
}

function buildRunRequestFromParams(input: {
  params: SubagentRunParams | SubagentFanoutParams;
  mode: SubagentDelegationMode;
}): { ok: true; request: SubagentRunRequest } | { ok: false; message: string } {
  const { params } = input;
  const agentSpec = params.agentSpec?.trim() ? params.agentSpec : undefined;
  const envelope = params.envelope?.trim() ? params.envelope : undefined;
  const explicitSkillName = params.skillName?.trim() ? params.skillName : undefined;
  const consultKind =
    params.consultKind === "investigate" ||
    params.consultKind === "diagnose" ||
    params.consultKind === "design" ||
    params.consultKind === "review"
      ? params.consultKind
      : undefined;
  const executionShape = buildExecutionShape(params.executionShape);
  const fallbackResultMode =
    params.fallbackResultMode === "consult" ||
    params.fallbackResultMode === "qa" ||
    params.fallbackResultMode === "patch"
      ? params.fallbackResultMode
      : undefined;
  const request: SubagentRunRequest = {
    agentSpec,
    envelope,
    skillName: explicitSkillName,
    consultKind,
    fallbackResultMode,
    executionShape,
    mode: input.mode,
    timeoutMs: params.timeoutMs,
  };
  if (
    (request.executionShape?.resultMode ?? request.fallbackResultMode) === "consult" &&
    !consultKind
  ) {
    return {
      ok: false,
      message: "Error: consultKind is required for consult delegation.",
    };
  }

  if (input.mode === "single") {
    const packet = buildPacket(params);
    if (!packet) {
      return {
        ok: false,
        message: "Error: objective is required for mode=single.",
      };
    }
    if (
      (request.executionShape?.resultMode ?? request.fallbackResultMode) === "consult" &&
      !packet.consultBrief
    ) {
      return {
        ok: false,
        message: "Error: consultBrief is required for consult delegation.",
      };
    }
    request.packet = packet;
    return { ok: true, request };
  }

  if (!params.tasks || params.tasks.length === 0) {
    return {
      ok: false,
      message: "Error: tasks is required for mode=parallel.",
    };
  }
  if (hasSinglePacketInput(params)) {
    const sharedPacket = buildPacket(params);
    if (sharedPacket) {
      if (
        (request.executionShape?.resultMode ?? request.fallbackResultMode) === "consult" &&
        !sharedPacket.consultBrief
      ) {
        return {
          ok: false,
          message: "Error: consultBrief is required for consult delegation.",
        };
      }
      request.packet = sharedPacket;
    }
  }
  try {
    request.tasks = params.tasks.map((task) => toTask(task));
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
  delegate: string;
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
        ? `${input.startVerb} for delegate=${input.delegate}`
        : `${input.startVerb} for delegate=${input.delegate} (${started.runs.length} runs)`,
      ...started.runs.map((run) =>
        summarizeStartedRun({
          runId: run.runId,
          delegate: run.delegate,
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
      started.ok ? toolDetails(started) : withVerdict(toolDetails(started), "fail"),
    );
  }

  const result = await input.adapter.run({
    fromSessionId: input.sessionId,
    request: input.request,
  });
  if (!result.ok) {
    return failTextResult(
      `${input.completionVerb} failed for delegate=${input.delegate}: ${result.error ?? "unknown_error"}`,
      toolDetails(result),
    );
  }

  const failures = result.outcomes.filter((outcome) => !outcome.ok);
  const header =
    input.mode === "single"
      ? `${input.completionVerb} completed for delegate=${input.delegate}`
      : `${input.completionVerb} completed for delegate=${input.delegate} (${result.outcomes.length} runs)`;
  const delivery =
    result.outcomes.length > 0 && input.returnMode !== "text_only"
      ? deliverSubagentOutcome({
          runtime: input.options.runtime,
          sessionId: input.sessionId,
          delegate: input.delegate,
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
    ...toolDetails(result),
    delivery,
  };
  return textResult(lines.join("\n"), failures.length > 0 ? withVerdict(details, "fail") : details);
}

export function createSubagentRunTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "subagent_run",
    label: "Subagent Run",
    description:
      "Delegate a bounded task to an isolated worker configuration and return structured results.",
    promptSnippet:
      "Use isolated delegated runs for focused advisor consults, QA, or patch work without polluting the main context window.",
    promptGuidelines: [
      "Prefer canonical public agent specs advisor, qa, and patch-worker for the default delegated posture.",
      "For advisor runs, declare consultKind explicitly and provide a consultBrief with the decision and success criteria.",
      "Delegate when the task needs cross-3+-file investigation, diagnosis, a second-opinion review pass, or parallel slice analysis.",
      "Use single for one delegated run and parallel to fan out multiple independent slices.",
      "Use agentSpec for named reusable workers, envelope for runtime posture, and skillName for explicit semantic contracts.",
      "Keep objectives specific, pass only the context references the child needs, and avoid broad parent-context dumps.",
    ],
    parameters: Type.Object({
      ...SubagentRunParamsSchema.properties,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const adapter = options.runtime.orchestration?.subagents;
      if (!adapter) {
        return failTextResult("Subagent orchestration is unavailable in this session.", {
          ok: false,
        });
      }

      const legacyFieldPaths = collectLegacyDelegationFieldPaths(params);
      if (legacyFieldPaths.length > 0) {
        return failTextResult(legacyDelegationFieldMessage(legacyFieldPaths), { ok: false });
      }
      const decodedParams = decodeToolParams(SubagentRunParamsSchema, params);
      const mode = resolveMode(decodedParams.mode, decodedParams.tasks);
      const waitMode = resolveWaitMode(decodedParams.waitMode);
      const returnMode = resolveReturnMode(decodedParams.returnMode);
      const deliveryValidation = validateDeliveryConfiguration(options.runtime, returnMode);
      if (!deliveryValidation.ok) {
        return failTextResult(deliveryValidation.message, { ok: false });
      }
      const builtRequest = buildRunRequestFromParams({
        params: decodedParams,
        mode,
      });
      if (!builtRequest.ok) {
        return failTextResult(builtRequest.message, { ok: false });
      }
      const sessionId = getSessionId(ctx);
      return executeSubagentToolWithRequest({
        options,
        sessionId,
        delegate: resolveDelegationLabel(builtRequest.request),
        mode,
        waitMode,
        returnMode,
        request: builtRequest.request,
        adapter,
        completionVerb: "subagent_run",
        startVerb: "subagent_run started",
        delivery: buildDeliveryRequest(returnMode, decodedParams),
      });
    },
  });
}

export function createSubagentFanoutTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "subagent_fanout",
    label: "Subagent Fanout",
    description:
      "Launch multiple isolated delegated runs under one worker configuration for independent slices of work.",
    promptSnippet:
      "Use this for explicit fan-out when several repository slices or internal review lanes can run independently under the same delegated setup.",
    promptGuidelines: [
      "Prefer canonical public agent specs advisor, qa, and patch-worker unless a narrower internal worker is explicitly required.",
      "For advisor fan-out, keep consultKind explicit and share one consultBrief across the delegated slices unless a lane-specific brief is required.",
      "Use this when tasks are independent and a shared packet plus per-task objectives is clearer than one large delegated run.",
      "Keep each task label and objective specific so the parent can inspect outcomes separately.",
      "Prefer read-only envelopes unless the workflow is explicitly ready to inspect and merge isolated patch results.",
    ],
    parameters: Type.Object({
      ...SubagentFanoutParamsSchema.properties,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const adapter = options.runtime.orchestration?.subagents;
      if (!adapter) {
        return failTextResult("Subagent orchestration is unavailable in this session.", {
          ok: false,
        });
      }

      const legacyFieldPaths = collectLegacyDelegationFieldPaths(params);
      if (legacyFieldPaths.length > 0) {
        return failTextResult(legacyDelegationFieldMessage(legacyFieldPaths), { ok: false });
      }
      const decodedParams = decodeToolParams(SubagentFanoutParamsSchema, params);
      const waitMode = resolveWaitMode(decodedParams.waitMode);
      const returnMode = resolveReturnMode(decodedParams.returnMode);
      const deliveryValidation = validateDeliveryConfiguration(options.runtime, returnMode);
      if (!deliveryValidation.ok) {
        return failTextResult(deliveryValidation.message, { ok: false });
      }
      const builtRequest = buildRunRequestFromParams({
        params: { ...decodedParams, mode: "parallel" },
        mode: "parallel",
      });
      if (!builtRequest.ok) {
        return failTextResult(builtRequest.message, { ok: false });
      }
      const sessionId = getSessionId(ctx);
      return executeSubagentToolWithRequest({
        options,
        sessionId,
        delegate: resolveDelegationLabel(builtRequest.request),
        mode: "parallel",
        waitMode,
        returnMode,
        request: builtRequest.request,
        adapter,
        completionVerb: "subagent_fanout",
        startVerb: "subagent_fanout started",
        delivery: buildDeliveryRequest(returnMode, decodedParams),
      });
    },
  });
}
