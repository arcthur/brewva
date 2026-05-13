import type { ResourceLeaseRecord } from "@brewva/brewva-runtime/context";
import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolOptions } from "../../contracts/index.js";
import { createRuntimeBoundBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { buildStringEnumSchema } from "../../registry/string-enum-contract.js";
import { failTextResult, textResult } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";

const RESOURCE_LEASE_ACTION_VALUES = ["request", "list", "cancel"] as const;
const LeaseActionSchema = buildStringEnumSchema(RESOURCE_LEASE_ACTION_VALUES, {
  guidance:
    "Use request to ask for a temporary budget increase, list to inspect active leases, and cancel to release an existing lease.",
});

function formatLease(lease: ResourceLeaseRecord): string {
  const budget = [
    `max_tool_calls=${lease.budget.maxToolCalls ?? "(unset)"}`,
    `max_tokens=${lease.budget.maxTokens ?? "(unset)"}`,
    `max_parallel=${lease.budget.maxParallel ?? "(unset)"}`,
  ].join(", ");
  return [
    `- ${lease.id}`,
    `status=${lease.status}`,
    `skill=${lease.skillName}`,
    `budget=${budget}`,
    `expires_at=${lease.expiresAt ?? "(none)"}`,
    `expires_after_turn=${lease.expiresAfterTurn ?? "(none)"}`,
    `reason=${lease.reason}`,
  ].join(" ");
}

export function createResourceLeaseTool(options: BrewvaToolOptions): ToolDefinition {
  const { runtime, define } = createRuntimeBoundBrewvaToolFactory(
    options.runtime,
    "resource_lease",
  );
  return define(
    {
      name: "resource_lease",
      label: "Resource Lease",
      description: "Request, inspect, or cancel temporary task-scoped budget expansions.",
      promptSnippet:
        "Negotiate temporary budget expansions when the current task needs more execution headroom.",
      promptGuidelines: [
        "Use this when the current task needs more budget than its default lease provides.",
        "Prefer bounded TTLs and the smallest budget increase that unblocks the task.",
        "Action values are request, list, and cancel.",
      ],
      parameters: Type.Object({
        action: LeaseActionSchema,
        reason: Type.Optional(Type.String({ minLength: 1, maxLength: 800 })),
        leaseId: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        maxToolCalls: Type.Optional(Type.Integer({ minimum: 1 })),
        maxTokens: Type.Optional(Type.Integer({ minimum: 1 })),
        maxParallel: Type.Optional(Type.Integer({ minimum: 1 })),
        ttlMs: Type.Optional(Type.Integer({ minimum: 1 })),
        ttlTurns: Type.Optional(Type.Integer({ minimum: 1 })),
        includeInactive: Type.Optional(Type.Boolean()),
        skillName: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
      }),
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const sessionId = getSessionId(ctx);

        if (params.action === "request") {
          if (typeof params.reason !== "string" || params.reason.trim().length === 0) {
            return failTextResult("Error: reason is required for action=request.", { ok: false });
          }
          const result = runtime.authority.tools.resourceLeases.request(sessionId, {
            reason: params.reason,
            budget: {
              maxToolCalls: params.maxToolCalls,
              maxTokens: params.maxTokens,
              maxParallel: params.maxParallel,
            },
            ttlMs: params.ttlMs,
            ttlTurns: params.ttlTurns,
          });
          if (!result.ok) {
            return failTextResult(`Error: ${result.reason}`, { ok: false });
          }
          return textResult(["# Resource Lease Granted", formatLease(result.lease)].join("\n"), {
            ok: true,
            leaseId: result.lease.id,
            sessionId,
          });
        }

        if (params.action === "list") {
          const leases = runtime.inspect.tools.resourceLeases.list(sessionId, {
            includeInactive: params.includeInactive,
            skillName: params.skillName,
          });
          const lines = ["# Resource Leases"];
          if (leases.length === 0) {
            lines.push("(none)");
          } else {
            lines.push(...leases.map((lease) => formatLease(lease)));
          }
          return textResult(lines.join("\n"), {
            ok: true,
            count: leases.length,
            sessionId,
          });
        }

        if (typeof params.leaseId !== "string" || params.leaseId.trim().length === 0) {
          return failTextResult("Error: leaseId is required for action=cancel.", { ok: false });
        }
        const result = runtime.authority.tools.resourceLeases.cancel(
          sessionId,
          params.leaseId,
          params.reason,
        );
        if (!result.ok) {
          return failTextResult(`Error: ${result.reason}`, { ok: false });
        }
        return textResult(["# Resource Lease Cancelled", formatLease(result.lease)].join("\n"), {
          ok: true,
          leaseId: result.lease.id,
          sessionId,
        });
      },
    },
    {},
  );
}
