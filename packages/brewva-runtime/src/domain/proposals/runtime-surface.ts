import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";
import type {
  DecideEffectCommitmentInput,
  DecideEffectCommitmentResult,
  DecisionReceipt,
  EffectCommitmentListQuery,
  EffectCommitmentProposal,
  EffectCommitmentRecord,
  EffectCommitmentRequestListQuery,
  EffectCommitmentRequestRecord,
  PendingEffectCommitmentRequest,
} from "./types.js";

export interface ProposalsSurfaceDependencies {
  getProposalAdmissionService(): {
    submitProposal(sessionId: string, proposal: EffectCommitmentProposal): DecisionReceipt;
    listProposalRecords(
      sessionId: string,
      query?: EffectCommitmentListQuery,
    ): EffectCommitmentRecord[];
  };
  getEffectCommitmentDeskService(): {
    listRequests(
      sessionId: string,
      query?: EffectCommitmentRequestListQuery,
    ): EffectCommitmentRequestRecord[];
    listPending(sessionId: string): PendingEffectCommitmentRequest[];
    decide(
      sessionId: string,
      requestId: string,
      input: DecideEffectCommitmentInput,
    ): DecideEffectCommitmentResult;
  };
}

export interface RuntimeProposalsSurfaceMethods {
  submit(sessionId: string, proposal: EffectCommitmentProposal): DecisionReceipt;
  list(sessionId: string, query?: EffectCommitmentListQuery): EffectCommitmentRecord[];
  listEffectCommitmentRequests(
    sessionId: string,
    query?: EffectCommitmentRequestListQuery,
  ): EffectCommitmentRequestRecord[];
  listPendingEffectCommitments(sessionId: string): PendingEffectCommitmentRequest[];
  decideEffectCommitment(
    sessionId: string,
    requestId: string,
    input: DecideEffectCommitmentInput,
  ): DecideEffectCommitmentResult;
}

export const proposalsSurfaceContribution = {
  authority: ["submit", "decideEffectCommitment"],
  inspect: ["list", "listEffectCommitmentRequests", "listPendingEffectCommitments"],
} as const satisfies SurfaceContribution<RuntimeProposalsSurfaceMethods>;

export function createProposalsSurfaceMethods(
  deps: ProposalsSurfaceDependencies,
): RuntimeProposalsSurfaceMethods {
  return {
    submit: (sessionId: string, proposal: EffectCommitmentProposal): DecisionReceipt =>
      deps.getProposalAdmissionService().submitProposal(sessionId, proposal),
    list: (sessionId: string, query?: EffectCommitmentListQuery): EffectCommitmentRecord[] =>
      deps.getProposalAdmissionService().listProposalRecords(sessionId, query),
    listEffectCommitmentRequests: (
      sessionId: string,
      query?: EffectCommitmentRequestListQuery,
    ): EffectCommitmentRequestRecord[] =>
      deps.getEffectCommitmentDeskService().listRequests(sessionId, query),
    listPendingEffectCommitments: (sessionId: string): PendingEffectCommitmentRequest[] =>
      deps.getEffectCommitmentDeskService().listPending(sessionId),
    decideEffectCommitment: (
      sessionId: string,
      requestId: string,
      input: DecideEffectCommitmentInput,
    ): DecideEffectCommitmentResult =>
      deps.getEffectCommitmentDeskService().decide(sessionId, requestId, input),
  };
}

export const proposalsRuntimeSurface = defineRuntimeSurfaceModule({
  name: "proposals",
  createMethods: createProposalsSurfaceMethods,
  contribution: proposalsSurfaceContribution,
});
