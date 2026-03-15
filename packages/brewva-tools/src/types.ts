import type { BrewvaRuntime, ToolGovernanceDescriptor } from "@brewva/brewva-runtime";
import type { ToolDefinition } from "@mariozechner/pi-coding-agent";

export type BrewvaToolSurface = "base" | "skill" | "operator";

export interface BrewvaToolMetadata {
  surface: BrewvaToolSurface;
  governance: ToolGovernanceDescriptor;
}

export type BrewvaManagedToolDefinition = ToolDefinition & {
  brewva?: BrewvaToolMetadata;
};

export type BrewvaToolRuntime = Pick<
  BrewvaRuntime,
  | "cwd"
  | "workspaceRoot"
  | "config"
  | "skills"
  | "verification"
  | "tools"
  | "ledger"
  | "cost"
  | "context"
  | "events"
  | "task"
  | "schedule"
  | "session"
> & {
  orchestration?: {
    a2a: {
      send(input: {
        fromSessionId: string;
        fromAgentId?: string;
        toAgentId: string;
        message: string;
        correlationId?: string;
        depth?: number;
        hops?: number;
      }): Promise<{
        ok: boolean;
        toAgentId: string;
        responseText?: string;
        error?: string;
        depth?: number;
        hops?: number;
      }>;
      broadcast(input: {
        fromSessionId: string;
        fromAgentId?: string;
        toAgentIds: string[];
        message: string;
        correlationId?: string;
        depth?: number;
        hops?: number;
      }): Promise<{
        ok: boolean;
        error?: string;
        results: Array<{
          toAgentId: string;
          ok: boolean;
          responseText?: string;
          error?: string;
          depth?: number;
          hops?: number;
        }>;
      }>;
      listAgents(input?: { includeDeleted?: boolean }): Promise<
        Array<{
          agentId: string;
          status: "active" | "deleted";
        }>
      >;
    };
  };
};

export interface BrewvaToolOptions {
  runtime: BrewvaToolRuntime;
  verification?: {
    executeCommands?: boolean;
    timeoutMs?: number;
  };
}
