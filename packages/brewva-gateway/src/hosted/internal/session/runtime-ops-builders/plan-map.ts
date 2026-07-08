import type { HostedRuntimeOpsContext } from "../runtime-ops-context.js";
import { createPlanMapRuntimeController } from "../runtime-ops-plan-map-state.js";
import type { HostedRuntimeOpsPort } from "../runtime-ops-port.js";

export function buildPlanMapRuntimeOps(
  ctx: HostedRuntimeOpsContext,
): HostedRuntimeOpsPort["planMap"] {
  const controller = createPlanMapRuntimeController(ctx);
  return {
    state: { get: (mapId) => controller.get(mapId) },
    map: { create: (mapId, input) => controller.create(mapId, input) },
    ticket: {
      open: (mapId, input) => controller.open(mapId, input),
      claim: (mapId, input) => controller.claim(mapId, input),
      unclaim: (mapId, input) => controller.unclaim(mapId, input),
      resolve: (mapId, input) => controller.resolve(mapId, input),
      close: (mapId, input) => controller.close(mapId, input),
      rescope: (mapId, input) => controller.rescope(mapId, input),
    },
    fog: {
      record: (mapId, input) => controller.recordFog(mapId, input),
      graduate: (mapId, input) => controller.graduateFog(mapId, input),
    },
  };
}
