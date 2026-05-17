import type { BrewvaRuntimeRoot } from "@brewva/brewva-runtime";
import type { DelegationPacket } from "@brewva/brewva-tools/contracts";
import type { ContextBundle } from "../context/api.js";
import { buildDelegationPrompt } from "./prompt.js";
import type { HostedDelegationTarget } from "./targets.js";

export interface PreparedSubagentEntry {
  readonly prompt: string;
  readonly delegatedSkill?: string;
  readonly childOwnsSkill: boolean;
}

export function prepareSubagentEntry(input: {
  readonly parentRuntime: BrewvaRuntimeRoot;
  readonly childRuntime: BrewvaRuntimeRoot;
  readonly childSessionId: string;
  readonly target: HostedDelegationTarget;
  readonly packet: DelegationPacket;
  readonly delegate?: string;
  readonly promptOverride?: string;
  readonly contextBundle: ContextBundle;
}): PreparedSubagentEntry {
  const delegatedSkill = input.target.skillName;
  const childOwnsSkill = Boolean(delegatedSkill && input.target.resultMode !== "consult");
  const skillDocument = delegatedSkill
    ? input.parentRuntime.inspect.skills.catalog.get(delegatedSkill)
    : undefined;
  const producerContract = delegatedSkill
    ? input.parentRuntime.inspect.skills.catalog.getProducer(delegatedSkill)
    : undefined;
  if (delegatedSkill && !skillDocument) {
    throw new Error(`unknown_skill:${delegatedSkill}`);
  }
  const prepared: PreparedSubagentEntry = {
    prompt: buildDelegationPrompt({
      target: input.target,
      delegate: input.delegate,
      packet: input.packet,
      promptOverride: input.promptOverride,
      contextBundle: input.contextBundle,
      skill: skillDocument,
      producer: producerContract,
    }),
    childOwnsSkill,
  };
  if (delegatedSkill) {
    return {
      ...prepared,
      delegatedSkill,
    };
  }
  return prepared;
}
