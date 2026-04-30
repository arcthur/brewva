import type {
  DelegationIsolationStrategy,
  DelegationVisibility,
  ManagedToolMode,
} from "@brewva/brewva-runtime";
import type {
  AdvisorConsultKind,
  DelegationPacket,
  ReviewLaneName,
  SubagentContextBudget,
  SubagentExecutionBoundary,
  SubagentResultMode,
} from "@brewva/brewva-tools";
import type { HostedContextProfile, HostedDelegationBuiltinToolName } from "./config-files.js";

export type { HostedDelegationBuiltinToolName } from "./config-files.js";

export interface HostedDelegationTarget {
  name: string;
  description: string;
  visibility: DelegationVisibility;
  resultMode: SubagentResultMode;
  executorPreamble?: string;
  instructionsMarkdown?: string;
  boundary?: SubagentExecutionBoundary;
  skillName?: string;
  consultKind?: AdvisorConsultKind;
  reviewLane?: ReviewLaneName;
  fallbackResultMode?: SubagentResultMode;
  agentSpecName?: string;
  envelopeName?: string;
  builtinToolNames?: HostedDelegationBuiltinToolName[];
  managedToolNames?: string[];
  defaultContextBudget?: SubagentContextBudget;
  managedToolMode?: ManagedToolMode;
  producesPatches: boolean;
  contextProfile: HostedContextProfile;
  isolationStrategy: DelegationIsolationStrategy;
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
