import {
  type DelegationRunQuery,
  type DelegationRunRecord,
  type BrewvaEventRecord,
  type BrewvaEventQuery,
  type BrewvaRuntime,
  type ContextCompactionGateStatus,
  type ContextInjectionCategory,
} from "@brewva/brewva-runtime";
import type { BuildCapabilityViewResult } from "./capability-view.js";
import { estimateTokens } from "./tool-output-distiller.js";

type ContextComposerEventQuery = Pick<Exclude<BrewvaEventQuery, undefined>, "type" | "last">;

type ContextComposerEventQueryResult = Array<
  Pick<BrewvaEventRecord, "payload" | "turn" | "timestamp">
>;

type ContextComposerTapeStatus = Pick<
  ReturnType<BrewvaRuntime["events"]["getTapeStatus"]>,
  "tapePressure" | "entriesSinceAnchor"
>;

export type ContextComposerSupplementalRuntime = {
  events: {
    getTapeStatus(sessionId: string): ContextComposerTapeStatus;
    query?: (
      sessionId: string,
      query: ContextComposerEventQuery,
    ) => ContextComposerEventQueryResult;
  };
  delegation?: {
    listRuns?: (
      sessionId: string,
      query?: Pick<DelegationRunQuery, "statuses" | "includeTerminal" | "limit">,
    ) => DelegationRunRecord[];
    listPendingOutcomes?: (
      sessionId: string,
      query?: {
        limit?: number;
      },
    ) => DelegationRunRecord[];
  };
};

export interface SupplementalContextBlock {
  id: string;
  category: ContextInjectionCategory;
  content: string;
  estimatedTokens: number;
}

export interface ResolveSupplementalContextBlocksInput {
  runtime: ContextComposerSupplementalRuntime;
  sessionId: string;
  gateStatus: ContextCompactionGateStatus;
  pendingCompactionReason?: string | null;
  capabilityView: BuildCapabilityViewResult;
}

const DIAGNOSTIC_CAPABILITY_NAMES = new Set<string>([
  "cost_view",
  "obs_query",
  "obs_slo_assert",
  "obs_snapshot",
  "tape_info",
  "tape_search",
]);

function makeSupplementalBlock(
  id: string,
  category: ContextInjectionCategory,
  content: string,
): SupplementalContextBlock | null {
  const normalized = content.trim();
  if (normalized.length === 0) {
    return null;
  }
  return {
    id,
    category,
    content: normalized,
    estimatedTokens: estimateTokens(normalized),
  };
}

export function listPendingDelegations(
  runtime: ContextComposerSupplementalRuntime,
  sessionId: string,
): DelegationRunRecord[] {
  return (
    runtime.delegation?.listRuns?.(sessionId, {
      statuses: ["pending", "running"],
      includeTerminal: false,
      limit: 6,
    }) ?? []
  );
}

export function listPendingDelegationOutcomes(
  runtime: ContextComposerSupplementalRuntime,
  sessionId: string,
): DelegationRunRecord[] {
  const pending = runtime.delegation?.listPendingOutcomes?.(sessionId, {
    limit: 6,
  });
  if (pending) {
    return pending;
  }
  return (
    runtime.delegation
      ?.listRuns?.(sessionId, {
        statuses: ["completed", "failed", "timeout", "cancelled"],
        includeTerminal: true,
        limit: 6,
      })
      ?.filter((run) => run.delivery?.handoffState === "pending_parent_turn") ?? []
  );
}

function formatPendingDelegationRuns(pendingDelegations: readonly DelegationRunRecord[]): string {
  return pendingDelegations
    .map((run) => `${run.delegate}/${run.label ?? run.runId}:${run.status}`)
    .join(", ");
}

function buildPendingDelegationsBlock(input: {
  pendingDelegations: readonly DelegationRunRecord[];
}): string {
  const lines = ["[PendingDelegations]", `count: ${input.pendingDelegations.length}`];
  if (input.pendingDelegations.length === 0) {
    return lines.join("\n");
  }
  lines.push(`runs: ${formatPendingDelegationRuns(input.pendingDelegations)}`);
  return lines.join("\n");
}

function buildOperationalDiagnosticsBlock(input: {
  runtime: ContextComposerSupplementalRuntime;
  sessionId: string;
  gateStatus: ContextCompactionGateStatus;
  pendingCompactionReason?: string | null;
  requested: string[];
  includeTapeTelemetry: boolean;
  pendingDelegations: readonly DelegationRunRecord[];
  pendingDelegationOutcomes: readonly DelegationRunRecord[];
  compact?: boolean;
}): string {
  const requiredAction = input.gateStatus.required
    ? "session_compact_now"
    : input.pendingCompactionReason
      ? "session_compact_recommended"
      : "none";
  const lines = [
    "[OperationalDiagnostics]",
    `context_pressure: ${input.gateStatus.pressure.level}`,
    `pending_compaction_reason: ${input.pendingCompactionReason ?? "none"}`,
    `pending_delegations: ${input.pendingDelegations.length}`,
    `pending_delegation_outcomes: ${input.pendingDelegationOutcomes.length}`,
    `required_action: ${requiredAction}`,
  ];
  if (input.compact) {
    return [
      "[OperationalDiagnostics]",
      `pending_compaction_reason: ${input.pendingCompactionReason ?? "none"}`,
      `required_action: ${requiredAction}`,
      ...(input.pendingDelegations.length > 0
        ? [`pending_delegations: ${input.pendingDelegations.length}`]
        : []),
      ...(input.pendingDelegationOutcomes.length > 0
        ? [`pending_delegation_outcomes: ${input.pendingDelegationOutcomes.length}`]
        : []),
    ].join("\n");
  }
  if (input.pendingDelegations.length > 0) {
    lines.push(`pending_delegation_runs: ${formatPendingDelegationRuns(input.pendingDelegations)}`);
  }
  if (input.pendingDelegationOutcomes.length > 0) {
    lines.push(
      `pending_delegation_outcome_runs: ${input.pendingDelegationOutcomes
        .map((run) => `${run.delegate}/${run.label ?? run.runId}:${run.status}`)
        .join(", ")}`,
    );
  }
  if (input.requested.length > 0) {
    lines.splice(1, 0, `requested_by: ${input.requested.map((name) => `$${name}`).join(", ")}`);
  }
  if (input.includeTapeTelemetry) {
    const tapeStatus = input.runtime.events.getTapeStatus(input.sessionId);
    lines.push(`tape_pressure: ${tapeStatus.tapePressure}`);
    lines.push(`tape_entries_since_anchor: ${tapeStatus.entriesSinceAnchor}`);
  }
  return lines.join("\n");
}

function buildCompletedDelegationOutcomesBlock(input: {
  pendingDelegationOutcomes: readonly DelegationRunRecord[];
}): string {
  const lines = [
    "[CompletedDelegationOutcomes]",
    `count: ${input.pendingDelegationOutcomes.length}`,
  ];
  if (input.pendingDelegationOutcomes.length === 0) {
    return lines.join("\n");
  }
  lines.push(
    ...input.pendingDelegationOutcomes.map(
      (run) =>
        `- ${run.delegate}/${run.label ?? run.runId}: ${run.status}${run.summary ? ` :: ${run.summary}` : ""}`,
    ),
  );
  return lines.join("\n");
}

function shouldIncludeOperationalDiagnostics(requested: string[]): string[] {
  return requested.filter((name) => DIAGNOSTIC_CAPABILITY_NAMES.has(name));
}

export function resolveSupplementalContextBlocks(
  input: ResolveSupplementalContextBlocksInput,
): SupplementalContextBlock[] {
  const blocks: SupplementalContextBlock[] = [];
  const diagnosticRequests = shouldIncludeOperationalDiagnostics(input.capabilityView.requested);
  const includeTapeTelemetry = diagnosticRequests.length > 0;
  const pendingDelegations = listPendingDelegations(input.runtime, input.sessionId);
  const pendingDelegationOutcomes = listPendingDelegationOutcomes(input.runtime, input.sessionId);

  if (
    pendingDelegations.length > 0 &&
    (input.gateStatus.required || !!input.pendingCompactionReason)
  ) {
    const pendingDelegationsBlock = makeSupplementalBlock(
      "pending-delegations",
      "constraint",
      buildPendingDelegationsBlock({
        pendingDelegations,
      }),
    );
    if (pendingDelegationsBlock) {
      blocks.push(pendingDelegationsBlock);
    }
  }
  if (pendingDelegationOutcomes.length > 0) {
    const completedOutcomesBlock = makeSupplementalBlock(
      "completed-delegation-outcomes",
      "diagnostic",
      buildCompletedDelegationOutcomesBlock({
        pendingDelegationOutcomes,
      }),
    );
    if (completedOutcomesBlock) {
      blocks.push(completedOutcomesBlock);
    }
  }
  if (
    diagnosticRequests.length > 0 ||
    input.gateStatus.required ||
    !!input.pendingCompactionReason
  ) {
    const preferCompactDiagnostics =
      diagnosticRequests.length === 0 &&
      (input.gateStatus.required || !!input.pendingCompactionReason);
    const diagnosticBlock = makeSupplementalBlock(
      "operational-diagnostics",
      "diagnostic",
      buildOperationalDiagnosticsBlock({
        runtime: input.runtime,
        sessionId: input.sessionId,
        gateStatus: input.gateStatus,
        pendingCompactionReason: input.pendingCompactionReason,
        requested: diagnosticRequests,
        includeTapeTelemetry,
        pendingDelegations,
        pendingDelegationOutcomes,
        compact: preferCompactDiagnostics,
      }),
    );
    if (diagnosticBlock) {
      blocks.push(diagnosticBlock);
    }
  }

  return blocks;
}
