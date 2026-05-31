import type { BrewvaToolDefinition as ToolDefinition } from "@brewva/brewva-substrate/tools";
import { Type } from "@sinclair/typebox";
import type { BrewvaToolRuntime } from "../../contracts/index.js";
import { createManagedBrewvaToolFactory } from "../../registry/runtime-bound-tool.js";
import { errTextResult, okTextResult } from "../../utils/result.js";
import { getSessionId } from "../../utils/session.js";

const OptionalUInt = Type.Optional(Type.Integer({ minimum: 0 }));

export interface CreateA2AToolsOptions {
  runtime: Pick<BrewvaToolRuntime, "orchestration">;
}

export function createA2ATools(options: CreateA2AToolsOptions): ToolDefinition[] {
  const agentSendTool = createManagedBrewvaToolFactory("agent_send");
  const agentBroadcastTool = createManagedBrewvaToolFactory("agent_broadcast");
  const agentListTool = createManagedBrewvaToolFactory("agent_list");

  const send = agentSendTool.define({
    name: "agent_send",
    label: "Agent Send",
    description: "Send a message to another orchestrated channel agent.",
    promptSnippet: "Use agent_send for channel A2A delivery.",
    promptGuidelines: [
      "Use subagent_status for durable subagent state. agent_send does not target subagents.",
    ],
    parameters: Type.Object({
      toAgentId: Type.String({ minLength: 1 }),
      message: Type.String({ minLength: 1 }),
      correlationId: Type.Optional(Type.String({ minLength: 1 })),
      depth: OptionalUInt,
      hops: OptionalUInt,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const adapter = options.runtime.orchestration?.a2a;
      if (!adapter) {
        return errTextResult("A2A orchestration is unavailable in this session.", { ok: false });
      }
      const sessionId = getSessionId(ctx);
      const result = await adapter.send({
        fromSessionId: sessionId,
        toAgentId: params.toAgentId,
        message: params.message,
        correlationId: params.correlationId,
        depth: params.depth,
        hops: params.hops,
      });
      if (!result.ok) {
        return errTextResult(
          `agent_send failed for ${result.toAgentId}: ${result.error}`,
          result as Record<string, unknown>,
        );
      }
      return okTextResult(
        result.responseText?.trim() || `agent_send completed for ${result.toAgentId}.`,
        result as Record<string, unknown>,
      );
    },
  });

  const broadcast = agentBroadcastTool.define({
    name: "agent_broadcast",
    label: "Agent Broadcast",
    description: "Broadcast a message to multiple orchestrated agents in one call.",
    parameters: Type.Object({
      toAgentIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
      message: Type.String({ minLength: 1 }),
      correlationId: Type.Optional(Type.String({ minLength: 1 })),
      depth: OptionalUInt,
      hops: OptionalUInt,
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const adapter = options.runtime.orchestration?.a2a;
      if (!adapter) {
        return errTextResult("A2A orchestration is unavailable in this session.", { ok: false });
      }
      const sessionId = getSessionId(ctx);
      const result = await adapter.broadcast({
        fromSessionId: sessionId,
        toAgentIds: params.toAgentIds,
        message: params.message,
        correlationId: params.correlationId,
        depth: params.depth,
        hops: params.hops,
      });
      const okCount = result.results.filter((entry) => entry.ok).length;
      const failCount = result.results.length - okCount;
      const lines = [
        `agent_broadcast completed: ok=${okCount} failed=${failCount}`,
        ...(!result.ok ? [`error=${result.error}`] : []),
        ...result.results.map((entry) =>
          entry.ok ? `- ${entry.toAgentId}: ok` : `- ${entry.toAgentId}: ${entry.error}`,
        ),
      ];
      if (failCount > 0) {
        return errTextResult(lines.join("\n"), result as Record<string, unknown>);
      }
      return okTextResult(lines.join("\n"), result as Record<string, unknown>);
    },
  });

  const list = agentListTool.define({
    name: "agent_list",
    label: "Agent List",
    description: "List orchestrated agents visible to the current channel workspace.",
    parameters: Type.Object({
      includeDeleted: Type.Optional(Type.Boolean()),
    }),
    async execute(_toolCallId, params) {
      const adapter = options.runtime.orchestration?.a2a;
      if (!adapter) {
        return errTextResult("A2A orchestration is unavailable in this session.", { ok: false });
      }
      const agents = await adapter.listAgents({
        includeDeleted: params.includeDeleted,
      });
      if (agents.length === 0) {
        return okTextResult("No agents found.", {
          ok: true,
          count: 0,
          agents,
        });
      }
      const lines = [
        "Agents:",
        ...agents.map((agent) => {
          const aliases =
            agent.aliases && agent.aliases.length > 0 ? ` aliases=${agent.aliases.join(",")}` : "";
          const primary = agent.primaryAddress ? ` primary=${agent.primaryAddress}` : "";
          return `- ${agent.agentId} (${agent.status})${primary}${aliases}`;
        }),
      ];
      return okTextResult(lines.join("\n"), {
        ok: true,
        count: agents.length,
        agents,
      });
    },
  });

  return [send, broadcast, list];
}
