import {
  createClaimAuthoritySurface,
  createClaimInspectSurface,
  type ClaimSurfaceDependencies,
} from "../domain/claim/api.js";
import {
  createContextInspectSurface,
  createContextOperatorSurface,
  type ContextSurfaceDependencies,
} from "../domain/context/api.js";
import {
  createConventionsAuthoritySurface,
  createConventionsInspectSurface,
  type ConventionsSurfaceDependencies,
} from "../domain/conventions/api.js";
import {
  createCostAuthoritySurface,
  createCostInspectSurface,
  type CostSurfaceDependencies,
} from "../domain/cost/api.js";
import {
  createEventsAuthoritySurface,
  createEventsInspectSurface,
  type EventsSurfaceDependencies,
} from "../domain/events/api.js";
import {
  createLedgerInspectSurface,
  type LedgerSurfaceDependencies,
} from "../domain/ledger/api.js";
import {
  createLifecycleInspectSurface,
  type LifecycleSurfaceDependencies,
} from "../domain/lifecycle/api.js";
import {
  createProposalsAuthoritySurface,
  createProposalsInspectSurface,
  type ProposalsSurfaceDependencies,
} from "../domain/proposals/api.js";
import {
  createReasoningAuthoritySurface,
  createReasoningInspectSurface,
  type ReasoningSurfaceDependencies,
} from "../domain/reasoning/api.js";
import {
  createRecoveryInspectSurface,
  createRecoveryOperatorSurface,
  type RecoverySurfaceDependencies,
} from "../domain/recovery/api.js";
import {
  createScheduleAuthoritySurface,
  createScheduleInspectSurface,
  type ScheduleSurfaceDependencies,
} from "../domain/schedule/api.js";
import {
  createSessionAuthoritySurface,
  createSessionInspectSurface,
  createSessionOperatorSurface,
  createSessionWireInspectSurface,
  type SessionSurfaceDependencies,
  type SessionWireSurfaceDependencies,
} from "../domain/sessions/api.js";
import {
  createSkillsInspectSurface,
  createSkillsOperatorSurface,
  type SkillsSurfaceDependencies,
} from "../domain/skills/api.js";
import {
  createTapeAuthoritySurface,
  createTapeInspectSurface,
  type TapeSurfaceDependencies,
} from "../domain/tape/api.js";
import {
  createTaskAuthoritySurface,
  createTaskInspectSurface,
  type TaskSurfaceDependencies,
} from "../domain/task/api.js";
import {
  createToolsAuthoritySurface,
  createToolsInspectSurface,
  createToolsOperatorSurface,
  type ToolsSurfaceDependencies,
} from "../domain/tools/api.js";
import {
  createVerificationAuthoritySurface,
  type VerificationSurfaceDependencies,
} from "../domain/verification/api.js";
import {
  createWorkbenchAuthoritySurface,
  createWorkbenchInspectSurface,
  type WorkbenchSurfaceDependencies,
} from "../domain/workbench/api.js";

export interface RuntimeSurfaceDependencies
  extends
    ContextSurfaceDependencies,
    ConventionsSurfaceDependencies,
    CostSurfaceDependencies,
    EventsSurfaceDependencies,
    LedgerSurfaceDependencies,
    LifecycleSurfaceDependencies,
    ProposalsSurfaceDependencies,
    ReasoningSurfaceDependencies,
    RecoverySurfaceDependencies,
    ScheduleSurfaceDependencies,
    SessionSurfaceDependencies,
    SessionWireSurfaceDependencies,
    SkillsSurfaceDependencies,
    TapeSurfaceDependencies,
    TaskSurfaceDependencies,
    ToolsSurfaceDependencies,
    ClaimSurfaceDependencies,
    VerificationSurfaceDependencies,
    WorkbenchSurfaceDependencies {}

export function createRuntimeSemanticSurfaces(deps: RuntimeSurfaceDependencies) {
  return {
    authority: {
      proposals: createProposalsAuthoritySurface(deps),
      conventions: createConventionsAuthoritySurface(deps),
      reasoning: createReasoningAuthoritySurface(deps),
      workbench: createWorkbenchAuthoritySurface(deps),
      tools: createToolsAuthoritySurface(deps),
      task: createTaskAuthoritySurface(deps),
      claim: createClaimAuthoritySurface(deps),
      schedule: createScheduleAuthoritySurface(deps),
      events: createEventsAuthoritySurface(deps),
      tape: createTapeAuthoritySurface(deps),
      verification: createVerificationAuthoritySurface(deps),
      cost: createCostAuthoritySurface(deps),
      session: createSessionAuthoritySurface(deps),
    },
    inspect: {
      skills: createSkillsInspectSurface(deps),
      proposals: createProposalsInspectSurface(deps),
      conventions: createConventionsInspectSurface(deps),
      reasoning: createReasoningInspectSurface(deps),
      workbench: createWorkbenchInspectSurface(deps),
      context: createContextInspectSurface(deps),
      tools: createToolsInspectSurface(deps),
      task: createTaskInspectSurface(deps),
      claim: createClaimInspectSurface(deps),
      ledger: createLedgerInspectSurface(deps),
      schedule: createScheduleInspectSurface(deps),
      recovery: createRecoveryInspectSurface(deps),
      lifecycle: createLifecycleInspectSurface(deps),
      events: createEventsInspectSurface(deps),
      tape: createTapeInspectSurface(deps),
      cost: createCostInspectSurface(deps),
      session: createSessionInspectSurface(deps),
      sessionWire: createSessionWireInspectSurface(deps),
    },
    operator: {
      skills: createSkillsOperatorSurface(deps),
      context: createContextOperatorSurface(deps),
      tools: createToolsOperatorSurface(deps),
      recovery: createRecoveryOperatorSurface(deps),
      session: createSessionOperatorSurface(deps),
    },
  };
}

export type RuntimeSemanticSurfaces = ReturnType<typeof createRuntimeSemanticSurfaces>;
