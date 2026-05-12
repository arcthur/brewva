import type {
  AdvisorConsultBrief,
  DelegationCompletionPredicate,
  DelegationPacket,
  DelegationTaskPacket,
  SubagentDelegationMode,
  SubagentExecutionBoundary,
  SubagentExecutionShape,
  SubagentReturnMode,
  SubagentRunRequest,
} from "../../../contracts/index.js";
import type {
  CompletionPredicateInput,
  DiagnosticSubagentFanoutParams,
  DiagnosticSubagentRunParams,
  ExecutionShapeInput,
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
    executionHints: buildExecutionHints(packet.executionHints),
    contextRefs: packet.contextRefs,
    contextBudget,
    completionPredicate: buildCompletionPredicate(packet.completionPredicate),
    effectCeiling,
  };
}

function buildPublicPacket(input: {
  skillName: string;
  packet: Omit<
    SubagentRunParams,
    "waitMode" | "timeoutMs" | "returnMode" | "returnLabel" | "returnScopeId"
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
  skillName: string;
  task: PublicTaskPacketInput;
  brief?: AdvisorConsultBrief;
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
    ...packet,
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
    value.managedToolMode === "direct" || value.managedToolMode === "hosted"
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
    ...packet,
  };
}

export function buildRunRequestFromParams(input: {
  params: DiagnosticSubagentRunParams | DiagnosticSubagentFanoutParams;
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

export function buildPublicRunRequestFromParams(input: {
  params: SubagentRunParams;
}): { ok: true; request: SubagentRunRequest } | { ok: false; message: string } {
  const skillName = input.params.skillName.trim();
  const packet = buildPublicPacket({ skillName, packet: input.params });
  if (!packet) {
    return {
      ok: false,
      message: "Error: objective is required for subagent_run.",
    };
  }
  return {
    ok: true,
    request: {
      skillName,
      mode: "single",
      timeoutMs: input.params.timeoutMs,
      packet,
    },
  };
}

export function buildPublicFanoutRequestFromParams(input: {
  params: SubagentFanoutParams;
}): { ok: true; request: SubagentRunRequest } | { ok: false; message: string } {
  const skillName = input.params.skillName.trim();
  const sharedPacket = input.params.objective
    ? buildPublicPacket({
        skillName,
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
        skillName,
        mode: "parallel",
        timeoutMs: input.params.timeoutMs,
        packet: sharedPacket,
        tasks: input.params.tasks.map((task) =>
          buildPublicTask({ skillName, task, brief: input.params.brief }),
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
