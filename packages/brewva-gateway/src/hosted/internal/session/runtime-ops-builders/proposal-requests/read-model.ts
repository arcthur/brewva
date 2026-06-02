import type {
  EffectCommitmentRequestRecord,
  PendingEffectCommitmentRequest,
} from "@brewva/brewva-vocabulary/iteration";
import type { HostedRuntimeOpsContext } from "../../runtime-ops-context.js";

export type ApprovalRequestRow = EffectCommitmentRequestRecord &
  PendingEffectCommitmentRequest & {
    readonly turnId?: string;
  };
type RequestState = ApprovalRequestRow["state"];
const ARG_SUMMARY_MAX_LENGTH = 240;

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function formatArgsSummaryValue(value: string): string | undefined {
  const normalized = value.trim().replaceAll(/\s+/g, " ");
  if (normalized.length === 0) {
    return undefined;
  }
  return normalized.length > ARG_SUMMARY_MAX_LENGTH
    ? `${normalized.slice(0, ARG_SUMMARY_MAX_LENGTH)}...`
    : normalized;
}

function readNamedStringArg(
  args: Record<string, unknown>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = formatArgsSummaryValue(readString(args[name]) ?? "");
    if (value) {
      return value;
    }
  }
  return undefined;
}

function formatApprovalArgsSummary(input: {
  toolName: string;
  args: Record<string, unknown>;
  fallbackReason?: string;
}): string | undefined {
  if (input.toolName === "exec") {
    const command = readNamedStringArg(input.args, ["command"]);
    if (command) {
      return `command=${command}`;
    }
  }

  const path = readNamedStringArg(input.args, ["path", "filePath", "file_path", "targetPath"]);
  if (path) {
    return `path=${path}`;
  }

  const query = readNamedStringArg(input.args, ["query", "pattern"]);
  if (query) {
    return `query=${query}`;
  }

  return input.fallbackReason;
}

function proposalIdForRequest(input: {
  sessionId: string;
  turnId?: string;
  toolCallId?: string;
  proposedByToolCallId: ReadonlyMap<string, string>;
}): string {
  if (input.toolCallId) {
    const proposed = input.proposedByToolCallId.get(input.toolCallId);
    if (proposed) {
      return proposed;
    }
    if (input.turnId) {
      return `tool:${encodeURIComponent(input.sessionId)}:${encodeURIComponent(input.turnId)}:${encodeURIComponent(input.toolCallId)}`;
    }
    return `tool:${encodeURIComponent(input.sessionId)}:${encodeURIComponent(input.toolCallId)}`;
  }
  return `approval:${encodeURIComponent(input.sessionId)}:unknown`;
}

function requestStateForDecision(
  decision: unknown,
): "accepted" | "denied" | "cancelled" | undefined {
  switch (decision) {
    case "accept":
      return "accepted";
    case "deny":
      return "denied";
    case "cancel":
      return "cancelled";
    default:
      return undefined;
  }
}

function readRequestState(value: unknown): RequestState | undefined {
  return value === "pending" ||
    value === "accepted" ||
    value === "denied" ||
    value === "cancelled" ||
    value === "consumed"
    ? value
    : undefined;
}

function applyRequestListQuery(rows: ApprovalRequestRow[], query: unknown): ApprovalRequestRow[] {
  const state = readRequestState(readObject(query).state);
  return state ? rows.filter((row) => row.state === state) : rows;
}

function buildApprovalRequests(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
): ApprovalRequestRow[] {
  const proposedByToolCallId = new Map<string, string>();
  const proposedCallsByToolCallId = new Map<string, Record<string, unknown>>();
  const rows = new Map<string, ApprovalRequestRow>();
  for (const event of ctx.listEvents(sessionId)) {
    const payload = readObject(event.payload);
    if (event.type === "tool.proposed") {
      const commitmentId = readString(payload.commitmentId);
      const call = readObject(payload.call);
      const toolCallId = readString(call.toolCallId);
      if (commitmentId && toolCallId) {
        proposedByToolCallId.set(toolCallId, commitmentId);
        proposedCallsByToolCallId.set(toolCallId, call);
      }
      continue;
    }
    if (event.type === "approval.requested") {
      const requestId = readString(payload.id) ?? readString(payload.requestId);
      if (!requestId) {
        continue;
      }
      const authority = readObject(payload.authority);
      const toolName = readString(payload.toolName) ?? "unknown";
      const toolCallId = readString(payload.toolCallId);
      const turnId = readString(payload.turnId) ?? readString(event.turnId);
      const proposedCall = toolCallId ? proposedCallsByToolCallId.get(toolCallId) : undefined;
      const argsSummary = formatApprovalArgsSummary({
        toolName,
        args: readObject(proposedCall?.args),
        fallbackReason: readString(payload.reason),
      });
      const proposalId = proposalIdForRequest({
        sessionId,
        turnId,
        toolCallId,
        proposedByToolCallId,
      });
      rows.set(requestId, {
        id: requestId,
        requestId,
        proposalId,
        state: "pending",
        createdAt: event.timestamp,
        subject: toolName,
        toolName,
        ...(toolCallId ? { toolCallId } : {}),
        ...(turnId ? { turnId } : {}),
        boundary: readString(authority.boundary) ?? "effectful",
        effects: readStringArray(authority.effects),
        evidenceRefs: [],
        ...(typeof event.turn === "number" ? { turn: event.turn } : {}),
        defaultRisk: readString(authority.riskLevel),
        ...(argsSummary ? { argsSummary } : {}),
        argsDigest: readString(payload.id),
      });
      continue;
    }
    if (event.type === "approval.decided") {
      const requestId = readString(payload.id) ?? readString(payload.requestId);
      const state = requestStateForDecision(payload.decision);
      if (!requestId || !state) {
        continue;
      }
      const existing = rows.get(requestId);
      if (!existing || existing.state !== "pending") {
        continue;
      }
      rows.set(requestId, {
        ...existing,
        state,
        actor: readString(payload.actor),
        reason: readString(payload.reason),
      });
      continue;
    }
    if (event.type === "tool.committed" || event.type === "tool.aborted") {
      const commitmentId = readString(payload.commitmentId);
      if (!commitmentId) {
        continue;
      }
      for (const [requestId, row] of rows.entries()) {
        if (row.proposalId === commitmentId && row.state === "accepted") {
          rows.set(requestId, { ...row, state: "consumed" });
        }
      }
    }
  }
  return [...rows.values()].toSorted((left, right) => left.createdAt - right.createdAt);
}

export function buildApprovalRequestsForOptionalSession(
  ctx: HostedRuntimeOpsContext,
  sessionId: string | undefined,
  query?: unknown,
): ApprovalRequestRow[] {
  const sessionIds = sessionId ? [sessionId] : ctx.sessionIds();
  return applyRequestListQuery(
    sessionIds.flatMap((id) => buildApprovalRequests(ctx, id)),
    query,
  );
}
