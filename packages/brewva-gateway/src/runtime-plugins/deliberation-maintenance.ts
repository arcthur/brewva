import {
  getOrCreateDeliberationMemoryPlane,
  getOrCreateOptimizationContinuityPlane,
} from "@brewva/brewva-deliberation";
import { getOrCreateRecallBroker } from "@brewva/brewva-recall";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import { getOrCreateSkillPromotionBroker } from "@brewva/brewva-skill-broker";
import type { TurnLifecyclePort } from "./turn-lifecycle-port.js";

function syncDeliberationState(runtime: BrewvaRuntime): void {
  getOrCreateDeliberationMemoryPlane(runtime).sync();
  getOrCreateOptimizationContinuityPlane(runtime).sync();
  getOrCreateSkillPromotionBroker(runtime).sync();
  getOrCreateRecallBroker(runtime).sync();
}

export function createDeliberationMaintenanceLifecycle(runtime: BrewvaRuntime): TurnLifecyclePort {
  return {
    beforeAgentStart() {
      syncDeliberationState(runtime);
      return undefined;
    },
    agentEnd() {
      syncDeliberationState(runtime);
      return undefined;
    },
  };
}
