import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import type {
  DelegationRunCard,
  DelegationRunRecord,
  DelegationRunStatus,
} from "@brewva/brewva-vocabulary/delegation";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { buildStringEnumSchema } from "../../registry/string-enum-contract.js";
import { errTextResult, okTextResult, toolOutcomeRecord } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";

const SUBAGENT_STATUS_VALUES = [
  "pending",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;
const SUBAGENT_DETAIL_MODE_VALUES = ["public", "internal", "diagnostic"] as const;
type SubagentDetailMode = (typeof SUBAGENT_DETAIL_MODE_VALUES)[number];

const StatusSchema = buildStringEnumSchema(SUBAGENT_STATUS_VALUES, {
  guidance:
    "Use pending, running, or blocked for active delegation. Include completed, failed, or cancelled when inspecting terminal history.",
});

const DetailModeSchema = buildStringEnumSchema(SUBAGENT_DETAIL_MODE_VALUES, {
  guidance:
    "public hides internal review lanes, internal includes public and internal records, diagnostic includes every run.",
});

function normalizeStatuses(value: unknown): DelegationRunStatus[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const statuses = value.filter(
    (entry): entry is DelegationRunStatus =>
      entry === "pending" ||
      entry === "running" ||
      entry === "blocked" ||
      entry === "completed" ||
      entry === "failed" ||
      entry === "cancelled",
  );
  return statuses.length > 0 ? statuses : undefined;
}

function summarizeRun(
  run: DelegationRunRecord & {
    live?: boolean;
    cancelable?: boolean;
  },
  detailMode: SubagentDetailMode,
): string {
  const head = [
    `status=${run.status}`,
    `agent=${run.agent}`,
    `path=${run.taskPath}`,
    run.kind ? `kind=${run.kind}` : null,
    `primitive=${run.executionPrimitive}`,
    `isolation=${run.isolationStrategy}`,
    run.parentSkill ? `parentSkill=${run.parentSkill}` : null,
    run.live ? "live=yes" : "live=no",
    run.cancelable ? "cancelable=yes" : "cancelable=no",
  ].filter(Boolean);
  const lines = [
    `- ${run.nickname ?? run.label ?? run.runId} (${run.delegate}): ${head.join(" ")}`,
  ];
  if (detailMode !== "public") {
    const delegateIdentity = [
      run.agentSpec ? `agentSpec=${run.agentSpec}` : null,
      run.envelope ? `envelope=${run.envelope}` : null,
      run.skillName ? `delegatedSkill=${run.skillName}` : null,
      run.consultKind ? `consultKind=${run.consultKind}` : null,
    ].filter(Boolean);
    if (delegateIdentity.length > 0) {
      lines.push(`  delegate: ${delegateIdentity.join(" ")}`);
    }
  }
  if (run.adoption) {
    const adoption = [
      `decision=${run.adoption.decision}`,
      detailMode !== "public" ? `contract=${run.adoption.contractId}` : null,
      `reason=${run.adoption.reason}`,
    ].filter(Boolean);
    lines.push(`  adoption: ${adoption.join(" ")}`);
  }
  if (run.summary) {
    lines.push(`  ${run.summary}`);
  } else if (run.error) {
    lines.push(`  error: ${run.error}`);
  }
  if (run.modelRoute && detailMode === "diagnostic") {
    const route = [
      run.modelRoute.selectedModel,
      `category=${run.modelRoute.category}`,
      `source=${run.modelRoute.source}`,
      `mode=${run.modelRoute.mode}`,
      run.modelRoute.policyId ? `policy=${run.modelRoute.policyId}` : null,
      run.modelRoute.presetName ? `preset=${run.modelRoute.presetName}` : null,
    ].filter(Boolean);
    lines.push(`  model: ${route.join(" ")}`);
    lines.push(`  routeReason: ${run.modelRoute.reason}`);
  }
  if (run.workerSessionId && detailMode !== "public") {
    lines.push(`  workerSessionId: ${run.workerSessionId}`);
  }
  if (run.artifactRefs && run.artifactRefs.length > 0) {
    lines.push(`  artifactRefs: ${run.artifactRefs.map((ref) => ref.path).join(", ")}`);
  }
  if (run.delivery) {
    const delivery = [
      `mode=${run.delivery.mode}`,
      run.delivery.scopeId ? `scope=${run.delivery.scopeId}` : null,
      run.delivery.handoffState ? `handoff=${run.delivery.handoffState}` : null,
      run.delivery.supplementalAppended ? "supplemental=yes" : null,
    ].filter(Boolean);
    if (delivery.length > 0) {
      lines.push(`  delivery: ${delivery.join(" ")}`);
    }
  }
  return lines.join("\n");
}

function summarizeRunCard(card: DelegationRunCard): string {
  return [
    `- ${card.title} (${card.role}): lifecycle=${card.lifecycle} reason=${card.lifecycleReason}`,
    `result=${card.resultMode} disposition=${card.disposition}`,
    `adoption=${card.adoptionRequirement} isolation=${card.isolation}`,
    card.taskPath ? `path=${card.taskPath}` : null,
  ]
    .filter(Boolean)
    .join(" ");
}

function shouldIncludeRunForDetailMode(
  run: DelegationRunRecord,
  detailMode: SubagentDetailMode,
): boolean {
  const visibility = run.visibility;
  if (detailMode === "diagnostic") {
    return true;
  }
  if (detailMode === "internal") {
    return visibility === "public" || visibility === "internal";
  }
  return visibility === "public";
}

function projectRunForDetailMode(
  run: DelegationRunRecord & {
    live?: boolean;
    cancelable?: boolean;
  },
  detailMode: SubagentDetailMode,
): Record<string, unknown> {
  if (detailMode === "diagnostic") {
    return { ...run };
  }
  const projected: Record<string, unknown> = {
    contractVersion: run.contractVersion,
    runId: run.runId,
    agent: run.agent,
    targetName: run.targetName,
    delegate: run.delegate,
    taskName: run.taskName,
    taskPath: run.taskPath,
    nickname: run.nickname,
    depth: run.depth,
    forkTurns: run.forkTurns,
    gateReason: run.gateReason,
    modelCategory: run.modelCategory,
    executionPrimitive: run.executionPrimitive,
    visibility: run.visibility,
    isolationStrategy: run.isolationStrategy,
    adoption: run.adoption,
    parentSessionId: run.parentSessionId,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    label: run.label,
    parentSkill: run.parentSkill,
    kind: run.kind,
    summary: run.summary,
    error: run.error,
    artifactRefs: run.artifactRefs,
    delivery: run.delivery,
    totalTokens: run.totalTokens,
    costUsd: run.costUsd,
    live: run.live,
    cancelable: run.cancelable,
  };
  if (detailMode === "internal") {
    projected.agentSpec = run.agentSpec;
    projected.envelope = run.envelope;
    projected.skillName = run.skillName;
    projected.consultKind = run.consultKind;
    projected.boundary = run.boundary;
    projected.workerSessionId = run.workerSessionId;
    projected.resultData = run.resultData;
  }
  // Model route exposes provider and policy internals, so it stays diagnostic-tier.
  return Object.fromEntries(Object.entries(projected).filter(([, value]) => value !== undefined));
}

export function createSubagentStatusTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "subagent_status",
  );
  return define({
    name: "subagent_status",
    label: "Subagent Status",
    description: "Inspect active and recent delegated subagent runs for the current session.",
    promptSnippet:
      "Use this to inspect running, completed, failed, or cancelled subagent runs without replaying the whole event tape.",
    promptGuidelines: [
      "Prefer filtering to pending/running when checking live delegation progress.",
      "Use runId or taskPath when you need the exact status of a known delegated run.",
      "Use nickname for display aliases; nicknames may return multiple matching live runs.",
      "Status inspection is read-only; use inbox_query for pullable evidence, debt, or adoption items.",
      "Do not treat a completed worker or librarian run as parent truth until the matching apply, reject, or adopt receipt exists.",
    ],
    parameters: Type.Object({
      runId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      taskPath: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      nickname: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      pathPrefix: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
      statuses: Type.Optional(Type.Array(StatusSchema, { minItems: 1, maxItems: 7 })),
      includeTerminal: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
      detailMode: Type.Optional(DetailModeSchema),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const adapter = runtime.orchestration?.subagents;
      const query = {
        runIds: typeof params.runId === "string" ? [params.runId] : undefined,
        taskPaths: typeof params.taskPath === "string" ? [params.taskPath] : undefined,
        nicknames: typeof params.nickname === "string" ? [params.nickname] : undefined,
        pathPrefix: typeof params.pathPrefix === "string" ? params.pathPrefix : undefined,
        statuses: normalizeStatuses(params.statuses),
        includeTerminal:
          typeof params.includeTerminal === "boolean" ? params.includeTerminal : true,
        limit: typeof params.limit === "number" ? params.limit : undefined,
      };
      const detailMode =
        params.detailMode === "internal" || params.detailMode === "diagnostic"
          ? params.detailMode
          : "public";
      const readModelRuns = await runtime.delegation?.listRuns?.(sessionId, query);
      let readModelResult:
        | {
            ok: true;
            runs: Array<DelegationRunRecord & { live?: boolean; cancelable?: boolean }>;
          }
        | undefined;
      if (readModelRuns) {
        readModelResult = {
          ok: true,
          runs: readModelRuns.map((run) =>
            Object.assign({}, run, {
              live: false,
              cancelable: false,
            }),
          ),
        };
      }
      if (readModelResult && adapter?.status && readModelResult.runs.length > 0) {
        const liveState = await adapter.status({
          fromSessionId: sessionId,
          query: {
            runIds: readModelResult.runs.map((run) => run.runId),
            includeTerminal: true,
          },
        });
        if (liveState.ok) {
          const liveByRunId = new Map(liveState.runs.map((run) => [run.runId, run] as const));
          readModelResult.runs = readModelResult.runs.map((run) => {
            const live = liveByRunId.get(run.runId);
            return live
              ? Object.assign({}, run, { live: live.live, cancelable: live.cancelable })
              : run;
          });
        }
      }
      const resolved =
        readModelResult ??
        (adapter?.status
          ? await adapter.status({
              fromSessionId: sessionId,
              query,
            })
          : undefined);

      if (!resolved) {
        return errTextResult("Subagent orchestration is unavailable in this session.", {
          ok: false,
        });
      }

      if (!resolved.ok) {
        return errTextResult(
          `subagent_status failed: ${resolved.error}`,
          toolOutcomeRecord(resolved),
        );
      }

      if (resolved.runs.length === 0) {
        return okTextResult("No matching subagent runs.", toolOutcomeRecord(resolved));
      }
      const visibleRuns = resolved.runs.filter((run) =>
        shouldIncludeRunForDetailMode(run, detailMode),
      );
      const hiddenCount = resolved.runs.length - visibleRuns.length;
      if (detailMode !== "diagnostic") {
        const inspection = await runtime.delegation?.inspect?.(sessionId);
        if (!inspection) {
          return errTextResult(
            "subagent_status failed: delegation inspection projection is unavailable.",
            toolOutcomeRecord({
              ok: false,
              detailMode,
              hiddenCount,
            }),
          );
        }
        const visibleRunIds = new Set(visibleRuns.map((run) => run.runId));
        const runCards = inspection.runCards.filter((card) => visibleRunIds.has(card.runId));
        if (runCards.length === 0) {
          const hiddenSuffix =
            hiddenCount > 0
              ? ` ${hiddenCount} internal/diagnostic run(s) hidden by detailMode=${detailMode}.`
              : "";
          return okTextResult(
            `No matching subagent runs.${hiddenSuffix}`,
            toolOutcomeRecord({
              ok: true,
              detailMode,
              hiddenCount,
              runCards,
              workboard: inspection.workboard,
              inbox: inspection.inbox,
            }),
          );
        }
        return okTextResult(
          [
            "# Subagent Status",
            hiddenCount > 0
              ? `detailMode=${detailMode}; hidden internal/diagnostic runs=${hiddenCount}`
              : `detailMode=${detailMode}`,
            ...runCards.map(summarizeRunCard),
          ].join("\n"),
          toolOutcomeRecord({
            ok: true,
            detailMode,
            hiddenCount,
            runCards,
            workboard: inspection.workboard,
            inbox: inspection.inbox,
          }),
        );
      }
      if (visibleRuns.length === 0) {
        const hiddenSuffix =
          hiddenCount > 0
            ? ` ${hiddenCount} internal/diagnostic run(s) hidden by detailMode=${detailMode}.`
            : "";
        return okTextResult(
          `No matching subagent runs.${hiddenSuffix}`,
          toolOutcomeRecord({
            ...resolved,
            runs: visibleRuns.map((run) => projectRunForDetailMode(run, detailMode)),
            hiddenCount,
            detailMode,
          }),
        );
      }

      return okTextResult(
        [
          "# Subagent Status",
          hiddenCount > 0
            ? `detailMode=${detailMode}; hidden internal/diagnostic runs=${hiddenCount}`
            : `detailMode=${detailMode}`,
          ...visibleRuns.map((run) => summarizeRun(run, detailMode)),
        ].join("\n"),
        toolOutcomeRecord({
          ...resolved,
          runs: visibleRuns.map((run) => projectRunForDetailMode(run, detailMode)),
          hiddenCount,
          detailMode,
        }),
      );
    },
  });
}

export function createSubagentCancelTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "subagent_cancel",
  );
  return define({
    name: "subagent_cancel",
    label: "Subagent Cancel",
    description: "Cancel a live delegated subagent run by runId.",
    promptSnippet:
      "Use this to stop a running background subagent when the delegated work is no longer needed or is heading the wrong way.",
    promptGuidelines: [
      "Pass the exact runId from subagent_run(waitMode=start) or subagent_status.",
      "Cancelling a non-live run reports the current terminal state instead of fabricating a cancellation.",
    ],
    parameters: Type.Object({
      runId: Type.String({ minLength: 1, maxLength: 200 }),
      reason: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const adapter = runtime.orchestration?.subagents;
      if (!adapter?.cancel) {
        return errTextResult("Subagent cancellation is unavailable in this session.", {
          ok: false,
        });
      }

      const cancelled = await adapter.cancel({
        fromSessionId: sessionId,
        runId: params.runId,
        reason: typeof params.reason === "string" ? params.reason : undefined,
      });

      if (!cancelled.ok) {
        const text = cancelled.run
          ? `subagent_cancel failed: ${cancelled.error}\n${summarizeRun(cancelled.run, "public")}`
          : `subagent_cancel failed: ${cancelled.error}`;
        return errTextResult(
          text,
          toolOutcomeRecord({
            ...cancelled,
            run: cancelled.run ? projectRunForDetailMode(cancelled.run, "public") : undefined,
          }),
        );
      }

      if (!cancelled.run) {
        return errTextResult("subagent_cancel failed: missing_run_state", {
          ok: false,
        });
      }

      const details = toolOutcomeRecord({
        ...cancelled,
        run: projectRunForDetailMode(cancelled.run, "public"),
      });
      const text = ["Subagent cancelled.", summarizeRun(cancelled.run, "public")].join("\n");
      if (cancelled.run.status !== "cancelled") {
        return errTextResult(text, details);
      }
      return okTextResult(text, details);
    },
  });
}
