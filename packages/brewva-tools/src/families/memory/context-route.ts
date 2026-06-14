import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { buildReductionCandidate } from "@brewva/brewva-vocabulary/reduction";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { okTextResult } from "../../utils/result.js";

/**
 * Advisory Compression Routing: classify a context span by shape and describe a
 * shape-aware reduction the model could apply. Pure and advisory — it reads only
 * the supplied content, records nothing, and never mutates attention. The model
 * decides whether to act (by evicting or compacting the span, which is where RCR
 * attaches a reversible reference).
 */
export function createContextRouteTool(options: BrewvaToolOptions): ToolDefinition {
  const { define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "context_route");
  return define({
    name: "context_route",
    label: "Context Route",
    description:
      "Advisory only: classify a context span by shape and describe a reversible reduction you could apply. Never mutates attention; you decide whether to act.",
    promptSnippet:
      "Call this when a large tool output or span is crowding the prompt to get a deterministic shape classification and a suggested reduction before you evict or compact it.",
    promptGuidelines: [
      "This only describes a reduction; it never applies one. Adopt a suggestion by issuing your own workbench_evict or workbench_compact.",
      "A null candidate means the span has no high-signal shape worth routing; leave it alone.",
    ],
    parameters: Type.Object({
      content: Type.String({ minLength: 1, maxLength: 200_000 }),
      span_ref: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
    }),
    execute(_toolCallId, params) {
      const spanRef = params.span_ref?.trim() || "span";
      const candidate = buildReductionCandidate({ spanRef, content: params.content });
      const result = candidate
        ? okTextResult(
            [
              "[ContextRoute]",
              `span_ref: ${candidate.spanRef}`,
              `detected_shape: ${candidate.detectedShape}`,
              `confidence: ${candidate.confidence}`,
              `indicators: ${candidate.indicators.join(", ")}`,
              `estimated_tokens_saved: ${candidate.estimatedTokensSaved}`,
              `suggested_reduction: ${candidate.suggestedReduction}`,
              "note: advisory only — evict or compact the span yourself to apply it reversibly.",
            ].join("\n"),
            {
              ok: true,
              candidate: {
                spanRef: candidate.spanRef,
                detectedShape: candidate.detectedShape,
                suggestedReduction: candidate.suggestedReduction,
                estimatedTokensSaved: candidate.estimatedTokensSaved,
                confidence: candidate.confidence,
                indicators: candidate.indicators,
              },
            },
          )
        : okTextResult(
            ["[ContextRoute]", `span_ref: ${spanRef}`, "verdict: no_high_signal_reduction"].join(
              "\n",
            ),
            { ok: true, candidate: null },
          );
      return Promise.resolve(result);
    },
  });
}
