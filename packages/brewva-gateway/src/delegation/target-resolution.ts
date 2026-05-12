import { readNonEmptyString } from "@brewva/brewva-std/text";
import type { SubagentRunRequest } from "@brewva/brewva-tools/contracts";
import {
  assertHostedExecutionEnvelopeTightening,
  buildHostedDelegationTargetFromAgentSpec,
  deriveDefaultConsultKindForSkillName,
  deriveDefaultAgentSpecNameForResultMode,
  deriveDefaultAgentSpecNameForSkillName,
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
    "agentSpec" | "envelope" | "skillName" | "consultKind" | "fallbackResultMode" | "executionShape"
  >;
  catalog: HostedDelegationCatalog;
}): ResolvedDelegationTarget {
  const requestedAgentSpec = readNonEmptyString(input.request.agentSpec);
  const requestedResultMode =
    input.request.executionShape?.resultMode ?? input.request.fallbackResultMode;
  let resolvedAgentSpecName = requestedAgentSpec;
  const derivedFromSkillName = !requestedAgentSpec && Boolean(input.request.skillName);
  const skillNameAgentSpec = input.request.skillName
    ? input.catalog.agentSpecs.get(input.request.skillName)
    : undefined;
  if (
    input.request.skillName &&
    !requestedAgentSpec &&
    !input.request.envelope &&
    !isKnownDelegationSkillName(input.request.skillName) &&
    !skillNameAgentSpec
  ) {
    throw new Error(`unknown_delegation_skill:${input.request.skillName}`);
  }
  if (!resolvedAgentSpecName && !input.request.envelope) {
    if (input.request.skillName) {
      resolvedAgentSpecName =
        deriveDefaultAgentSpecNameForSkillName(input.request.skillName) ?? skillNameAgentSpec?.name;
      if (!resolvedAgentSpecName) {
        throw new Error(`missing_default_agent_spec_for_skill:${input.request.skillName}`);
      }
    } else if (requestedResultMode) {
      resolvedAgentSpecName = deriveDefaultAgentSpecNameForResultMode(requestedResultMode);
      if (!resolvedAgentSpecName) {
        throw new Error(`missing_default_agent_spec_for_result_mode:${requestedResultMode}`);
      }
    }
  }

  const resolvedAgentSpec = resolvedAgentSpecName
    ? input.catalog.agentSpecs.get(resolvedAgentSpecName)
    : undefined;

  if (resolvedAgentSpecName && !resolvedAgentSpec) {
    throw new Error(`unknown_agent_spec:${resolvedAgentSpecName}`);
  }

  if (resolvedAgentSpec) {
    if (
      input.request.skillName &&
      resolvedAgentSpec.skillName &&
      input.request.skillName !== resolvedAgentSpec.skillName &&
      !derivedFromSkillName
    ) {
      throw new Error("conflicting_agent_spec_and_skill_name");
    }
    const baseEnvelope = resolveHostedExecutionEnvelope(input.catalog, resolvedAgentSpec.envelope);
    const requestedEnvelope = resolveHostedExecutionEnvelope(input.catalog, input.request.envelope);
    const resolvedSkillName =
      input.request.skillName && isKnownDelegationSkillName(input.request.skillName)
        ? input.request.skillName
        : resolvedAgentSpec.skillName;
    const derivedConsultKind =
      input.request.consultKind ??
      resolvedAgentSpec.defaultConsultKind ??
      deriveDefaultConsultKindForSkillName(input.request.skillName) ??
      (derivedFromSkillName &&
      !isKnownDelegationSkillName(input.request.skillName) &&
      (resolvedAgentSpec.fallbackResultMode ?? "consult") === "consult"
        ? "investigate"
        : undefined);
    if (!baseEnvelope) {
      throw new Error(`unknown_envelope:${resolvedAgentSpec.envelope}`);
    }
    if (input.request.envelope && !requestedEnvelope) {
      throw new Error(`unknown_envelope:${input.request.envelope}`);
    }
    if (requestedEnvelope && requestedEnvelope.name !== baseEnvelope.name) {
      assertHostedExecutionEnvelopeTightening(
        baseEnvelope,
        requestedEnvelope,
        "conflicting_agent_spec_and_envelope",
      );
    }
    const envelope = requestedEnvelope ?? baseEnvelope;
    const target = buildHostedDelegationTargetFromAgentSpec({
      agentSpec: {
        ...resolvedAgentSpec,
        skillName: resolvedSkillName,
        defaultConsultKind: derivedConsultKind,
        fallbackResultMode:
          input.request.fallbackResultMode ??
          input.request.executionShape?.resultMode ??
          deriveFallbackResultModeForSkillName(input.request.skillName) ??
          resolvedAgentSpec.fallbackResultMode,
      },
      envelope,
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

  if (input.request.envelope) {
    throw new Error("envelope_requires_agent_spec");
  }

  throw new Error("missing_agent_spec_or_skill_name");
}
