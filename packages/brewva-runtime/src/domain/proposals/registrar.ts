import type { BrewvaEventDescriptor } from "../../events/descriptor-core.js";
import type {
  RuntimeGovernanceServices,
  RuntimeServiceRegistrarOptions,
} from "../../runtime/service-registrar-types.js";
import type { ToolGovernanceDescriptor } from "../governance/api.js";
import { EffectCommitmentDeskService } from "./effect-commitment-desk.js";
import {
  DECISION_RECEIPT_RECORDED_EVENT_DESCRIPTOR,
  PROPOSALS_EVENT_DESCRIPTORS,
} from "./event-descriptors.js";
import type { EffectCommitmentAuthorizationDecision } from "./proposal-admission-effect-commitment.js";
import { ProposalAdmissionService } from "./proposal-admission.js";
import { proposalsSurfaceContribution } from "./runtime-surface.js";

function normalizeReasonList(
  input: { reason?: string; reasons?: string[] } | undefined,
  fallback: string,
): string[] {
  const values = [
    ...(input?.reasons ?? []),
    ...(typeof input?.reason === "string" ? [input.reason] : []),
  ]
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (values.length === 0) {
    return [fallback];
  }
  return [...new Set(values)];
}

function normalizePolicyBasis(values: readonly string[] | undefined, fallback: string): string[] {
  const normalized = (values ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (normalized.length === 0) {
    return [fallback];
  }
  return [...new Set(normalized)];
}

function buildKernelEffectCommitmentDecision(input: {
  descriptor: ToolGovernanceDescriptor;
  toolName: string;
}): EffectCommitmentAuthorizationDecision {
  const effectSet = new Set(input.descriptor.effects);
  const toolName = input.toolName;
  const policySuffix =
    effectSet.has("external_network") || effectSet.has("external_side_effect")
      ? "effect_commitment_external_requires_port"
      : effectSet.has("schedule_mutation")
        ? "effect_commitment_schedule_requires_port"
        : effectSet.has("local_exec")
          ? "effect_commitment_local_exec_requires_port"
          : "effect_commitment_unknown_requires_port";

  return {
    decision: "defer",
    policyBasis: ["effect_commitment_kernel_policy", policySuffix],
    reasons: [`effect_commitment_requires_governance_port:${toolName}`],
  };
}

export interface RuntimeProposalsDomainRegistration {
  services: Pick<
    RuntimeGovernanceServices,
    | "getEffectCommitmentDeskService"
    | "getProposalAdmissionService"
    | "clearEffectCommitmentDeskState"
  >;
  surfaceContribution: typeof proposalsSurfaceContribution;
  eventDescriptors: readonly BrewvaEventDescriptor<string, unknown>[];
}

export function registerProposalsDomain(
  options: RuntimeServiceRegistrarOptions,
): RuntimeProposalsDomainRegistration {
  let effectCommitmentDeskService: EffectCommitmentDeskService | undefined;
  const getEffectCommitmentDeskService = (): EffectCommitmentDeskService => {
    effectCommitmentDeskService ??= new EffectCommitmentDeskService({
      getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
      listEvents: (sessionId) => options.coreDependencies.eventStore.list(sessionId),
      recordEvent: (input) => options.kernel.recordEvent(input),
    });
    return effectCommitmentDeskService;
  };

  let proposalAdmissionService: ProposalAdmissionService | undefined;
  const getProposalAdmissionService = (): ProposalAdmissionService => {
    proposalAdmissionService ??= new ProposalAdmissionService({
      listDecisionReceiptEvents: (sessionId) =>
        options.coreDependencies.eventStore.list(sessionId, {
          type: DECISION_RECEIPT_RECORDED_EVENT_DESCRIPTOR.type,
        }),
      recordEvent: (input) => options.kernel.recordEvent(input),
      getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
      resolveToolAuthority: (toolName) => options.resolveToolAuthority(toolName),
      effectCommitmentAuthorizer: ({ sessionId, proposal, descriptor, turn }) => {
        const toolName = proposal.payload.toolName.trim() || proposal.subject.trim();
        const governanceDecision = options.governancePort?.authorizeEffectCommitment?.({
          sessionId,
          proposal,
          turn,
        });
        if (governanceDecision !== undefined) {
          const decision =
            governanceDecision.decision === "accept" ||
            governanceDecision.decision === "reject" ||
            governanceDecision.decision === "defer"
              ? governanceDecision.decision
              : "reject";
          if (decision === "defer") {
            const deskDecision = getEffectCommitmentDeskService().authorize({
              sessionId,
              proposal,
              descriptor,
              turn,
            });
            const combinedDecision =
              deskDecision.decision === "accept" || deskDecision.decision === "reject"
                ? deskDecision.decision
                : "defer";
            return {
              decision: combinedDecision,
              requestId: deskDecision.requestId,
              policyBasis: normalizePolicyBasis(
                [...(governanceDecision.policyBasis ?? []), ...(deskDecision.policyBasis ?? [])],
                "effect_commitment_governance_port",
              ),
              reasons: normalizePolicyBasis(
                [
                  ...normalizeReasonList(governanceDecision, `effect_commitment_defer:${toolName}`),
                  ...(deskDecision.reasons ?? []),
                ],
                `effect_commitment_${combinedDecision}:${toolName}`,
              ),
              committedEffects: deskDecision.committedEffects,
            };
          }
          return {
            decision,
            policyBasis: normalizePolicyBasis(
              governanceDecision.policyBasis,
              "effect_commitment_governance_port",
            ),
            reasons: normalizeReasonList(
              governanceDecision,
              `effect_commitment_${decision}:${toolName}`,
            ),
          };
        }
        if (options.governancePort) {
          return buildKernelEffectCommitmentDecision({
            descriptor,
            toolName,
          });
        }
        return getEffectCommitmentDeskService().authorize({
          sessionId,
          proposal,
          descriptor,
          turn,
        });
      },
    });
    return proposalAdmissionService;
  };

  return {
    services: {
      getEffectCommitmentDeskService,
      getProposalAdmissionService,
      clearEffectCommitmentDeskState: (sessionId: string) => {
        effectCommitmentDeskService?.clear(sessionId);
      },
    },
    surfaceContribution: proposalsSurfaceContribution,
    eventDescriptors: PROPOSALS_EVENT_DESCRIPTORS,
  };
}
