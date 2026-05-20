import { readNonEmptyString } from "@brewva/brewva-std/text";
import type { SubagentRunRequest } from "@brewva/brewva-tools/contracts";
import {
  buildHostedDelegationTargetFromAgentSpec,
  deriveDefaultConsultKindForSkillName,
  deriveFallbackResultModeForSkillName,
  isKnownDelegationSkillName,
  resolveHostedExecutionEnvelope,
  type HostedDelegationCatalog,
} from "./catalog/registry.js";
import { assertDelegationShapeNarrowing } from "./execution-plan.js";
import type { HostedDelegationTarget } from "./targets.js";

export interface ResolvedDelegationTarget {
  target: HostedDelegationTarget;
  delegate: string;
}

export function resolveDelegationTarget(input: {
  request: Pick<
    SubagentRunRequest,
    "agent" | "targetName" | "skillName" | "consultKind" | "executionShape" | "gateReason"
  >;
  catalog: HostedDelegationCatalog;
}): ResolvedDelegationTarget {
  const roleSkillMatrix: Record<SubagentRunRequest["agent"], readonly string[]> = {
    navigator: ["discovery", "repository-analysis"],
    explorer: [
      "architecture",
      "office-hours",
      "debugging",
      "strategy",
      "plan",
      "review",
      "predict-review",
    ],
    worker: ["implementation"],
    verifier: ["verifier"],
    librarian: ["learning-research"],
  };
  const requestedTargetName = readNonEmptyString(input.request.targetName);
  let resolvedAgentSpecName = requestedTargetName ?? input.request.agent;
  const targetNameExplicit = Boolean(requestedTargetName);
  if (
    input.request.skillName &&
    (!isKnownDelegationSkillName(input.request.skillName) ||
      !(roleSkillMatrix[input.request.agent] ?? []).includes(input.request.skillName))
  ) {
    throw new Error(`incompatible_agent_skill:${input.request.agent}:${input.request.skillName}`);
  }

  const resolvedAgentSpec = resolvedAgentSpecName
    ? input.catalog.agentSpecs.get(resolvedAgentSpecName)
    : undefined;

  if (resolvedAgentSpecName && !resolvedAgentSpec) {
    throw new Error(`unknown_agent_spec:${resolvedAgentSpecName}`);
  }

  if (resolvedAgentSpec) {
    if (resolvedAgentSpec.agent !== input.request.agent) {
      throw new Error(
        `incompatible_agent_spec_role:${resolvedAgentSpec.name}:${input.request.agent}`,
      );
    }
    if (input.request.gateReason && input.request.gateReason !== resolvedAgentSpec.gateReason) {
      throw new Error(
        `incompatible_agent_gate_reason:${input.request.agent}:${input.request.gateReason}`,
      );
    }
    if (
      input.request.skillName &&
      resolvedAgentSpec.skillName &&
      input.request.skillName !== resolvedAgentSpec.skillName &&
      targetNameExplicit
    ) {
      throw new Error("conflicting_agent_spec_and_skill_name");
    }
    const baseEnvelope = resolveHostedExecutionEnvelope(input.catalog, resolvedAgentSpec.envelope);
    const resolvedSkillName =
      input.request.skillName && isKnownDelegationSkillName(input.request.skillName)
        ? input.request.skillName
        : resolvedAgentSpec.skillName;
    const derivedConsultKind =
      input.request.consultKind ??
      resolvedAgentSpec.defaultConsultKind ??
      deriveDefaultConsultKindForSkillName(input.request.skillName);
    if (!baseEnvelope) {
      throw new Error(`unknown_envelope:${resolvedAgentSpec.envelope}`);
    }
    const target = buildHostedDelegationTargetFromAgentSpec({
      agentSpec: {
        ...resolvedAgentSpec,
        skillName: resolvedSkillName,
        defaultConsultKind: derivedConsultKind,
        fallbackResultMode:
          deriveFallbackResultModeForSkillName(input.request.skillName) ??
          resolvedAgentSpec.fallbackResultMode,
      },
      envelope: baseEnvelope,
    });
    if (target.resultMode === "consult" && !target.consultKind) {
      throw new Error("missing_consult_kind");
    }
    if (target.reviewLane && target.consultKind !== "review") {
      throw new Error("invalid_review_lane_consult_kind");
    }
    assertDelegationShapeNarrowing(target, input.request.executionShape);
    return {
      target,
      delegate: target.agentSpecName ?? target.name,
    };
  }

  throw new Error("missing_agent");
}
