import {
  getToolActionPolicy,
  type ToolActionClass,
  type ToolActionPolicy,
  type ToolAdmissionBehavior,
  type ToolEffectClass,
  type ToolReceiptPolicy,
  type ToolRecoveryPolicy,
  type ToolRiskLevel,
} from "@brewva/brewva-runtime/security";
import type { SessionPhase } from "@brewva/brewva-substrate/session";
import { TOOL_EXECUTION_PHASES, type ToolExecutionPhase } from "@brewva/brewva-substrate/tools";
import type { PendingEffectCommitmentRequest } from "@brewva/brewva-vocabulary/iteration";

export type OperatorSafetyShellPhase = "inspect" | "authorize" | "commit" | "record" | "recover";
export type OperatorSafetyShellTone = "neutral" | "info" | "warning" | "success" | "error";
export type OperatorSafetyShellDetailKey =
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

export interface OperatorSafetyShellDetailRow {
  key: OperatorSafetyShellDetailKey;
  label: string;
  value: string;
}

export interface OperatorSafetyShellView {
  phase: OperatorSafetyShellPhase;
  label: string;
  shortLabel: string;
  title: string;
  headline: string;
  subline?: string;
  tone: OperatorSafetyShellTone;
  effectSummary?: string;
  riskSummary?: string;
  receiptSummary?: string;
  recoverySummary?: string;
  statusText: string;
}

export interface OperatorSafetyShellToolView extends OperatorSafetyShellView {
  kind: "tool";
  toolName: string;
  actionClass?: ToolActionClass;
  executionPhase?: ToolExecutionPhase;
  policySource: "resolved" | "missing";
  details: OperatorSafetyShellDetailRow[];
}

export interface OperatorSafetyShellAskView extends OperatorSafetyShellView {
  kind: "ask";
  requestId: string;
  subject: string;
  toolName: string;
  boundary: PendingEffectCommitmentRequest["boundary"];
  primaryActionLabel: string;
  denyActionLabel: string;
  details: OperatorSafetyShellDetailRow[];
}

export interface OperatorSafetyShellAskEmptyView extends OperatorSafetyShellView {
  kind: "ask_empty";
}

export interface OperatorSafetyShellSessionView extends OperatorSafetyShellView {
  kind: "session";
  source: "ask" | "tool" | "recovery" | "idle";
}

export interface OperatorSafetyShellToolViewInput {
  toolName: string;
  args?: unknown;
  executionPhase?: ToolExecutionPhase;
  status?: string;
}

export interface OperatorSafetyShellAskViewInput {
  request: PendingEffectCommitmentRequest;
}

export interface OperatorSafetyShellSessionViewInput {
  phase?: SessionPhase;
  pendingAskCount?: number;
  activeTool?: OperatorSafetyShellToolView;
}

export interface OperatorSafetyShellCopy {
  readonly reasonReceiptRecovery: string;
  readonly askBeforeEffectBoundary: string;
  readonly inspectReplayUndo: string;
}

export const OPERATOR_SAFETY_SHELL_COPY: OperatorSafetyShellCopy = {
  reasonReceiptRecovery:
    "Every code-changing action gets a reason, a receipt, and a recovery path.",
  askBeforeEffectBoundary: "Brewva asks before crossing effect boundaries.",
  inspectReplayUndo: "Brewva keeps receipts you can inspect, replay, and undo from.",
};

const LABEL_BY_PHASE: Record<OperatorSafetyShellPhase, string> = {
  inspect: "Inspect",
  authorize: "Ask",
  commit: "Commit",
  record: "Record",
  recover: "Recover",
};

const SHORT_LABEL_BY_PHASE: Record<OperatorSafetyShellPhase, string> = {
  inspect: "inspect",
  authorize: "ask",
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

function phaseLabel(phase: OperatorSafetyShellPhase): string {
  return LABEL_BY_PHASE[phase];
}

function shortPhaseLabel(phase: OperatorSafetyShellPhase): string {
  return SHORT_LABEL_BY_PHASE[phase];
}

function unreachableOperatorSafetyShellPhase(phase: never): never {
  throw new Error(`Unsupported operator safety phase: ${String(phase)}`);
}

function resolveToolPolicy(input: {
  toolName: string;
  args?: unknown;
}): ToolActionPolicy | undefined {
  return getToolActionPolicy(input.toolName, undefined, asRecord(input.args));
}

export function isOperatorSafetyShellToolExecutionPhase(
  value: unknown,
): value is ToolExecutionPhase {
  return typeof value === "string" && TOOL_EXECUTION_PHASES.includes(value as ToolExecutionPhase);
}

function isReadOnlyActionClass(actionClass: ToolActionClass | undefined): boolean {
  return actionClass ? READ_ONLY_ACTION_CLASSES.has(actionClass) : false;
}

export function isOperatorSafetyShellReadOnlyActionClass(
  actionClass: ToolActionClass | undefined,
): boolean {
  return isReadOnlyActionClass(actionClass);
}

function isEffectfulActionClass(actionClass: ToolActionClass | undefined): boolean {
  return actionClass !== undefined && !isReadOnlyActionClass(actionClass);
}

function resolveToolPhase(input: {
  actionClass?: ToolActionClass;
  executionPhase?: ToolExecutionPhase;
  status?: string;
}): OperatorSafetyShellPhase {
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

function resolveToolTone(input: {
  phase: OperatorSafetyShellPhase;
  status?: string;
}): OperatorSafetyShellTone {
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
      return unreachableOperatorSafetyShellPhase(input.phase);
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
  key: OperatorSafetyShellDetailKey,
  label: string,
  value: string | undefined,
): OperatorSafetyShellDetailRow | undefined {
  return value ? { key, label, value } : undefined;
}

function buildShellViewBase(input: {
  phase: OperatorSafetyShellPhase;
  titleSubject?: string;
  title?: string;
  headline?: string;
  subline?: string;
  tone: OperatorSafetyShellTone;
  effectSummary?: string;
  riskSummary?: string;
  receiptSummary?: string;
  recoverySummary?: string;
  statusText?: string;
}): OperatorSafetyShellView {
  const label = phaseLabel(input.phase);
  return {
    phase: input.phase,
    label,
    shortLabel: shortPhaseLabel(input.phase),
    title: input.title ?? formatOperatorSafetyShellTitle({ label }, input.titleSubject),
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

function headlineForPhase(phase: OperatorSafetyShellPhase): string {
  switch (phase) {
    case "authorize":
      return OPERATOR_SAFETY_SHELL_COPY.askBeforeEffectBoundary;
    case "commit":
      return OPERATOR_SAFETY_SHELL_COPY.reasonReceiptRecovery;
    case "record":
      return OPERATOR_SAFETY_SHELL_COPY.inspectReplayUndo;
    case "recover":
      return OPERATOR_SAFETY_SHELL_COPY.inspectReplayUndo;
    case "inspect":
      return OPERATOR_SAFETY_SHELL_COPY.askBeforeEffectBoundary;
    default:
      return unreachableOperatorSafetyShellPhase(phase);
  }
}

function sublineForPhase(phase: OperatorSafetyShellPhase): string | undefined {
  switch (phase) {
    case "authorize":
      return OPERATOR_SAFETY_SHELL_COPY.reasonReceiptRecovery;
    case "commit":
      return OPERATOR_SAFETY_SHELL_COPY.inspectReplayUndo;
    case "record":
      return OPERATOR_SAFETY_SHELL_COPY.reasonReceiptRecovery;
    case "recover":
      return OPERATOR_SAFETY_SHELL_COPY.reasonReceiptRecovery;
    case "inspect":
      return OPERATOR_SAFETY_SHELL_COPY.inspectReplayUndo;
    default:
      return unreachableOperatorSafetyShellPhase(phase);
  }
}

export function formatOperatorSafetyShellTitle(
  shellView: Pick<OperatorSafetyShellView, "label">,
  subject?: string,
): string {
  const normalizedSubject = subject?.trim();
  return normalizedSubject && normalizedSubject.length > 0
    ? `${shellView.label} · ${normalizedSubject}`
    : shellView.label;
}

export function buildOperatorSafetyShellToolView(
  input: OperatorSafetyShellToolViewInput,
): OperatorSafetyShellToolView {
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
  ].filter((row): row is OperatorSafetyShellDetailRow => row !== undefined);
  const base = buildShellViewBase({
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

export function buildOperatorSafetyShellAskView(
  input: OperatorSafetyShellAskViewInput,
): OperatorSafetyShellAskView {
  const request = input.request;
  const policy = resolveToolPolicy({ toolName: request.toolName });
  const effectValue = formatEffectsValue(
    (policy?.effectClasses ?? request.effects) as Parameters<typeof formatEffectsValue>[0],
  );
  const riskValue = formatRiskValue(
    policy,
    request.defaultRisk as Parameters<typeof formatRiskValue>[1],
  );
  const receiptValue = formatReceiptPolicyValue(policy?.receiptPolicy);
  const recoveryValue = formatRecoveryPolicyValue(policy?.recoveryPolicy);
  const admissionValue = formatAdmissionValue(policy?.defaultAdmission);
  const effectSummary = prefixedSummary("Effects", effectValue);
  const riskSummary = prefixedSummary("Risk", riskValue);
  const receiptSummary = prefixedSummary("Receipt", receiptValue);
  const recoverySummary = prefixedSummary("Recovery", recoveryValue);
  const base = buildShellViewBase({
    phase: "authorize",
    title: "Ask operator",
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
  ].filter((row): row is OperatorSafetyShellDetailRow => row !== undefined);
  return {
    ...base,
    kind: "ask",
    requestId: request.requestId,
    subject: request.subject,
    toolName: request.toolName,
    boundary: request.boundary,
    primaryActionLabel: "Allow once",
    denyActionLabel: "Deny",
    details,
  };
}

export function buildOperatorSafetyShellAskEmptyView(): OperatorSafetyShellAskEmptyView {
  return {
    ...buildShellViewBase({
      phase: "authorize",
      title: "Operator safety",
      headline: "No pending asks.",
      subline: OPERATOR_SAFETY_SHELL_COPY.askBeforeEffectBoundary,
      tone: "neutral",
      statusText: "Ask",
    }),
    kind: "ask_empty",
  };
}

export function buildOperatorSafetyShellIdleView(): OperatorSafetyShellSessionView {
  return {
    ...buildShellViewBase({
      phase: "record",
      title: "Record receipts",
      tone: "success",
      headline: OPERATOR_SAFETY_SHELL_COPY.inspectReplayUndo,
      subline: OPERATOR_SAFETY_SHELL_COPY.reasonReceiptRecovery,
    }),
    kind: "session",
    source: "idle",
  };
}

export function buildOperatorSafetyShellSessionView(
  input: OperatorSafetyShellSessionViewInput,
): OperatorSafetyShellSessionView | undefined {
  if ((input.pendingAskCount ?? 0) > 0 || input.phase?.kind === "waiting_approval") {
    return {
      ...buildShellViewBase({
        phase: "authorize",
        titleSubject: "operator",
        tone: "warning",
      }),
      kind: "session",
      source: "ask",
    };
  }

  if (input.phase?.kind === "recovering" || input.phase?.kind === "crashed") {
    return {
      ...buildShellViewBase({
        phase: "recover",
        titleSubject: "runtime",
        tone: "error",
      }),
      kind: "session",
      source: "recovery",
    };
  }

  if (input.phase?.kind === "tool_executing") {
    const toolShellView =
      input.activeTool ??
      buildOperatorSafetyShellToolView({
        toolName: input.phase.toolName,
      });
    return {
      ...buildShellViewBase({
        phase: toolShellView.phase,
        titleSubject: toolShellView.toolName,
        tone: toolShellView.tone,
        effectSummary: toolShellView.effectSummary,
        riskSummary: toolShellView.riskSummary,
        receiptSummary: toolShellView.receiptSummary,
        recoverySummary: toolShellView.recoverySummary,
        statusText: toolShellView.statusText,
      }),
      kind: "session",
      source: "tool",
    };
  }

  if (input.phase?.kind === "idle") {
    return buildOperatorSafetyShellIdleView();
  }

  return undefined;
}
