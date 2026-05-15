import { SUBAGENT_KNOWLEDGE_ADOPTION_RECORDED_EVENT_TYPE } from "@brewva/brewva-runtime/events";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type, type Static } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { buildStringEnumSchema } from "../../registry/string-enum-contract.js";
import { failTextResult, textResult, toolDetails } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";

const DecisionSchema = buildStringEnumSchema(["accept", "reject", "defer"] as const, {
  guidance: "Accept records promotion evidence; reject and defer preserve the parent decision.",
});

const SubagentKnowledgeAdoptParamsSchema = Type.Object({
  runId: Type.String({ minLength: 1, maxLength: 240 }),
  decision: DecisionSchema,
  reason: Type.String({ minLength: 1, maxLength: 1000 }),
  knowledgeCaptureArtifactRef: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  workerPatchArtifactRef: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
  finalArtifactRef: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
});

type SubagentKnowledgeAdoptParams = Static<typeof SubagentKnowledgeAdoptParamsSchema>;

function adoptionArtifactRefs(params: SubagentKnowledgeAdoptParams): string[] {
  return [
    params.knowledgeCaptureArtifactRef,
    params.workerPatchArtifactRef,
    params.finalArtifactRef,
  ].filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0);
}

export function createSubagentKnowledgeAdoptTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "subagent_knowledge_adopt",
  );
  return define({
    name: "subagent_knowledge_adopt",
    label: "Subagent Knowledge Adopt",
    description:
      "Record a parent accept, reject, or defer receipt for a librarian knowledge proposal.",
    promptSnippet:
      "Use this after inspecting a librarian knowledge outcome. Acceptance must point at the authoritative artifact created by the parent path.",
    promptGuidelines: [
      "This tool records only a receipt; it never writes docs or silently promotes knowledge.",
      "For decision=accept, provide knowledgeCaptureArtifactRef, workerPatchArtifactRef, or finalArtifactRef.",
      "Use reject or defer when provenance is weak, stale, conflicting, or not worth promoting.",
    ],
    parameters: SubagentKnowledgeAdoptParamsSchema,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const decision =
        params.decision === "accept" || params.decision === "reject" || params.decision === "defer"
          ? params.decision
          : "defer";
      const normalizedParams = {
        ...params,
        decision,
      };
      const artifactRefs = adoptionArtifactRefs(normalizedParams);
      if (decision === "accept" && artifactRefs.length === 0) {
        return failTextResult(
          "subagent_knowledge_adopt failed: accept requires a knowledge-capture, worker patch, or final artifact reference.",
          {
            ok: false,
            runId: params.runId,
            decision,
          },
        );
      }
      const sessionId = getSessionId(ctx);
      runtime.extensions?.tools?.recordEvent?.({
        sessionId,
        type: SUBAGENT_KNOWLEDGE_ADOPTION_RECORDED_EVENT_TYPE,
        payload: {
          runId: params.runId,
          decision,
          reason: params.reason,
          artifactRefs,
          knowledgeCaptureArtifactRef: params.knowledgeCaptureArtifactRef ?? null,
          workerPatchArtifactRef: params.workerPatchArtifactRef ?? null,
          finalArtifactRef: params.finalArtifactRef ?? null,
        },
      });
      return textResult(
        `subagent_knowledge_adopt recorded ${decision} for run=${params.runId}`,
        toolDetails({
          ok: true,
          runId: params.runId,
          decision: params.decision,
          artifactRefs,
        }),
      );
    },
  });
}
