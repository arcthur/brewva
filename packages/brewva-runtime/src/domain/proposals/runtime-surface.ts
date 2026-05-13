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

export function createProposalsSurfaceMethods(deps: ProposalsSurfaceDependencies) {
  return {
    authority: {
      proposals: {
        submit: (sessionId: string, proposal: EffectCommitmentProposal): DecisionReceipt =>
          deps.getProposalAdmissionService().submitProposal(sessionId, proposal),
      },
      requests: {
        decide: (
          sessionId: string,
          requestId: string,
          input: DecideEffectCommitmentInput,
        ): DecideEffectCommitmentResult =>
          deps.getEffectCommitmentDeskService().decide(sessionId, requestId, input),
      },
    },
    inspect: {
      proposals: {
        list: (sessionId: string, query?: EffectCommitmentListQuery): EffectCommitmentRecord[] =>
          deps.getProposalAdmissionService().listProposalRecords(sessionId, query),
      },
      requests: {
        list: (
          sessionId: string,
          query?: EffectCommitmentRequestListQuery,
        ): EffectCommitmentRequestRecord[] =>
          deps.getEffectCommitmentDeskService().listRequests(sessionId, query),
        listPending: (sessionId: string): PendingEffectCommitmentRequest[] =>
          deps.getEffectCommitmentDeskService().listPending(sessionId),
      },
    },
  };
}

export type RuntimeProposalsSurfaceMethods = ReturnType<typeof createProposalsSurfaceMethods>;

export function createProposalsAuthoritySurface(deps: ProposalsSurfaceDependencies) {
  return createProposalsSurfaceMethods(deps).authority;
}

export function createProposalsInspectSurface(deps: ProposalsSurfaceDependencies) {
  return createProposalsSurfaceMethods(deps).inspect;
}
