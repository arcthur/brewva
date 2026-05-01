import { registerCostDomain } from "../domain/cost/api.js";
import { registerLedgerDomain } from "../domain/ledger/api.js";
import { registerSkillsDomain } from "../domain/skills/api.js";
import { registerTaskDomain } from "../domain/task/api.js";
import { registerTruthDomain } from "../domain/truth/api.js";
import type {
  RuntimeGovernanceServices,
  RuntimeServiceRegistrarOptions,
  RuntimeWorkServices,
} from "./service-registrar-types.js";

export function registerRuntimeWorkServices(
  options: RuntimeServiceRegistrarOptions,
  governance: RuntimeGovernanceServices,
): RuntimeWorkServices {
  const taskDomain = registerTaskDomain(options);
  const skillsDomain = registerSkillsDomain(options, {
    taskService: taskDomain.services.taskService,
  });
  const truthDomain = registerTruthDomain(options);
  const ledgerDomain = registerLedgerDomain(options, {
    skillLifecycleService: skillsDomain.services.skillLifecycleService,
    getEffectCommitmentDeskService: () => governance.getEffectCommitmentDeskService(),
  });
  const costDomain = registerCostDomain(options, {
    ledgerService: ledgerDomain.services.ledgerService,
    skillLifecycleService: skillsDomain.services.skillLifecycleService,
  });

  return {
    taskService: taskDomain.services.taskService,
    taskWatchdogService: taskDomain.services.taskWatchdogService,
    skillLifecycleService: skillsDomain.services.skillLifecycleService,
    truthService: truthDomain.services.truthService,
    ledgerService: ledgerDomain.services.ledgerService,
    costService: costDomain.services.costService,
  };
}
