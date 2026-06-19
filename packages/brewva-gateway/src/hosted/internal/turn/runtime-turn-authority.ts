import type { RuntimeToolAuthorityResolver } from "@brewva/brewva-runtime";
import {
  createActionPolicyRegistry,
  getToolActionPolicyForClass,
  resolveToolAuthority,
  type ToolActionAdmissionOverrides,
} from "@brewva/brewva-runtime/security";
import { getBrewvaToolMetadata } from "@brewva/brewva-tools/registry";
import type { CollectSessionPromptOutputSession } from "./collect-output.js";
import { isRuntimeToolSession } from "./runtime-turn-session.js";

export function createHostedRuntimeToolAuthorityResolver(
  session: CollectSessionPromptOutputSession,
  input: {
    readonly actionAdmissionOverrides?: ToolActionAdmissionOverrides;
  } = {},
): RuntimeToolAuthorityResolver {
  if (!isRuntimeToolSession(session)) {
    throw new Error("hosted_runtime_tool_authority_session_incompatible");
  }
  const baseRegistry = createActionPolicyRegistry();
  return (toolName, args) => {
    const base = resolveToolAuthority(toolName, baseRegistry, args, input.actionAdmissionOverrides);
    if (base.source === "exact" || base.source === "registry") {
      return base;
    }
    const tool = session.getRegisteredTools().find((candidate) => candidate.name === toolName);
    const actionClass = getBrewvaToolMetadata(tool)?.actionClass;
    if (!actionClass) {
      return base;
    }
    const registeredToolRegistry = createActionPolicyRegistry();
    registeredToolRegistry.register(toolName, getToolActionPolicyForClass(actionClass));
    return resolveToolAuthority(
      toolName,
      registeredToolRegistry,
      args,
      input.actionAdmissionOverrides,
    );
  };
}
