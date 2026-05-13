import type { FileChangeService } from "../patching/api.js";
import type { ConventionAdmissionService } from "./service.js";
import type { ConventionChangeRequest, ConventionRequestState } from "./types.js";

export interface ConventionsSurfaceDependencies {
  getConventionAdmissionService(): ConventionAdmissionService;
  getFileChangeService(): FileChangeService;
}

export function createConventionsSurfaceMethods(deps: ConventionsSurfaceDependencies) {
  return {
    authority: {
      requests: {
        submit: (sessionId: string, request: ConventionChangeRequest) =>
          deps.getConventionAdmissionService().submitChangeRequest(sessionId, request),
        decide: (
          sessionId: string,
          requestId: string,
          input: Parameters<ConventionAdmissionService["decideChangeRequest"]>[2],
        ) => deps.getConventionAdmissionService().decideChangeRequest(sessionId, requestId, input),
        applyApprovedChange: (sessionId: string, requestId: string) =>
          deps
            .getConventionAdmissionService()
            .applyApprovedChange(sessionId, requestId, deps.getFileChangeService()),
      },
    },
    inspect: {
      state: {
        get: (sessionId: string) => deps.getConventionAdmissionService().getState(sessionId),
      },
      requests: {
        list: (sessionId: string, state?: ConventionRequestState) =>
          deps.getConventionAdmissionService().listRequests(sessionId, state),
        listPending: (sessionId: string) =>
          deps.getConventionAdmissionService().listPending(sessionId),
      },
      digest: {
        get: (sessionId: string) => deps.getConventionAdmissionService().getDigest(sessionId),
      },
    },
  };
}

export type RuntimeConventionsSurfaceMethods = ReturnType<typeof createConventionsSurfaceMethods>;

export function createConventionsAuthoritySurface(deps: ConventionsSurfaceDependencies) {
  return createConventionsSurfaceMethods(deps).authority;
}

export function createConventionsInspectSurface(deps: ConventionsSurfaceDependencies) {
  return createConventionsSurfaceMethods(deps).inspect;
}
