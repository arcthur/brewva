import type { RuntimeLazyServiceRegistrarOptions } from "../../runtime/wiring.js";
import { REASONING_EVENT_DESCRIPTORS } from "./event-descriptors.js";
import { ReasoningService } from "./reasoning.js";

export interface RuntimeReasoningDomainRegistration {
  lazyFactories: {
    createReasoningService(): ReasoningService;
  };
  eventDescriptors: typeof REASONING_EVENT_DESCRIPTORS;
}

export function registerReasoningDomain(
  options: RuntimeLazyServiceRegistrarOptions,
): RuntimeReasoningDomainRegistration {
  let reasoningService: ReasoningService | undefined;
  return {
    lazyFactories: {
      createReasoningService: () => {
        reasoningService ??= new ReasoningService({
          replay: options.coreDependencies.reasoningReplay,
          getCurrentTurn: (sessionId) => options.kernel.getCurrentTurn(sessionId),
          recordEvent: (input) => options.kernel.recordEvent(input),
        });
        return reasoningService;
      },
    },
    eventDescriptors: REASONING_EVENT_DESCRIPTORS,
  };
}
