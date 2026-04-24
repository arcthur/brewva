import {
  getOrCreateDeliberationMemoryPlane,
  getOrCreateOptimizationContinuityPlane,
} from "@brewva/brewva-deliberation";
import { getOrCreateRecallBroker } from "@brewva/brewva-recall";
import type { BrewvaRuntime } from "@brewva/brewva-runtime";
import { getOrCreateSkillPromotionBroker } from "@brewva/brewva-skill-broker";
import type { TurnLifecyclePort } from "./turn-lifecycle-port.js";

async function syncDeliberationState(runtime: BrewvaRuntime): Promise<void> {
  getOrCreateDeliberationMemoryPlane(runtime).sync();
  getOrCreateOptimizationContinuityPlane(runtime).sync();
  getOrCreateSkillPromotionBroker(runtime).sync();
  await getOrCreateRecallBroker(runtime).sync();
}

export function createDeliberationMaintenanceLifecycle(runtime: BrewvaRuntime): TurnLifecyclePort {
  return {
    async beforeAgentStart() {
      await syncDeliberationState(runtime);
      return undefined;
    },
    async agentEnd() {
      await syncDeliberationState(runtime);
      return undefined;
    },
  };
}
