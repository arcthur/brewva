import {
  defineRuntimeSurfaceModule,
  type SurfaceContribution,
} from "../../runtime/surface-descriptor.js";
import type { FileChangeService } from "../patching/api.js";
import type { ConventionAdmissionService } from "./service.js";
import type {
  ApplyApprovedConventionChangeResult,
  ConventionChangeRequest,
  ConventionDecisionReceipt,
  ConventionDigest,
  ConventionRequestRecord,
  ConventionRequestState,
  ConventionState,
  DecideConventionChangeResult,
} from "./types.js";

export interface ConventionsSurfaceDependencies {
  getConventionAdmissionService(): ConventionAdmissionService;
  getFileChangeService(): FileChangeService;
}

export interface RuntimeConventionsSurfaceMethods {
  submitChangeRequest(
    sessionId: string,
    request: ConventionChangeRequest,
  ): ConventionDecisionReceipt;
  decideChangeRequest(
    sessionId: string,
    requestId: string,
    input: { decision: "accept" | "reject"; actor?: string; reason?: string },
  ): DecideConventionChangeResult;
  applyApprovedChange(sessionId: string, requestId: string): ApplyApprovedConventionChangeResult;
  getState(sessionId: string): ConventionState;
  listRequests(sessionId: string, state?: ConventionRequestState): ConventionRequestRecord[];
  listPending(sessionId: string): ConventionRequestRecord[];
  getDigest(sessionId: string): ConventionDigest;
}

export const conventionsSurfaceContribution = {
  authority: ["submitChangeRequest", "decideChangeRequest", "applyApprovedChange"],
  inspect: ["getState", "listRequests", "listPending", "getDigest"],
} as const satisfies SurfaceContribution<RuntimeConventionsSurfaceMethods>;

export function createConventionsSurfaceMethods(
  deps: ConventionsSurfaceDependencies,
): RuntimeConventionsSurfaceMethods {
  return {
    submitChangeRequest: (sessionId, request) =>
      deps.getConventionAdmissionService().submitChangeRequest(sessionId, request),
    decideChangeRequest: (sessionId, requestId, input) =>
      deps.getConventionAdmissionService().decideChangeRequest(sessionId, requestId, input),
    applyApprovedChange: (sessionId, requestId) =>
      deps
        .getConventionAdmissionService()
        .applyApprovedChange(sessionId, requestId, deps.getFileChangeService()),
    getState: (sessionId) => deps.getConventionAdmissionService().getState(sessionId),
    listRequests: (sessionId, state) =>
      deps.getConventionAdmissionService().listRequests(sessionId, state),
    listPending: (sessionId) => deps.getConventionAdmissionService().listPending(sessionId),
    getDigest: (sessionId) => deps.getConventionAdmissionService().getDigest(sessionId),
  };
}

export const conventionsRuntimeSurface = defineRuntimeSurfaceModule({
  name: "conventions",
  createMethods: createConventionsSurfaceMethods,
  contribution: conventionsSurfaceContribution,
});
