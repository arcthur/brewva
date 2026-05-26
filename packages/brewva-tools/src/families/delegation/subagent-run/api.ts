import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../../registry/runtime-bound-tool.js";
import { failTextResult } from "../../../utils/result.js";
import { getSessionId } from "../../../utils/session.js";
import { validateDeliveryConfiguration } from "./delivery.js";
import { executeSubagentToolWithRequest } from "./executor.js";
import {
  buildDeliveryRequest,
  buildPublicFanoutRequestFromParams,
  buildPublicRunRequestFromParams,
  buildRunRequestFromParams,
  resolveDelegationLabel,
  resolveMode,
  resolveReturnMode,
  resolveWaitMode,
} from "./packet-builder.js";
import {
  DiagnosticSubagentRunParamsSchema,
  SubagentFanoutParamsSchema,
  SubagentRunParamsSchema,
} from "./schemas.js";
import { decodeToolParams, failIfLegacyFields, failIfPublicForbiddenFields } from "./validation.js";

export function createSubagentRunTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(options.runtime, "subagent_run");
  return define(
    {
      name: "subagent_run",
      label: "Subagent Run",
      description:
        "Delegate a bounded task to a public subagent role and return structured results.",
      promptSnippet:
        "Use delegated runs for navigator evidence, explorer judgment, worker patches, verifier verification, or librarian knowledge proposals.",
      promptGuidelines: [
        "Set agent explicitly: navigator, explorer, worker, verifier, or librarian.",
        "Use local read/search tools first for direct path, symbol, or exact-string lookup; delegation is for broader epistemic or isolated execution roles.",
        "Route task-local evidence collection to navigator, cross-module judgment or diagnosis to explorer, institutional/history knowledge to librarian, bounded isolated implementation to worker, and non-trivial implementation checks to verifier.",
        "Delegation Gate vocabulary: find_evidence -> navigator, make_judgment -> explorer, implement_isolated -> worker, verify_reproducibly -> verifier, compound_knowledge -> librarian.",
        "Use skillName only as an optional semantic contract compatible with the selected agent.",
        "Use gateReason when the reason is not obvious from the role; the resolver validates it instead of auto-spawning teams.",
        "For consult-style skills, provide brief with the decision and success criteria.",
        "Delegate when the task needs cross-3+-file investigation, diagnosis, a second-opinion review pass, or parallel slice analysis.",
        "Keep objectives specific, pass only the context references the child needs, and avoid broad parent-context dumps.",
        "For waitMode=start, do not predict or race background results; inspect them later with subagent_status or inbox_query.",
        "Worker patches, librarian knowledge, and verifier evidence stay non-authoritative until the parent explicitly applies, adopts, rejects, or consults them.",
      ],
      parameters: Type.Object({
        ...SubagentRunParamsSchema.properties,
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const adapter = runtime.orchestration?.subagents;
        if (!adapter) {
          return failTextResult("Subagent orchestration is unavailable in this session.", {
            ok: false,
          });
        }

        const publicValidation = failIfPublicForbiddenFields(params);
        if (!publicValidation.ok) {
          return failTextResult(publicValidation.message, { ok: false });
        }
        const decodedParams = decodeToolParams(SubagentRunParamsSchema, params);
        const waitMode = resolveWaitMode(decodedParams.waitMode);
        const returnMode = resolveReturnMode(decodedParams.returnMode);
        const deliveryValidation = validateDeliveryConfiguration(runtime, returnMode);
        if (!deliveryValidation.ok) {
          return failTextResult(deliveryValidation.message, { ok: false });
        }
        const builtRequest = buildPublicRunRequestFromParams({ params: decodedParams });
        if (!builtRequest.ok) {
          return failTextResult(builtRequest.message, { ok: false });
        }
        const sessionId = getSessionId(ctx);
        return executeSubagentToolWithRequest({
          options: { ...options, runtime },
          sessionId,
          delegate: resolveDelegationLabel(builtRequest.request),
          mode: "single",
          detailsMode: "public",
          waitMode,
          returnMode,
          request: builtRequest.request,
          adapter,
          completionVerb: "subagent_run",
          startVerb: "subagent_run started",
          delivery: buildDeliveryRequest(returnMode, decodedParams),
        });
      },
    },
    {},
  );
}

export function createSubagentFanoutTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "subagent_fanout",
  );
  return define(
    {
      name: "subagent_fanout",
      label: "Subagent Fanout",
      description:
        "Launch multiple delegated runs under one public subagent role for independent slices of work.",
      promptSnippet:
        "Use this for explicit fan-out when several repository slices can run independently under the same role and result contract.",
      promptGuidelines: [
        "Set agent explicitly and keep each task independently addressable with taskName when useful.",
        "Use local read/search tools first for direct path, symbol, or exact-string lookup; fanout is for independent slices that benefit from parallel role-bound work.",
        "Route evidence slices to navigator, judgment or diagnosis slices to explorer, institutional/history lookup to librarian, isolated implementation slices to worker, and post-implementation checks to verifier.",
        "Delegation Gate vocabulary: find_evidence -> navigator, make_judgment -> explorer, implement_isolated -> worker, verify_reproducibly -> verifier, compound_knowledge -> librarian.",
        "Use skillName only as an optional semantic contract compatible with the selected agent.",
        "For consult-style fan-out, provide one shared brief unless the parent can safely complete without advisory framing.",
        "Use this when tasks are independent and a shared packet plus per-task objectives is clearer than one large delegated run.",
        "Keep each task label and objective specific so the parent can inspect outcomes separately.",
        "For waitMode=start, do not infer completion from launch success; inspect later with subagent_status or inbox_query.",
        "Fan-out results are advisory or pending-adoption inputs until the parent explicitly applies, adopts, rejects, or consults each result.",
      ],
      parameters: Type.Object({
        ...SubagentFanoutParamsSchema.properties,
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const adapter = runtime.orchestration?.subagents;
        if (!adapter) {
          return failTextResult("Subagent orchestration is unavailable in this session.", {
            ok: false,
          });
        }

        const publicValidation = failIfPublicForbiddenFields(params);
        if (!publicValidation.ok) {
          return failTextResult(publicValidation.message, { ok: false });
        }
        const decodedParams = decodeToolParams(SubagentFanoutParamsSchema, params);
        const waitMode = resolveWaitMode(decodedParams.waitMode);
        const returnMode = resolveReturnMode(decodedParams.returnMode);
        const deliveryValidation = validateDeliveryConfiguration(runtime, returnMode);
        if (!deliveryValidation.ok) {
          return failTextResult(deliveryValidation.message, { ok: false });
        }
        const builtRequest = buildPublicFanoutRequestFromParams({ params: decodedParams });
        if (!builtRequest.ok) {
          return failTextResult(builtRequest.message, { ok: false });
        }
        const sessionId = getSessionId(ctx);
        return executeSubagentToolWithRequest({
          options: { ...options, runtime },
          sessionId,
          delegate: resolveDelegationLabel(builtRequest.request),
          mode: "parallel",
          detailsMode: "public",
          waitMode,
          returnMode,
          request: builtRequest.request,
          adapter,
          completionVerb: "subagent_fanout",
          startVerb: "subagent_fanout started",
          delivery: buildDeliveryRequest(returnMode, decodedParams),
        });
      },
    },
    {},
  );
}

export function createSubagentRunDiagnosticTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "subagent_run_diagnostic",
  );
  return define(
    {
      name: "subagent_run_diagnostic",
      label: "Subagent Run Diagnostic",
      description:
        "Maintainer-only delegated run with explicit current-contract target and envelope fields.",
      promptSnippet:
        "Use only for maintainer diagnostics when the public role-first delegation interface cannot express the routing probe.",
      promptGuidelines: [
        "Prefer public subagent_run for ordinary work.",
        "Use explicit targetName, boundary, and managedToolMode only to diagnose routing or envelope behavior.",
        "Do not present diagnostic lane invocation as normal workflow guidance.",
      ],
      parameters: Type.Object({
        ...DiagnosticSubagentRunParamsSchema.properties,
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const adapter = runtime.orchestration?.subagents;
        if (!adapter) {
          return failTextResult("Subagent orchestration is unavailable in this session.", {
            ok: false,
          });
        }

        const legacyValidation = failIfLegacyFields(params);
        if (!legacyValidation.ok) {
          return failTextResult(legacyValidation.message, { ok: false });
        }
        const decodedParams = decodeToolParams(DiagnosticSubagentRunParamsSchema, params);
        const mode = resolveMode(decodedParams.mode, decodedParams.tasks);
        const waitMode = resolveWaitMode(decodedParams.waitMode);
        const returnMode = resolveReturnMode(decodedParams.returnMode);
        const deliveryValidation = validateDeliveryConfiguration(runtime, returnMode);
        if (!deliveryValidation.ok) {
          return failTextResult(deliveryValidation.message, { ok: false });
        }
        const builtRequest = buildRunRequestFromParams({
          params: decodedParams,
          mode,
        });
        if (!builtRequest.ok) {
          return failTextResult(builtRequest.message, { ok: false });
        }
        const sessionId = getSessionId(ctx);
        return executeSubagentToolWithRequest({
          options: { ...options, runtime },
          sessionId,
          delegate: resolveDelegationLabel(builtRequest.request),
          mode,
          detailsMode: "diagnostic",
          waitMode,
          returnMode,
          request: builtRequest.request,
          adapter,
          completionVerb: "subagent_run_diagnostic",
          startVerb: "subagent_run_diagnostic started",
          delivery: buildDeliveryRequest(returnMode, decodedParams),
        });
      },
    },
    {},
  );
}
