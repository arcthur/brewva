import type {
  ExplorerConsultKind,
  DelegationPacket,
  ReviewLaneName,
  SubagentContextBudget,
  SubagentExecutionBoundary,
  SubagentResultMode,
} from "@brewva/brewva-tools/contracts";
import type {
  DelegationGateReason,
  DelegationIsolationStrategy,
  DelegationModelCategory,
  DelegationVisibility,
  PublicSubagentRole,
} from "@brewva/brewva-vocabulary/delegation";
import type { ManagedToolMode } from "@brewva/brewva-vocabulary/session";
import type { HostedDelegationBuiltinToolName } from "./config-files.js";

export type { HostedDelegationBuiltinToolName } from "./config-files.js";

export interface HostedDelegationTarget {
  name: string;
  agent: PublicSubagentRole;
  targetName: string;
  description: string;
  visibility: DelegationVisibility;
  resultMode: SubagentResultMode;
  modelCategory: DelegationModelCategory;
  gateReason: DelegationGateReason;
  executorPreamble?: string;
  instructionsMarkdown?: string;
  boundary?: SubagentExecutionBoundary;
  skillName?: string;
  consultKind?: ExplorerConsultKind;
  reviewLane?: ReviewLaneName;
  fallbackResultMode?: SubagentResultMode;
  agentSpecName?: string;
  envelopeName?: string;
  builtinToolNames?: HostedDelegationBuiltinToolName[];
  managedToolNames?: string[];
  defaultContextBudget?: SubagentContextBudget;
  managedToolMode?: ManagedToolMode;
  producesPatches: boolean;
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
