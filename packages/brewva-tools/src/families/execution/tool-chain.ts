import { toJsonValue } from "@brewva/brewva-std/json";
import type {
  BrewvaToolContentPart,
  BrewvaToolDefinition as ToolDefinition,
  BrewvaToolResult,
} from "@brewva/brewva-substrate/tools";
import {
  TOOL_CHAIN_RESULT_SCHEMA,
  type ToolChainResultRecordedEventPayload,
  type ToolChainStepReceipt,
} from "@brewva/brewva-vocabulary/iteration";
import { outcomeVerdict } from "@brewva/brewva-vocabulary/outcome";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { BrewvaBundledToolRuntime } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { getSessionId } from "../../utils/session.js";

/**
 * Read-only action classes a chain step is allowed to dispatch. The envelope is
 * admitted once as `observe_compound`; keeping every step read-only is what
 * makes single-transaction admission safe (a chain of reads cannot mutate the
 * world). Effectful classes are Phase 2 and need per-step kernel admission.
 */
const READ_ONLY_STEP_ACTION_CLASSES: ReadonlySet<string> = new Set([
  "workspace_read",
  "runtime_observe",
  "local_exec_readonly",
]);

const MAX_CHAIN_STEPS = 20;

// Per-step result preview cap on the chain receipt (tape). Keeps a 20-step chain
// over large files from persisting one multi-megabyte advisory event while still
// recording enough of each step for replay inspection.
const STEP_RESULT_PREVIEW_CHARS = 2000;

const ToolChainSchema = Type.Object({
  steps: Type.Array(
    Type.Object({
      tool: Type.String({ minLength: 1, description: "Managed read-only tool name." }),
      args: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description: "Arguments for the step tool.",
        }),
      ),
      label: Type.Optional(Type.String({ description: "Human-readable step label." })),
    }),
    { minItems: 1, maxItems: MAX_CHAIN_STEPS },
  ),
  returnSteps: Type.Optional(
    Type.Union(
      [Type.Literal("last"), Type.Literal("all"), Type.Array(Type.Integer({ minimum: 0 }))],
      {
        description:
          "Which step results enter context: 'last' (default), 'all', or explicit 0-based indices.",
      },
    ),
  ),
});

type ReturnSteps = "last" | "all" | readonly number[];

export interface ToolChainToolOptions {
  runtime: BrewvaBundledToolRuntime;
  /**
   * Late-bound resolver over the sibling managed tools, injected at bundle
   * assembly (the only site with visibility into all tool definitions). The
   * chain dispatches a resolved tool's implementation directly — there is no
   * kernel re-entrancy in Phase 1.
   */
  resolveSibling: (name: string) => ToolDefinition | undefined;
}

function selectReturnIndices(returnSteps: ReturnSteps, count: number): number[] {
  if (count === 0) {
    return [];
  }
  if (returnSteps === "last") {
    return [count - 1];
  }
  if (returnSteps === "all") {
    return Array.from({ length: count }, (_unused, index) => index);
  }
  const inRange = returnSteps.filter(
    (index) => Number.isInteger(index) && index >= 0 && index < count,
  );
  return [...new Set(inRange)].toSorted((left, right) => left - right);
}

function serializeReturnSelection(returnSteps: ReturnSteps): string {
  return Array.isArray(returnSteps) ? returnSteps.join(",") : (returnSteps as string);
}

function stepContentParts(
  index: number,
  step: { tool: string; label?: string },
  result: BrewvaToolResult,
): BrewvaToolContentPart[] {
  const heading = step.label ? `${step.tool} — ${step.label}` : step.tool;
  return [{ type: "text", text: `[step ${index} · ${heading}]` }, ...result.content];
}

// A bounded preview of the step's text result for the chain receipt, so replay
// can inspect what each step produced without persisting an unbounded payload on
// one tape event. Non-text parts (e.g. images) are noted as a placeholder;
// `truncated`/`fullChars` record when the preview was cut.
function stepResultPreview(result: BrewvaToolResult): {
  resultText: string;
  truncated: boolean;
  fullChars: number;
} {
  const full = result.content
    .map((part) => (part.type === "text" ? part.text : `[${part.type}]`))
    .join("");
  const truncated = full.length > STEP_RESULT_PREVIEW_CHARS;
  return {
    resultText: truncated ? full.slice(0, STEP_RESULT_PREVIEW_CHARS) : full,
    truncated,
    fullChars: full.length,
  };
}

export function createToolChainTool(options: ToolChainToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "tool_chain");
  const resolveSibling = options.resolveSibling;

  return define({
    name: "tool_chain",
    label: "Tool Chain",
    description:
      "Execute a bounded sequence of read-only tools in one call. Intermediate " +
      "results are recorded on the tape as advisory receipts but do NOT enter " +
      "context; only the selected step results are returned. Use for read-heavy " +
      "exploration (grep -> read -> grep -> read) to spend context on conclusions, " +
      "not on intermediate output.",
    promptSnippet:
      "Batch a read-only exploration sequence; only the selected step results return to context.",
    promptGuidelines: [
      "Only read-only tools are allowed (workspace_read, runtime_observe, local_exec_readonly).",
      "Steps run sequentially and the chain stops at the first errored step (an " +
        "inconclusive step, e.g. no matches, does not stop the chain).",
      "returnSteps defaults to 'last'; use 'all' or explicit 0-based indices to surface more.",
    ],
    parameters: ToolChainSchema,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const steps = params.steps;
      const returnSteps: ReturnSteps = params.returnSteps ?? "last";

      const stepReceipts: ToolChainStepReceipt[] = [];
      const stepResults: BrewvaToolResult[] = [];
      let stopped = false;
      let stopReason: string | undefined;

      for (let index = 0; index < steps.length; index += 1) {
        if (signal?.aborted) {
          stopped = true;
          stopReason = `aborted before step ${index}`;
          break;
        }
        const step = steps[index]!;

        const child = resolveSibling(step.tool);
        if (!child) {
          stopped = true;
          stopReason = `unknown tool '${step.tool}' at step ${index}`;
          break;
        }

        // The gate reads the tool's declared action *class* (by name, without
        // args), not the concrete args. This is sound only because every
        // read-only class allowed here has no arg-dependent escalation to an
        // effectful class (unlike exec/process, which resolve to their
        // effectful default with no args and are rejected). A future
        // read-only-classed tool with an arg-triggered effect would need a
        // per-arg gate.
        const actionClass = runtime.capabilities.tools.access.getActionPolicy(
          step.tool,
        )?.actionClass;
        if (!actionClass || !READ_ONLY_STEP_ACTION_CLASSES.has(actionClass)) {
          stopped = true;
          stopReason = `step ${index} tool '${step.tool}' is not read-only (${actionClass ?? "unknown action class"})`;
          break;
        }

        const rawArgs = step.args ?? {};
        if (!Value.Check(child.parameters, rawArgs)) {
          stopped = true;
          stopReason = `step ${index} args failed validation for '${step.tool}'`;
          break;
        }

        let result: BrewvaToolResult;
        try {
          // prepareArguments is inside the try so a throwing preparer becomes a
          // clean step-level stop with a receipt, not an escape that skips the
          // chain receipt.
          const childArgs = child.prepareArguments ? child.prepareArguments(rawArgs) : rawArgs;
          result = await child.execute(
            `${toolCallId}:step:${index}`,
            childArgs,
            signal,
            undefined,
            ctx,
          );
        } catch (error) {
          result = {
            content: [{ type: "text", text: `step ${index} threw: ${String(error)}` }],
            outcome: { kind: "err", error: { message: String(error) } },
          };
        }

        const verdict = outcomeVerdict(result.outcome);
        runtime.capabilities.tools.invocation.recordResult({
          sessionId,
          toolName: step.tool,
          verdict,
          failureClass: verdict === "fail" ? "chain_step_failed" : "none",
        });
        stepReceipts.push({
          index,
          toolName: step.tool,
          verdict,
          ...stepResultPreview(result),
        });
        stepResults.push(result);

        if (result.outcome.kind === "err") {
          stopped = true;
          stopReason = `step ${index} tool '${step.tool}' failed`;
          break;
        }
      }

      const returnSelection = serializeReturnSelection(returnSteps);
      const selectedIndices = selectReturnIndices(returnSteps, stepResults.length);

      const chainReceipt: ToolChainResultRecordedEventPayload = {
        schema: TOOL_CHAIN_RESULT_SCHEMA,
        chainId: toolCallId,
        stepCount: steps.length,
        stepsRun: stepReceipts.length,
        steps: stepReceipts,
        returnSelection,
        stopped,
      };
      runtime.capabilities.tools.invocation.recordChainResult({ sessionId, ...chainReceipt });

      const content: BrewvaToolContentPart[] = [];
      for (const index of selectedIndices) {
        content.push(...stepContentParts(index, steps[index]!, stepResults[index]!));
      }
      if (stopped) {
        // Always surface the stop reason in context: the model reads `content`,
        // and the structured error/tape receipt alone would leave it invisible.
        content.push({
          type: "text",
          text: `tool_chain stopped after ${stepReceipts.length}/${steps.length} steps: ${stopReason ?? "a step failed"}`,
        });
      } else if (content.length === 0) {
        content.push({ type: "text", text: "tool_chain: no step results selected" });
      }

      // Lean structured summary for a direct consumer of the tool result; the
      // per-step verdict list lives only in the `tool_chain.result.recorded`
      // tape event and the per-step `tool.result.recorded` receipts (no dup).
      const summary = toJsonValue({
        chainId: toolCallId,
        stepCount: steps.length,
        stepsRun: stepReceipts.length,
        returnSelection,
        selectedSteps: selectedIndices,
        stopped,
        ...(stopReason ? { stopReason } : {}),
      });

      if (stopped) {
        return { content, outcome: { kind: "err", error: summary } };
      }
      return { content, outcome: { kind: "ok", value: summary } };
    },
  });
}
