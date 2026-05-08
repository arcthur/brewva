import type {
  BrewvaToolOptions,
  SubagentDelegationMode,
  SubagentOutcome,
  SubagentReturnMode,
  SubagentRunRequest,
} from "../../../contracts/index.js";
import { failTextResult, textResult, toolDetails, withVerdict } from "../../../utils/result.js";
import { deliverSubagentOutcome } from "./delivery.js";
import {
  projectRunResultForPublicDetails,
  projectStartResultForPublicDetails,
} from "./projection.js";

function summarizeOutcome(outcome: SubagentOutcome): string {
  if (!outcome.ok) {
    return `- ${outcome.label ?? outcome.runId}: failed (${outcome.error})`;
  }
  const totals = [
    outcome.metrics.totalTokens ? `tokens=${outcome.metrics.totalTokens}` : null,
    typeof outcome.metrics.costUsd === "number"
      ? `cost=$${outcome.metrics.costUsd.toFixed(4)}`
      : null,
  ].filter(Boolean);
  const detailSuffix = totals.length > 0 ? ` [${totals.join(", ")}]` : "";
  return `- ${outcome.label ?? outcome.runId}: ${outcome.kind}${detailSuffix}\n  ${outcome.summary}`;
}

function summarizeStartedRun(run: {
  runId: string;
  delegate: string;
  status: string;
  label?: string;
  kind?: string;
  live?: boolean;
  cancelable?: boolean;
}): string {
  const parts = [
    `status=${run.status}`,
    run.kind ? `kind=${run.kind}` : null,
    run.live ? "live=yes" : "live=no",
    run.cancelable ? "cancelable=yes" : "cancelable=no",
  ].filter(Boolean);
  const prefix = run.label ?? run.runId;
  return `- ${prefix}: ${parts.join(" ")}`;
}

export async function executeSubagentToolWithRequest(input: {
  options: BrewvaToolOptions;
  sessionId: string;
  delegate: string;
  mode: SubagentDelegationMode;
  detailsMode: "public" | "diagnostic";
  waitMode: "completion" | "start";
  returnMode: SubagentReturnMode;
  request: SubagentRunRequest;
  adapter: NonNullable<NonNullable<BrewvaToolOptions["runtime"]["orchestration"]>["subagents"]>;
  completionVerb: string;
  startVerb: string;
  delivery?: NonNullable<SubagentRunRequest["delivery"]>;
}): Promise<ReturnType<typeof textResult>> {
  if (input.waitMode === "start") {
    if (!input.adapter.start) {
      return failTextResult("Subagent background start is unavailable in this session.", {
        ok: false,
      });
    }
    if (input.returnMode === "supplemental") {
      return failTextResult(
        "Background subagent delivery must be text_only; inspect durable results later with subagent_status or worker_results_*.",
        {
          ok: false,
        },
      );
    }
    if (input.delivery) {
      input.request.delivery = input.delivery;
    }

    const started = await input.adapter.start({
      fromSessionId: input.sessionId,
      request: input.request,
    });
    const lines = [
      input.mode === "single"
        ? `${input.startVerb} for delegate=${input.delegate}`
        : `${input.startVerb} for delegate=${input.delegate} (${started.runs.length} runs)`,
      ...started.runs.map((run) =>
        summarizeStartedRun({
          runId: run.runId,
          delegate: run.delegate,
          status: run.status,
          label: run.label,
          kind: run.kind,
          live: false,
          cancelable: run.status === "pending" || run.status === "running",
        }),
      ),
    ];
    const details =
      input.detailsMode === "public"
        ? projectStartResultForPublicDetails(started, input.delegate)
        : started;
    return textResult(
      lines.join("\n"),
      started.ok ? toolDetails(details) : withVerdict(toolDetails(details), "fail"),
    );
  }

  const result = await input.adapter.run({
    fromSessionId: input.sessionId,
    request: input.request,
  });
  if (!result.ok) {
    return failTextResult(
      `${input.completionVerb} failed for delegate=${input.delegate}: ${result.error}`,
      toolDetails(result),
    );
  }

  const failures = result.outcomes.filter((outcome) => !outcome.ok);
  const header =
    input.mode === "single"
      ? `${input.completionVerb} completed for delegate=${input.delegate}`
      : `${input.completionVerb} completed for delegate=${input.delegate} (${result.outcomes.length} runs)`;
  const delivery =
    result.outcomes.length > 0 && input.returnMode !== "text_only"
      ? deliverSubagentOutcome({
          runtime: input.options.runtime,
          sessionId: input.sessionId,
          delegate: input.delegate,
          mode: input.mode,
          outcomes: result.outcomes,
          returnMode: input.returnMode,
          returnLabel: input.delivery?.returnLabel,
          returnScopeId: input.delivery?.returnScopeId,
        })
      : undefined;
  const lines = [header, ...result.outcomes.map((outcome) => summarizeOutcome(outcome))];
  if (delivery?.supplemental?.attempted) {
    lines.push(
      delivery.supplemental.accepted
        ? `supplemental delivery accepted${delivery.supplemental.truncated ? " (truncated)" : ""}`
        : `supplemental delivery skipped (${delivery.supplemental.droppedReason ?? "unavailable"})`,
    );
  }
  const details = {
    ...toolDetails(
      input.detailsMode === "public"
        ? projectRunResultForPublicDetails(result, input.delegate)
        : result,
    ),
    delivery,
  };
  return textResult(lines.join("\n"), failures.length > 0 ? withVerdict(details, "fail") : details);
}
