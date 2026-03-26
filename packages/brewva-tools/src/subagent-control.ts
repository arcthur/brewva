import type { DelegationRunRecord, DelegationRunStatus } from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "./types.js";
import { buildStringEnumSchema } from "./utils/input-alias.js";
import { failTextResult, textResult, withVerdict } from "./utils/result.js";
import { getSessionId } from "./utils/session.js";
import { defineBrewvaTool } from "./utils/tool.js";

const SUBAGENT_STATUS_VALUES = [
  "pending",
  "running",
  "completed",
  "failed",
  "timeout",
  "cancelled",
  "merged",
] as const;

const StatusSchema = buildStringEnumSchema(
  SUBAGENT_STATUS_VALUES,
  {},
  {
    guidance:
      "Use pending or running for active delegation only. Include completed, failed, timeout, cancelled, or merged when inspecting terminal history.",
  },
);

function normalizeStatuses(value: unknown): DelegationRunStatus[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const statuses = value.filter(
    (entry): entry is DelegationRunStatus =>
      entry === "pending" ||
      entry === "running" ||
      entry === "completed" ||
      entry === "failed" ||
      entry === "timeout" ||
      entry === "cancelled" ||
      entry === "merged",
  );
  return statuses.length > 0 ? statuses : undefined;
}

function summarizeRun(
  run: DelegationRunRecord & {
    live?: boolean;
    cancelable?: boolean;
  },
): string {
  const head = [
    `status=${run.status}`,
    run.kind ? `kind=${run.kind}` : null,
    run.parentSkill ? `skill=${run.parentSkill}` : null,
    run.live ? "live=yes" : "live=no",
    run.cancelable ? "cancelable=yes" : "cancelable=no",
  ].filter(Boolean);
  const lines = [`- ${run.label ?? run.runId} (${run.delegate}): ${head.join(" ")}`];
  const delegateIdentity = [
    run.agentSpec ? `agentSpec=${run.agentSpec}` : null,
    run.envelope ? `envelope=${run.envelope}` : null,
    run.skillName ? `delegatedSkill=${run.skillName}` : null,
  ].filter(Boolean);
  if (delegateIdentity.length > 0) {
    lines.push(`  delegate: ${delegateIdentity.join(" ")}`);
  }
  if (run.summary) {
    lines.push(`  ${run.summary}`);
  } else if (run.error) {
    lines.push(`  error: ${run.error}`);
  }
  if (run.workerSessionId) {
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

export function createSubagentStatusTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
    name: "subagent_status",
    label: "Subagent Status",
    description: "Inspect active and recent delegated subagent runs for the current session.",
    promptSnippet:
      "Use this to inspect running, completed, failed, or merged subagent runs without replaying the whole event tape.",
    promptGuidelines: [
      "Prefer filtering to pending/running when checking live delegation progress.",
      "Use runId when you need the exact status of a known delegated run.",
    ],
    parameters: Type.Object({
      runId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      statuses: Type.Optional(Type.Array(StatusSchema, { minItems: 1, maxItems: 7 })),
      includeTerminal: Type.Optional(Type.Boolean()),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const query = {
        runIds: typeof params.runId === "string" ? [params.runId] : undefined,
        statuses: normalizeStatuses(params.statuses),
        includeTerminal:
          typeof params.includeTerminal === "boolean" ? params.includeTerminal : true,
        limit: typeof params.limit === "number" ? params.limit : undefined,
      };

      const result = options.runtime.orchestration?.subagents?.status
        ? await options.runtime.orchestration.subagents.status({
            fromSessionId: sessionId,
            query,
          })
        : {
            ok: true as const,
            runs: options.runtime.session.listDelegationRuns(sessionId, query).map((run) => ({
              runId: run.runId,
              delegate: run.delegate,
              agentSpec: run.agentSpec,
              envelope: run.envelope,
              skillName: run.skillName,
              parentSessionId: run.parentSessionId,
              status: run.status,
              createdAt: run.createdAt,
              updatedAt: run.updatedAt,
              label: run.label,
              workerSessionId: run.workerSessionId,
              parentSkill: run.parentSkill,
              kind: run.kind,
              boundary: run.boundary,
              summary: run.summary,
              error: run.error,
              artifactRefs: run.artifactRefs?.map((ref) => ({
                kind: ref.kind,
                path: ref.path,
                summary: ref.summary,
              })),
              delivery: run.delivery
                ? {
                    mode: run.delivery.mode,
                    scopeId: run.delivery.scopeId,
                    label: run.delivery.label,
                    handoffState: run.delivery.handoffState,
                    readyAt: run.delivery.readyAt,
                    surfacedAt: run.delivery.surfacedAt,
                    supplementalAppended: run.delivery.supplementalAppended,
                    updatedAt: run.delivery.updatedAt,
                  }
                : undefined,
              totalTokens: run.totalTokens,
              costUsd: run.costUsd,
              live: false,
              cancelable: false,
            })),
          };

      if (!result.ok) {
        return failTextResult(
          `subagent_status failed: ${result.error ?? "unknown_error"}`,
          result as unknown as Record<string, unknown>,
        );
      }

      if (result.runs.length === 0) {
        return textResult(
          "No matching subagent runs.",
          result as unknown as Record<string, unknown>,
        );
      }

      return textResult(
        ["# Subagent Status", ...result.runs.map((run) => summarizeRun(run))].join("\n"),
        result as unknown as Record<string, unknown>,
      );
    },
  });
}

export function createSubagentCancelTool(options: BrewvaToolOptions): ToolDefinition {
  return defineBrewvaTool({
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
      const adapter = options.runtime.orchestration?.subagents;
      if (!adapter?.cancel) {
        return failTextResult("Subagent cancellation is unavailable in this session.", {
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
          ? `subagent_cancel failed: ${cancelled.error ?? "unknown_error"}\n${summarizeRun(cancelled.run)}`
          : `subagent_cancel failed: ${cancelled.error ?? "unknown_error"}`;
        return failTextResult(text, cancelled as unknown as Record<string, unknown>);
      }

      if (!cancelled.run) {
        return failTextResult("subagent_cancel failed: missing_run_state", {
          ok: false,
        });
      }

      return textResult(
        ["Subagent cancelled.", summarizeRun(cancelled.run)].join("\n"),
        cancelled.run.status === "cancelled" || cancelled.run.status === "timeout"
          ? (cancelled as unknown as Record<string, unknown>)
          : withVerdict(cancelled as unknown as Record<string, unknown>, "fail"),
      );
    },
  });
}
