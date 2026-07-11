import type { ToolEffectClass, UnattendedApprovalPolicy } from "@brewva/brewva-runtime/security";
import type {
  EnvelopeApprovalDecision,
  EnvelopePendingApproval,
} from "./resume-approvals-within-envelope.js";

/**
 * Decide how an unattended run answers one pending approval, given the operator's
 * declared effect-class policy and the call's projected effect classes.
 *
 * The fold precedence is `suspend` > `deny` > `accept`, so the safest, most
 * honest outcome wins for a multi-effect call:
 * - any effect class ABSENT from the policy => `suspend` (fail-closed: the
 *   operator did not speak to it, so a human should);
 * - else any effect class mapped to `deny` => `deny` (the operator pre-refused
 *   it; the run continues with the tool denied);
 * - else (every effect class mapped to `allow`) => `accept`.
 *
 * An empty effect set never auto-accepts: a call whose effects we cannot see is
 * suspended. In practice observe-only calls do not reach approval, but the guard
 * keeps the envelope fail-closed regardless.
 */
export function decideUnattendedApproval(
  policy: UnattendedApprovalPolicy,
  effects: readonly string[],
): EnvelopeApprovalDecision {
  if (effects.length === 0) {
    return "suspend";
  }
  let sawDeny = false;
  for (const effect of effects) {
    const behavior = policy[effect as ToolEffectClass];
    if (behavior === "allow") {
      continue;
    }
    if (behavior === "deny") {
      sawDeny = true;
      continue;
    }
    // Unlisted (undefined) or any value that is not exactly allow/deny (a policy
    // that bypassed schema validation) fails closed — never auto-accept a class
    // the operator did not explicitly allow.
    return "suspend";
  }
  return sawDeny ? "deny" : "accept";
}

/**
 * Bind an `UnattendedApprovalPolicy` into an envelope decider. The returned
 * closure captures the deep-readonly config policy at construction — the model
 * cannot reach or widen it — and reads only the pending approval's projected
 * effect classes.
 */
export function buildUnattendedApprovalDecider(
  policy: UnattendedApprovalPolicy,
): (approval: EnvelopePendingApproval) => EnvelopeApprovalDecision {
  return (approval) => decideUnattendedApproval(policy, approval.effects ?? []);
}

/**
 * Whether a policy can auto-decide anything at all. An empty policy suspends
 * every effectful tool (today's headless behavior), so callers skip the envelope
 * entirely rather than run a resume loop that will only ever suspend.
 */
export function unattendedApprovalPolicyIsActive(policy: UnattendedApprovalPolicy): boolean {
  return Object.keys(policy).length > 0;
}
