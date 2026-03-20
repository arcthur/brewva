import { buildEvidenceRef, submitContextPacketProposal } from "@brewva/brewva-deliberation";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type {
  BrewvaToolOptions,
  DelegationPacket,
  DelegationTaskPacket,
  SubagentDelegationMode,
  SubagentReturnMode,
  SubagentOutcome,
  SubagentRunRequest,
  SubagentExecutionPosture,
} from "./types.js";
import { buildStringEnumSchema } from "./utils/input-alias.js";
import { failTextResult, textResult, withVerdict } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

const SUBAGENT_MODE_VALUES = ["single", "parallel"] as const;
const SUBAGENT_POSTURE_VALUES = ["observe", "reversible_mutate"] as const;
const SUBAGENT_RETURN_MODE_VALUES = [
  "text_only",
  "supplemental",
  "context_packet",
  "both",
] as const;
const SUBAGENT_WAIT_MODE_VALUES = ["completion", "start"] as const;

const ModeSchema = buildStringEnumSchema(
  SUBAGENT_MODE_VALUES,
  {},
  {
    guidance: "Use single for one delegated run and parallel for fan-out execution.",
  },
);

const PostureSchema = buildStringEnumSchema(
  SUBAGENT_POSTURE_VALUES,
  {},
  {
    guidance:
      "Observe is the default. Reversible mutate is reserved for isolated write-capable runners.",
  },
);

const ReturnModeSchema = buildStringEnumSchema(
  SUBAGENT_RETURN_MODE_VALUES,
  {},
  {
    guidance:
      "Use supplemental for same-turn hidden reinjection, context_packet for replayable handoff, or both for both channels.",
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
    ],
    { description: "Reference kinds made available to the delegated run." },
  ),
  locator: Type.String({ minLength: 1, maxLength: 1000 }),
  summary: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
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
  effectCeiling: Type.Optional(
    Type.Object({
      posture: Type.Optional(PostureSchema),
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
  effectCeiling?: unknown;
}): DelegationPacket | undefined {
  const objective = typeof packet.objective === "string" ? packet.objective.trim() : "";
  if (!objective) {
    return undefined;
  }
  const posture = normalizePosture(
    typeof packet.effectCeiling === "object" && packet.effectCeiling !== null
      ? (packet.effectCeiling as { posture?: unknown }).posture
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
    effectCeiling: posture ? { posture } : undefined,
  };
}

function normalizePosture(value: unknown): SubagentExecutionPosture | undefined {
  return value === "observe" || value === "reversible_mutate" ? value : undefined;
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
  return value === "supplemental" ||
    value === "context_packet" ||
    value === "both" ||
    value === "text_only"
    ? value
    : "text_only";
}

function resolveWaitMode(value: unknown): "completion" | "start" {
  return value === "start" ? "start" : "completion";
}

function includesSupplementalReturn(mode: SubagentReturnMode): boolean {
  return mode === "supplemental" || mode === "both";
}

function includesContextPacketReturn(mode: SubagentReturnMode): boolean {
  return mode === "context_packet" || mode === "both";
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

function buildOutcomeEvidenceRefs(input: {
  sessionId: string;
  outcomes: SubagentOutcome[];
  createdAt: number;
}) {
  const refs = [];
  let index = 0;
  for (const outcome of input.outcomes) {
    if (!outcome.ok) {
      continue;
    }
    for (const evidenceRef of outcome.evidenceRefs) {
      refs.push(
        buildEvidenceRef({
          id: `${input.sessionId}:subagent_outcome:${outcome.runId}:${index}`,
          sourceType: evidenceRef.sourceType,
          locator: evidenceRef.locator,
          createdAt: input.createdAt,
        }),
      );
      index += 1;
    }
  }
  return refs;
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
  returnPacketKey?: string;
  returnTtlMs?: number;
}): {
  supplemental?: {
    attempted: boolean;
    accepted: boolean;
    truncated?: boolean;
    finalTokens?: number;
    droppedReason?: "hard_limit" | "budget_exhausted";
  };
  contextPacket?: {
    attempted: boolean;
    submitted: boolean;
    proposalId?: string;
    decision?: "accept" | "reject" | "defer";
  };
} {
  const createdAt = Date.now();
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
    contextPacket?: {
      attempted: boolean;
      submitted: boolean;
      proposalId?: string;
      decision?: "accept" | "reject" | "defer";
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

  if (includesContextPacketReturn(input.returnMode)) {
    const submitted = submitContextPacketProposal({
      runtime: {
        proposals: input.runtime.proposals,
      },
      sessionId: input.sessionId,
      issuer: "brewva.subagent",
      subject: `delegation outcome ${input.profile}`,
      label: input.returnLabel ?? `Subagent outcome (${input.profile})`,
      content,
      scopeId: input.returnScopeId ?? `subagent:${input.profile}`,
      packetKey:
        input.returnPacketKey ?? `subagent_outcome:${input.profile}:${createdAt.toString(36)}`,
      evidenceRefs: buildOutcomeEvidenceRefs({
        sessionId: input.sessionId,
        outcomes: input.outcomes,
        createdAt,
      }),
      expiresAt: createdAt + (input.returnTtlMs ?? 0),
    });
    delivery.contextPacket = {
      attempted: true,
      submitted: submitted.receipt.decision === "accept",
      proposalId: submitted.proposal.id,
      decision: submitted.receipt.decision,
    };
  }

  return delivery;
}

function validateDeliveryConfiguration(
  runtime: BrewvaToolOptions["runtime"],
  returnMode: SubagentReturnMode,
  returnTtlMs: unknown,
): { ok: true } | { ok: false; message: string } {
  if (includesContextPacketReturn(returnMode) && typeof returnTtlMs !== "number") {
    return {
      ok: false,
      message: "Error: returnTtlMs is required when returnMode includes context_packet.",
    };
  }
  if (includesContextPacketReturn(returnMode) && !runtime.proposals) {
    return {
      ok: false,
      message: "Error: runtime proposals are unavailable for context_packet delivery.",
    };
  }
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
    returnPacketKey:
      typeof params.returnPacketKey === "string" ? params.returnPacketKey : undefined,
    returnTtlMs: typeof params.returnTtlMs === "number" ? params.returnTtlMs : undefined,
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
  if (!profile) {
    return {
      ok: false,
      message: "Error: profile is required.",
    };
  }
  const request: SubagentRunRequest = {
    profile,
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
    if (input.returnMode === "supplemental" || input.returnMode === "both") {
      return failTextResult(
        "Background subagent delivery must be text_only or context_packet; supplemental return paths are not durable across turns.",
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
    if (input.returnMode !== "text_only") {
      lines.push(`delivery=${input.returnMode}`);
    }
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
          returnPacketKey: input.delivery?.returnPacketKey,
          returnTtlMs: input.delivery?.returnTtlMs,
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
  if (delivery?.contextPacket?.attempted) {
    lines.push(
      delivery.contextPacket.submitted
        ? `context_packet accepted (${delivery.contextPacket.proposalId})`
        : `context_packet not accepted (${delivery.contextPacket.decision ?? "unknown"})`,
    );
  }
  const details = {
    ...(result as unknown as Record<string, unknown>),
    delivery,
  };
  const contextPacketRejected =
    delivery?.contextPacket?.attempted === true ? !delivery.contextPacket.submitted : false;
  return textResult(
    lines.join("\n"),
    failures.length > 0 || contextPacketRejected ? withVerdict(details, "fail") : details,
  );
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
      "Prefer this for bounded investigations, reviews, or verifier-style checks.",
      "Use single for one delegated run and parallel to fan out multiple independent slices.",
      "Keep objectives specific, pass only the context references the child needs, and avoid broad parent-context dumps.",
    ],
    parameters: Type.Object({
      profile: Type.String({ minLength: 1, maxLength: 200 }),
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
      effectCeiling: PacketFields.effectCeiling,
      waitMode: Type.Optional(WaitModeSchema),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
      returnMode: Type.Optional(ReturnModeSchema),
      returnLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
      returnScopeId: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
      returnPacketKey: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
      returnTtlMs: Type.Optional(Type.Integer({ minimum: 1 })),
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
      const deliveryValidation = validateDeliveryConfiguration(
        options.runtime,
        returnMode,
        params.returnTtlMs,
      );
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
        profile: params.profile,
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
      "Use this when tasks are independent and a shared packet plus per-task objectives is clearer than one large delegated run.",
      "Keep each task label and objective specific so the parent can inspect outcomes separately.",
      "Prefer read-only profiles unless the workflow is explicitly ready to inspect and merge isolated patch results.",
    ],
    parameters: Type.Object({
      profile: Type.String({ minLength: 1, maxLength: 200 }),
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
      effectCeiling: PacketFields.effectCeiling,
      waitMode: Type.Optional(WaitModeSchema),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
      returnMode: Type.Optional(ReturnModeSchema),
      returnLabel: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
      returnScopeId: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
      returnPacketKey: Type.Optional(Type.String({ minLength: 1, maxLength: 240 })),
      returnTtlMs: Type.Optional(Type.Integer({ minimum: 1 })),
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
      const deliveryValidation = validateDeliveryConfiguration(
        options.runtime,
        returnMode,
        params.returnTtlMs,
      );
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
        profile: params.profile,
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
