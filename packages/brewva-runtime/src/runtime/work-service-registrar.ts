import { registerClaimDomain } from "../domain/claim/api.js";
import { registerCostDomain } from "../domain/cost/api.js";
import { registerLedgerDomain } from "../domain/ledger/api.js";
import { registerSkillsDomain } from "../domain/skills/api.js";
import { registerTaskDomain } from "../domain/task/api.js";
import { registerWorkbenchDomain } from "../domain/workbench/api.js";
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
  registerSkillsDomain(options);
  const claimDomain = registerClaimDomain(options);
  const ledgerDomain = registerLedgerDomain(options, {
    getEffectCommitmentDeskService: () => governance.getEffectCommitmentDeskService(),
  });
  const costDomain = registerCostDomain(options, {
    ledgerService: ledgerDomain.services.ledgerService,
  });
  const workbenchDomain = registerWorkbenchDomain(options);

  return {
    taskService: taskDomain.services.taskService,
    taskWatchdogService: taskDomain.services.taskWatchdogService,
    claimService: claimDomain.services.claimService,
    ledgerService: ledgerDomain.services.ledgerService,
    costService: costDomain.services.costService,
    workbenchService: workbenchDomain.services.workbenchService,
  };
}
