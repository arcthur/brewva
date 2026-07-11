import { isRecord } from "@brewva/brewva-std/unknown";
import type {
  EffectCommitmentRequestRecord,
  PendingEffectCommitmentRequest,
} from "@brewva/brewva-vocabulary/iteration";
import { previewWorkspaceRewind } from "../../recovery/rewind-engine.js";
import type { HostedRuntimeOpsContext } from "../../runtime-ops-context.js";

// Effect classes (from the kernel's ToolEffectClass union) whose mutation a
// whole-workspace rewind can restore. A world-restore reverses the workspace to
// the last checkpoint, so a workspace-mutating effect is workspace-rewindable
// even when the per-effect tier marks it manual_recovery — the coarse advisory
// the world lane enables. Non-filesystem effects (external_network,
// credential_access, schedule/memory/budget mutation, …) stay outside any
// workspace rewind and never get the advisory.
const WORKSPACE_MUTATING_EFFECTS = new Set(["workspace_write", "local_exec"]);

/**
 * Whether a `/rewind code` could restore the workspace to a recent checkpoint:
 * world snapshots enabled AND the latest rewindable checkpoint carries an
 * available world. A world restore reverses the WHOLE workspace to that
 * checkpoint, so it undoes any effect committed after it — including a pending
 * effect once it runs — without needing per-effect patch material (the exact
 * gap the world lane closed). This is a coarse workspace-level fact, not a
 * per-effect guarantee, which is why the card field is named
 * `workspaceRewindable`, not `reversible`.
 *
 * Cost: one `previewWorkspaceRewind` (a rewind-state fold + a shallow world
 * check) per session per approval-list build, and zero when the world store is
 * disabled (the default). If the store defaults on, memoize by
 * `(sessionId, tape length)` before this fans across many sessions per sync.
 */
function resolveWorkspaceRewindable(ctx: HostedRuntimeOpsContext, sessionId: string): boolean {
  if (!ctx.runtime.config.worlds.enabled) {
    return false;
  }
  return previewWorkspaceRewind(ctx, sessionId).world?.status === "available";
}

export type ApprovalRequestRow = EffectCommitmentRequestRecord &
  PendingEffectCommitmentRequest & {
    readonly turnId?: string;
  };
type RequestState = ApprovalRequestRow["state"];
const ARG_SUMMARY_MAX_LENGTH = 240;

function readObject(value: unknown): Record<string, unknown> {
  return isRecord(value) ? (value as Record<string, unknown>) : {};
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
    value === "consumed" ||
    value === "expired"
    ? value
    : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Display-time expiry projection mirroring the kernel's lazy rule: an open
 * (pending or accepted, unconsumed) request whose `expiresAt` elapsed
 * projects to `expired`. The kernel records the durable terminal receipt at
 * its next authority touch; this projection never grants or revokes anything.
 */
function projectExpiry(row: ApprovalRequestRow, now: number): ApprovalRequestRow {
  if (
    (row.state === "pending" || row.state === "accepted") &&
    row.expiresAt !== undefined &&
    now >= row.expiresAt
  ) {
    return { ...row, state: "expired" };
  }
  return row;
}

function applyRequestListQuery(rows: ApprovalRequestRow[], query: unknown): ApprovalRequestRow[] {
  const state = readRequestState(readObject(query).state);
  return state ? rows.filter((row) => row.state === state) : rows;
}

/**
 * The Phase 4 projection: lift the kernel's already-derived recoverability tier
 * off the authority payload onto the operator card, and add the coarse
 * workspace-rewindability advisory when the world lane covers this turn and the
 * effect is workspace-mutating. Pure over the authority record so the exact
 * behavior is unit-testable without synthesizing a kernel approval.
 */
export function deriveApprovalReversibility(
  authority: Record<string, unknown>,
  workspaceRewindable: boolean,
): { readonly recoverability?: string; readonly workspaceRewindable?: true } {
  const manifestBasis = readObject(authority.manifestBasis);
  const posture = readObject(manifestBasis.commitmentPosture);
  const recoverability = readString(posture.recoverability);
  const mutatesWorkspace = readStringArray(authority.effects).some((effect) =>
    WORKSPACE_MUTATING_EFFECTS.has(effect),
  );
  return {
    ...(recoverability ? { recoverability } : {}),
    ...(workspaceRewindable && mutatesWorkspace ? { workspaceRewindable: true } : {}),
  };
}

function buildApprovalRequests(
  ctx: HostedRuntimeOpsContext,
  sessionId: string,
): ApprovalRequestRow[] {
  const proposedByToolCallId = new Map<string, string>();
  const proposedCallsByToolCallId = new Map<string, Record<string, unknown>>();
  const rows = new Map<string, ApprovalRequestRow>();
  // Workspace-level rewindability is a per-session fact; resolve it once.
  const workspaceRewindable = resolveWorkspaceRewindable(ctx, sessionId);
  for (const event of ctx.listEvents(sessionId)) {
    if (event.source === "advisory") {
      // Advisory ops events never bear approval authority, even when their
      // kind reuses a canonical event name. Same rule as the kernel.
      continue;
    }
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
        // Stop dropping the kernel's derived recoverability tier at the operator
        // boundary, and add the world-lane rewindability advisory.
        ...deriveApprovalReversibility(authority, workspaceRewindable),
        ...(argsSummary ? { argsSummary } : {}),
        // Canonical argument digest recorded by the kernel on the approval
        // request. Request ids identify requests; this identifies the exact
        // arguments the operator decided on.
        ...(readString(payload.argsDigest) ? { argsDigest: readString(payload.argsDigest) } : {}),
        ...(readNumber(payload.expiresAt) !== undefined
          ? { expiresAt: readNumber(payload.expiresAt) }
          : {}),
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
      // A decision recorded at or after the closure bound does not bind
      // authority; it stays on tape as a no-op receipt. Same rule as kernel.
      if (existing.expiresAt !== undefined && event.timestamp >= existing.expiresAt) {
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
      const abortReason = event.type === "tool.aborted" ? readString(payload.reason) : undefined;
      const expiredAbort = abortReason === "approval_request_expired";
      for (const [requestId, row] of rows.entries()) {
        if (row.proposalId !== commitmentId) {
          continue;
        }
        if (expiredAbort && (row.state === "pending" || row.state === "accepted")) {
          // Durable terminal expiry recorded by the kernel at an authority
          // touch; the closure ended without a committed effect.
          rows.set(requestId, { ...row, state: "expired" });
        } else if (row.state === "accepted" && event.type === "tool.committed") {
          // Consumed means exactly one thing: the accepted approval closed
          // over its durable committed result.
          rows.set(requestId, { ...row, state: "consumed" });
        } else if (
          (row.state === "pending" || row.state === "accepted") &&
          abortReason !== undefined
        ) {
          // The bound commitment terminated without a committed effect
          // (digest mismatch, call mismatch, explicit abort): the request
          // closes with it as cancelled, carrying the abort reason. Keeping
          // it open would invite decisions the kernel can no longer honor.
          rows.set(requestId, { ...row, state: "cancelled", reason: abortReason });
        }
      }
    }
  }
  const now = ctx.clock();
  return [...rows.values()]
    .map((row) => projectExpiry(row, now))
    .toSorted((left, right) => left.createdAt - right.createdAt);
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
