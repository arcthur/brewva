import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import type { DelegationPacket } from "@brewva/brewva-tools/contracts";
import { buildDelegationPrompt } from "./prompt.js";
import type { HostedDelegationTarget } from "./targets.js";

export interface PreparedSubagentEntry {
  readonly prompt: string;
  readonly delegatedSkill?: string;
  readonly childOwnsSkill: boolean;
}

export function prepareSubagentEntry(input: {
  readonly parentRuntime: BrewvaRuntime;
  readonly childRuntime: BrewvaRuntime;
  readonly childSessionId: string;
  readonly target: HostedDelegationTarget;
  readonly packet: DelegationPacket;
  readonly delegate?: string;
  readonly promptOverride?: string;
}): PreparedSubagentEntry {
  const delegatedSkill = input.target.skillName;
  const childOwnsSkill = Boolean(delegatedSkill && input.target.resultMode !== "consult");
  const skillDocument = delegatedSkill
    ? input.parentRuntime.inspect.skills.catalog.get(delegatedSkill)
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
      skill: skillDocument,
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
