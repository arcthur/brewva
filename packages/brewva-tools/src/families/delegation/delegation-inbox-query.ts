import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { failTextResult, textResult, toolDetails } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";

export function createDelegationInboxQueryTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "inbox_query");
  return define({
    name: "inbox_query",
    label: "Inbox Query",
    description:
      "Explicitly pull pending delegation inbox items without injecting them into parent context.",
    promptSnippet:
      "Use this to inspect worker patches, librarian knowledge, verifier debt, and unread delegation evidence.",
    promptGuidelines: [
      "This is a pull-only inspection tool; reading the inbox does not mark items consumed.",
      "Use worker_results_apply, worker_results_reject, or subagent_knowledge_adopt for explicit adoption decisions.",
      "Treat inbox items as canonical pointers to receipts, not as implicit parent-context updates.",
      "Do not infer source mutation, knowledge promotion, or verification acceptance from an inbox item alone.",
    ],
    parameters: Type.Object(
      {
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
      },
      { additionalProperties: false },
    ),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionId = getSessionId(ctx);
      const inspection = await runtime.delegation?.inspect?.(sessionId);
      if (!inspection) {
        return failTextResult("inbox_query failed: delegation inspection is unavailable.", {
          ok: false,
        });
      }
      const limit = typeof params.limit === "number" ? Math.trunc(params.limit) : 25;
      const items = inspection.inbox.items.slice(0, limit);
      if (items.length === 0) {
        return textResult(
          "# Delegation Inbox\nNo pending delegation inbox items.",
          toolDetails({
            ok: true,
            explicitPull: true,
            injectedIntoParentContext: false,
            items,
          }),
        );
      }
      return textResult(
        [
          "# Delegation Inbox",
          "explicit_pull=true injected_into_parent_context=false",
          ...items.map(
            (item) =>
              `- ${item.kind} ${item.runId}: ${item.title} disposition=${item.disposition} adoption=${item.adoptionRequirement}`,
          ),
        ].join("\n"),
        toolDetails({
          ok: true,
          explicitPull: true,
          injectedIntoParentContext: false,
          items,
        }),
      );
    },
  });
}
