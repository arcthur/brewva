import { registerSessionsDomain } from "../domain/sessions/api.js";
import type {
  RuntimeContextServices,
  RuntimeGovernanceServices,
  RuntimeServiceRegistrarOptions,
  RuntimeSessionServices,
  RuntimeWorkServices,
} from "./service-registrar-types.js";

export function registerRuntimeSessionServices(
  options: RuntimeServiceRegistrarOptions,
  workServices: RuntimeWorkServices,
  contextServices: RuntimeContextServices,
  governanceServices: RuntimeGovernanceServices,
): RuntimeSessionServices {
  return registerSessionsDomain(options, workServices, contextServices, governanceServices)
    .services;
}
