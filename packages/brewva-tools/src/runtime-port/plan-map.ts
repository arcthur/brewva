import type {
  PlanFogGraduateInput,
  PlanFogRecordInput,
  PlanMapCreateInput,
  PlanTicketClaimInput,
  PlanTicketCloseInput,
  PlanTicketOpenInput,
  PlanTicketRescopeInput,
  PlanTicketResolveInput,
  PlanTicketUnclaimInput,
} from "@brewva/brewva-vocabulary/plan-map";
import type { BrewvaToolRuntime } from "../contracts/index.js";

export function getPlanMapState(
  runtime: BrewvaToolRuntime,
  mapId: string,
): ReturnType<BrewvaToolRuntime["capabilities"]["planMap"]["state"]["get"]> {
  return runtime.capabilities.planMap.state.get(mapId);
}

export function createPlanMap(
  runtime: BrewvaToolRuntime,
  mapId: string,
  input: PlanMapCreateInput,
): ReturnType<BrewvaToolRuntime["capabilities"]["planMap"]["map"]["create"]> {
  return runtime.capabilities.planMap.map.create(mapId, input);
}

export function openPlanTicket(
  runtime: BrewvaToolRuntime,
  mapId: string,
  input: PlanTicketOpenInput,
): ReturnType<BrewvaToolRuntime["capabilities"]["planMap"]["ticket"]["open"]> {
  return runtime.capabilities.planMap.ticket.open(mapId, input);
}

export function claimPlanTicket(
  runtime: BrewvaToolRuntime,
  mapId: string,
  input: PlanTicketClaimInput,
): ReturnType<BrewvaToolRuntime["capabilities"]["planMap"]["ticket"]["claim"]> {
  return runtime.capabilities.planMap.ticket.claim(mapId, input);
}

export function unclaimPlanTicket(
  runtime: BrewvaToolRuntime,
  mapId: string,
  input: PlanTicketUnclaimInput,
): ReturnType<BrewvaToolRuntime["capabilities"]["planMap"]["ticket"]["unclaim"]> {
  return runtime.capabilities.planMap.ticket.unclaim(mapId, input);
}

export function resolvePlanTicket(
  runtime: BrewvaToolRuntime,
  mapId: string,
  input: PlanTicketResolveInput,
): ReturnType<BrewvaToolRuntime["capabilities"]["planMap"]["ticket"]["resolve"]> {
  return runtime.capabilities.planMap.ticket.resolve(mapId, input);
}

export function closePlanTicket(
  runtime: BrewvaToolRuntime,
  mapId: string,
  input: PlanTicketCloseInput,
): ReturnType<BrewvaToolRuntime["capabilities"]["planMap"]["ticket"]["close"]> {
  return runtime.capabilities.planMap.ticket.close(mapId, input);
}

export function rescopePlanTicket(
  runtime: BrewvaToolRuntime,
  mapId: string,
  input: PlanTicketRescopeInput,
): ReturnType<BrewvaToolRuntime["capabilities"]["planMap"]["ticket"]["rescope"]> {
  return runtime.capabilities.planMap.ticket.rescope(mapId, input);
}

export function recordPlanFog(
  runtime: BrewvaToolRuntime,
  mapId: string,
  input: PlanFogRecordInput,
): ReturnType<BrewvaToolRuntime["capabilities"]["planMap"]["fog"]["record"]> {
  return runtime.capabilities.planMap.fog.record(mapId, input);
}

export function graduatePlanFog(
  runtime: BrewvaToolRuntime,
  mapId: string,
  input: PlanFogGraduateInput,
): ReturnType<BrewvaToolRuntime["capabilities"]["planMap"]["fog"]["graduate"]> {
  return runtime.capabilities.planMap.fog.graduate(mapId, input);
}
