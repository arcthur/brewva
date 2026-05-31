import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type {
  BrewvaToolOptions,
  SubagentForkRequest,
  SubagentForkResult,
} from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { errTextResult, okTextResult, toolOutcomeRecord } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";

const ForkTurnsSchema = Type.Union([
  Type.Literal("none"),
  Type.Literal("all"),
  Type.Integer({ minimum: 1, maximum: 8 }),
]);

const SubagentForkParamsSchema = Type.Object({
  objective: Type.String({ minLength: 1, maxLength: 4000 }),
  deliverable: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  taskName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  nickname: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  forkTurns: Type.Optional(ForkTurnsSchema),
  timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
});

type SubagentForkParams = Static<typeof SubagentForkParamsSchema>;

function decodeForkParams(value: unknown): SubagentForkParams {
  const cleaned = Value.Clean(SubagentForkParamsSchema, value);
  if (!Value.Check(SubagentForkParamsSchema, cleaned)) {
    throw new Error("validated subagent fork params failed schema decode");
  }
  return Value.Clone(cleaned);
}

function buildForkRequest(params: SubagentForkParams): SubagentForkRequest {
  const forkTurns =
    params.forkTurns === "none" ||
    params.forkTurns === "all" ||
    (typeof params.forkTurns === "number" && Number.isInteger(params.forkTurns))
      ? params.forkTurns
      : undefined;
  return {
    objective: params.objective,
    deliverable: params.deliverable,
    taskName: params.taskName,
    nickname: params.nickname,
    forkTurns,
    timeoutMs: params.timeoutMs,
  };
}

function projectForkRunForPublicDetails(
  run: NonNullable<SubagentForkResult["run"]>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      contractVersion: run.contractVersion,
      runId: run.runId,
      delegate: run.delegate,
      executionPrimitive: run.executionPrimitive,
      visibility: run.visibility,
      isolationStrategy: run.isolationStrategy,
      adoption: run.adoption,
      lineage: run.lineage,
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
    }).filter(([, value]) => value !== undefined),
  );
}

function projectForkResultForPublicDetails(result: SubagentForkResult): Record<string, unknown> {
  return {
    ...result,
    run: result.run ? projectForkRunForPublicDetails(result.run) : undefined,
  };
}

export function createSubagentForkTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "subagent_fork");
  return define({
    name: "subagent_fork",
    label: "Subagent Fork",
    description:
      "Fork the current parent session into a read-only parallel execution branch without selecting a catalog specialist.",
    promptSnippet:
      "Use this when the child should inherit filtered parent turns and continue a same-context branch.",
    promptGuidelines: [
      "Use fork for same-context exploration, trial reasoning, or parallel probes that should not become public specialist names.",
      "forkTurns defaults to all, meaning filtered mainline turns without raw tool frames or internal reasoning.",
      "Do not use fork to request additional authority; the runtime records lineage and keeps the fork under the parent ceiling.",
      "Use subagent_run or subagent_fanout when the work fits navigator, explorer, worker, verifier, or librarian contracts.",
    ],
    parameters: Type.Object({
      ...SubagentForkParamsSchema.properties,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const adapter = runtime.orchestration?.subagents;
      if (!adapter?.fork) {
        return errTextResult("Subagent fork is unavailable in this session.", {
          ok: false,
        });
      }

      const decodedParams = decodeForkParams(params);
      const result = await adapter.fork({
        fromSessionId: getSessionId(ctx),
        request: buildForkRequest(decodedParams),
      });
      const run = result.run;
      const lines = [
        `${result.ok ? "subagent_fork completed" : "subagent_fork failed"} for run=${run?.runId ?? "unknown"}`,
        run ? `status=${run.status} primitive=${run.executionPrimitive}` : undefined,
        !result.ok && result.error ? `error=${result.error}` : undefined,
        run?.summary,
      ].filter((line): line is string => typeof line === "string" && line.length > 0);
      const details = projectForkResultForPublicDetails(result);

      if (!result.ok) {
        return errTextResult(lines.join("\n"), toolOutcomeRecord(details));
      }

      return okTextResult(lines.join("\n"), toolOutcomeRecord(details));
    },
  });
}
