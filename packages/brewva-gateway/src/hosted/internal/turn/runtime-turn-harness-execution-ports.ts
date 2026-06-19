import type {
  RuntimeProviderPort,
  RuntimeToolAuthorityResolver,
  RuntimeToolExecutorPort,
} from "@brewva/brewva-runtime";
import type { ToolActionAdmissionOverrides } from "@brewva/brewva-runtime/security";
import type { CollectSessionPromptOutputSession } from "./collect-output.js";
import { createHostedRuntimeToolAuthorityResolver } from "./runtime-turn-authority.js";
import { createHostedRuntimeProviderPort } from "./runtime-turn-provider.js";
import { isRuntimeAdapterSession, resolveRuntimeProviderFace } from "./runtime-turn-session.js";
import { createHostedRuntimeToolExecutorPort } from "./runtime-turn-tool-executor.js";
import { createVerificationGateRuntimeProviderPort } from "./runtime-turn-verification-gates.js";

export interface HostedHarnessRuntimeExecutionPorts {
  readonly provider: RuntimeProviderPort;
  readonly toolExecutor: RuntimeToolExecutorPort;
  readonly resolveToolAuthority: RuntimeToolAuthorityResolver;
}

export function createHostedHarnessRuntimeExecutionPorts(
  session: CollectSessionPromptOutputSession,
  input: {
    readonly actionAdmissionOverrides?: ToolActionAdmissionOverrides;
  } = {},
): HostedHarnessRuntimeExecutionPorts {
  if (!isRuntimeAdapterSession(session)) {
    throw new Error("hosted_harness_runtime_session_incompatible");
  }
  const providerFace = resolveRuntimeProviderFace(session);
  const provider = createVerificationGateRuntimeProviderPort(
    createHostedRuntimeProviderPort(session, providerFace),
    providerFace,
  );
  return {
    provider,
    toolExecutor: createHostedRuntimeToolExecutorPort(session),
    resolveToolAuthority: createHostedRuntimeToolAuthorityResolver(session, {
      actionAdmissionOverrides: input.actionAdmissionOverrides,
    }),
  };
}
