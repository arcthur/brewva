import type { RuntimeRecordEvent } from "../domain/sessions/api.js";
import type { BrewvaMaintenancePort } from "./runtime-api.js";
import {
  createHostedEventExtensionPort,
  createRecoverySchedulerExtensionPort,
  createToolRuntimeExtensionPort,
  type BrewvaRuntimeExtensions,
} from "./runtime-extensions.js";

export interface RuntimeExtensionFactoryInput {
  recordEvent: RuntimeRecordEvent;
  eventStore: {
    getLogPath(sessionId: string): string;
  };
  recoveryWalStore: {
    appendPending: Parameters<typeof createRecoverySchedulerExtensionPort>[0]["appendPending"];
    markInflight: Parameters<typeof createRecoverySchedulerExtensionPort>[0]["markInflight"];
    markDone: Parameters<typeof createRecoverySchedulerExtensionPort>[0]["markDone"];
    markFailed: Parameters<typeof createRecoverySchedulerExtensionPort>[0]["markFailed"];
    markExpired: Parameters<typeof createRecoverySchedulerExtensionPort>[0]["markExpired"];
    listPending: Parameters<typeof createRecoverySchedulerExtensionPort>[0]["listPending"];
  };
  maintain: BrewvaMaintenancePort;
}

export function createRuntimeExtensions(
  input: RuntimeExtensionFactoryInput,
): BrewvaRuntimeExtensions {
  const hostedEvents = createHostedEventExtensionPort({
    record: input.recordEvent,
    resolveLogPath: input.eventStore.getLogPath.bind(input.eventStore),
  });
  const recoveryScheduler = createRecoverySchedulerExtensionPort({
    appendPending: input.recoveryWalStore.appendPending.bind(input.recoveryWalStore),
    markInflight: input.recoveryWalStore.markInflight.bind(input.recoveryWalStore),
    markDone: input.recoveryWalStore.markDone.bind(input.recoveryWalStore),
    markFailed: input.recoveryWalStore.markFailed.bind(input.recoveryWalStore),
    markExpired: input.recoveryWalStore.markExpired.bind(input.recoveryWalStore),
    listPending: input.recoveryWalStore.listPending.bind(input.recoveryWalStore),
  });
  const tools = createToolRuntimeExtensionPort({
    recordEvent: hostedEvents.record,
    onClearState: input.maintain.session.onClearState,
    resolveCredentialBindings: input.maintain.session.resolveCredentialBindings,
  });
  return Object.freeze({
    hosted: Object.freeze({
      events: hostedEvents,
    }),
    recovery: Object.freeze({
      scheduler: recoveryScheduler,
    }),
    tools,
  });
}
