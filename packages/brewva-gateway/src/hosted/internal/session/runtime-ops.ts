import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import { buildChannelRuntimeOps } from "./runtime-ops-builders/channel.js";
import { buildClaimRuntimeOps } from "./runtime-ops-builders/claim.js";
import { buildContextRuntimeOps } from "./runtime-ops-builders/context.js";
import { buildCostRuntimeOps } from "./runtime-ops-builders/cost.js";
import { buildDelegationRuntimeOps } from "./runtime-ops-builders/delegation.js";
import { buildEventsRuntimeOps } from "./runtime-ops-builders/events.js";
import { buildGoalRuntimeOps } from "./runtime-ops-builders/goal.js";
import { buildLedgerRuntimeOps } from "./runtime-ops-builders/ledger.js";
import { buildLifecycleRuntimeOps } from "./runtime-ops-builders/lifecycle.js";
import { buildPlanMapRuntimeOps } from "./runtime-ops-builders/plan-map.js";
import { buildProposalsRuntimeOps } from "./runtime-ops-builders/proposals.js";
import { buildReasoningRuntimeOps } from "./runtime-ops-builders/reasoning.js";
import { buildRecoveryRuntimeOps } from "./runtime-ops-builders/recovery.js";
import { buildScheduleRuntimeOps } from "./runtime-ops-builders/schedule.js";
import { buildSessionWireRuntimeOps } from "./runtime-ops-builders/session-wire.js";
import { buildSessionRuntimeOps } from "./runtime-ops-builders/session.js";
import { buildSkillsRuntimeOps } from "./runtime-ops-builders/skills.js";
import { buildTapeRuntimeOps } from "./runtime-ops-builders/tape.js";
import { buildTaskRuntimeOps } from "./runtime-ops-builders/task.js";
import { buildToolsRuntimeOps } from "./runtime-ops-builders/tools.js";
import { buildVerificationRuntimeOps } from "./runtime-ops-builders/verification.js";
import { buildWorkbenchRuntimeOps } from "./runtime-ops-builders/workbench.js";
import { createHostedRuntimeOpsContext } from "./runtime-ops-context.js";
import type { HostedRuntimeOpsPort } from "./runtime-ops-port.js";

export const HOSTED_RUNTIME_OPS_NAMESPACE_LABELS = {
  claim: "B",
  context: "B",
  cost: "A",
  delegation: "C",
  events: "A",
  goal: "B",
  planMap: "B",
  ledger: "B",
  lifecycle: "A",
  proposals: "B",
  reasoning: "B",
  recovery: "A",
  schedule: "B",
  session: "B",
  sessionWire: "B",
  skills: "B",
  tape: "A",
  task: "B",
  tools: "B",
  verification: "B",
  workbench: "B",
  channel: "C",
} as const;

export function createHostedRuntimeOps(options: {
  readonly runtime: BrewvaRuntime;
  readonly listSessionIds?: () => readonly string[];
  readonly clock?: () => number;
}): HostedRuntimeOpsPort {
  const ctx = createHostedRuntimeOpsContext(options);
  const ops: HostedRuntimeOpsPort = {
    events: buildEventsRuntimeOps(ctx),
    goal: buildGoalRuntimeOps(ctx),
    planMap: buildPlanMapRuntimeOps(ctx),
    cost: buildCostRuntimeOps(ctx),
    task: buildTaskRuntimeOps(ctx),
    claim: buildClaimRuntimeOps(ctx),
    tape: buildTapeRuntimeOps(ctx),
    tools: buildToolsRuntimeOps(ctx),
    context: buildContextRuntimeOps(ctx),
    lifecycle: buildLifecycleRuntimeOps(ctx),
    session: buildSessionRuntimeOps(ctx),
    sessionWire: buildSessionWireRuntimeOps(ctx),
    skills: buildSkillsRuntimeOps(ctx),
    proposals: buildProposalsRuntimeOps(ctx),
    workbench: buildWorkbenchRuntimeOps(ctx),
    schedule: buildScheduleRuntimeOps(ctx),
    channel: buildChannelRuntimeOps(ctx),
    delegation: buildDelegationRuntimeOps(ctx),
    recovery: buildRecoveryRuntimeOps(ctx),
    verification: buildVerificationRuntimeOps(ctx),
    reasoning: buildReasoningRuntimeOps(ctx),
    ledger: buildLedgerRuntimeOps(ctx),
  };
  return ops;
}
