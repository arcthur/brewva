import type { RuntimeServiceRegistrarOptions } from "../../runtime/service-registrar-types.js";
import type { TaskService } from "../task/api.js";
import { SKILLS_EVENT_DESCRIPTORS } from "./event-descriptors.js";
import { skillsSurfaceContribution } from "./runtime-surface.js";
import { SkillLifecycleService } from "./skill-lifecycle.js";
import { SkillValidationContextBuilder } from "./validation/builders/validation-context-builder.js";
import { SkillOutputValidationPipeline } from "./validation/pipeline.js";
import { ConsumedOutputBlockingValidator } from "./validation/validators/consumed-output-blocking-validator.js";
import { ContractValidator } from "./validation/validators/contract-validator.js";
import { ImplementationOutputValidator } from "./validation/validators/implementation-validator.js";
import { PlanningOutputValidator } from "./validation/validators/planning-validator.js";
import { QaOutputValidator } from "./validation/validators/qa-validator.js";
import { ReviewOutputValidator } from "./validation/validators/review-validator.js";
import { ShipOutputValidator } from "./validation/validators/ship-validator.js";

export interface RuntimeSkillsDomainRegistration {
  services: {
    skillLifecycleService: SkillLifecycleService;
  };
  surfaceContribution: typeof skillsSurfaceContribution;
  eventDescriptors: typeof SKILLS_EVENT_DESCRIPTORS;
}

export function registerSkillsDomain(
  options: RuntimeServiceRegistrarOptions,
  support: { taskService: TaskService },
): RuntimeSkillsDomainRegistration {
  const skillValidationContextBuilder = new SkillValidationContextBuilder({
    skills: options.coreDependencies.skillRegistry,
    sessionState: options.sessionState,
    listEvents: (sessionId) => options.coreDependencies.eventStore.list(sessionId),
  });
  const skillValidationPipeline = new SkillOutputValidationPipeline([
    new ContractValidator(),
    new PlanningOutputValidator(),
    new ConsumedOutputBlockingValidator(),
    new ImplementationOutputValidator(),
    new ReviewOutputValidator(),
    new QaOutputValidator(),
    new ShipOutputValidator(),
  ]);
  const skillLifecycleService = new SkillLifecycleService({
    skills: options.coreDependencies.skillRegistry,
    sessionState: options.sessionState,
    getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
    getTaskState: (sessionId) => options.kernel.getTaskState(sessionId),
    validationContextBuilder: skillValidationContextBuilder,
    validationPipeline: skillValidationPipeline,
    recordEvent: (input) => options.kernel.recordEvent(input),
    setTaskSpec: (sessionId, spec) => support.taskService.setTaskSpec(sessionId, spec),
  });

  return {
    services: { skillLifecycleService },
    surfaceContribution: skillsSurfaceContribution,
    eventDescriptors: SKILLS_EVENT_DESCRIPTORS,
  };
}
