import {
  getToolActionPolicy,
  type PendingEffectCommitmentRequest,
  type ToolActionClass,
  type ToolActionPolicy,
  type ToolAdmissionBehavior,
  type ToolEffectClass,
  type ToolReceiptPolicy,
  type ToolRecoveryPolicy,
  type ToolRiskLevel,
} from "@brewva/brewva-runtime";
import {
  TOOL_EXECUTION_PHASES,
  type SessionPhase,
  type ToolExecutionPhase,
} from "@brewva/brewva-substrate";

export type TrustLoopPhase = "inspect" | "authorize" | "commit" | "record" | "recover";
export type TrustLoopTone = "neutral" | "info" | "warning" | "success" | "error";
export type TrustLoopDetailKey =
  | "subject"
  | "summary"
  | "tool"
  | "boundary"
  | "action"
  | "admission"
  | "effects"
  | "risk"
  | "receipt"
  | "recovery";

export interface TrustLoopDetailRow {
  key: TrustLoopDetailKey;
  label: string;
  value: string;
}

export interface TrustLoopProjection {
  phase: TrustLoopPhase;
  label: string;
  shortLabel: string;
  title: string;
  headline: string;
  subline?: string;
  tone: TrustLoopTone;
  effectSummary?: string;
  riskSummary?: string;
  receiptSummary?: string;
  recoverySummary?: string;
  statusText: string;
}

export interface TrustLoopToolProjection extends TrustLoopProjection {
  kind: "tool";
  toolName: string;
  actionClass?: ToolActionClass;
  executionPhase?: ToolExecutionPhase;
  policySource: "resolved" | "missing";
  details: TrustLoopDetailRow[];
}

export interface TrustLoopApprovalProjection extends TrustLoopProjection {
  kind: "approval";
  requestId: string;
  subject: string;
  toolName: string;
  boundary: PendingEffectCommitmentRequest["boundary"];
  primaryActionLabel: string;
  rejectActionLabel: string;
  details: TrustLoopDetailRow[];
}

export interface TrustLoopApprovalEmptyProjection extends TrustLoopProjection {
  kind: "approval_empty";
}

export interface TrustLoopSessionProjection extends TrustLoopProjection {
  kind: "session";
  source: "approval" | "tool" | "recovery" | "idle";
}

export interface TrustLoopToolProjectionInput {
  toolName: string;
  args?: unknown;
  executionPhase?: ToolExecutionPhase;
  status?: string;
}

export interface TrustLoopApprovalProjectionInput {
  request: PendingEffectCommitmentRequest;
}

export interface TrustLoopSessionProjectionInput {
  phase?: SessionPhase;
  pendingApprovalCount?: number;
  activeTool?: TrustLoopToolProjection;
}

export const TRUST_LOOP_COPY = {
  reasonReceiptRecovery:
    "Every code-changing action gets a reason, a receipt, and a recovery path.",
  askBeforeEffectBoundary: "Brewva asks before crossing effect boundaries.",
  inspectReplayUndo: "Brewva keeps receipts you can inspect, replay, and undo from.",
} as const;

const LABEL_BY_PHASE: Record<TrustLoopPhase, string> = {
  inspect: "Inspect",
  authorize: "Authorize",
  commit: "Commit",
  record: "Record",
  recover: "Recover",
};

const SHORT_LABEL_BY_PHASE: Record<TrustLoopPhase, string> = {
  inspect: "inspect",
  authorize: "auth",
  commit: "commit",
  record: "record",
  recover: "recover",
};

const READ_ONLY_ACTION_CLASSES = new Set<ToolActionClass>([
  "workspace_read",
  "runtime_observe",
  "local_exec_readonly",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function formatList(values: readonly string[] | undefined): string | undefined {
  if (!values || values.length === 0) {
    return undefined;
  }
  return values.join(", ");
}

function phaseLabel(phase: TrustLoopPhase): string {
  return LABEL_BY_PHASE[phase];
}

function shortPhaseLabel(phase: TrustLoopPhase): string {
  return SHORT_LABEL_BY_PHASE[phase];
}

function unreachableTrustLoopPhase(phase: never): never {
  throw new Error(`Unsupported trust loop phase: ${String(phase)}`);
}

function resolveToolPolicy(input: {
  toolName: string;
  args?: unknown;
}): ToolActionPolicy | undefined {
  return getToolActionPolicy(input.toolName, undefined, asRecord(input.args));
}

export function isTrustLoopToolExecutionPhase(value: unknown): value is ToolExecutionPhase {
  return typeof value === "string" && TOOL_EXECUTION_PHASES.includes(value as ToolExecutionPhase);
}

function isReadOnlyActionClass(actionClass: ToolActionClass | undefined): boolean {
  return actionClass ? READ_ONLY_ACTION_CLASSES.has(actionClass) : false;
}

function isEffectfulActionClass(actionClass: ToolActionClass | undefined): boolean {
  return actionClass !== undefined && !isReadOnlyActionClass(actionClass);
}

function resolveToolPhase(input: {
  actionClass?: ToolActionClass;
  executionPhase?: ToolExecutionPhase;
  status?: string;
}): TrustLoopPhase {
  if (input.executionPhase === "authorize") {
    return "authorize";
  }
  if (input.executionPhase === "record" || input.executionPhase === "cleanup") {
    return "record";
  }
  if (input.executionPhase === "classify" || input.executionPhase === "prepare") {
    return "inspect";
  }
  if (input.executionPhase === "execute") {
    return isReadOnlyActionClass(input.actionClass) ? "inspect" : "commit";
  }
  if (input.status === "completed" && isEffectfulActionClass(input.actionClass)) {
    return "record";
  }
  if (input.status === "error" && isEffectfulActionClass(input.actionClass)) {
    return "commit";
  }
  return "inspect";
}

function resolveToolTone(input: { phase: TrustLoopPhase; status?: string }): TrustLoopTone {
  if (input.status === "error") {
    return "error";
  }
  switch (input.phase) {
    case "authorize":
      return "warning";
    case "commit":
      return "warning";
    case "record":
      return "success";
    case "recover":
      return "error";
    case "inspect":
      return "info";
    default:
      return unreachableTrustLoopPhase(input.phase);
  }
}

function formatRiskValue(
  policy: ToolActionPolicy | undefined,
  defaultRisk?: ToolRiskLevel,
): string | undefined {
  const risk = policy?.riskLevel ?? defaultRisk;
  return risk;
}

function formatEffectsValue(effects: readonly ToolEffectClass[] | undefined): string | undefined {
  return formatList(effects);
}

function formatAdmissionValue(admission: ToolAdmissionBehavior | undefined): string | undefined {
  return admission;
}

function formatReceiptPolicyValue(policy: ToolReceiptPolicy | undefined): string | undefined {
  if (!policy || policy.kind === "none") {
    return undefined;
  }
  return `${policy.kind}${policy.required ? " required" : ""}`;
}

function formatRecoveryPolicyValue(policy: ToolRecoveryPolicy | undefined): string | undefined {
  if (!policy || policy.kind === "none") {
    return undefined;
  }
  switch (policy.kind) {
    case "exact_patch":
      return "patchset";
    case "compensation":
      return `compensation:${policy.mode}`;
    default:
      return policy.kind;
  }
}

function prefixedSummary(label: string, value: string | undefined): string | undefined {
  return value ? `${label}: ${value}` : undefined;
}

function detailRow(
  key: TrustLoopDetailKey,
  label: string,
  value: string | undefined,
): TrustLoopDetailRow | undefined {
  return value ? { key, label, value } : undefined;
}

function buildProjectionBase(input: {
  phase: TrustLoopPhase;
  titleSubject?: string;
  title?: string;
  headline?: string;
  subline?: string;
  tone: TrustLoopTone;
  effectSummary?: string;
  riskSummary?: string;
  receiptSummary?: string;
  recoverySummary?: string;
  statusText?: string;
}): TrustLoopProjection {
  const label = phaseLabel(input.phase);
  return {
    phase: input.phase,
    label,
    shortLabel: shortPhaseLabel(input.phase),
    title: input.title ?? formatTrustLoopTitle({ label }, input.titleSubject),
    headline: input.headline ?? headlineForPhase(input.phase),
    subline: input.subline ?? sublineForPhase(input.phase),
    tone: input.tone,
    effectSummary: input.effectSummary,
    riskSummary: input.riskSummary,
    receiptSummary: input.receiptSummary,
    recoverySummary: input.recoverySummary,
    statusText: input.statusText ?? label,
  };
}

function headlineForPhase(phase: TrustLoopPhase): string {
  switch (phase) {
    case "authorize":
      return TRUST_LOOP_COPY.askBeforeEffectBoundary;
    case "commit":
      return TRUST_LOOP_COPY.reasonReceiptRecovery;
    case "record":
      return TRUST_LOOP_COPY.inspectReplayUndo;
    case "recover":
      return TRUST_LOOP_COPY.inspectReplayUndo;
    case "inspect":
      return TRUST_LOOP_COPY.askBeforeEffectBoundary;
    default:
      return unreachableTrustLoopPhase(phase);
  }
}

function sublineForPhase(phase: TrustLoopPhase): string | undefined {
  switch (phase) {
    case "authorize":
      return TRUST_LOOP_COPY.reasonReceiptRecovery;
    case "commit":
      return TRUST_LOOP_COPY.inspectReplayUndo;
    case "record":
      return TRUST_LOOP_COPY.reasonReceiptRecovery;
    case "recover":
      return TRUST_LOOP_COPY.reasonReceiptRecovery;
    case "inspect":
      return TRUST_LOOP_COPY.inspectReplayUndo;
    default:
      return unreachableTrustLoopPhase(phase);
  }
}

export function formatTrustLoopTitle(
  projection: Pick<TrustLoopProjection, "label">,
  subject?: string,
): string {
  const normalizedSubject = subject?.trim();
  return normalizedSubject && normalizedSubject.length > 0
    ? `${projection.label} · ${normalizedSubject}`
    : projection.label;
}

export function buildTrustLoopToolProjection(
  input: TrustLoopToolProjectionInput,
): TrustLoopToolProjection {
  const policy = resolveToolPolicy({ toolName: input.toolName, args: input.args });
  const actionClass = policy?.actionClass;
  const phase = resolveToolPhase({
    actionClass,
    executionPhase: input.executionPhase,
    status: input.status,
  });
  const effectValue = formatEffectsValue(policy?.effectClasses);
  const riskValue = formatRiskValue(policy);
  const receiptValue = formatReceiptPolicyValue(policy?.receiptPolicy);
  const recoveryValue = formatRecoveryPolicyValue(policy?.recoveryPolicy);
  const effectSummary = prefixedSummary("Effects", effectValue);
  const riskSummary = prefixedSummary("Risk", riskValue);
  const receiptSummary = prefixedSummary("Receipt", receiptValue);
  const recoverySummary = prefixedSummary("Recovery", recoveryValue);
  const tone = resolveToolTone({ phase, status: input.status });
  const details = [
    detailRow("tool", "Tool", input.toolName),
    detailRow("action", "Action", actionClass),
    detailRow("admission", "Admission", formatAdmissionValue(policy?.defaultAdmission)),
    detailRow("effects", "Effects", effectValue),
    detailRow("risk", "Risk", riskValue),
    detailRow("receipt", "Receipt", receiptValue),
    detailRow("recovery", "Recovery", recoveryValue),
  ].filter((row): row is TrustLoopDetailRow => row !== undefined);
  const base = buildProjectionBase({
    phase,
    titleSubject: input.toolName,
    tone,
    effectSummary,
    riskSummary,
    receiptSummary,
    recoverySummary,
  });
  return {
    ...base,
    kind: "tool",
    toolName: input.toolName,
    actionClass,
    executionPhase: input.executionPhase,
    policySource: policy ? "resolved" : "missing",
    details,
  };
}

export function buildTrustLoopApprovalProjection(
  input: TrustLoopApprovalProjectionInput,
): TrustLoopApprovalProjection {
  const request = input.request;
  const policy = resolveToolPolicy({ toolName: request.toolName });
  const effectValue = formatEffectsValue(policy?.effectClasses ?? request.effects);
  const riskValue = formatRiskValue(policy, request.defaultRisk);
  const receiptValue = formatReceiptPolicyValue(policy?.receiptPolicy);
  const recoveryValue = formatRecoveryPolicyValue(policy?.recoveryPolicy);
  const admissionValue = formatAdmissionValue(policy?.defaultAdmission);
  const effectSummary = prefixedSummary("Effects", effectValue);
  const riskSummary = prefixedSummary("Risk", riskValue);
  const receiptSummary = prefixedSummary("Receipt", receiptValue);
  const recoverySummary = prefixedSummary("Recovery", recoveryValue);
  const base = buildProjectionBase({
    phase: "authorize",
    title: "Authorize effect",
    tone: "warning",
    effectSummary,
    riskSummary,
    receiptSummary,
    recoverySummary,
  });
  const details = [
    detailRow("subject", "Subject", request.subject),
    detailRow("summary", "Summary", request.argsSummary),
    detailRow("tool", "Tool", request.toolName),
    detailRow("boundary", "Boundary", request.boundary),
    detailRow("effects", "Effects", effectValue),
    detailRow("risk", "Risk", riskValue),
    detailRow("admission", "Admission", admissionValue),
    detailRow("receipt", "Receipt", receiptValue),
    detailRow("recovery", "Recovery", recoveryValue),
  ].filter((row): row is TrustLoopDetailRow => row !== undefined);
  return {
    ...base,
    kind: "approval",
    requestId: request.requestId,
    subject: request.subject,
    toolName: request.toolName,
    boundary: request.boundary,
    primaryActionLabel: "Authorize once",
    rejectActionLabel: "Reject",
    details,
  };
}

export function buildTrustLoopApprovalEmptyProjection(): TrustLoopApprovalEmptyProjection {
  return {
    ...buildProjectionBase({
      phase: "authorize",
      title: "Authorize effects",
      headline: "No pending effects to authorize.",
      subline: TRUST_LOOP_COPY.askBeforeEffectBoundary,
      tone: "neutral",
      statusText: "Authorize",
    }),
    kind: "approval_empty",
  };
}

export function buildTrustLoopIdleProjection(): TrustLoopSessionProjection {
  return {
    ...buildProjectionBase({
      phase: "record",
      title: "Record receipts",
      tone: "success",
      headline: TRUST_LOOP_COPY.inspectReplayUndo,
      subline: TRUST_LOOP_COPY.reasonReceiptRecovery,
      statusText: TRUST_LOOP_COPY.inspectReplayUndo,
    }),
    kind: "session",
    source: "idle",
  };
}

export function buildTrustLoopSessionProjection(
  input: TrustLoopSessionProjectionInput,
): TrustLoopSessionProjection | undefined {
  if ((input.pendingApprovalCount ?? 0) > 0 || input.phase?.kind === "waiting_approval") {
    return {
      ...buildProjectionBase({
        phase: "authorize",
        titleSubject: "approval",
        tone: "warning",
      }),
      kind: "session",
      source: "approval",
    };
  }

  if (input.phase?.kind === "recovering" || input.phase?.kind === "crashed") {
    return {
      ...buildProjectionBase({
        phase: "recover",
        titleSubject: "runtime",
        tone: "error",
      }),
      kind: "session",
      source: "recovery",
    };
  }

  if (input.phase?.kind === "tool_executing") {
    const toolProjection =
      input.activeTool ??
      buildTrustLoopToolProjection({
        toolName: input.phase.toolName,
      });
    return {
      ...buildProjectionBase({
        phase: toolProjection.phase,
        titleSubject: toolProjection.toolName,
        tone: toolProjection.tone,
        effectSummary: toolProjection.effectSummary,
        riskSummary: toolProjection.riskSummary,
        receiptSummary: toolProjection.receiptSummary,
        recoverySummary: toolProjection.recoverySummary,
        statusText: toolProjection.statusText,
      }),
      kind: "session",
      source: "tool",
    };
  }

  if (input.phase?.kind === "idle") {
    return buildTrustLoopIdleProjection();
  }

  return undefined;
}
