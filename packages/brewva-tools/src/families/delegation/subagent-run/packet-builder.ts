import type {
  ExplorerConsultBrief,
  DelegationCompletionPredicate,
  DelegationPacket,
  DelegationTaskPacket,
  SubagentAgent,
  SubagentDelegationMode,
  SubagentExecutionBoundary,
  SubagentExecutionShape,
  SubagentForkTurns,
  SubagentGateReason,
  SubagentReturnMode,
  SubagentRunRequest,
} from "../../../contracts/index.js";
import type {
  CompletionPredicateInput,
  DiagnosticSubagentFanoutParams,
  DiagnosticSubagentRunParams,
  PublicTaskPacketInput,
  SharedPacketInput,
  SubagentFanoutParams,
  SubagentRunParams,
  TaskPacketInput,
} from "./schemas.js";

function hasSinglePacketInput(params: SharedPacketInput): boolean {
  return (
    params.objective !== undefined ||
    params.deliverable !== undefined ||
    params.consultBrief !== undefined ||
    params.constraints !== undefined ||
    params.sharedNotes !== undefined ||
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
  if (!preferredTools && !fallbackTools) {
    return undefined;
  }
  return {
    preferredTools,
    fallbackTools,
  };
}

function buildConsultBrief(
  value: SharedPacketInput["consultBrief"],
): ExplorerConsultBrief | undefined {
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
    executionHints: buildExecutionHints(packet.executionHints),
    contextRefs: packet.contextRefs,
    contextBudget,
    completionPredicate: buildCompletionPredicate(packet.completionPredicate),
    effectCeiling,
  };
}

function buildPublicPacket(input: {
  packet: Omit<
    SubagentRunParams,
    | "agent"
    | "skillName"
    | "taskName"
    | "nickname"
    | "forkTurns"
    | "gateReason"
    | "waitMode"
    | "timeoutMs"
    | "returnMode"
    | "returnLabel"
    | "returnScopeId"
  >;
}): DelegationPacket | undefined {
  return buildPacket({
    objective: input.packet.objective,
    deliverable: input.packet.deliverable,
    consultBrief: input.packet.brief,
    constraints: input.packet.constraints,
    sharedNotes: input.packet.sharedNotes,
    executionHints: input.packet.executionHints,
    contextRefs: input.packet.contextRefs,
    contextBudget: input.packet.contextBudget,
    completionPredicate: input.packet.completionPredicate,
    effectCeiling: input.packet.effectCeiling,
  });
}

function buildPublicTask(input: {
  task: PublicTaskPacketInput;
  brief?: ExplorerConsultBrief;
}): DelegationTaskPacket {
  const packet = buildPacket({
    objective: input.task.objective,
    deliverable: input.task.deliverable,
    constraints: input.task.constraints,
    sharedNotes: input.task.sharedNotes,
    consultBrief: input.brief,
    executionHints: input.task.executionHints,
    contextRefs: input.task.contextRefs,
    contextBudget: input.task.contextBudget,
    completionPredicate: input.task.completionPredicate,
    effectCeiling: input.task.effectCeiling,
  });
  if (!packet) {
    throw new Error("parallel task objective is required");
  }
  return {
    label: input.task.label,
    taskName: input.task.taskName,
    nickname: input.task.nickname,
    ...packet,
  };
}

function normalizeAgent(value: unknown): SubagentAgent | undefined {
  return value === "navigator" ||
    value === "explorer" ||
    value === "worker" ||
    value === "verifier" ||
    value === "librarian"
    ? value
    : undefined;
}

function normalizeGateReason(value: unknown): SubagentGateReason | undefined {
  return value === "find_evidence" ||
    value === "make_judgment" ||
    value === "implement_isolated" ||
    value === "verify_reproducibly" ||
    value === "compound_knowledge"
    ? value
    : undefined;
}

function normalizeForkTurns(value: unknown): SubagentForkTurns | undefined {
  if (value === "none" || value === "all") {
    return value;
  }
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  return undefined;
}

function buildExecutionShape(
  value:
    | Pick<DiagnosticSubagentRunParams, "boundary" | "managedToolMode">
    | Pick<DiagnosticSubagentFanoutParams, "boundary" | "managedToolMode">
    | undefined,
): SubagentExecutionShape | undefined {
  if (!value) {
    return undefined;
  }
  const boundary = normalizeBoundary(value.boundary);
  const managedToolMode =
    value.managedToolMode === "direct" || value.managedToolMode === "hosted"
      ? value.managedToolMode
      : undefined;
  if (!boundary && !managedToolMode) {
    return undefined;
  }
  return {
    boundary,
    managedToolMode,
  };
}

function normalizeBoundary(value: unknown): SubagentExecutionBoundary | undefined {
  return value === "safe" || value === "effectful" ? value : undefined;
}

export function resolveMode(
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

export function resolveReturnMode(value: unknown): SubagentReturnMode {
  return value === "supplemental" || value === "text_only" ? value : "text_only";
}

export function resolveWaitMode(value: unknown): "completion" | "start" {
  return value === "start" ? "start" : "completion";
}

export function includesSupplementalReturn(mode: SubagentReturnMode): boolean {
  return mode === "supplemental";
}

function toTask(task: TaskPacketInput): DelegationTaskPacket {
  const packet = buildPacket(task);
  if (!packet) {
    throw new Error("parallel task objective is required");
  }
  return {
    label: task.label,
    taskName: task.taskName,
    nickname: task.nickname,
    ...packet,
  };
}

export function buildRunRequestFromParams(input: {
  params: DiagnosticSubagentRunParams | DiagnosticSubagentFanoutParams;
  mode: SubagentDelegationMode;
}): { ok: true; request: SubagentRunRequest } | { ok: false; message: string } {
  const { params } = input;
  const agent = normalizeAgent(params.agent) ?? "explorer";
  const targetName = params.targetName?.trim() ? params.targetName : undefined;
  const explicitSkillName = params.skillName?.trim() ? params.skillName : undefined;
  const consultKind =
    params.consultKind === "investigate" ||
    params.consultKind === "diagnose" ||
    params.consultKind === "design" ||
    params.consultKind === "review"
      ? params.consultKind
      : undefined;
  const executionShape = buildExecutionShape(params);
  const request: SubagentRunRequest = {
    agent,
    targetName,
    skillName: explicitSkillName,
    consultKind,
    executionShape,
    mode: input.mode,
    timeoutMs: params.timeoutMs,
  };

  if (input.mode === "single") {
    const packet = buildPacket(params);
    if (!packet) {
      return {
        ok: false,
        message: "Error: objective is required for mode=single.",
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

export function buildPublicRunRequestFromParams(input: {
  params: SubagentRunParams;
}): { ok: true; request: SubagentRunRequest } | { ok: false; message: string } {
  const agent = normalizeAgent(input.params.agent);
  if (!agent) {
    return {
      ok: false,
      message: "Error: agent is required for subagent_run.",
    };
  }
  const skillName = input.params.skillName?.trim() || undefined;
  const packet = buildPublicPacket({ packet: input.params });
  if (!packet) {
    return {
      ok: false,
      message: "Error: objective is required for subagent_run.",
    };
  }
  return {
    ok: true,
    request: {
      agent,
      skillName,
      taskName: input.params.taskName,
      nickname: input.params.nickname,
      forkTurns: normalizeForkTurns(input.params.forkTurns) ?? "none",
      gateReason: normalizeGateReason(input.params.gateReason),
      mode: "single",
      timeoutMs: input.params.timeoutMs,
      packet,
    },
  };
}

export function buildPublicFanoutRequestFromParams(input: {
  params: SubagentFanoutParams;
}): { ok: true; request: SubagentRunRequest } | { ok: false; message: string } {
  const agent = normalizeAgent(input.params.agent);
  if (!agent) {
    return {
      ok: false,
      message: "Error: agent is required for subagent_fanout.",
    };
  }
  const skillName = input.params.skillName?.trim() || undefined;
  const sharedPacket = input.params.objective
    ? buildPublicPacket({
        packet: {
          ...input.params,
          objective: input.params.objective,
        },
      })
    : undefined;
  try {
    return {
      ok: true,
      request: {
        agent,
        skillName,
        taskName: input.params.taskName,
        nickname: input.params.nickname,
        forkTurns: normalizeForkTurns(input.params.forkTurns) ?? "none",
        gateReason: normalizeGateReason(input.params.gateReason),
        mode: "parallel",
        timeoutMs: input.params.timeoutMs,
        packet: sharedPacket,
        tasks: input.params.tasks.map((task) =>
          buildPublicTask({ task, brief: input.params.brief }),
        ),
      },
    };
  } catch (error) {
    return {
      ok: false,
      message: `Error: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }
}

export function buildDeliveryRequest(
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

export function resolveDelegationLabel(
  request: Pick<
    SubagentRunRequest,
    "agent" | "targetName" | "skillName" | "consultKind" | "taskName" | "nickname"
  >,
): string {
  return (
    request.taskName ??
    request.nickname ??
    request.targetName ??
    request.agent ??
    request.consultKind ??
    request.skillName ??
    "ad-hoc"
  );
}
