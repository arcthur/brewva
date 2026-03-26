import type { ManagedToolMode } from "@brewva/brewva-runtime";
import type {
  DelegationPacket,
  SubagentContextBudget,
  SubagentExecutionBoundary,
  SubagentResultMode,
} from "@brewva/brewva-tools";
import type { HostedDelegationBuiltinToolName } from "./config-files.js";

export type { HostedDelegationBuiltinToolName } from "./config-files.js";

export interface HostedDelegationTarget {
  name: string;
  description: string;
  resultMode: SubagentResultMode;
  executorPreamble?: string;
  boundary?: SubagentExecutionBoundary;
  model?: string;
  skillName?: string;
  fallbackResultMode?: SubagentResultMode;
  agentSpecName?: string;
  envelopeName?: string;
  builtinToolNames?: HostedDelegationBuiltinToolName[];
  managedToolNames?: string[];
  defaultContextBudget?: SubagentContextBudget;
  managedToolMode?: ManagedToolMode;
}

export function mergeDelegationPacketWithTargetDefaults(
  target: HostedDelegationTarget,
  packet: DelegationPacket | undefined,
): DelegationPacket | undefined {
  if (!packet) {
    return undefined;
  }
  return {
    ...packet,
    contextBudget: {
      ...target.defaultContextBudget,
      ...packet.contextBudget,
    },
    effectCeiling: packet.effectCeiling?.boundary
      ? {
          boundary: packet.effectCeiling.boundary,
        }
      : undefined,
  };
}
