import { registerContextDomain } from "../domain/context/api.js";
import type {
  RuntimeContextServices,
  RuntimeServiceRegistrarOptions,
  RuntimeWorkServices,
} from "./service-registrar-types.js";

export function registerRuntimeContextServices(
  options: RuntimeServiceRegistrarOptions,
  workServices: RuntimeWorkServices,
): RuntimeContextServices {
  const contextDomain = registerContextDomain(options, {
    skillLifecycleService: workServices.skillLifecycleService,
    taskService: workServices.taskService,
    ledgerService: workServices.ledgerService,
  });

  return {
    contextService: contextDomain.services.contextService,
  };
}
